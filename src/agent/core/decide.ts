import { asyncSucceed, type Async } from "../../core/types/asyncEffect";
import {
    describeContextDiscovery,
    nextContextDiscoveryAction,
} from "./contextDiscovery";
import {
    describeCommandDiscovery,
    discoverValidationCommands,
    nextProjectProbeAction,
    nextUnrunValidationCommand,
} from "./projectCommands";
import {
    canRequestPatchRepair,
    describePatchQuality,
    patchQualitySummary,
    patchValidationStatus,
} from "./patchQuality";
import {
    canAutoRollback,
    describeRollbackSafety,
    latestUnappliedPatch,
    rollbackSafetySummary,
    shouldContinueRollbackStack,
    workspaceValidationStatus,
} from "./rollbackSafety";
import { extractUnifiedDiff } from "../tools/patch";
import { redactText } from "./redaction";
import { describeLanguagePolicy, spanishLike } from "./language";
import type { AgentAction, AgentEnv, AgentError, AgentMode, AgentState, Observation } from "./types";

const hasObservation = <T extends Observation["type"]>(state: AgentState, type: T): boolean =>
    state.observations.some((obs) => obs.type === type);

const lastObservation = <T extends Observation["type"]>(
    state: AgentState,
    type: T
): Extract<Observation, { type: T }> | undefined =>
    [...state.observations].reverse().find((obs): obs is Extract<Observation, { type: T }> => obs.type === type);

const firstObservation = <T extends Observation["type"]>(
    state: AgentState,
    type: T
): Extract<Observation, { type: T }> | undefined =>
    state.observations.find((obs): obs is Extract<Observation, { type: T }> => obs.type === type);

const lastObservationIndex = <T extends Observation["type"]>(state: AgentState, type: T): number =>
    [...state.observations].map((obs) => obs.type).lastIndexOf(type);

const observationsBeforePlanning = (state: AgentState): readonly Observation[] => {
    const planIndex = state.observations.findIndex((obs) => obs.type === "llm.response" && obs.purpose === "plan");
    return planIndex < 0 ? state.observations : state.observations.slice(0, planIndex);
};

const observationsAfterPatch = (state: AgentState): readonly Observation[] => {
    const patchIndex = lastObservationIndex(state, "patch.applied");
    return patchIndex < 0 ? [] : state.observations.slice(patchIndex + 1);
};

const latestWorkspaceChangeIndex = (state: AgentState): number =>
    Math.max(lastObservationIndex(state, "patch.applied"), lastObservationIndex(state, "patch.rolledBack"));

const observationsAfterLatestWorkspaceChange = (state: AgentState): readonly Observation[] => {
    const index = latestWorkspaceChangeIndex(state);
    return index < 0 ? [] : state.observations.slice(index + 1);
};

const latestWorkspaceChange = (state: AgentState): Extract<Observation, { type: "patch.applied" | "patch.rolledBack" }> | undefined => {
    const index = latestWorkspaceChangeIndex(state);
    const observation = index < 0 ? undefined : state.observations[index];
    return observation?.type === "patch.applied" || observation?.type === "patch.rolledBack" ? observation : undefined;
};

