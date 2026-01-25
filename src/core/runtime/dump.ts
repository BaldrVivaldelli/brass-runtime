import { RuntimeRegistry } from "./registry";

export function dumpAllFibers(reg: RuntimeRegistry): string {
    const fibers = Array.from(reg.fibers.values());
    fibers.sort((a,b) => (a.runState === b.runState ? b.lastActiveAt - a.lastActiveAt : a.runState.localeCompare(b.runState)));

    const lines: string[] = [];
    lines.push(`=== Fiber Dump (${new Date().toISOString()}) ===`);
    for (const f of fibers) {
        lines.push(
            `fiber#${f.fiberId} ${f.name ?? ""} run=${f.runState} status=${f.status}` +
            ` scope=${f.scopeId ?? "-"} trace=${f.traceId ?? "-"} span=${f.spanId ?? "-"} last=${new Date(f.lastActiveAt).toISOString()}`
        );
        if (f.awaiting) lines.push(`  awaiting: ${f.awaiting.reason}${f.awaiting.detail ? ` (${f.awaiting.detail})` : ""}`);
        if (f.lastEnd?.error) lines.push(`  end.error: ${f.lastEnd.error}`);
    }

    lines.push(`=== Recent Events ===`);
    for (const ev of reg.getRecentEvents().slice(-80)) {
        lines.push(`${ev.seq} ${new Date(ev.wallTs).toISOString()} ${ev.type} fiber=${ev.fiberId ?? "-"} scope=${ev.scopeId ?? "-"} trace=${ev.traceId ?? "-"}`);
    }
    return lines.join("\n");
}
