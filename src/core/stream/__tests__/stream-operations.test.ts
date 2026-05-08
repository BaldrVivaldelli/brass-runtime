import { describe, it, expect } from "vitest";
import {
  collectStream,
  concatStream,
  emptyStream,
  flattenStream,
  fromArray,
  merge,
  mergeStream,
  emitStream,
  fromPull,
  unwrapScoped,
  managedStream,
  mapStream,
  streamFromReadableStream,
  zip,
  foreachStream,
} from "../stream";
import { fail, succeed, sync } from "../../types/effect";
import { asyncFail, asyncSucceed, asyncSync, unit } from "../../types/asyncEffect";
import { Runtime } from "../../runtime/runtime";

/**
 * Verification tests for Stream operations after optimizations (Task 5.2.3).
 * Validates: Requirements 6.1, 6.2, 6.3, 12.6, 12.7
 *
 * Verifies that concat, merge, flatten, scoped, managed, and emptyStream
 * still work correctly after the optimizations in tasks 5.2.1 and 5.2.2:
 * - 5.2.1: EMPTY_STREAM singleton in emptyStream() and uncons Emit case
 * - 5.2.2: makeMergePull handler hoisting optimization
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

// ---------------------------------------------------------------------------
// 1. emptyStream singleton
// ---------------------------------------------------------------------------
describe("emptyStream singleton", () => {
  it("returns the same reference on every call (referential equality)", () => {
    const a = emptyStream();
    const b = emptyStream();
    expect(a).toBe(b);
  });

  it("has the correct _tag", () => {
    expect(emptyStream()._tag).toBe("Empty");
  });
});

// ---------------------------------------------------------------------------
// 2. concat
// ---------------------------------------------------------------------------
describe("Stream concat", () => {
  it("concatenates two non-empty streams in order", async () => {
    const result = await run<number[]>(
      collectStream(concatStream(fromArray([1, 2]), fromArray([3, 4])))
    );
    expect(result).toEqual([1, 2, 3, 4]);
  });

  it("concatenating with empty stream on the left yields the right", async () => {
    const result = await run<number[]>(
      collectStream(concatStream(emptyStream(), fromArray([5, 6])))
    );
    expect(result).toEqual([5, 6]);
  });

  it("concatenating with empty stream on the right yields the left", async () => {
    const result = await run<number[]>(
      collectStream(concatStream(fromArray([7, 8]), emptyStream()))
    );
    expect(result).toEqual([7, 8]);
  });
});

// ---------------------------------------------------------------------------
// 3. merge
// ---------------------------------------------------------------------------
describe("Stream merge", () => {
  it("merge of two streams contains all elements", async () => {
    const result = await run<number[]>(
      collectStream(merge(fromArray([1, 2]), fromArray([3, 4])))
    );
    // Order may vary due to merge semantics, but all elements must be present
    expect(result.sort()).toEqual([1, 2, 3, 4]);
  });

  it("merge with an empty stream yields the other stream's elements", async () => {
    const result = await run<number[]>(
      collectStream(merge(emptyStream(), fromArray([10, 20])))
    );
    expect(result.sort()).toEqual([10, 20]);
  });
});

// ---------------------------------------------------------------------------
// 4. flatten
// ---------------------------------------------------------------------------
describe("Stream flatten", () => {
  it("flattens a stream of streams into a single stream", async () => {
    const result = await run<number[]>(
      collectStream(
        flattenStream(fromArray([fromArray([1, 2]), fromArray([3, 4])]))
      )
    );
    expect(result).toEqual([1, 2, 3, 4]);
  });

  it("flattening an empty outer stream yields empty", async () => {
    const result = await run<number[]>(
      collectStream(flattenStream(fromArray([])))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. scoped (via unwrapScoped)
// ---------------------------------------------------------------------------
describe("Stream scoped (unwrapScoped)", () => {
  it("basic scoped stream works and release is called", async () => {
    let released = false;

    const scoped = unwrapScoped(
      sync(() => fromArray([100, 200, 300])),
      () =>
        asyncSync(() => {
          released = true;
        }) as any
    );

    const result = await run<number[]>(collectStream(scoped));
    // Give a tick for the release finalizer to run
    await new Promise((r) => setTimeout(r, 50));

    expect(result).toEqual([100, 200, 300]);
    expect(released).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. managed (via managedStream)
// ---------------------------------------------------------------------------
describe("Stream managed (managedStream)", () => {
  it("managedStream collects values and releases on normal end", async () => {
    const releases: string[] = [];
    const managed = managedStream(
      sync(() => ({
        stream: fromArray([10, 20, 30]),
        release: (exit) => asyncSync(() => {
          releases.push(exit._tag);
        }) as any,
      }))
    );

    expect(managed._tag).toBe("Managed");
    await expect(run<number[]>(collectStream(managed))).resolves.toEqual([10, 20, 30]);
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toEqual(["Success"]);
  });

  it("managedStream releases on stream failure and maps acquire failures", async () => {
    const releases: string[] = [];
    const failingStream = managedStream(
      sync(() => ({
        stream: fromPull(asyncFail({ _tag: "Some", value: "stream-failed" }) as any),
        release: (exit) => asyncSync(() => {
          releases.push(exit._tag);
        }) as any,
      }))
    );

    await expect(run(collectStream(failingStream))).rejects.toBe("stream-failed");
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toEqual(["Failure"]);

    const acquireFailed = managedStream(fail("acquire-failed") as any);
    await expect(run(collectStream(acquireFailed))).rejects.toBe("acquire-failed");
  });
});

describe("Stream extra coverage", () => {
  it("unwrapScoped maps acquire failures and stream failures through release", async () => {
    const releases: string[] = [];
    const failingScoped = unwrapScoped(
      sync(() => fromPull(asyncFail({ _tag: "Some", value: "inner-failed" }) as any)),
      (exit) => asyncSync(() => {
        releases.push(exit._tag);
      }) as any,
    );

    await expect(run(collectStream(failingScoped))).rejects.toBe("inner-failed");
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toEqual(["Failure"]);

    const acquireFailed = unwrapScoped(fail("scoped-acquire-failed") as any, () => unit() as any);
    await expect(run(collectStream(acquireFailed))).rejects.toBe("scoped-acquire-failed");
  });

  it("mapStream handles constructors beyond FromArray", async () => {
    await expect(run(collectStream(mapStream(emptyStream<unknown, never, number>(), (n) => n + 1)))).resolves.toEqual([]);
    await expect(run(collectStream(mapStream(emitStream(succeed(4)), (n) => n + 1)))).resolves.toEqual([5]);
    await expect(run(collectStream(mapStream(fromPull(asyncSucceed([6, emptyStream()]) as any), (n) => n + 1)))).resolves.toEqual([7]);

    const mappedConcat = mapStream(
      concatStream(fromArray([1]), fromArray([2])),
      (n) => n * 10,
    );
    await expect(run(collectStream(mappedConcat))).resolves.toEqual([10, 20]);

    const mappedFlatten = mapStream(
      flattenStream(fromArray([fromArray([1]), fromArray([2])])),
      (n) => String(n),
    );
    await expect(run(collectStream(mappedFlatten))).resolves.toEqual(["1", "2"]);

    const scoped = unwrapScoped(sync(() => fromArray([3])), () => unit() as any);
    await expect(run(collectStream(mapStream(scoped, (n) => n + 1)))).resolves.toEqual([4]);

    const managed = managedStream(sync(() => ({
      stream: fromArray([8]),
      release: () => unit() as any,
    })));
    await expect(run(collectStream(mapStream(managed, (n) => n + 1)))).resolves.toEqual([9]);

    const mappedMerge = mapStream(mergeStream(fromArray([1]), fromArray([2]), false), (n) => n * 2);
    await expect(run(collectStream(mappedMerge))).resolves.toEqual(expect.arrayContaining([2, 4]));
  });

  it("zip and foreachStream handle success, stream failure, and callback failure", async () => {
    await expect(run(collectStream(zip(fromArray([1, 2]), fromArray(["a"]))))).resolves.toEqual([[1, "a"]]);

    const seen: number[] = [];
    await expect(run(foreachStream(fromArray([1, 2]), (n) => asyncSync(() => { seen.push(n); })))).resolves.toBeUndefined();
    expect(seen).toEqual([1, 2]);

    await expect(run(foreachStream(fromPull(asyncFail({ _tag: "Some", value: "stream-error" }) as any), () => unit() as any))).rejects.toBe("stream-error");
    await expect(run(foreachStream(fromArray([1]), () => asyncFail("callback-error")))).rejects.toBe("callback-error");
  });

  it("streamFromReadableStream handles empty bodies, chunks, end, abort, release, and reader errors", async () => {
    expect(await run(collectStream(streamFromReadableStream(undefined, String)))).toEqual([]);

    let released = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2]));
        controller.close();
      },
    });
    await expect(run(collectStream(streamFromReadableStream(stream, String, { onRelease: () => { released++; } })))).resolves.toEqual([
      new Uint8Array([1]),
      new Uint8Array([2]),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(released).toBe(1);

    const aborted = new AbortController();
    aborted.abort();
    const abortingStream = new ReadableStream<Uint8Array>({ start() {} });
    await expect(run(collectStream(streamFromReadableStream(abortingStream, (e) => (e as Error).name, { signal: aborted.signal })))).rejects.toBe("AbortError");

    const erroringStream = {
      getReader: () => ({
        read: () => Promise.reject(new Error("reader failed")),
        cancel: () => undefined,
      }),
    } as unknown as ReadableStream<Uint8Array>;
    await expect(run(collectStream(streamFromReadableStream(erroringStream, (e) => (e as Error).message)))).rejects.toBe("reader failed");
  });

  it("streamFromReadableStream cancels the reader when the consumer is interrupted", async () => {
    let canceled = 0;
    const pendingStream = {
      getReader: () => ({
        read: () => new Promise(() => undefined),
        cancel: () => { canceled++; },
      }),
    } as unknown as ReadableStream<Uint8Array>;

    const fiber = rt.fork(collectStream(streamFromReadableStream(pendingStream, String)));
    await new Promise((resolve) => setImmediate(resolve));
    fiber.interrupt();
    await new Promise((resolve) => setImmediate(resolve));

    expect(canceled).toBeGreaterThanOrEqual(1);
  });
});
