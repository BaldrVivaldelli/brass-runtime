
import type { RuntimeEvent, RuntimeEmitContext, RuntimeHooks } from "./events";

export type LogLevel = "debug"|"info"|"warn"|"error";

export function consoleJsonLogger(): RuntimeHooks {
  return {
    emit(ev: RuntimeEvent, ctx: RuntimeEmitContext) {
      if (ev.type !== "log") return;

      const wallTs = Date.now();

      const out = {
        level: ev.level,
        msg: ev.message,
        wallTs,
        fiberId: ctx.fiberId,
        scopeId: ctx.scopeId,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        ...(ev.fields ?? {}),
      };

      if (ev.level === "error") console.error(JSON.stringify(out));
      else console.log(JSON.stringify(out));
    },
  };
}
