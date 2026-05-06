import type { Async } from "../../types/asyncEffect";
import { RuntimeFiber } from "../fiber";
import type { FiberEngine, FiberEngineStats, WasmEngineRuntime } from "./types";

export class JsFiberEngine<R> implements FiberEngine<R> {
  readonly kind = "ts" as const;
  private startedFibers = 0;

  constructor(private readonly runtime: WasmEngineRuntime<R> & any) {}

  fork<E, A>(effect: Async<R, E, A>, scopeId?: number): RuntimeFiber<R, E, A> {
    this.startedFibers += 1;
    const fiber = new RuntimeFiber(this.runtime, effect) as RuntimeFiber<R, E, A> & { scopeId?: number };
    if (scopeId !== undefined) fiber.scopeId = scopeId;
    return fiber as RuntimeFiber<R, E, A>;
  }

  stats(): FiberEngineStats {
    return {
      engine: this.kind,
      startedFibers: this.startedFibers,
      runningFibers: 0,
      suspendedFibers: 0,
      queuedFibers: 0,
      completedFibers: 0,
      failedFibers: 0,
      interruptedFibers: 0,
      pendingHostEffects: 0,
    };
  }
}
