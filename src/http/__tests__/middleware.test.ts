import { describe, expect, it, vi } from "vitest";
import { withAuth, withLogging, withResponseTransform } from "../lifecycle/middleware";
import type { LogEvent } from "../lifecycle/middleware";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import { asyncSucceed, asyncFail } from "../../core/types/asyncEffect";
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";

const rt = Runtime.make({});

const runExit = <E, A>(eff: Async<unknown, E, A>): Promise<Exit<E, A>> =>
  new Promise((resolve) => {
    rt.unsafeRunAsync(eff, resolve);
  });

const makeResponse = (body: string = "ok", status: number = 200): HttpWireResponse => ({
  status,
  statusText: "OK",
  headers: { "content-type": "text/plain" },
  bodyText: body,
  ms: 10,
});

const makeRequest = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "GET",
  url: "/test",
  headers: { accept: "application/json" },
  ...overrides,
});

/** Creates a simple mock HttpClientFn that returns a fixed response */
function mockClient(response: HttpWireResponse): HttpClientFn {
  return (_req: HttpRequest) => asyncSucceed(response);
}

/** Creates a mock HttpClientFn that fails with the given error */
function failingClient(error: HttpError): HttpClientFn {
  return (_req: HttpRequest) => asyncFail(error);
}

/** Creates a mock HttpClientFn that captures the request it receives */
function capturingClient(response: HttpWireResponse): {
  client: HttpClientFn;
  captured: HttpRequest[];
} {
  const captured: HttpRequest[] = [];
  const client: HttpClientFn = (req: HttpRequest) => {
    captured.push(req);
    return asyncSucceed(response);
  };
  return { client, captured };
}

describe("withAuth", () => {
  it("injects bearer token into Authorization header", async () => {
    const response = makeResponse("authenticated");
    const { client, captured } = capturingClient(response);
    const tokenProvider = () => asyncSucceed("my-secret-token") as Async<unknown, HttpError, string>;

    const authedClient = withAuth(tokenProvider)(client);
    const req = makeRequest();
    const exit = await runExit(authedClient(req));

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value).toEqual(response);
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers!.Authorization).toBe("Bearer my-secret-token");
  });

  it("preserves existing headers when injecting auth", async () => {
    const response = makeResponse();
    const { client, captured } = capturingClient(response);
    const tokenProvider = () => asyncSucceed("token123") as Async<unknown, HttpError, string>;

    const authedClient = withAuth(tokenProvider)(client);
    const req = makeRequest({ headers: { "x-custom": "value", accept: "text/html" } });
    const exit = await runExit(authedClient(req));

    expect(exit._tag).toBe("Success");
    expect(captured[0]!.headers!["x-custom"]).toBe("value");
    expect(captured[0]!.headers!.accept).toBe("text/html");
    expect(captured[0]!.headers!.Authorization).toBe("Bearer token123");
  });

  it("propagates token provider errors to the caller", async () => {
    const response = makeResponse();
    const client = mockClient(response);
    const authError: HttpError = { _tag: "FetchError", message: "token expired" };
    const tokenProvider = () => asyncFail(authError) as Async<unknown, HttpError, string>;

    const authedClient = withAuth(tokenProvider)(client);
    const req = makeRequest();
    const exit = await runExit(authedClient(req));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause._tag).toBe("Fail");
      if (exit.cause._tag === "Fail") {
        expect(exit.cause.error).toEqual(authError);
      }
    }
  });

  it("does not call next when token provider fails", async () => {
    const response = makeResponse();
    const { client, captured } = capturingClient(response);
    const authError: HttpError = { _tag: "FetchError", message: "auth failed" };
    const tokenProvider = () => asyncFail(authError) as Async<unknown, HttpError, string>;

    const authedClient = withAuth(tokenProvider)(client);
    const req = makeRequest();
    await runExit(authedClient(req));

    expect(captured).toHaveLength(0);
  });

  it("handles undefined request headers gracefully", async () => {
    const response = makeResponse();
    const { client, captured } = capturingClient(response);
    const tokenProvider = () => asyncSucceed("tok") as Async<unknown, HttpError, string>;

    const authedClient = withAuth(tokenProvider)(client);
    const req: HttpRequest = { method: "GET", url: "/no-headers" };
    const exit = await runExit(authedClient(req));

    expect(exit._tag).toBe("Success");
    expect(captured[0]!.headers!.Authorization).toBe("Bearer tok");
  });
});

