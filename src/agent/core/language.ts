import type { AgentGoal, AgentLanguageConfig, AgentResponseLanguage } from "./types";

const LANGUAGE_LABELS: Record<Exclude<AgentResponseLanguage, "auto" | "match-user" | "custom">, string> = {
    en: "English",
    es: "Spanish",
    pt: "Portuguese",
    fr: "French",
    de: "German",
    it: "Italian",
};

const SPANISH_HINT = /[¿¡ñáéíóúü]|\b(aca|acá|ahora|arregl|ayuda|como|cómo|consulta|cual|cuál|cuando|cuándo|dale|decime|deberia|debería|donde|dónde|errores|explica|explicame|hacer|hagamos|mejorar|porque|porqué|por que|por qué|proyecto|quiero|seria|sería|tengo|usar|vayamos)\b/i;
const PORTUGUESE_HINT = /[ãõç]|\b(como|corrigir|erro|falha|quero|projeto|porque|você|voce)\b/i;
const FRENCH_HINT = /[àâçéèêëîïôûùüÿœ]|\b(comment|pourquoi|corriger|erreur|projet|fichier)\b/i;
const GERMAN_HINT = /[äöüß]|\b(warum|fehler|projekt|datei|bitte)\b/i;
const ITALIAN_HINT = /\b(come|perché|perche|errore|progetto|file|voglio)\b/i;

export const inferUserLanguage = (text: string): string | undefined => {
    if (SPANISH_HINT.test(text)) return "Spanish";
    if (PORTUGUESE_HINT.test(text)) return "Portuguese";
    if (FRENCH_HINT.test(text)) return "French";
    if (GERMAN_HINT.test(text)) return "German";
    if (ITALIAN_HINT.test(text)) return "Italian";
    return undefined;
};

const configuredLanguageName = (language: AgentLanguageConfig | undefined): string | undefined => {
    const response = language?.response ?? "auto";
    if (response === "custom") return language?.custom?.trim() || undefined;
    if (response === "auto" || response === "match-user") return undefined;
    return LANGUAGE_LABELS[response];
};

export const responseLanguageName = (goal: AgentGoal): string | undefined =>
    configuredLanguageName(goal.language) ?? inferUserLanguage(goal.text);

export const describeLanguagePolicy = (goal: AgentGoal): string => {
    const configured = configuredLanguageName(goal.language);
    const inferred = inferUserLanguage(goal.text);

    if (configured) {
        return [
            `Language policy: respond in ${configured}.`,
            "Keep code, identifiers, file paths, shell commands, logs, and unified diffs unchanged.",
        ].join(" ");
    }

    if (inferred) {
        return [
            `Language policy: the user goal appears to be in ${inferred}; respond in ${inferred}.`,
            "Keep code, identifiers, file paths, shell commands, logs, and unified diffs unchanged.",
        ].join(" ");
    }

    return [
        "Language policy: respond in the same natural language as the user's latest goal or follow-up.",
        "If the user's goal is in Spanish, respond in Spanish.",
        "Keep code, identifiers, file paths, shell commands, logs, and unified diffs unchanged.",
    ].join(" ");
};

export const spanishLike = (goal: AgentGoal): boolean => responseLanguageName(goal) === "Spanish";
