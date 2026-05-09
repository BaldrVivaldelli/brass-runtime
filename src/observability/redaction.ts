export type RedactionOptions = {
  readonly keys?: readonly (string | RegExp)[];
  readonly headers?: readonly (string | RegExp)[];
  readonly replacement?: string;
  readonly redactUrlQuery?: boolean;
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
};

export type ObservabilityRedactor = {
  readonly value: (value: unknown) => unknown;
  readonly fields: (fields: Record<string, unknown>) => Record<string, unknown>;
  readonly attributes: (fields: Record<string, unknown>) => Record<string, unknown>;
  readonly headers: (headers: Record<string, string>) => Record<string, string>;
  readonly url: (url: string) => string;
};

export type RedactionConfig = false | RedactionOptions | ObservabilityRedactor;

const DEFAULT_REPLACEMENT = "[REDACTED]";
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_STRING_LENGTH = 8_192;

const DEFAULT_KEY_PATTERNS: readonly (string | RegExp)[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "private_key",
  /credential/i,
];

const DEFAULT_HEADER_PATTERNS: readonly (string | RegExp)[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
];

export function makeObservabilityRedactor(config: RedactionConfig | undefined): ObservabilityRedactor {
  if (isRedactor(config)) return config;

  const options = config === false ? { keys: [], headers: [], redactUrlQuery: false } : config ?? {};
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  const keys = options.keys ?? DEFAULT_KEY_PATTERNS;
  const headers = options.headers ?? DEFAULT_HEADER_PATTERNS;
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH));
  const maxStringLength = Math.max(0, Math.floor(options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH));
  const redactUrlQuery = options.redactUrlQuery ?? true;

  const redactByKey = (key: string, value: unknown, depth: number): unknown => {
    if (matchesAny(key, keys)) return replacement;
    return redactValue(value, depth);
  };

  const redactValue = (value: unknown, depth: number): unknown => {
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return maxStringLength > 0 && value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}...`
      : value;
    if (depth >= maxDepth) return "[MaxDepth]";
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      };
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = redactByKey(key, item, depth + 1);
      }
      return out;
    }
    return String(value);
  };

  return {
    value: (value) => redactValue(value, 0),
    fields: (fields) => redactRecord(fields, redactByKey),
    attributes: (fields) => redactRecord(fields, redactByKey),
    headers: (input) => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(input)) {
        out[key] = matchesAny(key, headers) ? replacement : value;
      }
      return out;
    },
    url: (url) => redactUrl(url, redactUrlQuery),
  };
}

function redactRecord(
  fields: Record<string, unknown>,
  redactByKey: (key: string, value: unknown, depth: number) => unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactByKey(key, value, 0);
  }
  return out;
}

function redactUrl(url: string, redactQuery: boolean): string {
  if (!redactQuery) return url;
  try {
    const parsed = new URL(url);
    if (parsed.search) parsed.search = "?[REDACTED]";
    return parsed.toString();
  } catch {
    const queryIndex = url.indexOf("?");
    if (queryIndex < 0) return url;
    return `${url.slice(0, queryIndex)}?[REDACTED]`;
  }
}

function matchesAny(key: string, patterns: readonly (string | RegExp)[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some((pattern) =>
    typeof pattern === "string" ? lower === pattern.toLowerCase() : pattern.test(key)
  );
}

function isRedactor(value: unknown): value is ObservabilityRedactor {
  return typeof value === "object"
    && value !== null
    && typeof (value as ObservabilityRedactor).fields === "function"
    && typeof (value as ObservabilityRedactor).attributes === "function";
}
