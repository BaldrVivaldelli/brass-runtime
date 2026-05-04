import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { foreachStream, fromArray } from "../stream";
import { asyncSync } from "../../types/asyncEffect";
import { Runtime } from "../../runtime/runtime";

/**
 * **Validates: Requirements 12.6**
 *
 * Propiedad 12: Stream foreachStream procesa todos los elementos en orden
 *
 * Para todo array de valores, `foreachStream(fromArray(values), collect)` invoca
 * collect con cada valor en orden. Esto verifica que foreachStream preserva
 * el orden de emisión y procesa todos los elementos sin pérdida ni duplicación.
 *
 * Generador: Arrays de números de longitud 0-500.
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

describe("Stream foreachStream processes all elements in order (Property 12)", () => {
  it("foreachStream(fromArray(values), collect) invokes collect with each value in order", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 0, maxLength: 500 }),
        async (values) => {
          const collected: number[] = [];
          const effect = foreachStream(
            fromArray(values),
            (a: number) =>
              asyncSync(() => {
                collected.push(a);
              })
          );
          await run<void>(effect);
          expect(collected).toEqual(values);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("foreachStream on empty array collects nothing", () => {
    return fc.assert(
      fc.asyncProperty(fc.constant([]), async (values: number[]) => {
        const collected: number[] = [];
        const effect = foreachStream(
          fromArray(values),
          (a: number) =>
            asyncSync(() => {
              collected.push(a);
            })
        );
        await run<void>(effect);
        expect(collected).toEqual([]);
      }),
      { numRuns: 50 }
    );
  });
});
