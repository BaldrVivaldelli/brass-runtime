import {
    HttpClient,
    HttpRequest,
    HttpWireResponse,
    MakeHttpConfig,
    makeHttp,
    makeHttpStream, withRetryStream, HttpClientStream, HttpMiddleware,
    HttpError,
} from "./client";

import { toPromise as runToPromise } from "../core/runtime/runtime";
import { Async, AsyncWithPromise, asyncFlatMap, asyncSucceed, mapTryAsync, withAsyncPromise } from "../core/types/asyncEffect";

import { setHeaderIfMissing } from "./optics/request";
import {RetryPolicy, withRetry} from "./retry/retry";
import {
    decodeJsonBodyEffect,
    encodeJsonBodyEffect,
    type AnyJsonSchemaLike,
    type InferJsonSchema,
    type ValidationError,
} from "./validation";
import { buildHttpRequest, type HttpRequestPolicyInit } from "./requestBuilder";

type InitNoMethodBody = Omit<RequestInit, "method" | "body"> & HttpRequestPolicyInit & { timeoutMs?: number; poolKey?: string; headers?: any };
type JsonInitNoSchema = InitNoMethodBody & { schema?: undefined; schemaName?: string };
type JsonInitWithSchema<Validator extends AnyJsonSchemaLike> = InitNoMethodBody & { schema: Validator; schemaName?: string };
type PostJsonInitNoSchema = AnyInitWithHeaders & { schema?: undefined; schemaName?: string; bodySchema?: undefined; bodySchemaName?: string };
type PostJsonInitWithBodySchema<BodyValidator extends AnyJsonSchemaLike> = AnyInitWithHeaders & { schema?: undefined; schemaName?: string; bodySchema: BodyValidator; bodySchemaName?: string };
type PostJsonInitWithSchema<Validator extends AnyJsonSchemaLike> = AnyInitWithHeaders & { schema: Validator; schemaName?: string; bodySchema?: undefined; bodySchemaName?: string };
type PostJsonInitWithSchemaAndBody<Validator extends AnyJsonSchemaLike, BodyValidator extends AnyJsonSchemaLike> = AnyInitWithHeaders & { schema: Validator; schemaName?: string; bodySchema: BodyValidator; bodySchemaName?: string };
type AnyJsonInit = InitNoMethodBody & { schema?: AnyJsonSchemaLike; schemaName?: string };


// -------------------------------------------------------------------------------------------------
// Tipos meta
// -------------------------------------------------------------------------------------------------

export type HttpMeta = {
    request: HttpRequest;
    urlFinal: string;
    startedAt: number; // Date.now() cuando inicia el request
    durationMs: number; // w.ms (del wire)
};

export type HttpResponse<A> = {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: A;
};

export type HttpWireWithMeta = {
    wire: HttpWireResponse;
    meta: HttpMeta;
};

export type HttpResponseWithMeta<A> = {
    wire: HttpWireResponse;
    response: HttpResponse<A>;
    meta: HttpMeta;
};

const resolveFinalUrl = (baseUrl: string | undefined, url: string): string => {
    try {
        return new URL(url, baseUrl ?? "").toString();
    } catch {
        return (baseUrl ?? "") + url;
    }
};

type AnyInitWithHeaders = HttpRequestPolicyInit & { headers?: any; timeoutMs?: number; poolKey?: string } & Record<string, any>;

const createHttpCore = (cfg: MakeHttpConfig = {}) => {
    const wire: HttpClient = makeHttp(cfg);

    const withPromise = <R, E, A>(eff: Async<R, E, A>): AsyncWithPromise<R, E, A> =>
        withAsyncPromise<R, E, A>((e, env) => runToPromise(e, env))(eff);

    const requestRaw = (req: HttpRequest) => wire(req);

    const toResponse = <A>(w: HttpWireResponse, body: A) => ({
        status: w.status,
        statusText: w.statusText,
        headers: w.headers,
        body,
    });

    const decodeResponse = <A>(
        w: HttpWireResponse,
        validator?: AnyJsonSchemaLike,
        schemaName?: string,
    ): Async<unknown, ValidationError, HttpResponse<A>> =>
        asyncFlatMap(
            decodeJsonBodyEffect<A>(w.bodyText, validator as any, { schemaName }),
            (body) => asyncSucceed(toResponse(w, body)),
        );

    return {
        cfg,
        wire,
        withPromise,
        requestRaw,
        buildReq: buildHttpRequest,
        toResponse,
        decodeResponse,
    };
};

// -------------------------------------------------------------------------------------------------
// httpClient (sin meta)
// -------------------------------------------------------------------------------------------------

