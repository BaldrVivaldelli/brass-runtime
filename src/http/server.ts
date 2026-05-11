import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { async, asyncFlatMap, asyncFold, asyncSucceed, type Async } from "../core/types/asyncEffect";
import type { RuntimeOptions } from "../core/runtime/runtime";
import { Runtime } from "../core/runtime/runtime";
import { resource, type Resource } from "../core/runtime/resource";
import { fixed, makeScheduleDriver, take, type Schedule } from "../core/runtime/schedule";
import type { Observability } from "../observability/setup";
import {
  healthToHttpResponse,
  makeRuntimeHealth,
  type RuntimeHealthOptions,
  type RuntimeHealthReport,
  type HealthHttpResponse,
} from "../observability/health";
import {
  runObservedHttpServerEffect,
  type HttpServerObservabilityOptions,
} from "../observability/server";
import {
  formatIssues,
  makeSchemaIssue,
  validateValue,
  type AnyJsonSchemaLike,
  type InferJsonSchema,
  type JsonSchemaLike,
  type SchemaIssue,
  type ValidationError,
} from "./validation";
import type { HttpMethod } from "./client";

export type HttpServerMethod = HttpMethod | "ALL";
export type HttpServerHeaders = Record<string, string>;
export type HttpServerQuery = Record<string, string | readonly string[]>;
export type HttpServerParams = Record<string, string>;
export type HttpServerBody = string | Uint8Array | ArrayBuffer | unknown;

export type HttpServerRequest = {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly target: string;
  readonly headers: HttpServerHeaders;
  readonly query: HttpServerQuery;
  readonly params: HttpServerParams;
  readonly bodyText: string;
  readonly raw?: unknown;
};

export type HttpServerContext<
  Params = HttpServerParams,
  Query = HttpServerQuery,
  Body = unknown,
> = Omit<HttpServerRequest, "params" | "query"> & {
  readonly route: string;
  readonly params: Params;
  readonly query: Query;
  readonly body: Body;
};

export type HttpServerResponse<Body = unknown> = {
  readonly status?: number;
  readonly headers?: HttpServerHeaders;
  readonly body?: Body;
};

export type HttpServerHandler<
  R = unknown,
  E = unknown,
  Params = HttpServerParams,
  Query = HttpServerQuery,
  Body = unknown,
  ResponseBody = unknown,
> = (
  ctx: HttpServerContext<Params, Query, Body>
) => Async<R, E, HttpServerResponse<ResponseBody>>;

export type HttpServerMiddleware = (
  next: HttpServerHandler<any, any, any, any, any, any>
) => HttpServerHandler<any, any, any, any, any, any>;

export type HttpRouteSchemas<
  ParamsSchema extends AnyJsonSchemaLike | undefined = undefined,
  QuerySchema extends AnyJsonSchemaLike | undefined = undefined,
  BodySchema extends AnyJsonSchemaLike | undefined = undefined,
  ResponseSchema extends AnyJsonSchemaLike | undefined = undefined,
> = {
  readonly params?: ParamsSchema;
  readonly paramsSchemaName?: string;
  readonly query?: QuerySchema;
  readonly querySchemaName?: string;
  readonly body?: BodySchema;
  readonly bodySchemaName?: string;
  readonly response?: ResponseSchema;
  readonly responseSchemaName?: string;
};

export type HttpRouteOptions<
  ParamsSchema extends AnyJsonSchemaLike | undefined = undefined,
  QuerySchema extends AnyJsonSchemaLike | undefined = undefined,
  BodySchema extends AnyJsonSchemaLike | undefined = undefined,
  ResponseSchema extends AnyJsonSchemaLike | undefined = undefined,
> = HttpRouteSchemas<ParamsSchema, QuerySchema, BodySchema, ResponseSchema> & {
  readonly middleware?: readonly HttpServerMiddleware[];
};

export type HttpRuntimeHealthRouteOptions = RuntimeHealthOptions & {
  readonly path?: string;
};

export type InferServerPart<Schema, Fallback> =
  Schema extends AnyJsonSchemaLike ? InferJsonSchema<Schema> : Fallback;

export type RoutePathParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? StripRouteParamModifier<Param> | RoutePathParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? StripRouteParamModifier<Param>
      : never;

