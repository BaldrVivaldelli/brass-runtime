import { describe, expect, it } from "vitest";
import { async, asyncFail, asyncSucceed } from "../../types/asyncEffect";
import { Exit } from "../../types/effect";
import { Runtime } from "../../runtime/runtime";
import { Scope } from "../../runtime/scope";
import { collectAllPar, race, raceWith, zipPar } from "../structuredConcurrency";

const makeRuntimeAndScope = () => {
  const rt = Runtime.make({});
  return { rt, scope: new Scope(rt as any) };
};

const delayed = <A>(value: A, ms: number, onCancel?: () => void) =>
  async<unknown, string, A>((_env, cb) => {
    const id = setTimeout(() => cb(Exit.succeed(value)), ms);

    return () => {
      clearTimeout(id);
      onCancel?.();
    };
  });

describe("structured concurrency helpers", () => {
  it("race returns the first success", async () => {
    const { rt, scope } = makeRuntimeAndScope();

    await expect(
      rt.toPromise(
        race(
          delayed("fast", 0),
          delayed("slow", 30),
          scope
        )
      )
    ).resolves.toBe("fast");
  });

  it("zipPar returns both values when both succeed", async () => {
    const { rt, scope } = makeRuntimeAndScope();

    await expect(
      rt.toPromise(zipPar(delayed(1, 0), delayed("b", 0), scope))
    ).resolves.toEqual([1, "b"]);
  });

  it("zipPar fails when either side fails", async () => {
    const { rt, scope } = makeRuntimeAndScope();

    await expect(
      rt.toPromise(zipPar(delayed(1, 0), asyncFail("boom"), scope))
    ).rejects.toBe("boom");
  });

  it("collectAllPar keeps input order", async () => {
    const { rt, scope } = makeRuntimeAndScope();

    await expect(
      rt.toPromise(
        collectAllPar(
          [delayed(1, 5), delayed(2, 0), delayed(3, 1)],
          scope
        )
      )
    ).resolves.toEqual([1, 2, 3]);
  });

  it("collectAllPar propagates the first failure", async () => {
    const { rt, scope } = makeRuntimeAndScope();

    await expect(
      rt.toPromise(
        collectAllPar(
          [asyncSucceed(1), asyncFail("x"), asyncSucceed(3)],
          scope
        )
      )
    ).rejects.toBe("x");
  });

  it("raceWith can select custom continuation for the winner", async () => {
    const { rt, scope } = makeRuntimeAndScope();

    const eff = raceWith(
      delayed("left", 0),
      delayed("right", 20),
      scope,
      (exit, rightFiber) => {
        rightFiber.interrupt();

        return asyncSucceed(
          exit._tag === "Success" ? `L:${exit.value}` : "L:fail"
        );
      },
      (exit, leftFiber) => {
        leftFiber.interrupt();

        return asyncSucceed(
          exit._tag === "Success" ? `R:${exit.value}` : "R:fail"
        );
      }
    );

    await expect(rt.toPromise(eff)).resolves.toBe("L:left");
  });

  it("raceWith can interrupt the loser explicitly", async () => {
    const { rt, scope } = makeRuntimeAndScope();

    const eff = raceWith(
      delayed("fast", 0),
      delayed("slow", 30),
      scope,
      (exit, rightFiber) => {
        rightFiber.interrupt();

        return asyncSucceed(
          exit._tag === "Success" ? exit.value : "failed"
        );
      },
      (exit, leftFiber) => {
        leftFiber.interrupt();

        return asyncSucceed(
          exit._tag === "Success" ? exit.value : "failed"
        );
      }
    );

    await expect(rt.toPromise(eff)).resolves.toBe("fast");
  });
});
