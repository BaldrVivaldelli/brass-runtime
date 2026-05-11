import type { Async } from "../types/asyncEffect";
import { async } from "../types/asyncEffect";
import { Cause, type Exit } from "../types/effect";
import type { Fiber } from "./fiber";
import type { Runtime } from "./runtime";
import { makeScheduleDriver, type Schedule, type ScheduleDriver } from "./schedule";
import { liveClock, type RuntimeClock } from "./clock";

export type SupervisorStrategy = "one-for-one" | "all-for-one";
export type SupervisorEscalation = "ignore" | "shutdown";
export type SupervisorRestartMode = "never" | "always" | "on-failure";
export type SupervisedChildStatus = "running" | "restarting" | "succeeded" | "failed" | "interrupted";

export type SupervisorRestartContext = {
  readonly supervisorId: number;
  readonly childId: number;
  readonly name?: string;
  readonly restartCount: number;
  readonly exit: Exit<any, any>;
};

export type SupervisorRestartPolicy =
  | SupervisorRestartMode
  | {
      readonly mode?: SupervisorRestartMode;
      readonly maxRestarts?: number;
      readonly withinMs?: number;
      readonly delayMs?: number | ((context: SupervisorRestartContext) => number);
      readonly schedule?: Schedule<SupervisorRestartContext, unknown>;
    };

export type SupervisorEvent = {
  readonly type:
    | "child-start"
    | "child-end"
    | "child-restart"
    | "child-escalate"
    | "shutdown";
  readonly supervisorId: number;
  readonly childId?: number;
  readonly name?: string;
  readonly status?: SupervisedChildStatus;
  readonly restartCount?: number;
  readonly delayMs?: number;
  readonly exit?: Exit<any, any>;
  readonly reason?: string;
};

export type SupervisorConfig = {
  readonly strategy?: SupervisorStrategy;
  readonly restart?: SupervisorRestartPolicy;
  readonly escalation?: SupervisorEscalation;
  readonly clock?: () => number;
  readonly onEvent?: (event: SupervisorEvent) => void;
};

export type SupervisedChildSpec<R, E, A> = {
  readonly name?: string;
  readonly effect: Async<R, E, A> | (() => Async<R, E, A>);
  readonly restart?: SupervisorRestartPolicy;
};

export type SupervisedFiber<E, A> = {
  readonly id: number;
  readonly name?: string;
  readonly current: () => Fiber<E, A> | undefined;
  readonly status: () => SupervisedChildStatus;
  readonly restartCount: () => number;
  readonly interrupt: () => void;
  readonly join: (cb: (exit: Exit<E, A>) => void) => void;
};

type ChildRecord<R, E = any, A = any> = {
  readonly id: number;
  readonly name?: string;
  readonly spec: SupervisedChildSpec<R, E, A>;
  readonly restart: ResolvedRestartPolicy;
  current?: Fiber<E, A>;
  status: SupervisedChildStatus;
  restartCount: number;
  restartTimes: number[];
  scheduleDriver?: ScheduleDriver<SupervisorRestartContext, unknown>;
  generation: number;
  plannedRestart: boolean;
  terminalExit?: Exit<E, A>;
  timer?: ReturnType<typeof setTimeout>;
  joiners: Array<(exit: Exit<E, A>) => void>;
};

type ResolvedRestartPolicy = {
  readonly mode: SupervisorRestartMode;
  readonly maxRestarts?: number;
  readonly withinMs?: number;
  readonly delayMs?: number | ((context: SupervisorRestartContext) => number);
  readonly schedule?: Schedule<SupervisorRestartContext, unknown>;
};

let nextSupervisorId = 1;
let nextChildId = 1;

export class Supervisor<R> {
  readonly id = nextSupervisorId++;
  private readonly records = new Map<number, ChildRecord<R>>();
  private readonly strategy: SupervisorStrategy;
  private readonly restart: ResolvedRestartPolicy;
  private readonly escalation: SupervisorEscalation;
  private readonly clock: () => number;
  private readonly onEvent?: (event: SupervisorEvent) => void;
  private closed = false;

  constructor(
    private readonly runtime: Runtime<R>,
    config: SupervisorConfig = {},
  ) {
    this.strategy = config.strategy ?? "one-for-one";
    this.restart = resolveRestartPolicy(config.restart ?? "on-failure");
    this.escalation = config.escalation ?? "shutdown";
    this.clock = config.clock ?? Date.now;
    this.onEvent = config.onEvent;
  }

  start<E, A>(spec: SupervisedChildSpec<R, E, A>): SupervisedFiber<E, A> {
    if (this.closed) throw new Error("Supervisor is shut down");

    const record: ChildRecord<R, E, A> = {
      id: nextChildId++,
      name: spec.name,
      spec,
      restart: resolveRestartPolicy(spec.restart ?? this.restart),
      status: "running",
      restartCount: 0,
      restartTimes: [],
      generation: 0,
      plannedRestart: false,
      joiners: [],
    };

    this.records.set(record.id, record as ChildRecord<R>);
    this.launch(record);
    return this.handle(record);
  }