export type RoutePathParams<Path extends string> =
  [RoutePathParamNames<Path>] extends [never]
    ? {}
    : { readonly [Key in RoutePathParamNames<Path>]: string };

type StripRouteParamModifier<Param extends string> =
  Param extends `${infer Name}?` ? Name :
  Param extends `${infer Name}+` ? Name :
  Param extends `${infer Name}*` ? Name :
  Param;

export type HttpServerRoute<
  R = unknown,
  E = unknown,
  Path extends string = string,
  ParamsSchema extends AnyJsonSchemaLike | undefined = AnyJsonSchemaLike | undefined,
  QuerySchema extends AnyJsonSchemaLike | undefined = AnyJsonSchemaLike | undefined,
  BodySchema extends AnyJsonSchemaLike | undefined = AnyJsonSchemaLike | undefined,
  ResponseSchema extends AnyJsonSchemaLike | undefined = AnyJsonSchemaLike | undefined,
> = {
  readonly method: HttpServerMethod;
  readonly path: Path;
  readonly options: HttpRouteOptions<ParamsSchema, QuerySchema, BodySchema, ResponseSchema>;
  readonly handler: HttpServerHandler<
    R,
    E,
    InferServerPart<ParamsSchema, RoutePathParams<Path>>,
    InferServerPart<QuerySchema, HttpServerQuery>,
    InferServerPart<BodySchema, unknown>,
    InferServerPart<ResponseSchema, unknown>
  >;
  readonly match: (path: string) => HttpServerParams | undefined;
};

export type HttpRouterOptions = {
  readonly middleware?: readonly HttpServerMiddleware[];
  readonly includeErrorDetails?: boolean;
};

export type HttpRouteMatch =
  | {
    readonly _tag: "Match";
    readonly route: HttpServerRoute<any, any, any, any, any, any, any>;
    readonly params: HttpServerParams;
  }
  | {
    readonly _tag: "MethodNotAllowed";
    readonly route: HttpServerRoute<any, any, any, any, any, any, any>;
    readonly allowed: readonly HttpServerMethod[];
  }
  | {
    readonly _tag: "NotFound";
  };

export type HttpRouter = {
  readonly routes: readonly HttpServerRoute<any, any, any, any, any, any, any>[];
  readonly match: (method: string, path: string) => HttpRouteMatch;
  readonly handle: (
    request: HttpServerRequest,
    match?: HttpRouteMatch
  ) => Async<unknown, never, HttpServerResponse>;
  readonly listen: <R extends object = {}>(
    options?: Omit<NodeHttpServerOptions<R>, "router">
  ) => Resource<unknown, NodeHttpServerError, NodeHttpServerHandle>;
};

export type NodeHttpServerError =
  | { readonly _tag: "ListenError"; readonly error: unknown; readonly message: string }
  | { readonly _tag: "ServerClosed"; readonly message: string };

export type NodeHttpServerHandle = {
  readonly server: Server;
  readonly router: HttpRouter;
  readonly address: () => AddressInfo | string | null;
  readonly url: () => string | undefined;
  readonly close: () => Promise<void>;
};

export type NodeHttpServerOptions<R extends object = {}> = {
  readonly router: HttpRouter | readonly HttpServerRoute<any, any, any, any, any, any, any>[];
  readonly host?: string;
  readonly port?: number;
  readonly env?: R;
  readonly runtime?: Runtime<R>;
  readonly runtimeOptions?: Omit<RuntimeOptions<R>, "env" | "hooks">;
  readonly observability?: Observability;
  readonly observabilityOptions?: HttpServerObservabilityOptions<HttpServerResponse>;
  readonly maxBodyBytes?: number;
  readonly gracefulShutdownMs?: number;
  readonly shutdownPollSchedule?: Schedule<NodeHttpServerShutdownState, unknown>;
  readonly onError?: (error: unknown) => void;
};

export type NodeHttpServerShutdownState = {
  readonly listening: boolean;
  readonly elapsedMs: number;
};

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export function route<
  Path extends string,
  ParamsSchema extends AnyJsonSchemaLike | undefined = undefined,
  QuerySchema extends AnyJsonSchemaLike | undefined = undefined,
  BodySchema extends AnyJsonSchemaLike | undefined = undefined,
  ResponseSchema extends AnyJsonSchemaLike | undefined = undefined,
  R = unknown,
  E = unknown,
