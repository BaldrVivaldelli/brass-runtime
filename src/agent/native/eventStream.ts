import type { NativeProgressEvent, NativeServiceEvent } from "./protocol";

export type NativeEventStreamStats = {
  readonly capacity: number;
  readonly size: number;
  readonly offered: number;
  readonly delivered: number;
  readonly coalescedProgress: number;
  readonly droppedProgress: number;
  readonly droppedDiagnostics: number;
  readonly droppedTerminal: number;
  readonly closed: boolean;
};

/** A single-consumer bounded async stream for extension-host progress UX. */
export class NativeServiceEventStream implements AsyncIterable<NativeServiceEvent> {
  private readonly values: NativeServiceEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<NativeServiceEvent>) => void> = [];
  private offered = 0;
  private delivered = 0;
  private coalescedProgress = 0;
  private droppedProgress = 0;
  private droppedDiagnostics = 0;
  private droppedTerminal = 0;
  private closed = false;

  constructor(readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 16 || capacity > 1_024) {
      throw new Error("native event stream capacity must be an integer between 16 and 1024");
    }
  }

  push(event: NativeServiceEvent): void {
    if (this.closed) return;
    this.offered += 1;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.delivered += 1;
      waiter({ done: false, value: event });
      return;
    }
    if (event.type === "native.progress") {
      const existing = this.findProgress(event.requestId);
      if (existing >= 0) {
        this.values[existing] = event;
        this.coalescedProgress += 1;
        return;
      }
    }
    if (this.values.length >= this.capacity) {
      const expendable = this.values.findIndex((value) => value.type !== "native.terminal");
      if (event.type !== "native.terminal" && expendable < 0) {
        if (event.type === "native.progress") this.droppedProgress += 1;
        else this.droppedDiagnostics += 1;
        return;
      }
      const removed = this.values.splice(expendable >= 0 ? expendable : 0, 1)[0];
      if (removed.type === "native.progress") this.droppedProgress += 1;
      else if (removed.type === "native.terminal") this.droppedTerminal += 1;
      else this.droppedDiagnostics += 1;
    }
    this.values.push(event);
  }

  next(): Promise<IteratorResult<NativeServiceEvent>> {
    const value = this.values.shift();
    if (value !== undefined) {
      this.delivered += 1;
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolveNext) => this.waiters.push(resolveNext));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  stats(): NativeEventStreamStats {
    return Object.freeze({
      capacity: this.capacity,
      size: this.values.length,
      offered: this.offered,
      delivered: this.delivered,
      coalescedProgress: this.coalescedProgress,
      droppedProgress: this.droppedProgress,
      droppedDiagnostics: this.droppedDiagnostics,
      droppedTerminal: this.droppedTerminal,
      closed: this.closed,
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<NativeServiceEvent> {
    return { next: () => this.next() };
  }

  private findProgress(requestId: string): number {
    for (let index = this.values.length - 1; index >= 0; index -= 1) {
      const value = this.values[index];
      if (isProgressFor(value, requestId)) return index;
    }
    return -1;
  }
}

function isProgressFor(event: NativeServiceEvent, requestId: string): event is NativeProgressEvent {
  return event.type === "native.progress" && event.requestId === requestId;
}
