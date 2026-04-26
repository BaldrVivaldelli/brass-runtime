import { fromPromiseAbortable } from "../../core/runtime/runtime";
import type { AgentError, LLM, LLMResponse } from "../core/types";

const extractText = (json: any): string =>
    json?.choices?.[0]?.message?.content ??
    json?.output_text ??
    json?.content?.[0]?.text ??
    JSON.stringify(json);

export const makeOpenAICompatibleLLM = (config: {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly model: string;
}): LLM => ({
    complete: (request) =>
        fromPromiseAbortable<AgentError, LLMResponse>(
            async (signal) => {
                const res = await fetch(config.endpoint, {
                    method: "POST",
                    signal,
                    headers: {
                        "content-type": "application/json",
                        authorization: `Bearer ${config.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: config.model,
                        messages: [{ role: "user", content: request.prompt }],
                    }),
                });

                if (!res.ok) throw new Error(`LLM request failed with ${res.status}`);
                return { content: extractText(await res.json()) } satisfies LLMResponse;
            },
            (cause): AgentError => ({ _tag: "LLMError", cause })
        ),
});
