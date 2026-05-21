import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { OutputPreferences, VerbosityLevel } from "./types";
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
    const filePath = options?.path ?? join(process.cwd(), DEFAULT_STORE_PATH);
    const fsRead = options?.fs?.readFile ?? ((p: string) => readFile(p, "utf-8"));
    const fsWrite = options?.fs?.writeFile ?? ((p: string, c: string) => writeFile(p, c, "utf-8"));
    const fsMkdir = options?.fs?.mkdir ?? ((p: string) => mkdir(p, { recursive: true }).then(() => {}));

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
            await fsMkdir(dirname(filePath));
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
