import { describe, it, expect } from "vitest";
import {
  collectStream,
  emptyStream,
  fromArray,
} from "../stream";
import {
  mapP,
  filterP,
  filterMapP,
  takeP,
  dropP,
  groupedP,
  mapEffectP,
  tapEffectP,
  bufferP,
  via,
  andThen,
  compose,
  identity,
} from "../pipeline";
import { asyncSucceed } from "../../types/asyncEffect";
import { some, none, Option } from "../../types/option";
import { Runtime } from "../../runtime/runtime";

/**
 * Verification tests for Pipeline combinators after optimizations (Task 6.3.2).
 * Validates: Requirement 6.4
 *
 * Verifies that all pipeline combinators still produce correct results after
 * the closure-hoisting optimization in task 6.3.1.
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

// ---------------------------------------------------------------------------
// 1. mapP
// ---------------------------------------------------------------------------
describe("mapP", () => {
  it("transforms elements correctly (double each number)", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3, 4]), mapP((x: number) => x * 2)))
    );
    expect(result).toEqual([2, 4, 6, 8]);
  });

  it("works with empty stream", async () => {
    const result = await run<number[]>(
      collectStream(via(emptyStream(), mapP((x: number) => x * 2)))
    );
    expect(result).toEqual([]);
  });

  it("works with single element stream", async () => {
    const result = await run<string[]>(
      collectStream(via(fromArray([42]), mapP((x: number) => String(x))))
    );
    expect(result).toEqual(["42"]);
  });
});

// ---------------------------------------------------------------------------
// 2. filterP
// ---------------------------------------------------------------------------
describe("filterP", () => {
  it("filters elements correctly (keep evens)", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3, 4, 5, 6]), filterP((x: number) => x % 2 === 0)))
    );
    expect(result).toEqual([2, 4, 6]);
  });

  it("returns empty when nothing matches", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 3, 5]), filterP((x: number) => x % 2 === 0)))
    );
    expect(result).toEqual([]);
  });

  it("works with empty stream", async () => {
    const result = await run<number[]>(
      collectStream(via(emptyStream(), filterP((_: number) => true)))
    );
    expect(result).toEqual([]);
  });

  it("works with single element stream (match)", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([2]), filterP((x: number) => x % 2 === 0)))
    );
    expect(result).toEqual([2]);
  });

  it("works with single element stream (no match)", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1]), filterP((x: number) => x % 2 === 0)))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. filterMapP
// ---------------------------------------------------------------------------
describe("filterMapP", () => {
  it("filter-maps correctly (Some for evens, None for odds)", async () => {
    const f = (x: number): Option<number> =>
      x % 2 === 0 ? some(x * 10) : none;

    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3, 4, 5]), filterMapP(f)))
    );
    expect(result).toEqual([20, 40]);
  });

  it("works with empty stream", async () => {
    const result = await run<number[]>(
      collectStream(via(emptyStream(), filterMapP((_: number) => some(1))))
    );
    expect(result).toEqual([]);
  });

  it("works when all elements are None", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3]), filterMapP((_: number) => none as Option<number>)))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. takeP
// ---------------------------------------------------------------------------
describe("takeP", () => {
  it("takes first N elements", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([10, 20, 30, 40, 50]), takeP(3)))
    );
    expect(result).toEqual([10, 20, 30]);
  });

  it("takes all when N >= stream length", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2]), takeP(5)))
    );
    expect(result).toEqual([1, 2]);
  });

  it("takes 0 elements", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3]), takeP(0)))
    );
    expect(result).toEqual([]);
  });

  it("works with empty stream", async () => {
    const result = await run<number[]>(
      collectStream(via(emptyStream(), takeP(3)))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. dropP
// ---------------------------------------------------------------------------
describe("dropP", () => {
  it("drops first N elements", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([10, 20, 30, 40, 50]), dropP(2)))
    );
    expect(result).toEqual([30, 40, 50]);
  });

  it("drops all when N >= stream length", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2]), dropP(5)))
    );
    expect(result).toEqual([]);
  });

  it("drops 0 elements", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3]), dropP(0)))
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it("works with empty stream", async () => {
    const result = await run<number[]>(
      collectStream(via(emptyStream(), dropP(2)))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. groupedP
// ---------------------------------------------------------------------------
describe("groupedP", () => {
  it("groups into chunks of N", async () => {
    const result = await run<number[][]>(
      collectStream(via(fromArray([1, 2, 3, 4, 5]), groupedP(2)))
    );
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("groups into chunks of 1", async () => {
    const result = await run<number[][]>(
      collectStream(via(fromArray([1, 2, 3]), groupedP(1)))
    );
    expect(result).toEqual([[1], [2], [3]]);
  });

  it("groups when chunk size >= stream length", async () => {
    const result = await run<number[][]>(
      collectStream(via(fromArray([1, 2]), groupedP(5)))
    );
    expect(result).toEqual([[1, 2]]);
  });

  it("works with empty stream", async () => {
    const result = await run<number[][]>(
      collectStream(via(emptyStream(), groupedP(3)))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. mapEffectP
// ---------------------------------------------------------------------------
describe("mapEffectP", () => {
  it("maps with an effect", async () => {
    const result = await run<number[]>(
      collectStream(
        via(
          fromArray([1, 2, 3]),
          mapEffectP((x: number) => asyncSucceed(x + 100))
        )
      )
    );
    expect(result).toEqual([101, 102, 103]);
  });

  it("works with empty stream", async () => {
    const result = await run<number[]>(
      collectStream(
        via(emptyStream(), mapEffectP((x: number) => asyncSucceed(x)))
      )
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. tapEffectP
// ---------------------------------------------------------------------------
describe("tapEffectP", () => {
  it("taps with side effect and preserves elements", async () => {
    const tapped: number[] = [];
    const result = await run<number[]>(
      collectStream(
        via(
          fromArray([1, 2, 3]),
          tapEffectP((x: number) => {
            tapped.push(x);
            return asyncSucceed(undefined);
          })
        )
      )
    );
    expect(result).toEqual([1, 2, 3]);
    expect(tapped).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 9. via
// ---------------------------------------------------------------------------
describe("via", () => {
  it("applies pipeline to stream", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3]), mapP((x: number) => x + 1)))
    );
    expect(result).toEqual([2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// 10. andThen / compose
// ---------------------------------------------------------------------------
describe("andThen", () => {
  it("composes pipelines left-to-right", async () => {
    const double = mapP((x: number) => x * 2);
    const addOne = mapP((x: number) => x + 1);
    const pipeline = andThen(double, addOne); // first double, then add 1

    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3]), pipeline))
    );
    expect(result).toEqual([3, 5, 7]); // (1*2)+1=3, (2*2)+1=5, (3*2)+1=7
  });
});

describe("compose", () => {
  it("composes pipelines right-to-left", async () => {
    const double = mapP((x: number) => x * 2);
    const addOne = mapP((x: number) => x + 1);
    const pipeline = compose(addOne, double); // double first, then add 1

    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3]), pipeline))
    );
    expect(result).toEqual([3, 5, 7]); // (1*2)+1=3, (2*2)+1=5, (3*2)+1=7
  });
});

// ---------------------------------------------------------------------------
// 11. identity
// ---------------------------------------------------------------------------
describe("identity", () => {
  it("identity pipeline passes elements through unchanged", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3]), identity()))
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it("identity on empty stream", async () => {
    const result = await run<number[]>(
      collectStream(via(emptyStream(), identity()))
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12. bufferP
// ---------------------------------------------------------------------------
describe("bufferP", () => {
  it("buffers upstream elements", async () => {
    const result = await run<number[]>(
      collectStream(via(fromArray([1, 2, 3, 4]), bufferP(4)))
    );
    expect(result.sort()).toEqual([1, 2, 3, 4]);
  });
});
