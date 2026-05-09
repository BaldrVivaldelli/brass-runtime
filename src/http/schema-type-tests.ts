import type { AsyncWithPromise } from "../core/types/asyncEffect";
import { asyncSucceed } from "../core/types/asyncEffect";
import type { HttpResponse } from "./httpClient";
import { makeDefaultHttpClient } from "./defaultClient";
import { json, route, type RoutePathParams } from "./server";
import { s, type InferSchema } from "../schema";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

type Expect<T extends true> = T;

type EffectValue<T> = T extends AsyncWithPromise<any, any, infer A> ? A : never;

const User = s.object({
  id: s.number({ int: true }),
  name: s.string(),
});
const CreateUser = s.object({
  name: s.string(),
});

declare const http: ReturnType<typeof makeDefaultHttpClient>;

const getUser = http.getJson("/users/1", { schema: User });
const postUser = http.postJson("/users", { name: "Ada" }, { schema: User });
const postUserWithBodySchema = http.postJson("/users", { name: "Ada" }, {
  bodySchema: CreateUser,
  schema: User,
});
const postUnknownWithBodySchema = http.postJson("/users", { name: "Ada" }, {
  bodySchema: CreateUser,
});
// @ts-expect-error bodySchema should type-check the request body before runtime.
http.postJson("/users", {}, { bodySchema: CreateUser });
// @ts-expect-error bodySchema should also constrain the body when a response schema is present.
http.postJson("/users", { bad: true }, { bodySchema: CreateUser, schema: User });
const getUnknown = http.getJson<{ raw: unknown }>("/raw");

type _getUserBody = Expect<Equal<
  EffectValue<typeof getUser>,
  HttpResponse<InferSchema<typeof User>>
>>;

type _postUserBody = Expect<Equal<
  EffectValue<typeof postUser>,
  HttpResponse<InferSchema<typeof User>>
>>;

type _postUserWithBodySchemaBody = Expect<Equal<
  EffectValue<typeof postUserWithBodySchema>,
  HttpResponse<InferSchema<typeof User>>
>>;

type _postUnknownWithBodySchemaBody = Expect<Equal<
  EffectValue<typeof postUnknownWithBodySchema>,
  HttpResponse<unknown>
>>;

type _getUnknownBody = Expect<Equal<
  EffectValue<typeof getUnknown>,
  HttpResponse<{ raw: unknown }>
>>;

type _routeParamsFromPath = Expect<Equal<
  RoutePathParams<"/users/:id/books/:bookId">,
  { readonly id: string; readonly bookId: string }
>>;

route("GET", "/users/:id/books/:bookId", (ctx) => {
  const userId: string = ctx.params.id;
  const bookId: string = ctx.params.bookId;
  // @ts-expect-error path params are inferred from the route pattern.
  ctx.params.missing;
  return asyncSucceed(json({ userId, bookId }));
});

route("GET", "/users/:id", {
  params: s.object({ id: s.int() }),
}, (ctx) => {
  const id: number = ctx.params.id;
  // @ts-expect-error params schema overrides raw path-param strings.
  const raw: string = ctx.params.id;
  return asyncSucceed(json({ id, raw }));
});
