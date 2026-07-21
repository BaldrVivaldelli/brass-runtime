import type {
  AgentPersistence,
  AgentPersistenceKey,
  AgentPersistenceScope,
  AgentPersistenceWriteOptions,
} from "./types";

export type AgentPersistenceEnvelope = {
  readonly version: 1;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly value: string;
};

export type DecodedAgentPersistenceEnvelope =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "expired" }
  | { readonly kind: "legacy"; readonly value: string };

export const encodeAgentPersistenceEnvelope = (
  value: string,
  createdAt: number,
  expiresAt?: number,
): string => JSON.stringify({
  version: 1,
  createdAt,
  ...(expiresAt === undefined ? {} : { expiresAt }),
  value,
} satisfies AgentPersistenceEnvelope);

export const decodeAgentPersistenceEnvelope = (
  stored: string,
  now: number,
): DecodedAgentPersistenceEnvelope => {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).version !== 1 ||
      typeof (parsed as Record<string, unknown>).createdAt !== "number" ||
      typeof (parsed as Record<string, unknown>).value !== "string"
    ) {
      return { kind: "legacy", value: stored };
    }
    const envelope = parsed as AgentPersistenceEnvelope;
    if (envelope.expiresAt !== undefined && envelope.expiresAt <= now) {
      return { kind: "expired" };
    }
    return { kind: "value", value: envelope.value };
  } catch {
    return { kind: "legacy", value: stored };
  }
};

/** Redacts common secret-bearing JSON fields and authorization values. */
export const redactAgentPersistenceValue = (value: string): string => value
  .replace(/("(?:api[-_]?key|token|secret|password|authorization)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
  .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]");

export async function readAgentState<A>(
  persistence: AgentPersistence | undefined,
  key: AgentPersistenceKey,
  parse: (value: string) => A,
  fallback: () => A,
  scope: AgentPersistenceScope = "workspace",
): Promise<A> {
  if (!persistence) return fallback();
  try {
    const value = await persistence.read(scope, key);
    return value === undefined ? fallback() : parse(value);
  } catch {
    return fallback();
  }
}

export async function writeAgentState(
  persistence: AgentPersistence | undefined,
  key: AgentPersistenceKey,
  value: string,
  options?: AgentPersistenceWriteOptions,
  scope: AgentPersistenceScope = "workspace",
): Promise<void> {
  if (!persistence) return;
  await persistence.write(scope, key, value, options);
}

export function makeInMemoryAgentPersistence(now: () => number = Date.now): AgentPersistence & {
  readonly snapshot: () => Readonly<Record<string, string>>;
} {
  const state = new Map<string, { value: string; expiresAt?: number }>();
  const compound = (scope: AgentPersistenceScope, key: AgentPersistenceKey) => `${scope}:${key}`;
  return {
    version: 1,
    read: async (scope, key) => {
      const item = state.get(compound(scope, key));
      if (!item) return undefined;
      if (item.expiresAt !== undefined && item.expiresAt <= now()) {
        state.delete(compound(scope, key));
        return undefined;
      }
      return item.value;
    },
    write: async (scope, key, value, options) => {
      const bytes = new TextEncoder().encode(value).byteLength;
      const maximum = options?.maxBytes ?? 1_048_576;
      if (bytes > maximum) throw new Error(`Agent persistence payload for ${key} exceeds ${maximum} bytes`);
      if (options?.expiresAt !== undefined && options.expiresAt <= now()) {
        throw new Error(`Agent persistence payload for ${key} is already expired`);
      }
      state.set(compound(scope, key), { value, ...(options?.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }) });
    },
    remove: async (scope, key) => {
      state.delete(compound(scope, key));
    },
    snapshot: () => Object.freeze(Object.fromEntries([...state].map(([key, item]) => [key, item.value]))),
  };
}
