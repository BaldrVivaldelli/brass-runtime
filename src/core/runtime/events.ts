import {JSONValue} from "./contex";

export type RuntimeEvent =
    | { type: "fiber.start"; fiberId: number; parentFiberId?: number; scopeId?: number; name?: string }
    | { type: "fiber.end"; fiberId: number; status: "success"|"failure"|"interrupted"; error?: unknown }
    | { type: "scope.open"; scopeId: number; parentScopeId?: number }
    | { type: "scope.close"; scopeId: number; status: "success"|"failure"|"interrupted"; error?: unknown }
    | { type: "log"; level: "debug"|"info"|"warn"|"error"; message: string; fields?: Record<string, unknown> };

export interface RuntimeHooks {
    emit(ev: RuntimeEvent, ctx: RuntimeEmitContext): void;
}

export type RuntimeEmitContext = {
    fiberId?: number;
    scopeId?: number;
    traceId?: string;
    spanId?: string;
};