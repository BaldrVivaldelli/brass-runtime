// src/core/runtime/resource.ts
// Resource management combinators: bracket, ensuring, managed.
//
// These provide safe resource lifecycle management without requiring
// explicit Scope manipulation. Resources are guaranteed to be released
// even when the fiber is interrupted or the effect fails.

import { async, Async, asyncFlatMap, asyncFold, asyncSucceed, unit } from "../types/asyncEffect";
import { Cause, Exit } from "../types/effect";
import { unsafeGetCurrentRuntime } from "./fiber";
import { Scope } from "./scope";
import type { Runtime } from "./runtime";

// ---------------------------------------------------------------------------
// bracket — acquire/use/release with guaranteed cleanup
// ---------------------------------------------------------------------------

/**
 * Acquires a resource, uses it, and guarantees release regardless of outcome.
 *
 * - `acquire` runs uninterruptibly (once started, it completes)
 * - `use` runs with the acquired resource
 * - `release` runs after `use` completes (success, failure, or interruption)
 *
 * ```ts
 * const result = bracket(
 *   openConnection(),                    // acquire
 *   (conn) => queryDatabase(conn),       // use
 *   (conn, exit) => conn.close()         // release (always runs)
 * );
 * ```
 */
export function bracket<R, E, A, B>(
  acquire: Async<R, E, A>,
  use: (resource: A) => Async<R, E, B>,
  release: (resource: A, exit: Exit<E, B>) => Async<R, any, void>
): Async<R, E, B> {
  return async((env, cb) => {
    const runtime = unsafeGetCurrentRuntime<R>();
    const scope = new Scope<R>(runtime);

    // Step 1: Acquire the resource
    const acquireFiber = scope.fork(acquire);

    acquireFiber.join((acquireExit) => {
      if (acquireExit._tag === "Failure") {
        // Acquire failed — no resource to release, just propagate error
        scope.close(acquireExit);
        cb(acquireExit as unknown as Exit<E, B>);
        return;
      }

      const resource = acquireExit.value;

      // Step 2: Use the resource
      const useFiber = scope.fork(use(resource));

      useFiber.join((useExit) => {
        // Step 3: Release the resource (always, regardless of useExit)
        const releaseEffect = safeRelease(release, resource, useExit);
        const releaseFiber = runtime.fork(releaseEffect);

        releaseFiber.join(() => {
          // Close scope and propagate the use result
          scope.close(useExit as Exit<any, any>);
          cb(useExit);
        });
      });
    });

    // Canceler: interrupt the scope (which interrupts children)
    return () => {
      scope.close(Exit.failCause(Cause.interrupt()));
    };
  });
}

/**
 * Wraps a release function to never throw/fail — best-effort cleanup.
 */
function safeRelease<R, E, A, B>(
  release: (resource: A, exit: Exit<E, B>) => Async<R, any, void>,
  resource: A,
  exit: Exit<E, B>
): Async<R, never, void> {
  return asyncFold(
    (() => {
      try {
        return release(resource, exit);
      } catch {
        return unit<R>();
      }
    })() as Async<R, any, void>,
    () => unit<R>() as Async<R, never, void>,
    () => unit<R>() as Async<R, never, void>
  ) as Async<R, never, void>;
}

// ---------------------------------------------------------------------------
// ensuring — attach a finalizer to any effect
// ---------------------------------------------------------------------------

/**
 * Runs `effect` and then runs `finalizer` regardless of the outcome.
 * The finalizer receives the exit value for inspection.
 *
 * ```ts
 * const result = ensuring(
 *   doWork(),
 *   (exit) => logCompletion(exit)
 * );
 * ```
 */
export function ensuring<R, E, A>(
  effect: Async<R, E, A>,
  finalizer: (exit: Exit<E, A>) => Async<R, any, void>
): Async<R, E, A> {
  return async((env, cb) => {
    const runtime = unsafeGetCurrentRuntime<R>();
    const fiber = runtime.fork(effect);

    fiber.join((exit) => {
      // Run finalizer, then propagate the original exit
      const fin = asyncFold(
        (() => {
          try { return finalizer(exit); }
          catch { return unit<R>(); }
        })() as Async<R, any, void>,
        () => unit<R>(),
        () => unit<R>()
      );

      runtime.fork(fin as any).join(() => {
        cb(exit);
      });
    });

    return () => {
      fiber.interrupt();
    };
  });
}

