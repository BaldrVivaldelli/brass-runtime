import type { HttpClientFn, HttpWireResponse, HttpError } from "./client";
import { asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";
import {
  formatIssues,
  isSchema,
  makeSchemaIssue,
  validateValue,
  type JsonSchemaLike,
  type SchemaIssue,
  type SchemaResult,
} from "../schema";

export * from "../schema";

export type ValidationError = {
  readonly _tag: "ValidationError";
  readonly message: string;
  readonly body: string;
  readonly issues: readonly SchemaIssue[];
  readonly phase?: "request" | "response";
  readonly schema?: string;
};

export type JsonDecodeResult<A> =
  | { readonly success: true; readonly data: A }
  | { readonly success: false; readonly error: ValidationError };

export function makeJsonParseValidationError(
  bodyText: string,
  error: unknown,
  options: { readonly schemaName?: string } = {},
): ValidationError {
  return {
    _tag: "ValidationError",
    message: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    body: bodyText,
    phase: "response",
    schema: options.schemaName,
    issues: [makeSchemaIssue([], "valid JSON", bodyText, "Response body is not valid JSON")],
  };
}

export function decodeJsonBody<A = unknown>(
  bodyText: string,
  validator?: JsonSchemaLike<A>,
  options: { readonly schemaName?: string } = {},
): JsonDecodeResult<A> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    return {
      success: false,
      error: makeJsonParseValidationError(bodyText, error, options),
    };
  }

  if (!validator) return { success: true, data: parsed as A };

  // Fast path: branch once instead of using IIFE
  let validation: SchemaResult<A>;
  let legacyMessage: string | undefined;
  if (isSchema(validator)) {
    validation = validator.safeParse(parsed) as SchemaResult<A>;
  } else {
    const result = validator(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }
    legacyMessage = result.error;
    validation = {
      success: false,
      issues: result.issues ?? [makeSchemaIssue([], "valid JSON shape", parsed, result.error)],
    };
  }

  if (validation.success) return { success: true, data: validation.data };

  return {
    success: false,
    error: {
      _tag: "ValidationError",
      message: legacyMessage ?? `JSON response failed validation: ${formatIssues(validation.issues)}`,
      body: bodyText,
      phase: "response",
      schema: options.schemaName,
      issues: validation.issues,
    },
  };
}

export function encodeJsonBodyEffect(
  bodyObj: unknown,
  validator?: JsonSchemaLike<any>,
  options: { readonly schemaName?: string } = {},
): Async<unknown, ValidationError, string> {
  if (validator) {
    const validation = validateValue(bodyObj, validator);
    if (!validation.success) {
      return asyncFail({
        _tag: "ValidationError",
        message: `JSON request body failed validation: ${formatIssues(validation.issues)}`,
        body: previewJson(bodyObj),
        phase: "request",
        schema: options.schemaName,
        issues: validation.issues,
      });
    }
  }

  try {
    return asyncSucceed(JSON.stringify(bodyObj ?? {}));
  } catch (error) {
    return asyncFail({
      _tag: "ValidationError",
      message: `JSON request body could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
      body: "",
      phase: "request",
      schema: options.schemaName,
      issues: [
        makeSchemaIssue([], "JSON-serializable value", bodyObj, "Request body could not be serialized to JSON"),
      ],
    });
  }
}

export function decodeJsonBodyEffect<A = unknown>(
  bodyText: string,
  validator?: JsonSchemaLike<A>,
  options?: { readonly schemaName?: string },
): Async<unknown, ValidationError, A> {
  // Fast path: no validator — parse JSON directly without intermediate result object
  if (!validator) {
    try {
      return asyncSucceed(JSON.parse(bodyText) as A);
    } catch (error) {
      return asyncFail(makeJsonParseValidationError(bodyText, error, options ?? {}));
    }
  }
  const result = decodeJsonBody(bodyText, validator, options);
  return result.success ? asyncSucceed(result.data) : asyncFail(result.error);
}

export function validatedJson<A>(
  client: HttpClientFn,
  validator: JsonSchemaLike<A>,
): (req: Parameters<HttpClientFn>[0]) => Async<unknown, HttpError | ValidationError, A> {
  return (req) => asyncFold(
    client(req) as any,
    (error: HttpError) => asyncFail(error) as any,
    (response: HttpWireResponse) => decodeJsonBodyEffect(response.bodyText, validator) as any,
  );
}

export function validatedJsonResponse<A>(
  client: HttpClientFn,
  validator: JsonSchemaLike<A>,
): (req: Parameters<HttpClientFn>[0]) => Async<unknown, HttpError | ValidationError, HttpWireResponse & { readonly body: A }> {
  return (req) => asyncFold(
    client(req) as any,
    (error: HttpError) => asyncFail(error) as any,
    (response: HttpWireResponse) =>
      asyncFlatMap(decodeJsonBodyEffect(response.bodyText, validator), (body) =>
        asyncSucceed({ ...response, body }),
      ) as any,
  );
}

function previewJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