const compactObservation = (obs: Observation): unknown => {
    switch (obs.type) {
        case "fs.fileRead": {
            const lower = obs.path.toLowerCase();
            const isLockfile = lower.endsWith("package-lock.json")
                || lower.endsWith("npm-shrinkwrap.json")
                || lower.endsWith("pnpm-lock.yaml")
                || lower.endsWith("yarn.lock")
                || lower.endsWith("cargo.lock");
            const limit = isLockfile ? 1_500 : 8_000;
            return {
                type: obs.type,
                path: obs.path,
                content: obs.content.slice(0, limit),
                omittedChars: Math.max(0, obs.content.length - limit),
            };
        }
        case "fs.exists":
            return { type: obs.type, path: obs.path, exists: obs.exists };
        case "shell.result":
            return {
                type: obs.type,
                command: obs.command,
                exitCode: obs.exitCode,
                stdout: obs.stdout.slice(-8_000),
                stderr: obs.stderr.slice(-8_000),
            };
        case "fs.searchResult":
            return {
                type: obs.type,
                query: obs.query,
                matches: obs.matches.slice(0, 20),
                omittedMatches: Math.max(0, obs.matches.length - 20),
            };
        case "patch.proposed":
            return { type: obs.type, patch: obs.patch.slice(0, 8_000) };
        case "patch.applied":
            return { type: obs.type, changedFiles: obs.changedFiles };
        case "patch.rolledBack":
            return {
                type: obs.type,
                changedFiles: obs.changedFiles,
                ...(obs.automatic !== undefined ? { automatic: obs.automatic } : {}),
                ...(obs.reason ? { reason: obs.reason } : {}),
            };
        case "agent.done":
        case "agent.error":
            return obs;
        case "llm.response":
            return { type: obs.type, purpose: obs.purpose, content: obs.content.slice(-8_000) };
    }
};

const redactForPrompt = (state: AgentState, value: string): string => redactText(value, state.goal.redaction);

const isNoiseObservationForPrompt = (obs: Observation): boolean =>
    obs.type === "fs.exists" && !obs.exists;

const compactObservations = (state: AgentState): string =>
    redactForPrompt(
        state,
        state.observations
            .filter((obs) => !isNoiseObservationForPrompt(obs))
            .map((obs) => JSON.stringify(compactObservation(obs), null, 2))
            .join("\n\n")
    );

const causeMessage = (cause: unknown): string => {
    if (cause instanceof Error) return cause.message || String(cause);
    if (typeof cause === "string") return cause;
    if (cause && typeof cause === "object") {
        try {
            const json = JSON.stringify(cause);
            if (json && json !== "{}") return json;
        } catch {
            // fall through
        }
    }
    return String(cause);
};

const errorDetail = (state: AgentState, cause: unknown): string =>
    redactForPrompt(state, causeMessage(cause)).slice(0, 2_000);

const buildPlanningPrompt = (state: AgentState): string => {
    const discovery = discoverValidationCommands(state);

    return redactForPrompt(state, [
        "You are a coding agent running on brass-runtime.",
        "Return a concise diagnosis and proposed plan.",
        "If you can infer a patch, include it as a unified diff inside a ```diff fenced block.",
        "Do not claim that you edited files unless the runtime reports patch.applied.",
        "Prefer a single focused patch over speculative broad changes.",
        "Only propose a patch when the observations are strong enough.",
        "Use the project command discovery summary as context, but do not invent commands that were not run.",
        describeLanguagePolicy(state.goal),
        "",
        `Goal: ${state.goal.text}`,
        `Workspace: ${state.goal.cwd}`,
        `Project commands: ${describeCommandDiscovery(discovery)}`,
        describeContextDiscovery(state),
        describePatchQuality(state),
        describeRollbackSafety(state),
        "",
        "Observations:",
        compactObservations(state) || "No observations yet.",
    ].join("\n"));
};

const failedValidationLines = (state: AgentState): readonly string[] =>
    observationsAfterPatch(state)
        .filter((obs): obs is Extract<Observation, { type: "shell.result" }> => obs.type === "shell.result" && obs.exitCode !== 0)
        .map((result) => [
            `Command: ${result.command.join(" ")}`,
            `Exit code: ${result.exitCode}`,
            result.stdout ? `stdout:\n${result.stdout.slice(-8_000)}` : undefined,
            result.stderr ? `stderr:\n${result.stderr.slice(-8_000)}` : undefined,
        ].filter(Boolean).join("\n"));

