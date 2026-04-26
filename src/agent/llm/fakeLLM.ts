import { asyncSucceed } from "../../core/types/asyncEffect";
import type { LLM, LLMRequest } from "../core/types";

export type FakeLLMOptions = {
    readonly content?: string | ((request: LLMRequest) => string);
};

const defaultContent = (request: LLMRequest): string =>
    [
        "Fake LLM response.",
        "",
        `Purpose: ${request.purpose}`,
        "Set BRASS_LLM_PROVIDER=google with GEMINI_API_KEY/GOOGLE_API_KEY, or set BRASS_LLM_ENDPOINT and BRASS_LLM_API_KEY for an OpenAI-compatible model.",
        "You can also set BRASS_FAKE_LLM_RESPONSE to provide a deterministic offline response, including a fenced ```diff block.",
    ].join("\n");

export const makeFakeLLM = (options: FakeLLMOptions = {}): LLM => ({
    complete: (request) =>
        asyncSucceed({
            content:
                typeof options.content === "function"
                    ? options.content(request)
                    : options.content ?? defaultContent(request),
        }) as any,
});
