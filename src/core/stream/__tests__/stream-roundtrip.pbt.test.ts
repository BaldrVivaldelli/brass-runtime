import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { collectStream, fromArray } from "../stream";
import { Runtime } from "../../runtime/runtime";

/**
 * **Validates: Requirements 12.7**
 *
 * Propiedad 5: Round-trip de Stream collectStream/fromArray
 *
 * Para todo array de valores, `collectStream(fromArray(values))` produce
 * un array igual al original. Esto verifica que la serialización y
 * reconstrucción de streams preserva los datos exactamente.
 *
 * Generador: Arrays de números/strings de longitud 0-200.
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

describe("Stream collectStream/fromArray round-trip (Property 5)", () => {
  it("collectStream(fromArray(values)) === values for integer arrays", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 0, maxLength: 200 }),
        async (values) => {
          const result = await run<number[]>(
            collectStream(fromArray(values))
          );
          expect(result).toEqual(values);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("collectStream(fromArray(values)) === values for string arrays", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 0, maxLength: 200 }),
        async (values) => {
          const result = await run<string[]>(
            collectStream(fromArray(values))
          );
          expect(result).toEqual(values);
        }
      ),
      { numRuns: 500 }
    );
  });
});
