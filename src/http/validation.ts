import type { HttpClientFn, HttpMiddleware, HttpWireResponse, HttpError } from "./client";
import { asyncFail, asyncFold, asyncSucceed } from "../core/types/asyncEffect";
import type { Async } from "../core/types/asyncEffect";

export type ValidationError = {
  _tag: "ValidationError";
  message: string;
  body: string;
  schema?: string;
};

export type JsonValidator<A> = (data: unknown) => { success: true; data: A } | { success: false; error: string };

/**
 * Creates a validated JSON getter that checks the response body against a schema.
 * 
 * Usage:
 * ```ts
 * const getUser = validatedJson<User>(client, (data) => {
 *   if (typeof data === "object" && data !== null && "id" in data) {
 *     return { success: true, data: data as User };
 *   }
 *   return { success: false, error: "Invalid user shape" };
 * });
 * 
 * const user = await run(getUser({ method: "GET", url: "/users/1" }));
 * ```
 */
export function validatedJson<A>(
  client: HttpClientFn,
  validator: JsonValidator<A>
): (req: Parameters<HttpClientFn>[0]) => Async<unknown, HttpError | ValidationError, A> {
  return (req) => asyncFold(
    client(req) as any,
    (error: HttpError) => asyncFail(error) as any,
    (response: any) => {
      try {
        const parsed = JSON.parse(response.bodyText);
        const result = validator(parsed);
        if (result.success) {
          return asyncSucceed(result.data) as any;
        }
        return asyncFail({
          _tag: "ValidationError" as const,
          message: result.error,
          body: response.bodyText,
        }) as any;
      } catch (e) {
        return asyncFail({
          _tag: "ValidationError" as const,
          message: `JSON parse error: ${String(e)}`,
          body: response.bodyText,
        }) as any;
      }
    }
  );
}
