import type { TraceSampler, TraceSamplingInput } from "../core/runtime/tracer";
import { normalizeTraceId } from "./traceContext";

export type TraceSamplingRule = {
  readonly name?: string | RegExp;
  readonly route?: string | RegExp;
  readonly ratio?: number;
  readonly sampled?: boolean;
};

export type TraceSamplingOptions = {
  readonly ratio?: number;
  readonly rules?: readonly TraceSamplingRule[];
  readonly sampler?: TraceSampler;
  readonly respectRemoteSampled?: boolean;
  readonly forceSampleOnError?: boolean;
};

export type ResolvedTraceSampling = {
  readonly sampler: TraceSampler;
  readonly respectRemoteSampled: boolean;
  readonly forceSampleOnError: boolean;
};

export type TraceSamplingConfig = false | number | TraceSampler | TraceSamplingOptions;

const TRACE_SAMPLER_RATIO = Symbol.for("brass-runtime.traceSampler.ratio");

export const alwaysOnSampler: TraceSampler = withRatio({
  shouldSample: () => true,
}, 1);

export const alwaysOffSampler: TraceSampler = withRatio({
  shouldSample: () => false,
}, 0);

export function ratioSampler(ratio: number): TraceSampler {
  const bounded = clampRatio(ratio);
  if (bounded >= 1) return alwaysOnSampler;
  if (bounded <= 0) return alwaysOffSampler;

  return withRatio({
    shouldSample: (input) => traceRatio(input.traceId) < bounded,
  }, bounded);
}

export function makeTraceSampler(options: TraceSamplingOptions = {}): TraceSampler {
  const fallback = options.sampler ?? ratioSampler(options.ratio ?? 1);
  const rules = options.rules ?? [];

  const sampler: TraceSampler = {
    shouldSample(input: TraceSamplingInput) {
      for (const rule of rules) {
        if (!samplingRuleMatches(rule, input)) continue;
        if (rule.sampled !== undefined) return rule.sampled;
        if (rule.ratio !== undefined) return shouldSampleWith(ratioSampler(rule.ratio), input);
      }

      return shouldSampleWith(fallback, input);
    },
  };

  const fallbackRatio = samplerRatio(fallback);
  return rules.length === 0 && fallbackRatio !== undefined ? withRatio(sampler, fallbackRatio) : sampler;
}

export function resolveTraceSampling(config: TraceSamplingConfig | undefined): ResolvedTraceSampling {
  if (config === false) {
    return { sampler: alwaysOffSampler, respectRemoteSampled: true, forceSampleOnError: false };
  }

  if (typeof config === "number") {
    return { sampler: ratioSampler(config), respectRemoteSampled: true, forceSampleOnError: false };
  }

  if (isTraceSampler(config)) {
    return { sampler: config, respectRemoteSampled: true, forceSampleOnError: false };
  }

  return {
    sampler: makeTraceSampler(config ?? {}),
    respectRemoteSampled: config?.respectRemoteSampled ?? true,
    forceSampleOnError: config?.forceSampleOnError ?? false,
  };
}

export function shouldSampleWith(sampler: TraceSampler | undefined, input: TraceSamplingInput): boolean {
  if (!sampler) return true;
  if (typeof sampler === "function") return sampler(input);
  return sampler.shouldSample(input);
}

function samplingRuleMatches(rule: TraceSamplingRule, input: TraceSamplingInput): boolean {
  if (rule.name && !matchText(rule.name, input.spanName)) return false;
  if (rule.route && !matchText(rule.route, input.attributes?.["http.route"])) return false;
  return true;
}

function matchText(pattern: string | RegExp, value: unknown): boolean {
  if (typeof value !== "string") return false;
  return typeof pattern === "string" ? pattern === value : pattern.test(value);
}

function isTraceSampler(value: unknown): value is TraceSampler {
  return typeof value === "function"
    || (typeof value === "object" && value !== null && typeof (value as { shouldSample?: unknown }).shouldSample === "function");
}

function samplerRatio(sampler: TraceSampler | undefined): number | undefined {
  if (!sampler || typeof sampler === "function") return undefined;
  const ratio = (sampler as any)[TRACE_SAMPLER_RATIO];
  return typeof ratio === "number" && Number.isFinite(ratio) ? ratio : undefined;
}

function withRatio<T extends TraceSampler>(sampler: T, ratio: number): T {
  try {
    Object.defineProperty(sampler, TRACE_SAMPLER_RATIO, {
      configurable: false,
      enumerable: false,
      value: ratio,
    });
  } catch {
    // Non-extensible custom samplers simply run through the generic path.
  }
  return sampler;
}

function traceRatio(traceId: string): number {
  const normalized = normalizeTraceId(traceId);
  const head = normalized.slice(0, 8);
  const value = Number.parseInt(head, 16);
  if (!Number.isFinite(value)) return 1;
  return value / 0xffff_ffff;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}
