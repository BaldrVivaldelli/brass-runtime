// tests/httpScopeAsync.spec.ts (o scripts/httpScopeAsync.test.ts)

import { httpClientWithMeta } from "../http";
import { withScopeAsync } from "../core/runtime/scope";
import { zipPar } from "../core/stream/structuredConcurrency";
import { Runtime } from "../core/runtime/runtime";
import { Scope } from "../core/runtime/scope";

type Post = { id: number; userId: number; title: string; body: string };
type NewPost = Omit<Post, "id">;

const baseUrl = "https://jsonplaceholder.typicode.com";
type Env = {}; // tu R real

// ------------------------
// helpers de aserción
// ------------------------
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function deepEqual(a: any, b: any) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertDeepEqual(actual: unknown, expected: unknown, msg: string) {
  if (!deepEqual(actual, expected)) {
    console.error("Expected:", expected);
    console.error("Actual  :", actual);
    throw new Error(`ASSERT FAIL: ${msg}`);
  }
}

async function run(name: string, f: () => Promise<void>) {
  try {
    await f();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}`);
    throw e;
  }
}

// ------------------------
// helpers del test
// ------------------------
function getStatus(x: any): number | undefined {
  return x?.status ?? x?.wire?.status ?? x?.response?.status;
}

function getBody(x: any): any {
  return x?.body ?? x?.response?.body ?? x?.wire?.body;
}

// ------------------------
// tests
// ------------------------
async function test_zipPar_withScopeAsync_twoPosts() {
  const env: Env = {};
  const runtime = new Runtime<Env>({ env });

  const http = httpClientWithMeta({ baseUrl });
  const postBody: NewPost = { title: "foo", body: "bar", userId: 1 };

  const e1 = http.postJson("/posts", postBody, { headers: { accept: "application/json" } });
  const e2 = http.postJson("/posts", postBody, { headers: { accept: "application/json" } });

  // ✅ Runtime-only: withScopeAsync(runtime, ...)
  const program = withScopeAsync(runtime, (parentScope) => zipPar(e1, e2, parentScope));

  // ✅ Runtime-only: runtime.toPromise(program)
  const [r1, r2] = await runtime.toPromise(program);

  const s1 = getStatus(r1);
  const s2 = getStatus(r2);

  assertDeepEqual(s1, 201, "r1.status should be 201");
  assertDeepEqual(s2, 201, "r2.status should be 201");

  const b1 = getBody(r1) as Post | undefined;
  const b2 = getBody(r2) as Post | undefined;

  assert(!!b1, "r1 should have body");
  assert(!!b2, "r2 should have body");
  assert(typeof b1!.id === "number", "r1.body.id should be number");
  assert(typeof b2!.id === "number", "r2.body.id should be number");
}

// Opcional: comparación con el equivalente manual
async function test_zipPar_manualScope_equivalent() {
  const env: Env = {};
  const runtime = new Runtime<Env>({ env });

  const http = httpClientWithMeta({ baseUrl });
  const postBody: NewPost = { title: "foo", body: "bar", userId: 1 };

  const e1 = http.postJson("/posts", postBody, { headers: { accept: "application/json" } });
  const e2 = http.postJson("/posts", postBody, { headers: { accept: "application/json" } });

  // ✅ Runtime-only: Scope(runtime)
  const parentScope = new Scope(runtime);
  try {
    const program = zipPar(e1, e2, parentScope);
    const [r1, r2] = await runtime.toPromise(program);

    const s1 = getStatus(r1);
    const s2 = getStatus(r2);

    assertDeepEqual(s1, 201, "manual r1.status should be 201");
    assertDeepEqual(s2, 201, "manual r2.status should be 201");
  } finally {
    parentScope.close();
  }
}

// ------------------------
// runner
// ------------------------
(async () => {
  await run("zipPar + withScopeAsync (2 POST)", test_zipPar_withScopeAsync_twoPosts);
  await run("zipPar + manual Scope equivalence", test_zipPar_manualScope_equivalent);

  console.log("\nAll http/scope tests passed ✅");
})().catch((e) => {
  console.error("Unhandled:", e);
  process.exit(1);
});
