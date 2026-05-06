import { describe, expect, it } from "vitest";
import { async, asyncFlatMap } from "../../types/asyncEffect";
import { Exit } from "../../types/effect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";
import type { RuntimeEngineMode } from "../engine/types";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const engines: RuntimeEngineMode[] = ["ts"];

describe("RuntimeFiber transient async cancelers", () => {
  for (const engine of engines) {
    it(`detaches completed async cancelers in ${engine}`, async () => {
      let firstCancels = 0;
      let secondCancels = 0;
      let secondRegistered = false;

      const first = async<unknown, never, string>((_env, cb) => {
        const id = setTimeout(() => cb(Exit.succeed("first")), 0);
        return () => {
          clearTimeout(id);
          firstCancels++;
        };
      });

      const second = async<unknown, never, string>((_env, _cb) => {
        secondRegistered = true;
        return () => {
          secondCancels++;
        };
      });

      const rt = Runtime.makeWithEngine({}, engine, { scheduler: new Scheduler({ engine: "ts" }) });
      const fiber = rt.fork(asyncFlatMap(first, () => second));

      for (let i = 0; i < 50 && !secondRegistered; i++) await wait(1);
      expect(secondRegistered).toBe(true);

      fiber.interrupt();

      await new Promise<void>((resolve) => fiber.join(() => resolve()));
      await rt.shutdown();

      expect(firstCancels).toBe(0);
      expect(secondCancels).toBe(1);
    });
  }
});