export type Dx = {
    request: (req: HttpRequest) => AsyncWithPromise<unknown, HttpError, HttpWireResponse>;
    get: (url: string, init?: AnyInitWithHeaders) => AsyncWithPromise<unknown, HttpError, HttpWireResponse>;
    post: (url: string, body?: string, init?: AnyInitWithHeaders) => AsyncWithPromise<unknown, HttpError, HttpWireResponse>;

    getText: (url: string, init?: InitNoMethodBody) => AsyncWithPromise<unknown, HttpError, HttpResponse<string>>;
    getJson: {
        <Validator extends AnyJsonSchemaLike>(
            url: string,
            init: JsonInitWithSchema<Validator>,
        ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<InferJsonSchema<Validator>>>;
        <A = unknown>(
            url: string,
            init?: JsonInitNoSchema,
        ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<A>>;
    };
    postJson: {
        <Validator extends AnyJsonSchemaLike, BodyValidator extends AnyJsonSchemaLike>(
            url: string,
            bodyObj: InferJsonSchema<BodyValidator>,
            init: PostJsonInitWithSchemaAndBody<Validator, BodyValidator>,
        ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<InferJsonSchema<Validator>>>;
        <BodyValidator extends AnyJsonSchemaLike, A = unknown>(
            url: string,
            bodyObj: InferJsonSchema<BodyValidator>,
            init: PostJsonInitWithBodySchema<BodyValidator>,
        ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<A>>;
        <Validator extends AnyJsonSchemaLike>(
            url: string,
            bodyObj: unknown,
            init: PostJsonInitWithSchema<Validator>,
        ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<InferJsonSchema<Validator>>>;
        <A = unknown>(
            url: string,
            bodyObj: unknown,
            init?: PostJsonInitNoSchema,
        ): AsyncWithPromise<unknown, HttpError | ValidationError, HttpResponse<A>>;
    };

    with: (mw: HttpMiddleware) => Dx;
    withRetry: (p: RetryPolicy) => Dx;

    // power users
    wire: HttpClient;
    stats: () => ReturnType<HttpClient["stats"]>;
};

export function httpClient(cfg: MakeHttpConfig = {}) {
    const core = createHttpCore(cfg);



    const make = (wire: HttpClient): Dx => {
        const requestRaw = (req: HttpRequest) => wire(req);
        const request = (req: HttpRequest) => core.withPromise(requestRaw(req));

        const get = (url: string, init?: any) => request(core.buildReq("GET", url, init));
        const post = (url: string, body?: string, init?: any) => request(core.buildReq("POST", url, init, body));

        const getText = (url: string, init?: InitNoMethodBody) => {
            const req = core.buildReq("GET", url, init as any);
            return core.withPromise(mapTryAsync(requestRaw(req), (w) => core.toResponse(w, w.bodyText)));
        };

        const getJson = ((url: string, init?: AnyJsonInit) => {
            const base = core.buildReq("GET", url, init as any);
            const req = setHeaderIfMissing("accept", "application/json")(base);
            return core.withPromise(asyncFlatMap(requestRaw(req), (w) => core.decodeResponse(w, init?.schema, init?.schemaName)));
        }) as Dx["getJson"];

        const postJson = ((url: string, bodyObj: unknown, init?: AnyInitWithHeaders & { schema?: AnyJsonSchemaLike; schemaName?: string; bodySchema?: AnyJsonSchemaLike; bodySchemaName?: string }) => {
            return core.withPromise(
                asyncFlatMap(
                    encodeJsonBodyEffect(bodyObj, init?.bodySchema, { schemaName: init?.bodySchemaName }),
                    (bodyText) => {
                        const base = core.buildReq("POST", url, init, bodyText);

                        // defaults sin pisar (optics)
                        const req = setHeaderIfMissing("content-type", "application/json")(
                            setHeaderIfMissing("accept", "application/json")(base)
                        );

                        return asyncFlatMap(requestRaw(req), (w) => core.decodeResponse(w, init?.schema, init?.schemaName));
                    },
                )
            );
        }) as Dx["postJson"];

        return {
            request,
            get,
            post,
            getText,
            getJson,
            postJson,

            with: (mw) => make(wire.with(mw)),
            withRetry: (p) => make(wire.with(withRetry(p))),

            wire,
            stats: () => wire.stats(),
        };
    };

    return make(core.wire);
}




// -------------------------------------------------------------------------------------------------
// httpClientWithMeta
// -------------------------------------------------------------------------------------------------

export function httpClientWithMeta(cfg: MakeHttpConfig = {}) {
    const core = createHttpCore(cfg);

    const mkMeta = (req: HttpRequest, w: HttpWireResponse, startedAt: number): HttpMeta => ({
        request: req,
        urlFinal: resolveFinalUrl(core.cfg.baseUrl, req.url),
        startedAt,
        durationMs: w.ms,
    });

    // => { wire, meta }
    const request = (req: HttpRequest) => {
        const startedAt = Date.now();
        return core.withPromise(
            mapTryAsync(core.requestRaw(req), (w) => ({
                wire: w,
                meta: mkMeta(req, w, startedAt),
            } satisfies HttpWireWithMeta))
        );
    };

    const get = (url: string, init?: InitNoMethodBody) => {
        const req = core.buildReq("GET", url, init as any);
        return request(req);
    };

    const post = (url: string, body?: string, init?: InitNoMethodBody) => {
        const req = core.buildReq("POST", url, init as any, body);
        return request(req);
    };

    // Mantengo tu firma original (más “directa” con HttpInit)
    // => { wire, response(json), meta }
    const postJson = <A>(
        url: string,
        bodyObj: unknown,
        init?: AnyInitWithHeaders & { schema?: AnyJsonSchemaLike; schemaName?: string; bodySchema?: AnyJsonSchemaLike; bodySchemaName?: string }
    ) => {
        const startedAt = Date.now();

        return core.withPromise(
            asyncFlatMap(
                encodeJsonBodyEffect(bodyObj, init?.bodySchema, { schemaName: init?.bodySchemaName }),
                (bodyText) => {
                    const base = core.buildReq("POST", url, init as any, bodyText);

                    // defaults sin pisar si ya vinieron
                    const req = setHeaderIfMissing("content-type", "application/json")(
                        setHeaderIfMissing("accept", "application/json")(base)
                    );

                    return asyncFlatMap(core.requestRaw(req), (w) =>
                        asyncFlatMap(core.decodeResponse<A>(w, init?.schema, init?.schemaName), (response) =>
                            asyncSucceed({
                                wire: w,
                                response,
                                meta: mkMeta(req, w, startedAt),
                            } satisfies HttpResponseWithMeta<A>),
                        ),
                    );
                },
            )
        );
    };



    // => { wire, response(text), meta }
    const getText = (url: string, init?: InitNoMethodBody) => {
        const req = core.buildReq("GET", url, init as any);
        const startedAt = Date.now();

        return core.withPromise(
            mapTryAsync(core.requestRaw(req), (w) => ({
                wire: w,
                response: core.toResponse(w, w.bodyText),
                meta: mkMeta(req, w, startedAt),
            } satisfies HttpResponseWithMeta<string>))
        );
    };

    // => { wire, response(json), meta }
    const getJson = <A>(url: string, init?: AnyJsonInit) => {
        const base = core.buildReq("GET", url, init as any);

        // optics: default accept sin pisar
        const req = setHeaderIfMissing("accept", "application/json")(base);

        const startedAt = Date.now();
        return core.withPromise(
            asyncFlatMap(core.requestRaw(req), (w) =>
                asyncFlatMap(core.decodeResponse<A>(w, init?.schema, init?.schemaName), (response) =>
                    asyncSucceed({
                        wire: w,
                        response,
                        meta: mkMeta(req, w, startedAt),
                    } satisfies HttpResponseWithMeta<A>),
                ),
            )
        );
    };

    return {
        request,  // => { wire, meta }
        get,      // => { wire, meta }
        getText,  // => { wire, response(text), meta }
        getJson,  // => { wire, response(json), meta }
        post,     // => { wire, meta }
        postJson, // => { wire, meta } (y además setea headers via optics)
    };
}


export function httpClientStream(cfg: MakeHttpConfig = {}) {
    const wire = makeHttpStream(cfg);

    const make = (w: HttpClientStream) => {
        // ✅ igual que en httpClient.ts
        const withPromise = <R, E, A>(eff: Async<R, E, A>): AsyncWithPromise<R, E, A> =>
            withAsyncPromise<R, E, A>((e, env) => runToPromise(e, env))(eff);

        const request = (req: HttpRequest) => withPromise(w(req));

        const getStream = (url: string, init?: InitNoMethodBody) => {
            const base: HttpRequest = { method: "GET", url, init: init as any };
            const req = setHeaderIfMissing("accept", "*/*")(base);
            return request(req);
        };

        return {
            request,
            getStream,
            get: getStream,

            with: (mw: (n: HttpClientStream) => HttpClientStream) => make(mw(w)),
            withRetry: (p: RetryPolicy) => make(withRetryStream(p)(w)),
            wire: w,
            stats: () => w.stats(),
        };
    };

    return make(wire);
}
