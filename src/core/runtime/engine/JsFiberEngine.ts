import type { Async } from "../../types/asyncEffect";
import { RuntimeFiber } from "../fiber";
import type { FiberEngine, FiberEngineStats, WasmEngineRuntime } from "./types";
import { Cause } from "../../types/effect";

export class JsFiberEngine<R> implements FiberEngine<R> {
  readonly kind = "ts" as const;
  private startedFibers = 0;
  private readonly liveFibers = new Set<RuntimeFiber<any, any, any>>();
  private completedFibers = 0;
  private failedFibers = 0;
  private interruptedFibers = 0;

  constructor(private readonly runtime: WasmEngineRuntime<R> & any) {}

  fork<E, A>(effect: Async<R, E, A>, scopeId?: number): RuntimeFiber<R, E, A> {
    this.startedFibers += 1;
    const fiber = new RuntimeFiber(this.runtime, effect) as RuntimeFiber<R, E, A> & { scopeId?: number };
    this.liveFibers.add(fiber);
    fiber.join((exit) => {
      this.liveFibers.delete(fiber);
      if (exit._tag === "Success") this.completedFibers += 1;
      else if (Cause.isInterruptedOnly(exit.cause)) this.interruptedFibers += 1;
      else this.failedFibers += 1;
    });
    if (scopeId !== undefined) fiber.scopeId = scopeId;
    return fiber as RuntimeFiber<R, E, A>;
  }

  stats(): FiberEngineStats {
    let runningFibers = 0;
    let suspendedFibers = 0;
    let queuedFibers = 0;
    for (const fiber of this.liveFibers) {
      switch (fiber.diagnosticRunState()) {
        case "running": runningFibers += 1; break;
        case "suspended": suspendedFibers += 1; break;
        case "queued": queuedFibers += 1; break;
        case "done": break;
      }
    }
    return {
      engine: this.kind,
      startedFibers: this.startedFibers,
      runningFibers,
      suspendedFibers,
      queuedFibers,
      completedFibers: this.completedFibers,
      failedFibers: this.failedFibers,
      interruptedFibers: this.interruptedFibers,
      pendingHostEffects: 0,
    };
  }
}