// ---------------------------------------------------------------------------
// Managed — a reusable resource descriptor
// ---------------------------------------------------------------------------

/**
 * A Managed resource describes how to acquire and release a resource.
 * It can be used multiple times — each `use` call acquires a fresh instance.
 *
 * ```ts
 * const dbPool = managed(
 *   createPool({ max: 10 }),
 *   (pool) => pool.close()
 * );
 *
 * // Use it:
 * const result = useManaged(dbPool, (pool) => pool.query("SELECT 1"));
 * ```
 */
export type Managed<R, E, A> = {
  readonly _tag: "Managed";
  readonly acquire: Async<R, E, A>;
  readonly release: (resource: A, exit: Exit<any, any>) => Async<R, any, void>;
};

/**
 * Creates a Managed resource descriptor.
 */
export function managed<R, E, A>(
  acquire: Async<R, E, A>,
  release: (resource: A, exit?: Exit<any, any>) => Async<R, any, void>
): Managed<R, E, A> {
  return {
    _tag: "Managed",
    acquire,
    release: (resource, exit) => release(resource, exit),
  };
}

/**
 * Uses a Managed resource: acquires, runs the body, and releases.
 */
export function useManaged<R, E, A, B>(
  m: Managed<R, E, A>,
  body: (resource: A) => Async<R, E, B>
): Async<R, E, B> {
  return bracket(m.acquire, body, m.release as any);
}

/**
 * Combines multiple Managed resources. All are acquired in order,
 * and released in reverse order (LIFO).
 *
 * ```ts
 * const resources = managedAll([dbPool, cacheConn, fileHandle]);
 * const result = useManaged(resources, ([db, cache, file]) => ...);
 * ```
 */
export function managedAll<R, E, Resources extends readonly any[]>(
  manageds: { [K in keyof Resources]: Managed<R, E, Resources[K]> }
): Managed<R, E, Resources> {
  const acquire: Async<R, E, Resources> = async((env, cb) => {
    const runtime = unsafeGetCurrentRuntime<R>();
    const resources: any[] = [];
    let i = 0;

    const acquireNext = () => {
      if (i >= manageds.length) {
        cb({ _tag: "Success", value: resources as unknown as Resources });
        return;
      }

      const m = manageds[i]!;
      const fiber = runtime.fork(m.acquire);
      fiber.join((exit) => {
        if (exit._tag === "Failure") {
          // Release already-acquired resources in reverse order
          releaseAcquired(runtime, manageds, resources, exit).then(() => {
            cb(exit as unknown as Exit<E, Resources>);
          });
          return;
        }
        resources.push(exit.value);
        i++;
        acquireNext();
      });
    };

    acquireNext();
  });

  const release = (resources: Resources, exit: Exit<any, any>): Async<R, any, void> => {
    return async((_env, cb) => {
      const runtime = unsafeGetCurrentRuntime<R>();
      releaseAcquired(runtime, manageds, resources as any[], exit).then(() => {
        cb({ _tag: "Success", value: undefined });
      });
    });
  };

  return { _tag: "Managed", acquire, release };
}

/** Release acquired resources in reverse order (best-effort). */
async function releaseAcquired<R, E>(
  runtime: Runtime<R>,
  manageds: readonly Managed<R, E, any>[],
  resources: any[],
  exit: Exit<any, any>
): Promise<void> {
  for (let i = resources.length - 1; i >= 0; i--) {
    try {
      const m = manageds[i]!;
      await new Promise<void>((resolve) => {
        const releaseEff = asyncFold(
          m.release(resources[i], exit),
          () => unit<R>(),
          () => unit<R>()
        );
        runtime.fork(releaseEff as any).join(() => resolve());
      });
    } catch {
      // best-effort: never crash during cleanup
    }
  }
}
