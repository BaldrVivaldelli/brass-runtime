import { describe, it, expect } from "vitest";
import {
  Resource,
  bracket,
  ensuring,
  managed,
  makeResource,
  resourceAll,
  useManaged,
  useResource,
  managedAll,
} from "../resource";
import { async, asyncFail, asyncFlatMap, asyncSucceed, unit } from "../../types/asyncEffect";
import type { Async } from "../../types/asyncEffect";
import { Exit } from "../../types/effect";
import { Runtime } from "../runtime";
import { sleep } from "../combinators";

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

// ---------------------------------------------------------------------------
// bracket
// ---------------------------------------------------------------------------
describe("bracket", () => {
  it("acquires, uses, and releases on success", async () => {
    const log: string[] = [];

    const result = await run<number>(
      bracket(
        asyncSucceed("resource"),
        (r) => { log.push(`use:${r}`); return asyncSucceed(42); },
        (r, exit) => { log.push(`release:${r}:${exit._tag}`); return unit(); }
      )
    );

    expect(result).toBe(42);
    expect(log).toEqual(["use:resource", "release:resource:Success"]);
  });

  it("releases on failure", async () => {
    const log: string[] = [];

    try {
      await run(
        bracket(
          asyncSucceed("conn"),
          (_r) => asyncFail("boom"),
          (r, exit) => { log.push(`release:${r}:${exit._tag}`); return unit(); }
        )
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBe("boom");
    }

    expect(log).toEqual(["release:conn:Failure"]);
  });

  it("does not release if acquire fails", async () => {
    const log: string[] = [];

    try {
      await run(
        bracket(
          asyncFail("acquire-failed"),
          (_r) => asyncSucceed(1),
          (r, _exit) => { log.push(`release:${r}`); return unit(); }
        )
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBe("acquire-failed");
    }

    expect(log).toEqual([]); // release never called
  });

  it("release errors are swallowed (use result propagates)", async () => {
    const result = await run<number>(
      bracket(
        asyncSucceed("r"),
        (_r) => asyncSucceed(99),
        (_r, _exit) => asyncFail("release-error") // this error is swallowed
      )
    );

    expect(result).toBe(99);
  });

  it("handles async acquire and release", async () => {
    const log: string[] = [];

    const result = await run<string>(
      bracket(
        asyncFlatMap(sleep(10), () => { log.push("acquired"); return asyncSucceed("handle"); }),
        (h) => { log.push(`using:${h}`); return asyncSucceed("done"); },
        (h, _exit) => asyncFlatMap(sleep(5), () => { log.push(`released:${h}`); return unit(); })
      )
    );

    expect(result).toBe("done");
    expect(log).toEqual(["acquired", "using:handle", "released:handle"]);
  });
});

// ---------------------------------------------------------------------------
// ensuring
// ---------------------------------------------------------------------------
describe("ensuring", () => {
  it("runs finalizer on success", async () => {
    const log: string[] = [];

    const result = await run<number>(
      ensuring(
        asyncSucceed(42),
        (exit) => { log.push(`fin:${exit._tag}`); return unit(); }
      )
    );

    expect(result).toBe(42);
    expect(log).toEqual(["fin:Success"]);
  });

  it("runs finalizer on failure", async () => {
    const log: string[] = [];

    try {
      await run(
        ensuring(
          asyncFail("oops"),
          (exit) => { log.push(`fin:${exit._tag}`); return unit(); }
        )
      );
    } catch { }

    expect(log).toEqual(["fin:Failure"]);
  });

  it("propagates original result even if finalizer fails", async () => {
    const result = await run<number>(
      ensuring(
        asyncSucceed(7),
        (_exit) => asyncFail("fin-error") // swallowed
      )
    );

    expect(result).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// managed / useManaged
// ---------------------------------------------------------------------------
describe("managed + useManaged", () => {
  it("acquires and releases a managed resource", async () => {
    const log: string[] = [];

    const resource = managed(
      asyncSucceed("db-conn"),
      (r) => { log.push(`close:${r}`); return unit(); }
    );

    const result = await run<string>(
      useManaged(resource, (conn) => {
        log.push(`query:${conn}`);
        return asyncSucceed("rows");
      })
    );

    expect(result).toBe("rows");
    expect(log).toEqual(["query:db-conn", "close:db-conn"]);
  });

  it("releases on failure in body", async () => {
    const log: string[] = [];

    const resource = managed(
      asyncSucceed("file"),
      (r) => { log.push(`close:${r}`); return unit(); }
    );

    try {
      await run(
        useManaged(resource, (_f) => asyncFail("read-error"))
      );
    } catch { }

    expect(log).toEqual(["close:file"]);
  });

  it("can be reused multiple times", async () => {
    let acquireCount = 0;
    let releaseCount = 0;

    const resource = managed(
      async((_env, cb) => { acquireCount++; cb({ _tag: "Success", value: acquireCount }); }),
      () => { releaseCount++; return unit(); }
    );

    const r1 = await run<number>(useManaged(resource, (n) => asyncSucceed(n * 10)));
    const r2 = await run<number>(useManaged(resource, (n) => asyncSucceed(n * 10)));

    expect(r1).toBe(10);
    expect(r2).toBe(20);
    expect(acquireCount).toBe(2);
    expect(releaseCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// managedAll
// ---------------------------------------------------------------------------
describe("managedAll", () => {
  it("acquires all resources in order and releases in reverse", async () => {
    const log: string[] = [];

    const r1 = managed(
      async((_e, cb) => { log.push("acquire:A"); cb({ _tag: "Success", value: "A" }); }),
      (r) => { log.push(`release:${r}`); return unit(); }
    );
    const r2 = managed(
      async((_e, cb) => { log.push("acquire:B"); cb({ _tag: "Success", value: "B" }); }),
      (r) => { log.push(`release:${r}`); return unit(); }
    );
    const r3 = managed(
      async((_e, cb) => { log.push("acquire:C"); cb({ _tag: "Success", value: "C" }); }),
      (r) => { log.push(`release:${r}`); return unit(); }
    );

    const combined = managedAll([r1, r2, r3] as any);

    const result = await run<string>(
      useManaged(combined as any, (resources: any) => {
        log.push(`use:${resources.join(",")}`);
        return asyncSucceed(resources.join("+"));
      })
    );

    expect(result).toBe("A+B+C");
    expect(log).toEqual([
      "acquire:A", "acquire:B", "acquire:C",
      "use:A,B,C",
      "release:C", "release:B", "release:A"
    ]);
  });

  it("releases already-acquired resources if one acquire fails", async () => {
    const log: string[] = [];

    const r1 = managed(
      async((_e, cb) => { log.push("acquire:A"); cb({ _tag: "Success", value: "A" }); }),
      (r) => { log.push(`release:${r}`); return unit(); }
    );
    const r2 = managed(
      async((_e, cb) => { log.push("acquire:B-fail"); cb({ _tag: "Failure", cause: { _tag: "Fail", error: "B-failed" } }); }),
      (r) => { log.push(`release:${r}`); return unit(); }
    );
    const r3 = managed(
      async((_e, cb) => { log.push("acquire:C"); cb({ _tag: "Success", value: "C" }); }),
      (r) => { log.push(`release:${r}`); return unit(); }
    );

    const combined = managedAll([r1, r2, r3] as any);

    try {
      await run(useManaged(combined as any, () => asyncSucceed("never")));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBe("B-failed");
    }

    // A was acquired and should be released. B failed, C never acquired.
    expect(log).toContain("acquire:A");
    expect(log).toContain("acquire:B-fail");
    expect(log).not.toContain("acquire:C");
    expect(log).toContain("release:A");
  });
});

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------
describe("Resource", () => {
  it("composes with map/flatMap and releases in reverse acquisition order", async () => {
    const log: string[] = [];
    const connection = makeResource(
      asyncSucceed("conn"),
      (conn) => { log.push(`release:${conn}`); return unit(); },
    );
    const statement = (conn: string) => makeResource(
      asyncSucceed(`${conn}:stmt`),
      (stmt) => { log.push(`release:${stmt}`); return unit(); },
    );

    const program = connection
      .flatMap((conn) => statement(conn))
      .map((stmt) => `${stmt}:mapped`);

    const result = await run(useResource(program, (stmt) => {
      log.push(`use:${stmt}`);
      return asyncSucceed(stmt.length);
    }));

    expect(result).toBe("conn:stmt:mapped".length);
    expect(log).toEqual([
      "use:conn:stmt:mapped",
      "release:conn:stmt",
      "release:conn",
    ]);
  });

  it("releases every acquired resource when the body fails", async () => {
    const log: string[] = [];
    const first = Resource.make(
      asyncSucceed("a"),
      (value) => { log.push(`release:${value}`); return unit(); },
    );
    const second = Resource.make(
      asyncSucceed("b"),
      (value) => { log.push(`release:${value}`); return unit(); },
    );

    await expect(run(Resource.all([first, second] as const).use(() => asyncFail("boom"))))
      .rejects
      .toBe("boom");

    expect(log).toEqual(["release:b", "release:a"]);
  });

  it("adapts existing Managed resources", async () => {
    const log: string[] = [];
    const m = managed(
      asyncSucceed("managed"),
      (value) => { log.push(`release:${value}`); return unit(); },
    );

    await expect(run(Resource.fromManaged(m).zip(Resource.succeed("value")).use(([left, right]) =>
      asyncSucceed(`${left}:${right}`)
    ))).resolves.toBe("managed:value");

    expect(log).toEqual(["release:managed"]);
  });

  it("resourceAll acquires in order and releases in reverse", async () => {
    const log: string[] = [];
    const mk = (name: string) => makeResource(
      async((_env, cb) => {
        log.push(`acquire:${name}`);
        cb(Exit.succeed(name));
      }),
      (value) => {
        log.push(`release:${value}`);
        return unit();
      },
    );

    const result = await run(resourceAll([mk("a"), mk("b"), mk("c")] as const).use((values) =>
      asyncSucceed(values.join(","))
    ));

    expect(result).toBe("a,b,c");
    expect(log).toEqual([
      "acquire:a",
      "acquire:b",
      "acquire:c",
      "release:c",
      "release:b",
      "release:a",
    ]);
  });
});