>(
  method: HttpServerMethod,
  path: Path,
  options: HttpRouteOptions<ParamsSchema, QuerySchema, BodySchema, ResponseSchema>,
  handler: HttpServerHandler<
    R,
    E,
    InferServerPart<ParamsSchema, RoutePathParams<Path>>,
    InferServerPart<QuerySchema, HttpServerQuery>,
    InferServerPart<BodySchema, unknown>,
    InferServerPart<ResponseSchema, unknown>
  >
): HttpServerRoute<R, E, Path, ParamsSchema, QuerySchema, BodySchema, ResponseSchema>;
export function route<Path extends string, R = unknown, E = unknown>(
  method: HttpServerMethod,
  path: Path,
  handler: HttpServerHandler<R, E, RoutePathParams<Path>>
): HttpServerRoute<R, E, Path, undefined, undefined, undefined, undefined>;
export function route(
  method: HttpServerMethod,
  path: string,
  optionsOrHandler: HttpRouteOptions | HttpServerHandler,
  maybeHandler?: HttpServerHandler,
): HttpServerRoute {
  const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
  if (!handler) throw new Error(`Missing handler for HTTP route ${method} ${path}`);

  return {
    method: normalizeRouteMethod(method),
    path: normalizeRoutePath(path),
    options,
    handler,
    match: compileRoutePath(path),
  };
}

export const httpRoute = route;

export function makeHttpRouter(
  routes: readonly HttpServerRoute<any, any, any, any, any, any, any>[],
  options: HttpRouterOptions = {},
): HttpRouter {
  const normalizedRoutes = routes.map((item) => ({
    ...item,
    method: normalizeRouteMethod(item.method),
    path: normalizeRoutePath(item.path),
  }));

  const router: HttpRouter = {
    routes: normalizedRoutes,
    match: (method, path) => matchRoute(normalizedRoutes, method, path),
    handle: (request, existingMatch) => {
      const matched = existingMatch ?? router.match(request.method, request.path);
      return handleRouteMatch(request, matched, options);
    },
    listen: (serverOptions = {}) => nodeHttpServerResource({
      ...serverOptions,
      router,
    }),
  };
  return router;
}

export function json<Body>(
  body: Body,
  init: Omit<HttpServerResponse<Body>, "body"> = {},
): HttpServerResponse<Body> {
  return {
    ...init,
    headers: setHeaderIfMissing(init.headers, "content-type", "application/json"),
    body,
  };
}

export function text(
  body: string,
  init: Omit<HttpServerResponse<string>, "body"> = {},
): HttpServerResponse<string> {
  return {
    ...init,
    headers: setHeaderIfMissing(init.headers, "content-type", "text/plain; charset=utf-8"),
    body,
  };
}

export function empty(status = 204, headers?: HttpServerHeaders): HttpServerResponse<void> {
  return { status, headers };
}

export function makeRuntimeHealthRoute(
  options: HttpRuntimeHealthRouteOptions = {},
): HttpServerRoute<unknown, never, string, undefined, undefined, undefined, undefined> {
  const { path = "/health", ...healthOptions } = options;
  return route("GET", path, () =>
    asyncFlatMap(makeRuntimeHealth(healthOptions), (report) =>
      asyncSucceed(healthReportToServerResponse(report))
    )
  );
}

export function makeRuntimeReadinessRoute(
  options: HttpRuntimeHealthRouteOptions = {},
): HttpServerRoute<unknown, never, string, undefined, undefined, undefined, undefined> {
  return makeRuntimeHealthRoute({
    ...options,
    path: options.path ?? "/ready",
  });
}

export const runtimeHealthRoute = makeRuntimeHealthRoute;
export const runtimeReadinessRoute = makeRuntimeReadinessRoute;

export function withResponseHeader(name: string, value: string): HttpServerMiddleware {
  return (next) => (ctx) =>
    asyncFlatMap(next(ctx as any), (response) =>
      asyncSucceed({
        ...response,
        headers: setHeaderIfMissing(response.headers, name, value),
      })
    );
}

function healthReportToServerResponse(report: RuntimeHealthReport): HttpServerResponse<string> {
  return healthHttpResponseToServerResponse(healthToHttpResponse(report));
}

