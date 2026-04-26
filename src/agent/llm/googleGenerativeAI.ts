import { fromPromiseAbortable } from "../../core/runtime/runtime";
import type { AgentError, LLM, LLMResponse } from "../core/types";

export type GoogleGenerativeAIConfig = {
    /** API key for the Gemini API / Generative Language API. */
    readonly apiKey: string;
    /** Model id, with or without the `models/` prefix. Example: `gemini-2.5-flash`. */
    readonly model?: string;
    /** API version segment. Defaults to `v1beta` for broad Gemini feature coverage. */
    readonly apiVersion?: "v1" | "v1beta" | string;
    /** Base URL for the Generative Language API. Useful for tests/proxies. */
    readonly baseUrl?: string;
    /** Full generateContent endpoint override. If provided, baseUrl/apiVersion/model are ignored. */
    readonly endpoint?: string;
    /** Optional developer instruction. Gemini currently supports text system instructions. */
    readonly systemInstruction?: string;
    /** Optional generation config passthroughs. */
    readonly temperature?: number;
    readonly topP?: number;
    readonly topK?: number;
    readonly maxOutputTokens?: number;
    readonly stopSequences?: readonly string[];
    readonly responseMimeType?: string;
    /** Escape hatch for newer Gemini generationConfig fields without changing this adapter. */
    readonly extraGenerationConfig?: Record<string, unknown>;
};

type GoogleGenerateContentResponse = {
    readonly candidates?: readonly {
        readonly content?: {
            readonly parts?: readonly { readonly text?: string }[];
            readonly role?: string;
        };
        readonly finishReason?: string;
    }[];
    readonly promptFeedback?: {
        readonly blockReason?: string;
        readonly blockReasonMessage?: string;
    };
    readonly error?: {
        readonly code?: number;
        readonly message?: string;
        readonly status?: string;
    };
};

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_API_VERSION = "v1beta";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

const withoutTrailingSlash = (value: string): string => {
    let end = value.length;

    while (end > 0 && value.charCodeAt(end - 1) === 47) {
        end -= 1;
    }

    return end === value.length ? value : value.slice(0, end);
};

const normalizeModelName = (model: string): string => (model.startsWith("models/") ? model : `models/${model}`);

const makeGenerateContentEndpoint = (config: GoogleGenerativeAIConfig): string => {
    if (config.endpoint) return config.endpoint;

    const baseUrl = withoutTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
    const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    const model = normalizeModelName(config.model ?? DEFAULT_MODEL);

    return `${baseUrl}/${apiVersion}/${model}:generateContent`;
};

const optionalNumber = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

const omitUndefined = <T extends Record<string, unknown>>(value: T): Record<string, unknown> =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));

const makeRequestBody = (request: { readonly prompt: string }, config: GoogleGenerativeAIConfig): Record<string, unknown> => {
    const generationConfig = omitUndefined({
        temperature: optionalNumber(config.temperature),
        topP: optionalNumber(config.topP),
        topK: optionalNumber(config.topK),
        maxOutputTokens: optionalNumber(config.maxOutputTokens),
        stopSequences: config.stopSequences,
        responseMimeType: config.responseMimeType,
        ...(config.extraGenerationConfig ?? {}),
    });

    return omitUndefined({
        contents: [
            {
                role: "user",
                parts: [{ text: request.prompt }],
            },
        ],
        systemInstruction: config.systemInstruction
            ? {
                parts: [{ text: config.systemInstruction }],
            }
            : undefined,
        generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
    });
};

const extractGoogleText = (json: GoogleGenerateContentResponse): string => {
    const text = json.candidates
        ?.flatMap((candidate) => candidate.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n")
        .trim();

    if (text) return text;

    const blockReason = json.promptFeedback?.blockReason;
    if (blockReason) {
        const message = json.promptFeedback?.blockReasonMessage;
        throw new Error(`Google Gemini blocked the prompt: ${blockReason}${message ? ` - ${message}` : ""}`);
    }

    const finishReason = json.candidates?.[0]?.finishReason;
    if (finishReason) {
        throw new Error(`Google Gemini returned no text. finishReason=${finishReason}`);
    }

    if (json.error?.message) {
        throw new Error(`Google Gemini error: ${json.error.message}`);
    }

    return JSON.stringify(json);
};

const responseErrorMessage = async (res: Response): Promise<string> => {
    const raw = await res.text();

    try {
        const json = JSON.parse(raw) as GoogleGenerateContentResponse;
        return json.error?.message ?? raw;
    } catch {
        return raw;
    }
};

export const makeGoogleGenerativeAILLM = (config: GoogleGenerativeAIConfig): LLM => ({
    complete: (request) =>
        fromPromiseAbortable<AgentError, LLMResponse>(
            async (signal) => {
                const res = await fetch(makeGenerateContentEndpoint(config), {
                    method: "POST",
                    signal,
                    headers: {
                        "content-type": "application/json",
                        "x-goog-api-key": config.apiKey,
                    },
                    body: JSON.stringify(makeRequestBody({ prompt: request.prompt }, config)),
                });

                if (!res.ok) {
                    const message = await responseErrorMessage(res);
                    throw new Error(`Google Gemini request failed with ${res.status}: ${message}`);
                }

                const json = (await res.json()) as GoogleGenerateContentResponse;
                return { content: extractGoogleText(json) } satisfies LLMResponse;
            },
            (cause): AgentError => ({ _tag: "LLMError", cause })
        ),
});