  startAll<const Specs extends readonly SupervisedChildSpec<R, any, any>[]>(
    specs: Specs,
  ): { [K in keyof Specs]: Specs[K] extends SupervisedChildSpec<R, infer E, infer A> ? SupervisedFiber<E, A> : never } {
    return specs.map((spec) => this.start(spec)) as any;
  }

  shutdown(): Async<R, never, void> {
    return async((_env, cb) => {
      this.closed = true;
      this.emit({ type: "shutdown", supervisorId: this.id });

      const records = [...this.records.values()];
      let remaining = records.filter((record) => record.current !== undefined).length;

      for (const record of records) {
        if (record.timer) {
          clearTimeout(record.timer);
          record.timer = undefined;
        }
        record.plannedRestart = false;
        if (record.current) {
          record.status = "interrupted";
          record.current.interrupt();
        } else if (!record.terminalExit) {
          this.finish(record, interruptExit());
        }
      }

      if (remaining === 0) {
        cb({ _tag: "Success", value: undefined });
        return;
      }

      for (const record of records) {
        record.current?.join(() => {
          remaining--;
          if (remaining === 0) cb({ _tag: "Success", value: undefined });
        });
      }
    });
  }

  private handle<E, A>(record: ChildRecord<R, E, A>): SupervisedFiber<E, A> {
    return {
      id: record.id,
      name: record.name,
      current: () => record.current,
      status: () => record.status,
      restartCount: () => record.restartCount,
      interrupt: () => {
        record.plannedRestart = false;
        if (record.timer) {
          clearTimeout(record.timer);
          record.timer = undefined;
        }
        if (record.current) {
          record.current.interrupt();
        } else if (!record.terminalExit) {
          this.finish(record, interruptExit());
        }
      },
      join: (cb) => {
        if (record.terminalExit) cb(record.terminalExit);
        else record.joiners.push(cb);
      },
    };
  }

  private launch<E, A>(record: ChildRecord<R, E, A>): void {
    if (this.closed) return;

    record.generation++;
    record.status = "running";
    record.plannedRestart = false;
    record.terminalExit = undefined;
    const generation = record.generation;
    const effect = typeof record.spec.effect === "function"
      ? (record.spec.effect as () => Async<R, E, A>)()
      : record.spec.effect;

    const fiber = this.runtime.fork(effect);
    record.current = fiber;
    this.emit({
      type: "child-start",
      supervisorId: this.id,
      childId: record.id,
      name: record.name,
      status: "running",
      restartCount: record.restartCount,
    });

    fiber.join((exit) => this.onChildExit(record, generation, exit));
  }

  private onChildExit<E, A>(
    record: ChildRecord<R, E, A>,
    generation: number,
    exit: Exit<E, A>,
  ): void {
    if (generation !== record.generation) return;
    record.current = undefined;

    if (this.closed) {
      this.finish(record, exit);
      return;
    }

    if (record.plannedRestart) {
      this.scheduleRestart(record, exit, "all-for-one");
      return;
    }

    this.emit({
      type: "child-end",
      supervisorId: this.id,
      childId: record.id,
      name: record.name,
      status: statusFromExit(exit),
      restartCount: record.restartCount,
      exit,
    });

    if (!shouldRestart(record.restart.mode, exit)) {
      this.finish(record, exit);
      return;
    }

    if (this.strategy === "all-for-one") {
      this.restartAll(record, exit);
      return;
    }

    this.scheduleRestart(record, exit, "one-for-one");
  }

  private restartAll<E, A>(failed: ChildRecord<R, E, A>, exit: Exit<E, A>): void {
    for (const record of this.records.values()) {
      if (record.id === failed.id) continue;
      if (!record.current) continue;
      record.plannedRestart = true;
      record.status = "restarting";
      record.current.interrupt();
    }
    this.scheduleRestart(failed, exit, "all-for-one");
  }

  private scheduleRestart<E, A>(
    record: ChildRecord<R, E, A>,
    exit: Exit<E, A>,
    reason: string,
  ): void {
    const context = this.restartContext(record, exit);
    const delay = this.nextDelay(record, context);
    if (delay === undefined) {
      this.escalate(record, exit, "restart policy exhausted");
      return;
    }

    record.status = "restarting";
    record.restartCount++;
    this.emit({
      type: "child-restart",
      supervisorId: this.id,
      childId: record.id,
      name: record.name,
      status: "restarting",
      restartCount: record.restartCount,
      delayMs: delay,
      exit,
      reason,
    });

    record.timer = setTimeout(() => {
      record.timer = undefined;
      this.launch(record);
    }, delay);
  }

