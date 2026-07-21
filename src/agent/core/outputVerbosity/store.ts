import type { OutputPreferences, VerbosityLevel } from "./types";
import type { AgentPersistence } from "../types";
import { emptyOutputPreferences, MAX_RUN_HISTORY_ENTRIES } from "./types";

const DEFAULT_STORE_PATH = ".brass/output-prefs.json";

export type PreferencesStoreOptions = {
    /** Path to the preferences file. Defaults to "${cwd}/.brass/output-prefs.json". */
    readonly path?: string;
    /** Filesystem abstraction for testing. */
    readonly fs?: {
        readonly readFile: (path: string) => Promise<string>;
        readonly writeFile: (path: string, content: string) => Promise<void>;
        readonly mkdir: (path: string) => Promise<void>;
    };
    /** Preferred host-owned versioned persistence boundary. */
    readonly persistence?: AgentPersistence;
};

export type PreferencesStore = {
    /** Loads preferences from disk. Returns empty preferences on any failure. */
    readonly load: () => Promise<OutputPreferences>;
    /** Persists preferences to disk. Silently swallows write failures. */
    readonly save: (prefs: OutputPreferences) => Promise<void>;
    /** Appends a run duration and trims to max entries. Returns updated prefs. Pure. */
    readonly recordRunDuration: (durationMs: number, current: OutputPreferences) => OutputPreferences;
    /** Sets or clears the user override. Returns updated prefs. Pure. */
    readonly setUserOverride: (level: VerbosityLevel | undefined, current: OutputPreferences) => OutputPreferences;
};

/**
 * Creates a PreferencesStore for reading/writing OutputPreferences.
 * All I/O failures are handled gracefully — never throws, never emits errors.
 */
export const makePreferencesStore = (options?: PreferencesStoreOptions): PreferencesStore => {
    const filePath = options?.path ?? DEFAULT_STORE_PATH;
    const fsRead = options?.persistence
        ? async () => options.persistence!.read("workspace", "agent.output-preferences.v1").then((value) => value ?? "")
        : options?.fs?.readFile ?? (async () => { throw new Error("No AgentHost persistence adapter configured"); });
    const fsWrite = options?.persistence
        ? async (_path: string, content: string) => options.persistence!.write(
            "workspace",
            "agent.output-preferences.v1",
            content,
            { maxBytes: 65_536 },
        )
        : options?.fs?.writeFile ?? (async () => { throw new Error("No AgentHost persistence adapter configured"); });
    const fsMkdir = options?.fs?.mkdir ?? (async () => undefined);
    const parentPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".";

    const load = async (): Promise<OutputPreferences> => {
        try {
            const raw = await fsRead(filePath);
            const data: unknown = JSON.parse(raw);

            if (
                typeof data !== "object" ||
                data === null ||
                !("version" in data) ||
                (data as Record<string, unknown>).version !== 1
            ) {
                return emptyOutputPreferences();
            }

            const stored = data as Record<string, unknown>;

            const runHistory = Array.isArray(stored.runHistory) ? stored.runHistory : [];
            const userOverride =
                stored.userOverride === "minimal" ||
                stored.userOverride === "normal" ||
                stored.userOverride === "verbose"
                    ? stored.userOverride
                    : undefined;

            return {
                version: 1,
                runHistory,
                userOverride,
            };
        } catch {
            return emptyOutputPreferences();
        }
    };

    const save = async (prefs: OutputPreferences): Promise<void> => {
        try {
            await fsMkdir(parentPath);
            await fsWrite(filePath, JSON.stringify(prefs, null, 2));
        } catch {
            // Silently swallow write errors
        }
    };

    const recordRunDuration = (durationMs: number, current: OutputPreferences): OutputPreferences => {
        const updated = [...current.runHistory, durationMs];
        const trimmed = updated.length > MAX_RUN_HISTORY_ENTRIES
            ? updated.slice(updated.length - MAX_RUN_HISTORY_ENTRIES)
            : updated;

        return {
            ...current,
            runHistory: trimmed,
        };
    };

    const setUserOverride = (level: VerbosityLevel | undefined, current: OutputPreferences): OutputPreferences => ({
        ...current,
        userOverride: level,
    });

    return { load, save, recordRunDuration, setUserOverride };
};