const buildPatchRepairPrompt = (state: AgentState, reason: string): string => {
    const discovery = discoverValidationCommands(state);
    const quality = patchQualitySummary(state);
    const latestPatchError = lastObservation(state, "agent.error")?.error;
    const latestPatch = lastMaterializedPatch(state);

    return redactForPrompt(state, [
        "You are repairing a generated patch for a coding agent running on brass-runtime.",
        "The previous generated patch either failed to apply or failed validation.",
        "Return a concise diagnosis and, if you can fix it, include a replacement incremental unified diff inside a ```diff fenced block.",
        "The new diff should apply on top of the current workspace state, after any previous patch.applied observations.",
        "Do not repeat the old patch unless it is still correct for the current workspace state.",
        "Do not claim files were edited unless the runtime later reports patch.applied.",
        describeLanguagePolicy(state.goal),
        "",
        `Goal: ${state.goal.text}`,
        `Workspace: ${state.goal.cwd}`,
        `Repair reason: ${reason}`,
        `Repair attempts used: ${quality.repairAttemptsUsed}/${quality.maxRepairAttempts}`,
        `Project commands: ${describeCommandDiscovery(discovery)}`,
        describeContextDiscovery(state),
        describePatchQuality(state),
        describeRollbackSafety(state),
        "",
        latestPatch ? `Latest materialized patch:\n${latestPatch.slice(-8_000)}` : "Latest materialized patch: none.",
        "",
        failedValidationLines(state).length > 0
            ? `Failed validation after latest patch:\n${failedValidationLines(state).join("\n\n")}`
            : "Failed validation after latest patch: none recorded.",
        "",
        latestPatchError?._tag === "PatchError"
            ? `Latest patch error during ${latestPatchError.operation}: ${String(latestPatchError.cause)}`
            : "Latest patch error: none.",
        "",
        "Recent observations:",
        compactObservations(state) || "No observations yet.",
    ].join("\n"));
};

const isWritableMode = (mode: AgentMode): boolean => mode === "write" || mode === "autonomous";

const buildValidationSummary = (state: AgentState): string | undefined => {
    const validationResults = observationsAfterLatestWorkspaceChange(state)
        .filter((obs): obs is Extract<Observation, { type: "shell.result" }> => obs.type === "shell.result");
    if (validationResults.length === 0) return undefined;

    const change = latestWorkspaceChange(state);
    const spanish = spanishLike(state.goal);
    const label = change?.type === "patch.rolledBack"
        ? spanish ? "rollback" : "rollback"
        : spanish ? "aplicar patch" : "apply";

    return [
        spanish ? `Validación después de ${label}:` : `Validation after latest ${label}:`,
        ...validationResults.map((result) => `- ${result.command.join(" ")} ${spanish ? "terminó con código" : "exited with"} ${result.exitCode}.`),
    ].join("\n");
};

const buildCompletionSummary = (state: AgentState, patch: string | undefined): string => {
    const plan = firstObservation(state, "llm.response")?.content?.trim() ?? "No plan was generated.";
    const latestResponse = lastObservation(state, "llm.response");
    const patchApplied = lastObservation(state, "patch.applied");
    const patchRolledBack = lastObservation(state, "patch.rolledBack");
    const patchProposed = lastObservation(state, "patch.proposed");
    const validation = buildValidationSummary(state);
    const spanish = spanishLike(state.goal);
    const lines = [plan];

    if (latestResponse?.purpose === "patch" && latestResponse.content.trim()) {
        lines.push("", spanish ? "Última respuesta de reparación del patch:" : "Latest patch repair response:", latestResponse.content.trim());
    }

    if (patchRolledBack) {
        lines.push(
            "",
            spanish
                ? `Patch revertido en: ${patchRolledBack.changedFiles.join(", ") || "(sin archivos reportados)"}`
                : `Patch rolled back for: ${patchRolledBack.changedFiles.join(", ") || "(no files reported)"}`,
        );
    } else if (patchApplied) {
        lines.push(
            "",
            spanish
                ? `Patch aplicado en: ${patchApplied.changedFiles.join(", ") || "(sin archivos reportados)"}`
                : `Patch applied to: ${patchApplied.changedFiles.join(", ") || "(no files reported)"}`,
        );
    } else if (patchProposed) {
        lines.push("", spanish ? "Patch propuesto, pero no aplicado en este modo." : "Patch extracted and proposed, but not applied in this mode.");
    } else if (patch) {
        lines.push("", spanish ? "Había un diff con forma de patch, pero no se materializó como observación." : "A patch-shaped diff was present, but it was not materialized as an observation.");
    }

    if (validation) {
        lines.push("", validation);
    }

    return redactForPrompt(state, lines.join("\n").trim());
};