function healthHttpResponseToServerResponse(response: HealthHttpResponse): HttpServerResponse<string> {
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
  };
}

export function makeNodeHttpServer<R extends object = {}>(
  options: NodeHttpServerOptions<R>,
): Async<unknown, NodeHttpServerError, NodeHttpServerHandle> {
  return async((_env, cb) => {
    const router = resolveRouter(options.router);
    const server = createServer((req, res) => {
      void handleNodeRequest(req, res, router, options);
    });
    let settled = false;
    let closed = false;

    const close = () => closeNodeServer(server, options);
    const fail = (error: unknown) => {
      if (settled) {
        options.onError?.(error);
        return;
      }
      settled = true;
      cb({
        _tag: "Failure",
        cause: {
          _tag: "Fail",
          error: {
            _tag: "ListenError",
            error,
            message: error instanceof Error ? error.message : String(error),
          } satisfies NodeHttpServerError,
        },
      });
    };

    server.once("error", fail);
    server.once("close", () => {
      closed = true;
    });

    server.listen(options.port ?? 0, options.host, () => {
      if (settled) return;
      settled = true;
      server.off("error", fail);
      server.on("error", (error) => options.onError?.(error));
      cb({
        _tag: "Success",
        value: {
          server,
          router,
          address: () => server.address(),
          url: () => serverUrl(server),
          close,
        },
      });
    });

    return () => {
      if (closed) return;
      void close().catch((error) => options.onError?.(error));
    };
  });
}

export function nodeHttpServerResource<R extends object = {}>(
  options: NodeHttpServerOptions<R>,
): Resource<unknown, NodeHttpServerError, NodeHttpServerHandle> {
  return resource(
    makeNodeHttpServer(options),
    (handle) => async((_env, cb) => {
      handle.close()
        .then(() => cb({ _tag: "Success", value: undefined }))
        .catch(() => cb({ _tag: "Success", value: undefined }));
    }),
  );
}

export const makeNodeHttpServerResource = nodeHttpServerResource;
export const makeHttpServerResource = nodeHttpServerResource;

export const HttpServer = Object.freeze({
  route,
  httpRoute,
  router: makeHttpRouter,
  listen: makeNodeHttpServer,
  resource: nodeHttpServerResource,
  json,
  text,
  empty,
  healthRoute: makeRuntimeHealthRoute,
  readinessRoute: makeRuntimeReadinessRoute,
  middleware: Object.freeze({
    header: withResponseHeader,
  }),
});

function handleRouteMatch(
  request: HttpServerRequest,
  match: HttpRouteMatch,
  options: HttpRouterOptions,
): Async<unknown, never, HttpServerResponse> {
  if (match._tag === "NotFound") {
    return asyncSucceed(json({ error: "Not Found" }, { status: 404 }));
  }

  if (match._tag === "MethodNotAllowed") {
    return asyncSucceed(json(
      { error: "Method Not Allowed", allowed: match.allowed.filter((method) => method !== "ALL") },
      { status: 405, headers: { allow: match.allowed.filter((method) => method !== "ALL").join(", ") } },
    ));
  }

  const routeWithParams = match.route;
  const prepared = prepareRouteContext(request, match.params, routeWithParams);
  if (!prepared.success) return asyncSucceed(validationErrorResponse(prepared.error));

  const handler = composeMiddleware(
    [...(options.middleware ?? []), ...(routeWithParams.options.middleware ?? [])],
    routeWithParams.handler as HttpServerHandler,
  );

  let handled: Async<unknown, unknown, HttpServerResponse>;
  try {
    handled = handler(prepared.ctx);
  } catch (error) {
    return asyncSucceed(handlerErrorResponse(error, options));
  }

  return asyncFold(
    handled,
    (error) => asyncSucceed(handlerErrorResponse(error, options)),
    (response) => {
      const normalized = normalizeServerResponse(response);
      const validation = validateResponseBody(normalized, routeWithParams);
      return asyncSucceed(validation.success ? normalized : validationErrorResponse(validation.error));
    },
  );
}

