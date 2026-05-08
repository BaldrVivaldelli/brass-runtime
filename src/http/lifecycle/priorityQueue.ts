// src/http/lifecycle/priorityQueue.ts

/**
 * Clamps a priority value to the valid range [0, 9].
 *
 * - Truncates toward zero (removes fractional part)
 * - Clamps the result to the integer range 0 through 9
 * - Returns a default of 5 for `undefined`, `NaN`, or non-finite values
 *
 * @param value - The priority value to clamp. Must be an integer from 0 to 9.
 *   Values outside this range are clamped. Undefined or non-finite values default to 5.
 * @returns An integer in the range [0, 9] representing the clamped priority.
 *
 * @example
 * ```typescript
 * import { clampPriority } from "./priorityQueue";
 *
 * clampPriority(3);         // 3
 * clampPriority(15);        // 9 (clamped to max)
 * clampPriority(-2);        // 0 (clamped to min)
 * clampPriority(undefined); // 5 (default)
 * clampPriority(2.7);       // 2 (truncated)
 * ```
 */
export function clampPriority(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 5;
  return Math.max(0, Math.min(9, Math.trunc(value)));
}

/**
 * An entry stored in the priority queue.
 *
 * @property priority - Priority level from 0 to 9, where 0 is the highest priority.
 *   Clamped on enqueue via `clampPriority`.
 * @property arrivalOrder - Monotonic counter used for FIFO tiebreak within the same
 *   priority level. Lower values are dispatched first.
 * @property value - The stored value associated with this entry.
 * @property cancelled - When `true`, the entry is logically removed (lazy deletion).
 *   Cancelled entries are skipped during dequeue and peek operations.
 */
export type PriorityQueueEntry<T> = {
  /** Priority level 0-9 (0 = highest priority). Clamped on enqueue. */
  priority: number;
  /** Monotonic counter for FIFO tiebreak within the same priority level. */
  arrivalOrder: number;
  /** The stored value. */
  value: T;
  /** When true, the entry is logically removed (lazy deletion). */
  cancelled: boolean;
};

/**
 * Compares two priority queue entries for heap ordering.
 * Lower priority value = higher priority (dispatched first).
 * Equal priority: lower arrivalOrder dispatched first (FIFO).
 */
function comparePriority<T>(a: PriorityQueueEntry<T>, b: PriorityQueueEntry<T>): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.arrivalOrder - b.arrivalOrder;
}

/**
 * A generic binary min-heap priority queue.
 *
 * Entries are ordered by priority ascending (lower value = higher priority),
 * with FIFO tiebreak via a monotonic arrivalOrder counter. Priority values
 * are integers from 0 to 9, where 0 is the highest priority.
 *
 * Supports lazy removal: entries can be marked as cancelled and are
 * skipped during dequeue and peek operations.
 *
 * @example
 * ```typescript
 * import { PriorityQueue } from "./priorityQueue";
 *
 * const queue = new PriorityQueue<string>();
 * queue.enqueue("low", 9);
 * queue.enqueue("high", 0);
 * const entry = queue.dequeue(); // { value: "high", priority: 0, ... }
 * ```
 */
export class PriorityQueue<T> {
  private heap: PriorityQueueEntry<T>[] = [];
  private counter = 0;

  /**
   * Returns the number of entries in the queue (including cancelled entries).
   *
   * @returns The total number of entries in the internal heap.
   *
   * @example
   * ```typescript
   * import { PriorityQueue } from "./priorityQueue";
   *
   * const queue = new PriorityQueue<string>();
   * queue.enqueue("task", 5);
   * console.log(queue.size); // 1
   * ```
   */
  get size(): number {
    return this.heap.length;
  }

  /**
   * Adds a value to the queue with the given priority.
   *
   * Priority is clamped to the valid range [0, 9] via `clampPriority`.
   * Returns the created entry, which can be used for later cancellation
   * by setting `entry.cancelled = true`.
   *
   * @param value - The value to enqueue.
   * @param priority - Priority level, integer from 0 (highest) to 9 (lowest).
   *   Clamped to [0, 9]. Defaults to 5 if undefined.
   * @returns The created queue entry.
   *
   * @example
   * ```typescript
   * import { PriorityQueue } from "./priorityQueue";
   *
   * const queue = new PriorityQueue<string>();
   * const entry = queue.enqueue("urgent-task", 0);
   * entry.cancelled = true; // cancel later if needed
   * ```
   */
  enqueue(value: T, priority?: number): PriorityQueueEntry<T> {
    const entry: PriorityQueueEntry<T> = {
      priority: clampPriority(priority),
      arrivalOrder: this.counter++,
      value,
      cancelled: false,
    };

    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
    return entry;
  }

