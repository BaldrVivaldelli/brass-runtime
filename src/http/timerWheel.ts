import { performance } from "perf_hooks";

export interface TimerWheelConfig {
  /** Tick resolution in ms. Default: 10. Range: [1, 16]. Values outside are clamped. */
  readonly tickMs?: number;
  /** Number of wheel slots. Default: 512. Must be power of 2. */
  readonly slots?: number;
  /** Fine tick resolution in ms for short deadlines. Default: 4. Range: [1, 16]. */
  readonly fineTickMs?: number;
  /** Deadline threshold in ms: entries with deadline ≤ this use fine tick. Default: 50. */
  readonly fineThresholdMs?: number;
}

export interface TimerHandle {
  cancel(): void;
}

interface TimerEntry {
  /** Callback to invoke on expiry */
  cb: () => void;
  /** Absolute deadline (performance.now() + timeoutMs) */
  deadline: number;
  /** Slot index for O(1) removal */
  slot: number;
  /** Linked list pointers */
  prev: TimerEntry | null;
  next: TimerEntry | null;
  /** Cancelled flag — checked before invoking cb */
  cancelled: boolean;
  /** True if scheduled on fine-resolution path */
  fine: boolean;
}

export class TimerWheel {
  private readonly tickMs: number;
  private readonly mask: number;
  private readonly wheel: (TimerEntry | null)[];
  private currentTick: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: number;

  // Fine-tick scheduling state
  private readonly fineTickMs: number;
  private readonly fineThresholdMs: number;
  private fineHead: TimerEntry | null;
  private fineTimer: ReturnType<typeof setTimeout> | undefined;
  private finePending: number;

  constructor(config?: TimerWheelConfig) {
    const tickMs = config?.tickMs ?? 10;
    this.tickMs = Math.max(1, Math.min(16, Math.floor(tickMs)));

    const fineTickMs = config?.fineTickMs ?? 4;
    this.fineTickMs = Math.max(1, Math.min(16, Math.floor(fineTickMs)));
    this.fineThresholdMs = config?.fineThresholdMs ?? 50;
    this.fineHead = null;
    this.fineTimer = undefined;
    this.finePending = 0;

    let slots = config?.slots ?? 512;
    // Ensure power of 2
    if (slots < 1 || (slots & (slots - 1)) !== 0) {
      // Round up to next power of 2
      slots = 1;
      const target = config?.slots ?? 512;
      while (slots < target) slots <<= 1;
    }

    this.mask = slots - 1;
    this.wheel = new Array<TimerEntry | null>(slots).fill(null);
    this.currentTick = 0;
    this.timer = undefined;
    this.pending = 0;
  }

  /**
   * Schedule a timeout. Returns a cancel handle. O(1).
   * @param timeoutMs - Timeout duration in milliseconds.
   * @param cb - Callback to invoke on expiry.
   * @param now - Optional pre-captured `performance.now()` value to avoid an extra call.
   */
  schedule(timeoutMs: number, cb: () => void, now?: number): TimerHandle {
    if (timeoutMs <= this.fineThresholdMs) {
      return this.scheduleFine(timeoutMs, cb, now);
    }
    return this.scheduleNormal(timeoutMs, cb, now);
  }

  /** Schedule on the normal (coarse) wheel path. */
  private scheduleNormal(timeoutMs: number, cb: () => void, now?: number): TimerHandle {
    const deadline = (now ?? performance.now()) + timeoutMs;
    const ticks = Math.max(1, Math.ceil(timeoutMs / this.tickMs));
    const slot = (this.currentTick + ticks) & this.mask;

    const entry: TimerEntry = {
      cb,
      deadline,
      slot,
      prev: null,
      next: null,
      cancelled: false,
      fine: false,
    };

    // Insert at head of slot's linked list
    const head = this.wheel[slot];
    if (head !== null) {
      head.prev = entry;
      entry.next = head;
    }
    this.wheel[slot] = entry;

    this.pending++;
    this.ensureTimer();

    const handle: TimerHandle = {
      cancel: () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        this.unlink(entry);
        this.pending--;
        this.maybeStopTimer();
      },
    };