function prepareRouteContext(
  request: HttpServerRequest,
  params: HttpServerParams,
  routeWithSchemas: HttpServerRoute,
): { readonly success: true; readonly ctx: HttpServerContext } | { readonly success: false; readonly error: ValidationError } {
  const paramsResult = validatePart(params, routeWithSchemas.options.params, {
    phase: "request",
    schemaName: routeWithSchemas.options.paramsSchemaName ?? "params",
    body: JSON.stringify(params),
  });
  if (!paramsResult.success) return paramsResult;

  const queryResult = validatePart(request.query, routeWithSchemas.options.query, {
    phase: "request",
    schemaName: routeWithSchemas.options.querySchemaName ?? "query",
    body: JSON.stringify(request.query),
  });
  if (!queryResult.success) return queryResult;

  const bodyInput = routeWithSchemas.options.body
    ? parseJsonRequestBody(request.bodyText)
    : { success: true as const, data: request.bodyText.length > 0 ? request.bodyText : undefined };
  if (!bodyInput.success) {
    return {
      success: false,
      error: makeValidationError({
        message: bodyInput.message,
        body: request.bodyText,
        phase: "request",
        schema: routeWithSchemas.options.bodySchemaName ?? "body",
        issues: [makeSchemaIssue([], "valid JSON", request.bodyText, bodyInput.message)],
      }),
    };
  }

  const bodyResult = validatePart(bodyInput.data, routeWithSchemas.options.body, {
    phase: "request",
    schemaName: routeWithSchemas.options.bodySchemaName ?? "body",
    body: request.bodyText,
  });
  if (!bodyResult.success) return bodyResult;

  return {
    success: true,
    ctx: {
      ...request,
      route: routeWithSchemas.path,
      params: paramsResult.data as HttpServerParams,
      query: queryResult.data as HttpServerQuery,
      body: bodyResult.data,
    },
  };
}

function validateResponseBody(
  response: HttpServerResponse,
  routeWithSchemas: HttpServerRoute,
): { readonly success: true } | { readonly success: false; readonly error: ValidationError } {
  const schema = routeWithSchemas.options.response;
  if (!schema) return { success: true };

  const result = validateValue(response.body, schema);
  if (result.success) return { success: true };

  return {
    success: false,
    error: makeValidationError({
      message: `HTTP response failed validation: ${formatIssues(result.issues)}`,
      body: previewJson(response.body),
      phase: "response",
      schema: routeWithSchemas.options.responseSchemaName ?? "response",
      issues: result.issues,
    }),
  };
}

function validatePart<A>(
  input: unknown,
  schema: JsonSchemaLike<A> | undefined,
  options: { readonly phase: "request" | "response"; readonly schemaName: string; readonly body: string },
): { readonly success: true; readonly data: A | unknown } | { readonly success: false; readonly error: ValidationError } {
  if (!schema) return { success: true, data: input };

  const result = validateValue(input, schema);
  if (result.success) return { success: true, data: result.data };

  return {
    success: false,
    error: makeValidationError({
      message: `HTTP ${options.schemaName} failed validation: ${formatIssues(result.issues)}`,
      body: options.body,
      phase: options.phase,
      schema: options.schemaName,
      issues: result.issues,
    }),
  };
}

function resolveRouter(input: NodeHttpServerOptions["router"]): HttpRouter {
  return isHttpRouter(input) ? input : makeHttpRouter(input);
}

function isHttpRouter(value: NodeHttpServerOptions["router"]): value is HttpRouter {
  return !Array.isArray(value)
    && typeof value === "object"
    && value !== null
    && typeof (value as HttpRouter).match === "function"
    && typeof (value as HttpRouter).handle === "function";
}

function makeValidationError(input: {
  readonly message: string;
  readonly body: string;
  readonly phase: "request" | "response";
  readonly schema: string;
  readonly issues: readonly SchemaIssue[];
}): ValidationError {
  return {
    _tag: "ValidationError",
    message: input.message,
    body: input.body,
    phase: input.phase,
    schema: input.schema,
    issues: input.issues,
  };
}

function validationErrorResponse(error: ValidationError): HttpServerResponse {
  return json(
    {
      error: error.phase === "response" ? "Response validation failed" : "Request validation failed",
      message: error.message,
      phase: error.phase,
      schema: error.schema,
      issues: error.issues,
    },
    { status: error.phase === "response" ? 500 : 400 },
  );
}