  private nextDelay(record: ChildRecord<R>, context: SupervisorRestartContext): number | undefined {
    const now = this.clock();
    const windowStart = record.restart.withinMs === undefined
      ? Number.NEGATIVE_INFINITY
      : now - record.restart.withinMs;
    record.restartTimes = record.restartTimes.filter((ts) => ts >= windowStart);
    if (record.restart.maxRestarts !== undefined && record.restartTimes.length >= record.restart.maxRestarts) {
      return undefined;
    }
    record.restartTimes.push(now);

    if (record.restart.schedule) {
      record.scheduleDriver ??= makeScheduleDriver(record.restart.schedule, {
        name: record.restart.schedule.name ?? "supervisor.restart",
        clock: this.scheduleClock(),
      });
      const decision = record.scheduleDriver.next(context);
      return decision.continue ? Math.max(0, Math.floor(decision.delayMs)) : undefined;
    }

    const raw = typeof record.restart.delayMs === "function"
      ? record.restart.delayMs(context)
      : record.restart.delayMs ?? 0;
    return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  }

  private escalate<E, A>(record: ChildRecord<R, E, A>, exit: Exit<E, A>, reason: string): void {
    this.emit({
      type: "child-escalate",
      supervisorId: this.id,
      childId: record.id,
      name: record.name,
      status: statusFromExit(exit),
      restartCount: record.restartCount,
      exit,
      reason,
    });

    if (this.escalation === "shutdown") {
      for (const child of this.records.values()) {
        if (child.id !== record.id) child.current?.interrupt();
      }
    }
    this.finish(record, exit);
  }

  private finish<E, A>(record: ChildRecord<R, E, A>, exit: Exit<E, A>): void {
    record.status = statusFromExit(exit);
    record.terminalExit = exit;
    const joiners = record.joiners.splice(0);
    for (const joiner of joiners) joiner(exit);
  }

  private restartContext(record: ChildRecord<R>, exit: Exit<any, any>): SupervisorRestartContext {
    return {
      supervisorId: this.id,
      childId: record.id,
      name: record.name,
      restartCount: record.restartCount,
      exit,
    };
  }

  private emit(event: SupervisorEvent): void {
    this.onEvent?.(event);
    this.runtime.emit(toRuntimeEvent(event));
  }

  private scheduleClock(): RuntimeClock {
    return {
      now: this.clock,
      setTimeout: liveClock.setTimeout,
      clearTimeout: liveClock.clearTimeout,
    };
  }
}

export function makeSupervisor<R>(runtime: Runtime<R>, config: SupervisorConfig = {}): Supervisor<R> {
  return new Supervisor(runtime, config);
}

export function supervise<R, E, A>(
  runtime: Runtime<R>,
  spec: SupervisedChildSpec<R, E, A>,
  config: SupervisorConfig = {},
): SupervisedFiber<E, A> {
  return new Supervisor(runtime, config).start(spec);
}

export function joinSupervised<E, A>(fiber: SupervisedFiber<E, A>): Async<unknown, E, A> {
  return async((_env, cb) => fiber.join(cb));
}

function resolveRestartPolicy(policy: SupervisorRestartPolicy): ResolvedRestartPolicy {
  if (typeof policy === "string") return { mode: policy };
  return {
    mode: policy.mode ?? "on-failure",
    maxRestarts: policy.maxRestarts,
    withinMs: policy.withinMs,
    delayMs: policy.delayMs,
    schedule: policy.schedule,
  };
}

function shouldRestart(mode: SupervisorRestartMode, exit: Exit<any, any>): boolean {
  if (exit._tag === "Failure" && Cause.isInterruptedOnly(exit.cause)) return false;
  if (mode === "never") return false;
  if (mode === "always") return true;
  return exit._tag === "Failure";
}

function statusFromExit(exit: Exit<any, any>): SupervisedChildStatus {
  if (exit._tag === "Success") return "succeeded";
  return Cause.isInterruptedOnly(exit.cause) ? "interrupted" : "failed";
}

function toRuntimeEvent(event: SupervisorEvent) {
  switch (event.type) {
    case "child-start":
      return {
        type: "supervisor.child.start" as const,
        supervisorId: event.supervisorId,
        childId: event.childId!,
        name: event.name,
        restartCount: event.restartCount ?? 0,
      };
    case "child-end":
      return {
        type: "supervisor.child.end" as const,
        supervisorId: event.supervisorId,
        childId: event.childId!,
        name: event.name,
        status: event.status === "succeeded" ? "success" as const : event.status === "interrupted" ? "interrupted" as const : "failure" as const,
        error: event.exit?._tag === "Failure" ? event.exit.cause : undefined,
      };
    case "child-restart":
      return {
        type: "supervisor.child.restart" as const,
        supervisorId: event.supervisorId,
        childId: event.childId!,
        name: event.name,
        restartCount: event.restartCount ?? 0,
        delayMs: event.delayMs ?? 0,
        reason: event.reason,
      };
    case "child-escalate":
      return {
        type: "supervisor.child.escalate" as const,
        supervisorId: event.supervisorId,
        childId: event.childId!,
        name: event.name,
        reason: event.reason,
        error: event.exit?._tag === "Failure" ? event.exit.cause : undefined,
      };
    case "shutdown":
      return {
        type: "supervisor.shutdown" as const,
        supervisorId: event.supervisorId,
      };
  }
}

function interruptExit<E, A>(): Exit<E, A> {
  return { _tag: "Failure", cause: { _tag: "Interrupt" } };
}
