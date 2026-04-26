import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type AgentWorkspaceDiscoveryResult = {
    readonly inputCwd: string;
    readonly cwd: string;
    readonly marker?: string;
    readonly markerPath?: string;
    readonly changed: boolean;
    readonly disabled?: boolean;
};

type WorkspaceMarker = {
    readonly name: string;
    readonly kind: "file" | "directory";
};

const WORKSPACE_MARKERS: readonly WorkspaceMarker[] = [
    { name: ".brass-agent.json", kind: "file" },
    { name: "brass-agent.config.json", kind: "file" },
    { name: "package.json", kind: "file" },
    { name: "pnpm-workspace.yaml", kind: "file" },
    { name: "turbo.json", kind: "file" },
    { name: "nx.json", kind: "file" },
    { name: ".git", kind: "directory" },
];

const markerExists = (path: string, kind: WorkspaceMarker["kind"]): boolean => {
    try {
        const stat = statSync(path);
        return kind === "directory" ? stat.isDirectory() : stat.isFile();
    } catch {
        return false;
    }
};

const firstMarkerIn = (cwd: string): { readonly marker: string; readonly markerPath: string } | undefined => {
    for (const marker of WORKSPACE_MARKERS) {
        const markerPath = join(cwd, marker.name);
        if (markerExists(markerPath, marker.kind)) {
            return { marker: marker.name, markerPath };
        }
    }

    return undefined;
};

export const discoverNodeWorkspaceRoot = (
    cwd: string,
    options: { readonly enabled?: boolean } = {}
): AgentWorkspaceDiscoveryResult => {
    const inputCwd = resolve(cwd);

    if (options.enabled === false) {
        return {
            inputCwd,
            cwd: inputCwd,
            changed: false,
            disabled: true,
        };
    }

    if (!existsSync(inputCwd)) {
        return {
            inputCwd,
            cwd: inputCwd,
            changed: false,
        };
    }

    let current = inputCwd;

    while (true) {
        const match = firstMarkerIn(current);
        if (match) {
            return {
                inputCwd,
                cwd: current,
                marker: match.marker,
                markerPath: match.markerPath,
                changed: current !== inputCwd,
            };
        }

        const parent = dirname(current);
        if (parent === current) {
            return {
                inputCwd,
                cwd: inputCwd,
                changed: false,
            };
        }

        current = parent;
    }
};