describe("withLogging", () => {
  it("invokes logger with request phase before calling next", async () => {
    const events: LogEvent[] = [];
    const logger = (event: LogEvent) => events.push(event);
    const response = makeResponse("logged");
    const client = mockClient(response);

    const loggingClient = withLogging(logger)(client);
    const req = makeRequest();
    await runExit(loggingClient(req));

    const requestEvents = events.filter((e) => e.phase === "request");
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]!.req).toEqual(req);
    expect(requestEvents[0]!.res).toBeUndefined();
    expect(requestEvents[0]!.error).toBeUndefined();
  });

  it("invokes logger with response phase on success", async () => {
    const events: LogEvent[] = [];
    const logger = (event: LogEvent) => events.push(event);
    const response = makeResponse("success-body");
    const client = mockClient(response);

    const loggingClient = withLogging(logger)(client);
    const req = makeRequest();
    await runExit(loggingClient(req));

    const responseEvents = events.filter((e) => e.phase === "response");
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0]!.req).toEqual(req);
    expect(responseEvents[0]!.res).toEqual(response);
    expect(typeof responseEvents[0]!.durationMs).toBe("number");
  });

  it("invokes logger with error phase on failure", async () => {
    const events: LogEvent[] = [];
    const logger = (event: LogEvent) => events.push(event);
    const error: HttpError = { _tag: "Timeout", timeoutMs: 5000, message: "timed out" };
    const client = failingClient(error);

    const loggingClient = withLogging(logger)(client);
    const req = makeRequest();
    await runExit(loggingClient(req));

    const errorEvents = events.filter((e) => e.phase === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.req).toEqual(req);
    expect(errorEvents[0]!.error).toEqual(error);
    expect(typeof errorEvents[0]!.durationMs).toBe("number");
    expect(errorEvents[0]!.res).toBeUndefined();
  });

  it("logs all three phases in correct order (request, then response)", async () => {
    const events: LogEvent[] = [];
    const logger = (event: LogEvent) => events.push(event);
    const response = makeResponse();
    const client = mockClient(response);

    const loggingClient = withLogging(logger)(client);
    await runExit(loggingClient(makeRequest()));

    expect(events).toHaveLength(2);
    expect(events[0]!.phase).toBe("request");
    expect(events[1]!.phase).toBe("response");
  });

  it("logs request then error phase on failure", async () => {
    const events: LogEvent[] = [];
    const logger = (event: LogEvent) => events.push(event);
    const error: HttpError = { _tag: "FetchError", message: "network down" };
    const client = failingClient(error);

    const loggingClient = withLogging(logger)(client);
    await runExit(loggingClient(makeRequest()));

    expect(events).toHaveLength(2);
    expect(events[0]!.phase).toBe("request");
    expect(events[1]!.phase).toBe("error");
  });

  it("swallows logger errors without affecting the request", async () => {
    const logger = (_event: LogEvent) => {
      throw new Error("logger crashed");
    };
    const response = makeResponse("still works");
    const client = mockClient(response);

    const loggingClient = withLogging(logger)(client);
    const exit = await runExit(loggingClient(makeRequest()));

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value).toEqual(response);
    }
  });
});

describe("withResponseTransform", () => {
  it("transforms response body", async () => {
    const response = makeResponse('{"name":"test"}');
    const client = mockClient(response);

    const transformClient = withResponseTransform((res, _req) => ({
      ...res,
      bodyText: res.bodyText.toUpperCase(),
    }))(client);

    const exit = await runExit(transformClient(makeRequest()));

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.bodyText).toBe('{"NAME":"TEST"}');
      expect(exit.value.status).toBe(200);
    }
  });

  it("receives both response and request in transform function", async () => {
    const response = makeResponse("data");
    const client = mockClient(response);
    let receivedReq: HttpRequest | undefined;
    let receivedRes: HttpWireResponse | undefined;

    const transformClient = withResponseTransform((res, req) => {
      receivedReq = req;
      receivedRes = res;
      return res;
    })(client);

    const req = makeRequest({ url: "/specific" });
    await runExit(transformClient(req));

    expect(receivedReq).toEqual(req);
    expect(receivedRes).toEqual(response);
  });

  it("propagates transform function errors as FetchError", async () => {
    const response = makeResponse("data");
    const client = mockClient(response);

    const transformClient = withResponseTransform((_res, _req) => {
      throw new Error("transform failed");
    })(client);

    const exit = await runExit(transformClient(makeRequest()));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("FetchError");
      expect((exit.cause.error as any).message).toContain("transform failed");
    }
  });

  it("does not transform on upstream error", async () => {
    const error: HttpError = { _tag: "Timeout", timeoutMs: 3000, message: "timeout" };
    const client = failingClient(error);
    let transformCalled = false;

    const transformClient = withResponseTransform((res, _req) => {
      transformCalled = true;
      return res;
    })(client);

    const exit = await runExit(transformClient(makeRequest()));

    expect(exit._tag).toBe("Failure");
    expect(transformCalled).toBe(false);
  });
});

describe("middleware error short-circuits chain", () => {
  it("middleware error prevents downstream middleware from executing", async () => {
    const response = makeResponse();
    const { client, captured } = capturingClient(response);
    const error: HttpError = { _tag: "FetchError", message: "auth failed" };

    // withAuth that fails should prevent the request from reaching the client
    const tokenProvider = () => asyncFail(error) as Async<unknown, HttpError, string>;
    const authedClient = withAuth(tokenProvider)(client);

    const exit = await runExit(authedClient(makeRequest()));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toEqual(error);
    }
    // The downstream client was never called
    expect(captured).toHaveLength(0);
  });

  it("chained middleware: first failing middleware short-circuits all subsequent", async () => {
    const response = makeResponse();
    const { client, captured } = capturingClient(response);
    const error: HttpError = { _tag: "FetchError", message: "token expired" };

    // Chain: withAuth (fails) -> withLogging -> client
    const logEvents: LogEvent[] = [];
    const tokenProvider = () => asyncFail(error) as Async<unknown, HttpError, string>;

    // Apply logging first (outermost), then auth (innermost before client)
    const loggingMw = withLogging((e) => logEvents.push(e));
    const authMw = withAuth(tokenProvider);

    // Composition: logging wraps auth wraps client
    // Request path: logging -> auth -> client
    const composed = loggingMw(authMw(client));

    const exit = await runExit(composed(makeRequest()));

    expect(exit._tag).toBe("Failure");
    // Client was never called because auth failed
    expect(captured).toHaveLength(0);
    // Logging should still have logged the request phase (it's outermost)
    // and the error phase (since the inner chain failed)
    const requestPhases = logEvents.filter((e) => e.phase === "request");
    const errorPhases = logEvents.filter((e) => e.phase === "error");
    expect(requestPhases).toHaveLength(1);
    expect(errorPhases).toHaveLength(1);
    if (errorPhases[0]) {
      expect(errorPhases[0].error).toEqual(error);
    }
  });
});
