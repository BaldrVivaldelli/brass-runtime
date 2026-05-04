import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { collectStream, concatStream, fromArray } from "../stream";
import { Runtime } from "../../runtime/runtime";

/**
 * **Validates: Requirements 12.6, Design Property 16**
 *
 * Propiedad: Stream concat preserva orden
 *
 * Para dos arrays A y B,
 * `collectStream(concatStream(fromArray(A), fromArray(B)))` produce [...A, ...B].
 *
 * Esto verifica que la concatenación de streams preserva el orden de ambos
 * lados y no pierde ni duplica elementos.
 *
 * Generador: Pares de arrays de números/strings de longitud 0-200.
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

describe("Stream concat preserves order (Property 16)", () => {
  it("collectStream(concat(fromArray(A), fromArray(B))) === [...A, ...B] for integer arrays", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 0, maxLength: 200 }),
        fc.array(fc.integer(), { minLength: 0, maxLength: 200 }),
        async (a, b) => {
          const result = await run<number[]>(
            collectStream(concatStream(fromArray(a), fromArray(b)))
          );
          expect(result).toEqual([...a, ...b]);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("collectStream(concat(fromArray(A), fromArray(B))) === [...A, ...B] for string arrays", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 0, maxLength: 200 }),
        fc.array(fc.string(), { minLength: 0, maxLength: 200 }),
        async (a, b) => {
          const result = await run<string[]>(
            collectStream(concatStream(fromArray(a), fromArray(b)))
          );
          expect(result).toEqual([...a, ...b]);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("concat with empty left returns right", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 0, maxLength: 200 }),
        async (values) => {
          const result = await run<number[]>(
            collectStream(concatStream(fromArray([]), fromArray(values)))
          );
          expect(result).toEqual(values);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("concat with empty right returns left", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 0, maxLength: 200 }),
        async (values) => {
          const result = await run<number[]>(
            collectStream(concatStream(fromArray(values), fromArray([])))
          );
          expect(result).toEqual(values);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("concat is associative: concat(concat(A,B),C) === concat(A,concat(B,C))", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 0, maxLength: 100 }),
        fc.array(fc.integer(), { minLength: 0, maxLength: 100 }),
        fc.array(fc.integer(), { minLength: 0, maxLength: 100 }),
        async (a, b, c) => {
          const leftAssoc = await run<number[]>(
            collectStream(
              concatStream(concatStream(fromArray(a), fromArray(b)), fromArray(c))
            )
          );
          const rightAssoc = await run<number[]>(
            collectStream(
              concatStream(fromArray(a), concatStream(fromArray(b), fromArray(c)))
            )
          );
          expect(leftAssoc).toEqual(rightAssoc);
          expect(leftAssoc).toEqual([...a, ...b, ...c]);
        }
      ),
      { numRuns: 300 }
    );
  });
});