    return handle;
  }

  /** Schedule on the fine-resolution path for short deadlines. */
  private scheduleFine(timeoutMs: number, cb: () => void, now?: number): TimerHandle {
    const deadline = (now ?? performance.now()) + timeoutMs;

    const entry: TimerEntry = {
      cb,
      deadline,
      slot: -1, // Not used for fine entries
      prev: null,
      next: null,
      cancelled: false,
      fine: true,
    };

    // Insert at head of fine linked list
    if (this.fineHead !== null) {
      this.fineHead.prev = entry;
      entry.next = this.fineHead;
    }
    this.fineHead = entry;

    this.finePending++;
    this.ensureFineTimer();

    const handle: TimerHandle = {
      cancel: () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        this.unlinkFine(entry);
        this.finePending--;
        this.maybeStopFineTimer();
      },
    };

    return handle;
  }

  /** Advance the wheel, expiring due entries. Called by internal setTimeout. */
  private tick(): void {
    this.timer = undefined;
    this.currentTick = (this.currentTick + 1) & this.mask;

    const now = performance.now();
    let entry = this.wheel[this.currentTick];

    while (entry !== null) {
      const next = entry.next;
      if (entry.deadline <= now) {
        if (!entry.cancelled) {
          entry.cancelled = true;
          this.unlink(entry);
          this.pending--;
          entry.cb();
        } else {
          this.unlink(entry);
        }
      }
      entry = next;
    }

    if (this.pending > 0) {
      this.timer = setTimeout(() => this.tick(), this.tickMs);
    }
  }

  /** Tick the fine-resolution linked list, expiring due entries. */
  private fineTick(): void {
    this.fineTimer = undefined;

    const now = performance.now();
    let entry = this.fineHead;

    while (entry !== null) {
      const next = entry.next;
      if (entry.deadline <= now) {
        if (!entry.cancelled) {
          entry.cancelled = true;
          this.unlinkFine(entry);
          this.finePending--;
          entry.cb();
        } else {
          this.unlinkFine(entry);
        }
      }
      entry = next;
    }

    if (this.finePending > 0) {
      this.fineTimer = setTimeout(() => this.fineTick(), this.fineTickMs);
    }
  }

  /** Start the background timer if not running. */
  private ensureTimer(): void {
    if (this.timer === undefined && this.pending > 0) {
      this.timer = setTimeout(() => this.tick(), this.tickMs);
    }
  }

  /** Start the fine-tick timer if not running. */
  private ensureFineTimer(): void {
    if (this.fineTimer === undefined && this.finePending > 0) {
      this.fineTimer = setTimeout(() => this.fineTick(), this.fineTickMs);
    }
  }

  /** Stop the background timer if no entries pending. */
  private maybeStopTimer(): void {
    if (this.pending === 0 && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Stop the fine-tick timer if no fine entries pending. */
  private maybeStopFineTimer(): void {
    if (this.finePending === 0 && this.fineTimer !== undefined) {
      clearTimeout(this.fineTimer);
      this.fineTimer = undefined;
    }
  }

  /** Cancel all pending entries and stop. */
  destroy(): void {
    // Destroy normal wheel entries
    for (let i = 0; i < this.wheel.length; i++) {
      let entry = this.wheel[i];
      while (entry !== null) {
        const next = entry.next;
        entry.cancelled = true;
        entry.prev = null;
        entry.next = null;
        entry.cb = undefined as unknown as () => void;
        entry = next;
      }
      this.wheel[i] = null;
    }
    this.pending = 0;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // Destroy fine-tick entries
    let fineEntry = this.fineHead;
    while (fineEntry !== null) {
      const next = fineEntry.next;
      fineEntry.cancelled = true;
      fineEntry.prev = null;
      fineEntry.next = null;
      fineEntry.cb = undefined as unknown as () => void;
      fineEntry = next;
    }
    this.fineHead = null;
    this.finePending = 0;
    if (this.fineTimer !== undefined) {
      clearTimeout(this.fineTimer);
      this.fineTimer = undefined;
    }
  }

  /** Unlink an entry from its slot's doubly-linked list. O(1). */
  private unlink(entry: TimerEntry): void {
    const { prev, next, slot } = entry;
    if (prev !== null) {
      prev.next = next;
    } else {
      // Entry is head of its slot
      this.wheel[slot] = next;
    }
    if (next !== null) {
      next.prev = prev;
    }
    entry.prev = null;
    entry.next = null;
  }

  /** Unlink an entry from the fine-tick linked list. O(1). */
  private unlinkFine(entry: TimerEntry): void {
    const { prev, next } = entry;
    if (prev !== null) {
      prev.next = next;
    } else {
      // Entry is head of fine list
      this.fineHead = next;
    }
    if (next !== null) {
      next.prev = prev;
    }
    entry.prev = null;
    entry.next = null;
  }
}
