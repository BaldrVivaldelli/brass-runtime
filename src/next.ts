/**
 * Preview of the intentionally small brass-runtime v2 root surface.
 *
 * This entrypoint is additive during v1. Existing entrypoints remain the
 * compatibility contract; new application code may use this preview to give
 * feedback before it is promoted in a future major release.
 */
import { async as asyncEffect, type Async } from "./core/types/asyncEffect";
import {
  catchAll,
  fail,
  flatMap,
  interruptible,
  map,
  mapError,
  succeed,
  sync,
  uninterruptible,
  uninterruptibleMask,
} from "./core/types/effect";
import { retry, retryN, retryWithBackoff, sleep, timeout } from "./core/runtime/combinators";
import { fromPromiseAbortable } from "./core/runtime/runtime";

/** The canonical effect type proposed for the v2 root API. */
export type Effect<R, E, A> = Async<R, E, A>;

/**
 * Discoverable effect operations without exporting every combinator at the
 * package root. The underlying functions remain available from v1 entrypoints.
 */
export const Effect = Object.freeze({
  succeed,
  fail,
  sync,
  async: asyncEffect,
  map,
  flatMap,
  catchAll,
  mapError,
  interruptible,
  uninterruptible,
  uninterruptibleMask,
  sleep,
  timeout,
  retry,
  retryN,
  retryWithBackoff,
  fromPromiseAbortable,
});

export {
  Cause,
  Exit,
  formatCause,
  type CausePrettyOptions,
} from "./core/types/effect";

export {
  Runtime,
  type RuntimeDiagnosticsSnapshot,
  type RuntimeOptions,
} from "./core/runtime/runtime";
export {
  makeRuntime,
  runExit,
  runPromise,
  type MakeRuntimeOptions,
} from "./core/runtime/dx";

export type { Fiber, FiberId, FiberStatus } from "./core/runtime/fiber";
export {
  Scope,
  ScopeFinalizerError,
  withScopeAsync,
  type ScopeFinalizerFailure,
  type ScopeId,
} from "./core/runtime/scope";

export {
  Resource,
  type Resource as ResourceDescriptor,
} from "./core/runtime/resource";
export {
  Layer,
  LayerContext,
  MissingLayerServiceError,
  type Layer as LayerDescriptor,
  type ServiceTag,
} from "./core/runtime/layer";
export {
  Schedule,
  type Schedule as ScheduleDescriptor,
  type ScheduleDecision,
  type ScheduleDriver,
} from "./core/runtime/schedule";

export {
  Pipeline,
  Stream,
  type Stream as StreamDescriptor,
} from "./core/stream/dx";
