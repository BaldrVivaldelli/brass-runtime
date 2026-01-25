import type { RuntimeEvent } from "./events";

export type LogLevel = "debug"|"info"|"warn"|"error";

export function consoleJsonLoggerSink() {
    return (ev: RuntimeEvent) => {
        if (ev.type !== "log") return;

        const level = (ev.data?.level as any) ?? "info";
        const msg = (ev.data?.msg as any) ?? "";

        const out = {
            level,
            msg,
            wallTs: ev.wallTs,
            fiberId: ev.fiberId,
            scopeId: ev.scopeId,
            traceId: ev.traceId,
            spanId: ev.spanId,
            ...((ev.data?.fields as any) ?? {}),
        };

        // en prod querés stdout/stderr
        if (level === "error") console.error(JSON.stringify(out));
        else console.log(JSON.stringify(out));
    };
}
