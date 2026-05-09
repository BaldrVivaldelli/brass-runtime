import type { Baggage, TraceContext } from "../core/runtime/contex";

export type TraceContextHeaderValue = string | readonly string[] | undefined;

export type TraceContextCarrier =
  | Record<string, TraceContextHeaderValue>
  | Iterable<readonly [string, string]>
  | {
    get(name: string): string | null | undefined;
  };

export type InjectTraceContextOptions = {
  readonly overwrite?: boolean;
};

const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";
const BAGGAGE_HEADER = "baggage";
const HEX = /^[0-9a-f]+$/;
const BAGGAGE_KEY = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;

export function parseTraceparent(value: string | null | undefined): TraceContext | undefined {
  if (!value) return undefined;

  const parts = value.trim().split("-");
  if (parts.length < 4) return undefined;

  const [version, traceIdRaw, spanIdRaw, flagsRaw] = parts;
  if (!isFixedHex(version, 2) || version.toLowerCase() === "ff") return undefined;
  if (version.toLowerCase() === "00" && parts.length !== 4) return undefined;
  if (!isFixedHex(traceIdRaw, 32) || isAllZero(traceIdRaw)) return undefined;
  if (!isFixedHex(spanIdRaw, 16) || isAllZero(spanIdRaw)) return undefined;
  if (!isFixedHex(flagsRaw, 2)) return undefined;

  const flags = Number.parseInt(flagsRaw, 16);
  return {
    traceId: traceIdRaw.toLowerCase(),
    spanId: spanIdRaw.toLowerCase(),
    sampled: (flags & 0x01) === 0x01,
  };
}

export function formatTraceparent(trace: TraceContext): string {
  return `00-${normalizeTraceId(trace.traceId)}-${normalizeSpanId(trace.spanId)}-${trace.sampled === false ? "00" : "01"}`;
}

export function extractTraceContext(headers: TraceContextCarrier | undefined): TraceContext | undefined {
  const parsed = parseTraceparent(readHeader(headers, TRACEPARENT_HEADER));
  if (!parsed) return undefined;

  const traceState = readHeader(headers, TRACESTATE_HEADER);
  const baggage = extractBaggage(headers);
  return {
    ...parsed,
    ...(traceState ? { traceState } : {}),
    ...(baggage ? { baggage } : {}),
  };
}

export function injectTraceContext(
  headers: Record<string, string> | undefined,
  trace: TraceContext,
  options: InjectTraceContextOptions = {}
): Record<string, string> {
  const out = { ...(headers ?? {}) };
  const hasTraceparent = hasHeader(out, TRACEPARENT_HEADER);
  const shouldInjectTraceContext = options.overwrite || !hasTraceparent;

  if (!shouldInjectTraceContext) return out;

  if (shouldInjectTraceContext) {
    setHeader(out, TRACEPARENT_HEADER, formatTraceparent(trace));
  }

  if (trace.traceState && (options.overwrite || !hasHeader(out, TRACESTATE_HEADER))) {
    setHeader(out, TRACESTATE_HEADER, trace.traceState);
  }

  if (trace.baggage && Object.keys(trace.baggage).length > 0 && (options.overwrite || !hasHeader(out, BAGGAGE_HEADER))) {
    setHeader(out, BAGGAGE_HEADER, formatBaggage(trace.baggage));
  }

  return out;
}

export function parseBaggage(value: string | null | undefined): Baggage | undefined {
  if (!value) return undefined;

  const entries: Record<string, string> = {};
  for (const rawMember of value.split(",")) {
    const member = rawMember.trim();
    if (!member) continue;
    const [pair] = member.split(";", 1);
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1).trim();
    if (!BAGGAGE_KEY.test(key)) continue;
    entries[key] = decodeBaggageValue(rawValue);
  }

  return Object.keys(entries).length > 0 ? entries : undefined;
}

export function formatBaggage(baggage: Baggage | undefined): string {
  if (!baggage) return "";
  return Object.entries(baggage)
    .filter(([key, value]) => BAGGAGE_KEY.test(key) && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${encodeBaggageValue(value)}`)
    .join(",");
}

export function extractBaggage(headers: TraceContextCarrier | undefined): Baggage | undefined {
  return parseBaggage(readHeader(headers, BAGGAGE_HEADER));
}

export function injectBaggage(
  headers: Record<string, string> | undefined,
  baggage: Baggage | undefined,
  options: InjectTraceContextOptions = {}
): Record<string, string> {
  const out = { ...(headers ?? {}) };
  if (!baggage || Object.keys(baggage).length === 0) return out;
  if (!options.overwrite && hasHeader(out, BAGGAGE_HEADER)) return out;
  setHeader(out, BAGGAGE_HEADER, formatBaggage(baggage));
  return out;
}

export function normalizeTraceId(id: string): string {
  return normalizeHexId(id, 32);
}

export function normalizeSpanId(id: string): string {
  return normalizeHexId(id, 16);
}

function readHeader(headers: TraceContextCarrier | undefined, name: string): string | undefined {
  if (!headers) return undefined;

  const getter = (headers as { get?: (header: string) => string | null | undefined }).get;
  if (typeof getter === "function") {
    return getter.call(headers, name) ?? undefined;
  }

  if (isIterableHeaders(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === name) return value;
    }
    return undefined;
  }

  const record = headers as Record<string, TraceContextHeaderValue>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0];
    return undefined;
  }

  return undefined;
}

function isIterableHeaders(value: unknown): value is Iterable<readonly [string, string]> {
  return typeof (value as { [Symbol.iterator]?: unknown })?.[Symbol.iterator] === "function";
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === lower);
  headers[existing ?? name] = value;
}

function isFixedHex(value: string | undefined, length: number): value is string {
  return typeof value === "string" && value.length === length && HEX.test(value.toLowerCase());
}

function isAllZero(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "0") return false;
  }
  return true;
}

function normalizeHexId(id: string, length: number): string {
  const hex = String(id).toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length >= length) return avoidAllZero(hex.slice(0, length));
  if (hex.length > 0) return avoidAllZero(hex.padStart(length, "0"));
  return stableHex(String(id), length);
}

function decodeBaggageValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeBaggageValue(value: string): string {
  return encodeURIComponent(String(value));
}

function avoidAllZero(hex: string): string {
  return isAllZero(hex) ? `${hex.slice(0, -1)}1` : hex;
}

function stableHex(input: string, length: number): string {
  let hash = 0x811c9dc5;
  let out = "";
  while (out.length < length) {
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    out += (hash >>> 0).toString(16).padStart(8, "0");
    input = `${input}:${out.length}`;
  }
  return avoidAllZero(out.slice(0, length));
}