const buildErrorSummary = (state: AgentState): string => {
    const latestError = lastObservation(state, "agent.error")?.error;
    const spanish = spanishLike(state.goal);
    if (!latestError) return spanish ? "La ejecución del agente falló." : "Agent run failed.";

    switch (latestError._tag) {
        case "FsError":
            return spanish
                ? `El agente se detuvo por un error de filesystem durante ${latestError.operation}: ${errorDetail(state, latestError.cause)}`
                : `Agent stopped after a filesystem error during ${latestError.operation}: ${errorDetail(state, latestError.cause)}`;
        case "ShellError":
            return spanish
                ? `El agente se detuvo por un error ejecutando ${latestError.command?.join(" ") ?? latestError.operation}: ${errorDetail(state, latestError.cause)}`
                : `Agent stopped after a shell error during ${latestError.command?.join(" ") ?? latestError.operation}: ${errorDetail(state, latestError.cause)}`;
        case "LLMError":
            return spanish
                ? `El agente se detuvo porque falló la llamada al modelo: ${errorDetail(state, latestError.cause)}`
                : `Agent stopped because the model call failed: ${errorDetail(state, latestError.cause)}`;
        case "PatchError":
            return spanish
                ? `El agente se detuvo por un error de patch durante ${latestError.operation}: ${errorDetail(state, latestError.cause)}`
                : `Agent stopped after a patch error during ${latestError.operation}: ${errorDetail(state, latestError.cause)}`;
        case "PermissionDenied":
            return spanish
                ? `El agente se detuvo porque una acción fue denegada por policy: ${latestError.reason}`
                : `Agent stopped because an action was denied by policy: ${latestError.reason}`;
        case "ApprovalRejected":
            return spanish
                ? `El agente se detuvo porque se rechazó una aprobación: ${latestError.reason}`
                : `Agent stopped because an approval was rejected: ${latestError.reason}`;
        case "ToolTimeout":
            return spanish
                ? `El agente se detuvo porque una tool tardó más de ${latestError.timeoutMs}ms.`
                : `Agent stopped because a tool timed out after ${latestError.timeoutMs}ms.`;
        case "PathOutsideWorkspace":
            return spanish
                ? `El agente bloqueó un path fuera del workspace: ${latestError.path}`
                : `Agent blocked a path outside the workspace: ${latestError.path}`;
        case "AgentLoopError":
            return spanish
                ? `El agente se detuvo por un error del loop: ${latestError.message}`
                : `Agent stopped after an agent loop error: ${latestError.message}`;
    }
};

const nextValidationActionBeforePlanning = (state: AgentState): AgentAction | undefined => {
    if (state.goal.mode === "read-only") return undefined;

    const commands = discoverValidationCommands(state).validationCommands;
    const next = nextUnrunValidationCommand(commands, observationsBeforePlanning(state));
    return next ? { type: "shell.exec", command: next } : undefined;
};

const nextValidationActionAfterPatch = (state: AgentState): AgentAction | undefined => {
    const commands = discoverValidationCommands(state).validationCommands;
    const next = nextUnrunValidationCommand(commands, observationsAfterPatch(state));
    return next ? { type: "shell.exec", command: next } : undefined;
};

const nextValidationActionAfterLatestWorkspaceChange = (state: AgentState): AgentAction | undefined => {
    const commands = discoverValidationCommands(state).validationCommands;
    const next = nextUnrunValidationCommand(commands, observationsAfterLatestWorkspaceChange(state));
    return next ? { type: "shell.exec", command: next } : undefined;
};

