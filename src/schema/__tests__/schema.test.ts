import { describe, expect, it } from "vitest";

import {
  SchemaValidationException,
  formatIssues,
  s,
  validateValue,
} from "../index";

describe("schema", () => {
  it("validates and infers nested objects", () => {
    const User = s.object({
      id: s.number({ int: true, min: 1 }),
      name: s.string({ minLength: 1 }),
      role: s.enum(["admin", "user"] as const).optional(),
      tags: s.array(s.string()),
    });

    expect(User.safeParse({ id: 1, name: "Ada", tags: ["ops"] })).toEqual({
      success: true,
      data: { id: 1, name: "Ada", tags: ["ops"] },
    });

    const result = User.safeParse({ id: "1", name: "", tags: ["ok", 2] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.path)).toEqual([
        ["id"],
        ["name"],
        ["tags", 1],
      ]);
      expect(formatIssues(result.issues)).toContain("$.id");
    }
  });

  it("supports strict objects, unions, refinements, and transforms", () => {
    const PositiveId = s
      .union([s.string(), s.number({ int: true })])
      .transform((value) => Number(value), "numeric id")
      .refine((value) => value > 0, "id must be positive");

    expect(PositiveId.parse("42")).toBe(42);
    expect(() => PositiveId.parse("0")).toThrow(SchemaValidationException);

    const StrictUser = s.object({ id: PositiveId }, { unknownKeys: "strict" });
    const result = StrictUser.safeParse({ id: 1, extra: true });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]).toMatchObject({ path: ["extra"] });
    }

    const ToggleOrConfig = s.union([
      s.literal(false),
      s.object({ min: s.number({ min: 1 }) }),
    ]);
    const unionResult = ToggleOrConfig.safeParse({ min: 0 });

    expect(unionResult.success).toBe(false);
    if (!unionResult.success) {
      expect(unionResult.issues[0]).toMatchObject({ path: ["min"] });
    }
  });

  it("keeps custom validator compatibility in validateValue", () => {
    const result = validateValue({ ok: true }, (value) =>
      typeof value === "object" && value !== null && "ok" in value
        ? { success: true, data: value as { ok: boolean } }
        : { success: false, error: "missing ok" },
    );

    expect(result).toEqual({ success: true, data: { ok: true } });
  });

  it("provides common schema shortcuts", () => {
    expect(s.nonEmptyString().safeParse("Ada").success).toBe(true);
    expect(s.nonEmptyString().safeParse("").success).toBe(false);
    expect(s.email().safeParse("ada@example.com").success).toBe(true);
    expect(s.email().safeParse("nope").success).toBe(false);
    expect(s.url().safeParse("https://example.com/a").success).toBe(true);
    expect(s.url().safeParse("/relative").success).toBe(false);
    expect(s.uuid().safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
    expect(s.uuid().safeParse("not-a-uuid").success).toBe(false);
    expect(s.int().safeParse(3).success).toBe(true);
    expect(s.int().safeParse(3.14).success).toBe(false);
    expect(s.positive().safeParse(1).success).toBe(true);
    expect(s.positive().safeParse(0).success).toBe(false);
    expect(s.dateIso().safeParse("2026-05-09T12:30:00Z").success).toBe(true);
    expect(s.dateIso().safeParse("tomorrow-ish").success).toBe(false);
  });
});
