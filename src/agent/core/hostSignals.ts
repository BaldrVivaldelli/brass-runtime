// Host signal collection.
// Gathers observable signals from the process environment and produces
// an immutable, ordered list of HostSignal values for the inference pipeline.

import { deepFreeze, type HostSignal } from "./hostProfile";

export type HostSignalInput = {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly stdoutIsTTY: boolean;
    readonly stdinIsTTY: boolean;
    readonly ttyColumns: number | undefined;
    readonly parentProcessName: string | undefined;
    readonly workspaceMarkers: readonly string[];
    readonly stdinFirstLine: string | undefined;
    readonly configPaths: readonly string[];
};

/**
 * Maximum number of environment variable keys to collect (lexicographic order).
 */
const MAX_ENV_KEYS = 256;

/**
 * Collects host signals from the provided input in fixed source category order.
 *
 * Each source is collected independently with try/catch — if a source fails,
 * it is omitted from the result. Returns an empty array if all sources are
 * unavailable (never throws).
 */
export const collectHostSignals = (input: HostSignalInput): readonly HostSignal[] => {
    const signals: HostSignal[] = [];

    // Collect each source category in declaration order.
    // Each collector is wrapped in try/catch so a single failure
    // does not prevent other sources from being collected.

    // 1. argv signals
    try {
        for (const arg of input.argv) {
            signals.push({ source: "argv", value: arg });
        }
    } catch {
        // skip
    }

    // 2. env-key signals (first 256 keys by lexicographic order)
    try {
        const keys = Object.keys(input.env).sort();
        const limit = Math.min(keys.length, MAX_ENV_KEYS);
        for (let i = 0; i < limit; i++) {
            signals.push({ source: "env-key", value: keys[i] });
        }
    } catch {
        // skip
    }

    // 3. stdio signals (TTY state and columns)
    try {
        signals.push({
            source: "stdio",
            value: input.stdoutIsTTY ? "stdout:tty" : "stdout:pipe",
        });
        signals.push({
            source: "stdio",
            value: input.stdinIsTTY ? "stdin:tty" : "stdin:pipe",
        });
        if (input.ttyColumns !== undefined) {
            signals.push({ source: "stdio", value: `columns:${input.ttyColumns}` });
        }
    } catch {
        // skip
    }

    // 4. parent-process signal
    try {
        if (input.parentProcessName !== undefined) {
            signals.push({ source: "parent-process", value: input.parentProcessName });
        }
    } catch {
        // skip
    }

    // 5. workspace-marker signals
    try {
        for (const marker of input.workspaceMarkers) {
            signals.push({ source: "workspace-marker", value: marker });
        }
    } catch {
        // skip
    }

    // 6. protocol-handshake signal (only if stdin is not TTY)
    try {
        if (input.stdinFirstLine !== undefined && !input.stdinIsTTY) {
            signals.push({ source: "protocol-handshake", value: input.stdinFirstLine });
        }
    } catch {
        // skip
    }

    // 7. config signals
    try {
        for (const configPath of input.configPaths) {
            signals.push({ source: "config", value: configPath });
        }
    } catch {
        // skip
    }

    return deepFreeze(signals) as readonly HostSignal[];
};
