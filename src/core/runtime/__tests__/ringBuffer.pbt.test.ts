import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { RingBuffer } from "../ringBuffer";

/**
 * **Validates: Requirements 4.1**
 *
 * Propiedad 6: RingBuffer FIFO ordering
 * Para cualquier secuencia de operaciones push/shift en el RingBuffer,
 * los elementos se extraen en orden FIFO.
 *
 * Generador: Secuencias de operaciones push(value) y shift() con valores aleatorios.
 */

type PushOp = { type: "push"; value: number };
type ShiftOp = { type: "shift" };
type RingOp = PushOp | ShiftOp;

const pushOp: fc.Arbitrary<PushOp> = fc.integer().map((value) => ({
  type: "push" as const,
  value,
}));

const shiftOp: fc.Arbitrary<ShiftOp> = fc.constant({ type: "shift" as const });

const ringOp: fc.Arbitrary<RingOp> = fc.oneof(
  { weight: 3, arbitrary: pushOp },
  { weight: 2, arbitrary: shiftOp }
);

const opsArb: fc.Arbitrary<RingOp[]> = fc.array(ringOp, {
  minLength: 1,
  maxLength: 200,
});

const capacityArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 128 });

describe("RingBuffer FIFO ordering (Property 6)", () => {
  it("elements are shifted in the same order they were pushed", () => {
    fc.assert(
      fc.property(opsArb, capacityArb, (ops, initialCapacity) => {
        const buffer = new RingBuffer<number>(initialCapacity);
        const pushed: number[] = [];
        const shifted: number[] = [];

        for (const op of ops) {
          if (op.type === "push") {
            const status = buffer.push(op.value);
            // Only track values that were actually accepted (not dropped)
            if ((status & 2) === 0) {
              // PushStatus.Dropped === 1 << 1 === 2
              pushed.push(op.value);
            }
          } else {
            const value = buffer.shift();
            if (value !== undefined) {
              shifted.push(value);
            }
          }
        }

        // Drain remaining elements
        let remaining = buffer.shift();
        while (remaining !== undefined) {
          shifted.push(remaining);
          remaining = buffer.shift();
        }

        // All shifted values must match the first shifted.length pushed values in order
        expect(shifted).toEqual(pushed.slice(0, shifted.length));

        // The number of shifted values should equal pushed values
        // (since we drained the buffer at the end)
        expect(shifted.length).toBe(pushed.length);
      }),
      { numRuns: 500 }
    );
  });
});


/**
 * **Validates: Requirements 4.4**
 *
 * Propiedad 7: RingBuffer capacity es potencia de 2
 * Para cualquier capacidad inicial N, la capacidad real del RingBuffer
 * es la menor potencia de 2 >= max(2, N).
 *
 * Generador: Generar capacidades iniciales de 1 a 10000.
 */

function nextPow2(n: number): number {
  let v = Math.max(2, n);
  v--;
  v |= v >>> 1;
  v |= v >>> 2;
  v |= v >>> 4;
  v |= v >>> 8;
  v |= v >>> 16;
  v++;
  return v;
}

function isPowerOf2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * **Validates: Requirements 4.2**
 *
 * Propiedad 8: RingBuffer grow preserva elementos
 * Cuando el RingBuffer crece, todos los elementos existentes se preservan en orden FIFO.
 *
 * Generador: Generar secuencias de push que excedan la capacidad inicial pero no maxCap.
 * Opcionalmente hacer shifts antes del grow para crear wrap-around.
 */
describe("RingBuffer grow preserves elements (Property 8)", () => {
  it("when the buffer grows, all existing elements are preserved in FIFO order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 16 }),   // initialCapacity (small to trigger grows)
        fc.integer({ min: 0, max: 15 }),    // shiftsBeforeGrow: shifts before filling to create wrap-around
        fc.array(fc.integer(), { minLength: 1, maxLength: 300 }), // values to push
        (rawInitCap, shiftsBeforeGrow, values) => {
          // maxCap large enough to hold all values without dropping
          const maxCap = Math.max(rawInitCap, values.length + 1) * 4;
          const buffer = new RingBuffer<number>(rawInitCap, maxCap);
          const actualInitCap = buffer.capacity;

          // Phase 1: Push some elements and shift them to create wrap-around in the internal array.
          // This ensures head != 0 when grow happens, testing the copy logic.
          const preShiftCount = Math.min(shiftsBeforeGrow, actualInitCap - 1);
          for (let i = 0; i < preShiftCount; i++) {
            buffer.push(-1 - i); // sentinel values
          }
          for (let i = 0; i < preShiftCount; i++) {
            buffer.shift();
          }

          // Phase 2: Push all test values — this should trigger at least one grow
          // since values.length can exceed actualInitCap
          const fifo: number[] = [];
          let grew = false;
          for (const v of values) {
            const status = buffer.push(v);
            if ((status & 2) === 0) {
              // Not dropped — value was accepted
              fifo.push(v);
            }
            if ((status & 1) !== 0) {
              // PushStatus.Grew
              grew = true;
            }
          }

          // We only care about runs where a grow actually happened
          // Use fc.pre to skip runs that didn't trigger a grow
          fc.pre(grew);

          // Phase 3: Drain the buffer and verify FIFO order
          const drained: number[] = [];
          let val = buffer.shift();
          while (val !== undefined) {
            drained.push(val);
            val = buffer.shift();
          }

          // All elements must come out in the exact FIFO order they were pushed
          expect(drained).toEqual(fifo);
        }
      ),
      { numRuns: 500 }
    );
  });
});


describe("RingBuffer capacity is power of 2 (Property 7)", () => {
  it("for any initial capacity N (1..10000), actual capacity is the smallest power of 2 >= max(2, N)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        (initialCapacity) => {
          const buffer = new RingBuffer<number>(initialCapacity);
          const actualCapacity = buffer.capacity;

          // 1. Capacity must be a power of 2
          expect(isPowerOf2(actualCapacity)).toBe(true);

          // 2. Capacity must be >= max(2, initialCapacity)
          const minExpected = Math.max(2, initialCapacity);
          expect(actualCapacity).toBeGreaterThanOrEqual(minExpected);

          // 3. Capacity must be the *smallest* power of 2 >= max(2, N)
          const expectedCapacity = nextPow2(initialCapacity);
          expect(actualCapacity).toBe(expectedCapacity);

          // 4. The previous power of 2 must be strictly less than max(2, N)
          // (confirming this is indeed the smallest such power of 2)
          if (actualCapacity > 2) {
            expect(actualCapacity / 2).toBeLessThan(minExpected);
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});
