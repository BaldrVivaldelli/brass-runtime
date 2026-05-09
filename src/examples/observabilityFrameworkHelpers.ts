import type { Observability } from "../observability";

type DynamicImport = <T = any>(specifier: string) => Promise<T>;

const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

export async function loadOptionalPackage<T = any>(specifier: string, installHint: string): Promise<T> {
  try {
    return await dynamicImport<T>(specifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Missing optional package '${specifier}'.`);
    console.error(`Install it with: ${installHint}`);
    console.error(`Original error: ${message}`);
    process.exit(1);
  }
}

export function exampleOtlpFetch(serviceName: string) {
  return async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const size = init.body.length;
    const signal = url.endsWith("/v1/traces") ? "traces" : "metrics";
    console.log(`[${serviceName}] exported ${signal}: ${size} bytes`);
    return { ok: true, status: 202, text: async () => JSON.stringify(body).slice(0, 120) };
  };
}

export function portFromEnv(defaultPort: number): number {
  const parsed = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultPort;
}

export function installShutdownHandlers(observability: Observability, close: () => Promise<void> | void): void {
  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`received ${signal}, draining observability`);
    await close();
    await observability.shutdown();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