const latestLlmPatchCandidate = (state: AgentState): { readonly index: number; readonly patch: string } | undefined => {
    for (let index = state.observations.length - 1; index >= 0; index -= 1) {
        const observation = state.observations[index];
        if (!observation || observation.type !== "llm.response") continue;

        const patch = extractUnifiedDiff(observation.content);
        if (!patch) continue;

        const materialized = state.observations
            .slice(index + 1)
            .some((obs) => obs.type === "patch.applied" || obs.type === "patch.proposed");
        if (!materialized) return { index, patch };
        return undefined;
    }

    return undefined;
};

const latestExtractedPatch = (state: AgentState): string | undefined => {
    for (let index = state.observations.length - 1; index >= 0; index -= 1) {
        const observation = state.observations[index];
        if (observation?.type !== "llm.response") continue;
        const patch = extractUnifiedDiff(observation.content);
        if (patch) return patch;
    }

    return undefined;
};

const lastMaterializedPatch = (state: AgentState): string | undefined => {
    for (let index = state.observations.length - 1; index >= 0; index -= 1) {
        const observation = state.observations[index];
        if (observation?.type === "patch.proposed") return observation.patch;

        if (observation?.type === "patch.applied") {
            if (observation.patch) return observation.patch;

            const previousLlmPatch = state.observations
                .slice(0, index)
                .reverse()
                .find((obs): obs is Extract<Observation, { type: "llm.response" }> => obs.type === "llm.response" && Boolean(extractUnifiedDiff(obs.content)));
            return previousLlmPatch ? extractUnifiedDiff(previousLlmPatch.content) : state.goal.initialPatch;
        }
    }

    return undefined;
};

const shouldRequestRepairAfterValidation = (state: AgentState): boolean => {
    if (!isWritableMode(state.goal.mode)) return false;
    if (latestWorkspaceChange(state)?.type !== "patch.applied") return false;
    if (!canRequestPatchRepair(state)) return false;

    const commands = discoverValidationCommands(state).validationCommands;
    const status = patchValidationStatus(commands, observationsAfterPatch(state));
    return status.type === "failed";
};

const shouldAutoRollbackAfterFinalValidationFailure = (state: AgentState): boolean => {
    if (!isWritableMode(state.goal.mode)) return false;
    if (latestWorkspaceChange(state)?.type !== "patch.applied") return false;
    if (canRequestPatchRepair(state)) return false;

    const summary = rollbackSafetySummary(state);
    if (!summary.onFinalValidationFailure) return false;
    if (!canAutoRollback(state)) return false;

    const commands = discoverValidationCommands(state).validationCommands;
    const status = workspaceValidationStatus(commands, observationsAfterLatestWorkspaceChange(state));
    return status.type === "failed";
};

const shouldRequestRepairAfterPatchError = (state: AgentState): boolean => {
    if (!isWritableMode(state.goal.mode)) return false;
    if (!canRequestPatchRepair(state)) return false;

    const latest = state.observations.at(-1);
    return latest?.type === "agent.error" && latest.error._tag === "PatchError";
};

const repairAction = (state: AgentState, reason: string): AgentAction => ({
    type: "llm.complete",
    purpose: "patch",
    prompt: buildPatchRepairPrompt(state, reason),
});

const automaticRollbackAction = (state: AgentState, reason: string): AgentAction | undefined => {
    const candidate = latestUnappliedPatch(state);
    if (!candidate) return undefined;

    return {
        type: "patch.rollback",
        patch: candidate.patch,
        automatic: true,
        reason,
    };
};