  /**
   * Removes and returns the highest-priority non-cancelled entry.
   *
   * Skips (and discards) any cancelled entries at the top of the heap.
   * Returns `undefined` if the queue is empty or all entries are cancelled.
   *
   * @returns The highest-priority non-cancelled entry, or `undefined` if none available.
   *
   * @example
   * ```typescript
   * import { PriorityQueue } from "./priorityQueue";
   *
   * const queue = new PriorityQueue<string>();
   * queue.enqueue("first", 1);
   * queue.enqueue("second", 2);
   * const entry = queue.dequeue(); // { value: "first", priority: 1, ... }
   * ```
   */
  dequeue(): PriorityQueueEntry<T> | undefined {
    while (this.heap.length > 0) {
      const top = this.heap[0]!;

      if (top.cancelled) {
        this.removeTop();
        continue;
      }

      this.removeTop();
      return top;
    }

    return undefined;
  }

  /**
   * Returns the highest-priority non-cancelled entry without removing it.
   *
   * Discards cancelled entries at the top of the heap as a side effect.
   * Returns `undefined` if the queue is empty or all entries are cancelled.
   *
   * @returns The highest-priority non-cancelled entry, or `undefined` if none available.
   *
   * @example
   * ```typescript
   * import { PriorityQueue } from "./priorityQueue";
   *
   * const queue = new PriorityQueue<string>();
   * queue.enqueue("task", 3);
   * const top = queue.peek(); // { value: "task", priority: 3, ... }
   * console.log(queue.size);  // 1 (not removed)
   * ```
   */
  peek(): PriorityQueueEntry<T> | undefined {
    while (this.heap.length > 0) {
      const top = this.heap[0]!;

      if (top.cancelled) {
        this.removeTop();
        continue;
      }

      return top;
    }

    return undefined;
  }

  /**
   * Marks all entries matching the predicate as cancelled (lazy removal).
   *
   * Cancelled entries are skipped on subsequent dequeue/peek calls.
   * This does not immediately remove entries from the heap; they are
   * discarded lazily when encountered at the top during dequeue or peek.
   *
   * @param predicate - A function that returns `true` for entries to cancel.
   * @returns The number of entries marked as cancelled.
   *
   * @example
   * ```typescript
   * import { PriorityQueue } from "./priorityQueue";
   *
   * const queue = new PriorityQueue<string>();
   * queue.enqueue("a", 1);
   * queue.enqueue("b", 2);
   * const removed = queue.remove((e) => e.value === "a"); // 1
   * ```
   */
  remove(predicate: (entry: PriorityQueueEntry<T>) => boolean): number {
    let count = 0;
    for (const entry of this.heap) {
      if (!entry.cancelled && predicate(entry)) {
        entry.cancelled = true;
        count++;
      }
    }
    return count;
  }

  // --- Binary heap operations ---

  /** Removes the top element from the heap and restores heap property. */
  private removeTop(): void {
    const last = this.heap.pop();
    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
  }

  /** Moves an element up the heap until the heap property is restored. */
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = (index - 1) >>> 1;
      const current = this.heap[index]!;
      const parent = this.heap[parentIndex]!;

      if (comparePriority(current, parent) >= 0) break;

      this.heap[index] = parent;
      this.heap[parentIndex] = current;
      index = parentIndex;
    }
  }

  /** Moves an element down the heap until the heap property is restored. */
  private sinkDown(index: number): void {
    const length = this.heap.length;

    while (true) {
      const leftIndex = 2 * index + 1;
      const rightIndex = 2 * index + 2;
      let smallest = index;

      if (leftIndex < length && comparePriority(this.heap[leftIndex]!, this.heap[smallest]!) < 0) {
        smallest = leftIndex;
      }

      if (rightIndex < length && comparePriority(this.heap[rightIndex]!, this.heap[smallest]!) < 0) {
        smallest = rightIndex;
      }

      if (smallest === index) break;

      const temp = this.heap[index]!;
      this.heap[index] = this.heap[smallest]!;
      this.heap[smallest] = temp;
      index = smallest;
    }
  }
}
