type OtlpRouteContext = {
  readonly params: Promise<{ readonly signal?: readonly string[] }> | { readonly signal?: readonly string[] };
};

export async function POST(request: Request, context: OtlpRouteContext) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const body = await request.text();
  const params = await context.params;
  const signalPath = (params.signal ?? []).join("/");

  if (!endpoint) {
    return Response.json({ accepted: true, proxied: false, signalPath, bytes: body.length }, { status: 202 });
  }

  const response = await fetch(`${trimTrailingSlash(endpoint)}/${signalPath}`, {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      ...(process.env.OTEL_EXPORTER_OTLP_HEADERS
        ? parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
        : {}),
    },
    body,
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function parseHeaders(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(",")
      .map((entry) => entry.split("="))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([key, headerValue]) => [key.trim(), headerValue.trim()]),
  );
}