function handlerErrorResponse(error: unknown, options: HttpRouterOptions): HttpServerResponse {
  return json(
    {
      error: "Internal Server Error",
      ...(options.includeErrorDetails ? { message: error instanceof Error ? error.message : String(error) } : {}),
    },
    { status: 500 },
  );
}

async function handleNodeRequest<R extends object>(
  req: IncomingMessage,
  res: ServerResponse,
  router: HttpRouter,
  options: NodeHttpServerOptions<R>,
): Promise<void> {
  try {
    const bodyText = await readNodeRequestBody(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const serverRequest = nodeRequestToServerRequest(req, bodyText);
    const match = router.match(serverRequest.method, serverRequest.path);
    const effect = router.handle(serverRequest, match);
    const routeLabel = match._tag === "Match" || match._tag === "MethodNotAllowed" ? match.route.path : undefined;
    const observedInput = {
      method: serverRequest.method,
      route: routeLabel,
      target: serverRequest.target,
      headers: serverRequest.headers,
    };

    const response = options.observability
      ? (await runObservedHttpServerEffect(
        options.observability,
        observedInput,
        effect,
        {
          statusCode: (value) => value.status ?? 200,
          ...(options.observabilityOptions ?? {}),
        },
        options.env,
        options.runtimeOptions,
      )).value
      : await (options.runtime ?? new Runtime({
        env: (options.env ?? {}) as R,
        ...(options.runtimeOptions ?? {}),
      })).toPromise(effect);

    writeNodeResponse(res, response);
  } catch (error) {
    options.onError?.(error);
    writeNodeResponse(res, json({ error: "Internal Server Error" }, { status: 500 }));
  }
}

function nodeRequestToServerRequest(req: IncomingMessage, bodyText: string): HttpServerRequest {
  const headers = normalizeNodeHeaders(req.headers);
  const target = req.url ?? "/";
  const parsed = parseRequestUrl(target, headers.host);

  return {
    method: (req.method ?? "GET").toUpperCase(),
    url: parsed.toString(),
    path: parsed.pathname,
    target,
    headers,
    query: queryToObject(parsed.searchParams),
    params: {},
    bodyText,
    raw: req,
  };
}

function writeNodeResponse(res: ServerResponse, response: HttpServerResponse): void {
  const normalized = normalizeServerResponse(response);
  const encoded = encodeResponseBody(normalized);
  res.statusCode = normalized.status ?? 200;

  for (const [name, value] of Object.entries(encoded.headers)) {
    res.setHeader(name, value);
  }

  if (encoded.body === undefined) {
    res.end();
    return;
  }

  res.end(encoded.body);
}

function normalizeServerResponse(response: HttpServerResponse | unknown): HttpServerResponse {
  if (isServerResponse(response)) {
    return { status: 200, ...response };
  }
  return { status: 200, body: response };
}

function isServerResponse(value: unknown): value is HttpServerResponse {
  return typeof value === "object"
    && value !== null
    && ("status" in value || "headers" in value || "body" in value);
}

function encodeResponseBody(response: HttpServerResponse): { readonly headers: HttpServerHeaders; readonly body?: string | Uint8Array } {
  const headers = { ...(response.headers ?? {}) };
  const body = response.body;
  if (body === undefined || response.status === 204 || response.status === 304) return { headers };

  if (typeof body === "string") {
    return {
      headers: setHeaderIfMissing(headers, "content-type", "text/plain; charset=utf-8"),
      body,
    };
  }

  if (body instanceof Uint8Array) return { headers, body };
  if (body instanceof ArrayBuffer) return { headers, body: new Uint8Array(body) };

  return {
    headers: setHeaderIfMissing(headers, "content-type", "application/json"),
    body: JSON.stringify(body),
  };
}

function readNodeRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error(`HTTP request body exceeded ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function closeNodeServer<R extends object>(
  server: Server,
  options: NodeHttpServerOptions<R>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const schedule = options.shutdownPollSchedule ?? defaultShutdownPollSchedule(options.gracefulShutdownMs ?? 5_000);
    const driver = makeScheduleDriver(schedule, { name: schedule.name ?? "http.server.shutdown", startedAtMs: startedAt });
    let finished = false;

    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (error && error.message !== "Server is not running.") reject(error);
      else resolve();
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      if (finished) return;
      if (!server.listening) {
        done();
        return;
      }

      const decision = driver.next({
        listening: server.listening,
        elapsedMs: Date.now() - startedAt,
      });
      if (!decision.continue) {
        server.closeAllConnections?.();
        done();
        return;
      }
      timer = setTimeout(poll, decision.delayMs);
      timer.unref?.();
    };

    server.close(done);
    poll();
  });
}

function defaultShutdownPollSchedule(maxMs: number): Schedule<NodeHttpServerShutdownState, unknown> {
  const intervalMs = 25;
  return take(fixed(intervalMs), Math.max(1, Math.ceil(Math.max(0, maxMs) / intervalMs)));
}

function matchRoute(
  routes: readonly HttpServerRoute<any, any, any, any, any, any, any>[],
  method: string,
  path: string,
): HttpRouteMatch {
  const requestedMethod = method.toUpperCase();
  const allowed: HttpServerMethod[] = [];
  let methodMismatch: HttpServerRoute<any, any, any, any, any, any, any> | undefined;

  for (const candidate of routes) {
    const params = candidate.match(path);
    if (!params) continue;
    if (candidate.method === "ALL" || candidate.method === requestedMethod) {
      return { _tag: "Match", route: candidate, params };
    }
    methodMismatch ??= candidate;
    allowed.push(candidate.method);
  }

  if (methodMismatch) {
    return { _tag: "MethodNotAllowed", route: methodMismatch, allowed };
  }
  return { _tag: "NotFound" };
}

function composeMiddleware(
  middleware: readonly HttpServerMiddleware[],
  handler: HttpServerHandler,
): HttpServerHandler {
  return middleware.reduceRight((next, current) => current(next), handler);
}

function parseJsonRequestBody(bodyText: string): { readonly success: true; readonly data: unknown } | { readonly success: false; readonly message: string } {
  if (bodyText.length === 0) return { success: true, data: undefined };
  try {
    return { success: true, data: JSON.parse(bodyText) };
  } catch (error) {
    return {
      success: false,
      message: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function compileRoutePath(path: string): (input: string) => HttpServerParams | undefined {
  const keys: string[] = [];
  const normalized = normalizeRoutePath(path);
  if (normalized === "/") {
    return (input) => input === "/" ? {} : undefined;
  }

  const source = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment === "*") {
        keys.push("*");
        return "(.*)";
      }
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return escapeRegExp(segment);
    })
    .join("/");
  const regex = new RegExp(`^/${source}/?$`);

  return (input) => {
    const match = regex.exec(input);
    if (!match) return undefined;
    const params: HttpServerParams = {};
    keys.forEach((key, index) => {
      params[key] = decodePathPart(match[index + 1] ?? "");
    });
    return params;
  };
}

function normalizeRouteMethod(method: HttpServerMethod): HttpServerMethod {
  const upper = method.toUpperCase();
  return upper === "ALL" ? "ALL" : upper as HttpMethod;
}

function normalizeRoutePath(path: string): string {
  if (!path || path === "*") return "/";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function parseRequestUrl(target: string, host: string | undefined): URL {
  try {
    return new URL(target, `http://${host ?? "localhost"}`);
  } catch {
    return new URL("/", `http://${host ?? "localhost"}`);
  }
}

function queryToObject(searchParams: URLSearchParams): HttpServerQuery {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    const current = out[key];
    if (current === undefined) {
      out[key] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      out[key] = [current, value];
    }
  }
  return out;
}

function normalizeNodeHeaders(headers: IncomingMessage["headers"]): HttpServerHeaders {
  const out: HttpServerHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}

function setHeaderIfMissing(headers: HttpServerHeaders | undefined, name: string, value: string): HttpServerHeaders {
  const out = { ...(headers ?? {}) };
  const existing = Object.keys(out).find((key) => key.toLowerCase() === name.toLowerCase());
  if (!existing) out[name] = value;
  return out;
}

function serverUrl(server: Server): string | undefined {
  const address = server.address();
  if (!address || typeof address === "string") return undefined;
  const host = address.address === "::" || address.address === "0.0.0.0" ? "127.0.0.1" : address.address;
  return `http://${host}:${address.port}`;
}

function previewJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
