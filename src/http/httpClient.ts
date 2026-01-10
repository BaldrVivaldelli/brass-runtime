import {
    HttpClient,
    HttpRequest,
    HttpWireResponse,
    MakeHttpConfig,
    makeHttp,
    HttpInit, HttpMethod, normalizeHeadersInit, makeHttpStream, withRetryStream, HttpClientStream, HttpMiddleware,
} from "./client";

import { toPromise as runToPromise } from "../core/runtime/runtime";
import { Async, AsyncWithPromise, mapTryAsync, withAsyncPromise } from "../core/types/asyncEffect";

import { mergeHeaders, setHeaderIfMissing } from "./optics/request";
import {RetryPolicy, withRetry} from "./retry/retry";

type InitNoMethodBody = Omit<RequestInit, "method" | "body">;


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

type AnyInitWithHeaders = { headers?: any } & Record<string, any>;

const createHttpCore = (cfg: MakeHttpConfig = {}) => {
    const wire: HttpClient = makeHttp(cfg);

    const withPromise = <R, E, A>(eff: Async<R, E, A>): AsyncWithPromise<R, E, A> =>
        withAsyncPromise<R, E, A>((e, env) => runToPromise(e, env))(eff);

    const requestRaw = (req: HttpRequest) => wire(req);

    const splitInit = (init?: AnyInitWithHeaders) => {
        const { headers, ...rest } = (init ?? {}) as any;
        return {
            headers: normalizeHeadersInit(headers),
            init: rest as HttpInit,
        };
    };

    const applyInitHeaders =
        (headers?: Record<string, string>) =>
            (req: HttpRequest): HttpRequest =>
                headers ? mergeHeaders(headers)(req) : req;

    const buildReq = (method: HttpMethod, url: string, init?: AnyInitWithHeaders, body?: string) => {
        const s = splitInit(init);
        const req: HttpRequest = {
            method,
            url,
            ...(body && body.length > 0 ? { body } : {}),
            init: s.init,
        };
        return applyInitHeaders(s.headers)(req);
    };

    const toResponse = <A>(w: HttpWireResponse, body: A) => ({
        status: w.status,
        statusText: w.statusText,
        headers: w.headers,
        body,
    });

    return {
        cfg,
        wire,
        withPromise,
        requestRaw,
        splitInit,
        applyInitHeaders,
        buildReq,
        toResponse,
    };
};

// -------------------------------------------------------------------------------------------------
// httpClient (sin meta)
// -------------------------------------------------------------------------------------------------

export type Dx = {
    request: (req: HttpRequest) => any;
    get: (url: string, init?: any) => any;
    post: (url: string, body?: string, init?: any) => any;
    getText: (url: string, init?: any) => any;
    getJson: <A>(url: string, init?: any) => any;
    postJson: (url: string, body?: any, init?: any) => any;

    with: (mw: HttpMiddleware) => Dx;
    withRetry: (p: RetryPolicy) => Dx;

    wire: HttpClient;
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

        const getJson = <A>(url: string, init?: InitNoMethodBody) => {
            const base = core.buildReq("GET", url, init as any);
            const req = setHeaderIfMissing("accept", "application/json")(base);
            return core.withPromise(mapTryAsync(requestRaw(req), (w) => core.toResponse(w, JSON.parse(w.bodyText) as A)));
        };

        const postJson = (url: string, body?: any, init?: any) =>
            request(core.buildReq("POST", url, init, JSON.stringify(body ?? {})));

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
    const postJson = <A>(
        url: string,
        bodyObj: A,
        init?: HttpInit & { headers?: Record<string, string> }
    ) => {
        const base = core.buildReq("POST", url, init as any, JSON.stringify(bodyObj));

        // optics: defaults sin pisar si ya vinieron
        const req = setHeaderIfMissing("content-type", "application/json")(
            setHeaderIfMissing("accept", "application/json")(base)
        );

        return request(req);
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
    const getJson = <A>(url: string, init?: InitNoMethodBody) => {
        const base = core.buildReq("GET", url, init as any);

        // optics: default accept sin pisar
        const req = setHeaderIfMissing("accept", "application/json")(base);

        const startedAt = Date.now();
        return core.withPromise(
            mapTryAsync(core.requestRaw(req), (w) => ({
                wire: w,
                response: core.toResponse(w, JSON.parse(w.bodyText) as A),
                meta: mkMeta(req, w, startedAt),
            } satisfies HttpResponseWithMeta<A>))
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
        };
    };

    return make(wire);
}