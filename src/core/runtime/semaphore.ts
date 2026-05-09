// src/core/runtime/semaphore.ts
// Counting semaphore for limiting concurrency of effects.
//
// A Semaphore(n) allows at most n effects to run concurrently.
// Additional effects wait in a FIFO queue until a permit is released.

import { async, Async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../types/asyncEffect";
import { Exit } from "../types/effect";
import { LinkedQueue } from "./linkedQueue";
import { getCurrentFiber } from "./fiber";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Semaphore = {
  /** Current number of available permits. */
  readonly available: () => number;
  /** Total number of permits (capacity). */
  readonly capacity: number;
  /** Number of effects waiting for a permit. */
  readonly waiting: () => number;
  /** Acquire a permit, run the effect, and release the permit. */
  readonly withPermit: <R, E, A>(effect: Async<R, E, A>) => Async<R, E, A>;
  /** Acquire a permit (manual). Must call release() when done. */
  readonly acquire: () => Async<unknown, never, void>;
  /** Release a permit (manual). */
  readonly release: () => void;
};

export type SemaphoreStats = {
  readonly capacity: number;
  readonly available: number;
  readonly waiting: number;
  readonly acquired: number;
  readonly released: number;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Creates a counting semaphore with `n` permits.
 *
 * ```ts
 * const sem = makeSemaphore(5); // max 5 concurrent
 *
 * // Automatic acquire/release:
 * const result = await run(sem.withPermit(fetchData()));
 *
 * // Manual acquire/release:
 * await run(sem.acquire());
 * try { ... } finally { sem.release(); }
 * ```
 */
export function makeSemaphore(n: number): Semaphore {
  const capacity = Math.max(1, Math.floor(n));
  let available = capacity;
  let totalAcquired = 0;
  let totalReleased = 0;

  type Waiter = (exit: Exit<never, void>) => void;
  const waiters = new LinkedQueue<Waiter>();

  const acquire = (): Async<unknown, never, void> => {
    return async((_env, cb) => {
      if (available > 0) {
        // Fast path: permit available immediately
        available--;
        totalAcquired++;
        cb({ _tag: "Success", value: undefined });
        return;
      }

      // Slow path: queue the waiter
      const node = waiters.push(cb);

      // Return canceler that removes from queue
      return () => {
        waiters.remove(node);
      };
    });
  };

  const release = (): void => {
    totalReleased++;

    // If there are waiters, give the permit to the next one
    if (waiters.length > 0) {
      const waiter = waiters.shift()!;
      totalAcquired++;
      waiter({ _tag: "Success", value: undefined });
      return;
    }

    // No waiters — return permit to pool
    available++;
  };

  const acquirePermit = (): Async<unknown, never, () => void> =>
    asyncFlatMap(acquire(), () =>
      async((_env, cb) => {
        let released = false;
        const releaseOnce = () => {
          if (released) return;
          released = true;
          release();
        };

        const fiber = getCurrentFiber();
        fiber?.addFinalizer(() => {
          releaseOnce();
        });

        cb({ _tag: "Success", value: releaseOnce });
      })
    );

  const withPermit = <R, E, A>(effect: Async<R, E, A>): Async<R, E, A> =>
    asyncFlatMap(acquirePermit(), (releaseOnce) =>
      asyncFold(
        effect,
        (error: E) => {
          releaseOnce();
          return asyncFail(error) as Async<unknown, E, A>;
        },
        (value: A) => {
          releaseOnce();
          return asyncSucceed(value) as Async<unknown, E, A>;
        },
      )
    ) as Async<R, E, A>;

  return {
    capacity,
    available: () => available,
    waiting: () => waiters.length,
    withPermit,
    acquire,
    release,
  };
}