const initialPatchFlowAction = (state: AgentState, suppliedPatch: string): AgentAction | undefined => {
    if (isWritableMode(state.goal.mode)) {
        if (state.goal.initialPatchMode === "rollback") {
            if (!hasObservation(state, "patch.rolledBack")) {
                return { type: "patch.rollback", patch: suppliedPatch };
            }
            return undefined;
        }

        if (!hasObservation(state, "patch.applied")) {
            return { type: "patch.apply", patch: suppliedPatch };
        }

        return nextValidationActionAfterLatestWorkspaceChange(state);
    }

    if (state.goal.mode === "propose" && !hasObservation(state, "patch.proposed")) {
        return { type: "patch.propose", patch: suppliedPatch };
    }

    return undefined;
};

export const decideNextAction = (state: AgentState): Async<AgentEnv, AgentError, AgentAction> => {
    const latest = state.observations.at(-1);

    if (latest?.type === "agent.error") {
        if (shouldRequestRepairAfterPatchError(state)) {
            return asyncSucceed(repairAction(state, "previous patch failed to apply")) as any;
        }

        return asyncSucceed({ type: "agent.finish", summary: buildErrorSummary(state) }) as any;
    }

    if (!hasObservation(state, "fs.fileRead")) {
        return asyncSucceed({ type: "fs.readFile", path: "package.json" }) as any;
    }

    const probeAction = nextProjectProbeAction(state);
    if (probeAction) {
        return asyncSucceed(probeAction) as any;
    }

    const suppliedPatch = state.goal.initialPatch?.trim();
    if (suppliedPatch) {
        const action = initialPatchFlowAction(state, suppliedPatch);
        if (action) return asyncSucceed(action) as any;

        return asyncSucceed({
            type: "agent.finish",
            summary: buildCompletionSummary(state, suppliedPatch),
        }) as any;
    }

    const pendingLlmPatch = latestLlmPatchCandidate(state);
    if (pendingLlmPatch) {
        if (isWritableMode(state.goal.mode)) {
            return asyncSucceed({ type: "patch.apply", patch: pendingLlmPatch.patch }) as any;
        }

        if (state.goal.mode === "propose") {
            return asyncSucceed({ type: "patch.propose", patch: pendingLlmPatch.patch }) as any;
        }
    }

    const planResponse = state.observations.find(
        (obs): obs is Extract<Observation, { type: "llm.response" }> => obs.type === "llm.response" && obs.purpose === "plan"
    );

    if (!planResponse) {
        const validationAction = nextValidationActionBeforePlanning(state);
        if (validationAction) return asyncSucceed(validationAction) as any;

        const contextAction = nextContextDiscoveryAction(state);
        if (contextAction) return asyncSucceed(contextAction) as any;

        return asyncSucceed({
            type: "llm.complete",
            purpose: "plan",
            prompt: buildPlanningPrompt(state),
        }) as any;
    }

    if (isWritableMode(state.goal.mode)) {
        if (shouldContinueRollbackStack(state)) {
            const rollbackAction = automaticRollbackAction(state, "continuing rollback of generated patch stack");
            if (rollbackAction) return asyncSucceed(rollbackAction) as any;
        }

        if (latestWorkspaceChange(state)?.type === "patch.rolledBack") {
            const summary = rollbackSafetySummary(state);
            if (summary.runValidationAfterRollback) {
                const validationAction = nextValidationActionAfterLatestWorkspaceChange(state);
                if (validationAction) return asyncSucceed(validationAction) as any;
            }
        }

        if (latestWorkspaceChange(state)?.type === "patch.applied") {
            const validationAction = nextValidationActionAfterPatch(state);
            if (validationAction) return asyncSucceed(validationAction) as any;

            if (shouldRequestRepairAfterValidation(state)) {
                return asyncSucceed(repairAction(state, "validation failed after applying the generated patch")) as any;
            }

            if (shouldAutoRollbackAfterFinalValidationFailure(state)) {
                const rollbackAction = automaticRollbackAction(state, "validation failed after generated patches and no repair attempts remain");
                if (rollbackAction) return asyncSucceed(rollbackAction) as any;
            }
        }
    }

    const patch = latestExtractedPatch(state);

    return asyncSucceed({
        type: "agent.finish",
        summary: buildCompletionSummary(state, patch),
    }) as any;
};
