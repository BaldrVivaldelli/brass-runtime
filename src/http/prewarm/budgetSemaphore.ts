// src/http/prewarm/budgetSemaphore.ts — Counting semaphore for probe concurrency limiting.

/**
 * A lightweight counting semaphore that limits concurrent in-flight operations.
 */
export type BudgetSemaphore = {
  /** Acquire a slot. Resolves with a release handle when a slot is available. */
  acquire: () => Promise<{ release: () => void }>;
  /** Try to acquire a slot synchronously. Returns undefined if no slot is available. */
  tryAcquire: () => { release: () => void } | undefined;
  /** Number of currently available slots. */
  available: () => number;
  /** Number of waiters currently queued. */
  queued: () => number;
};

/**
 * Creates a budget semaphore with the given capacity.
 *
 * @param capacity - Maximum number of concurrent slots. Must be >= 1.
 * @returns A BudgetSemaphore instance.
 */
export function makeBudgetSemaphore(capacity: number): BudgetSemaphore {
  if (capacity < 1 || !Number.isFinite(capacity)) {
    throw new Error(`makeBudgetSemaphore: capacity must be >= 1, got ${capacity}`);
  }
  capacity = Math.floor(capacity);

  let active = 0;
  const waiters: Array<(handle: { release: () => void }) => void> = [];

  function release(): void {
    active--;
    if (waiters.length > 0) {
      const next = waiters.shift()!;
      active++;
      next({ release });
    }
  }

  function acquire(): Promise<{ release: () => void }> {
    if (active < capacity) {
      active++;
      return Promise.resolve({ release });
    }
    return new Promise<{ release: () => void }>((resolve) => {
      waiters.push(resolve);
    });
  }

  function tryAcquire(): { release: () => void } | undefined {
    if (active < capacity) {
      active++;
      return { release };
    }
    return undefined;
  }

  function available(): number {
    return capacity - active;
  }

  function queued(): number {
    return waiters.length;
  }

  return { acquire, tryAcquire, available, queued };
}
