// src/agent/core/errorRecovery/classifier.ts

import type { AgentError } from "../types";
import type { CategorizedError, LLMErrorSubcategory, PatchErrorSubcategory } from "./types";

/**
 * Classify a PatchError operation string into a subcategory.
 * - Contains "parse" → "parse"
 * - Contains "conflict" → "conflict"
 * - Default → "apply"
 */
const classifyPatchOperation = (operation: string): PatchErrorSubcategory => {
    const lower = operation.toLowerCase();
    if (lower.includes("parse")) return "parse";
    if (lower.includes("conflict")) return "conflict";
    return "apply";
};

/**
 * Classify an LLMError cause into a subcategory.
 * Stringifies the cause and checks for known patterns:
 * - Contains "rate" or "429" or "too many requests" → "rate-limit"
 * - Contains "timeout" or "ETIMEDOUT" or "ECONNABORTED" → "timeout"
 * - Default → "timeout"
 */
const classifyLLMCause = (cause: unknown): LLMErrorSubcategory => {
    let causeStr: string;
    try {
        causeStr = (typeof cause === "string" ? cause : String(cause)).toLowerCase();
    } catch {
        return "timeout";
    }
    if (causeStr.includes("rate") || causeStr.includes("429") || causeStr.includes("too many requests")) {
        return "rate-limit";
    }
    if (causeStr.includes("timeout") || causeStr.includes("etimedout") || causeStr.includes("econnaborted")) {
        return "timeout";
    }
    return "timeout";
};

/**
 * Classify an AgentError into a CategorizedError with category and subcategory.
 * Pure function, no side effects.
 */
export const classifyError = (error: AgentError): CategorizedError => {
    switch (error._tag) {
        case "PatchError":
            return {
                category: "PatchError",
                subcategory: classifyPatchOperation(error.operation),
                raw: error,
            };
        case "LLMError":
            return {
                category: "LLMError",
                subcategory: classifyLLMCause(error.cause),
                raw: error,
            };
        case "ShellError":
            return {
                category: "ShellError",
                subcategory: undefined,
                raw: error,
            };
        case "FsError":
            return {
                category: "FsError",
                subcategory: undefined,
                raw: error,
            };
        default:
            return {
                category: "unknown",
                subcategory: undefined,
                raw: error,
            };
    }
};
