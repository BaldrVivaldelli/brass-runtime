import { performance } from "perf_hooks";
import { s } from "../src/schema/index";

const gc = (globalThis as any).gc as (() => void) | undefined;

const userSchema = s.object({
  id: s.number(),
  name: s.string(),
  email: s.email(),
  age: s.number().optional(),
  tags: s.array(s.string()),
});

const validData = {
  id: 1,
  name: "John",
  email: "john@example.com",
  age: 30,
  tags: ["admin", "user"],
};

const N = 50000;

function bench(name: string, fn: () => void) {
  // warmup
  for (let i = 0; i < 5000; i++) fn();
  if (gc) gc();
  const start = performance.now();
  for (let i = 0; i < N; i++) fn();
  const ms = performance.now() - start;
  const perOp = (ms * 1000) / N;
  console.log(`  ${name}: ${ms.toFixed(2)}ms total, ${perOp.toFixed(2)}μs/op`);
}

console.log("\n── Schema validation throughput ──\n");
bench("safeParse simple object (5 fields)", () => {
  userSchema.safeParse(validData);
});

const stringSchema = s.string();
bench("safeParse string", () => {
  stringSchema.safeParse("hello");
});

const numberSchema = s.number();
bench("safeParse number", () => {
  numberSchema.safeParse(42);
});

const nestedSchema = s.object({
  user: userSchema,
  meta: s.object({
    createdAt: s.string(),
    updatedAt: s.string(),
  }),
});
const nestedData = {
  user: validData,
  meta: { createdAt: "2024-01-01", updatedAt: "2024-01-02" },
};
bench("safeParse nested object", () => {
  nestedSchema.safeParse(nestedData);
});
