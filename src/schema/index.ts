export type SchemaPathPart = string | number;

export type SchemaIssue = {
  readonly path: readonly SchemaPathPart[];
  readonly expected: string;
  readonly received: string;
  readonly message: string;
};

export type SchemaResult<A> =
  | { readonly success: true; readonly data: A }
  | { readonly success: false; readonly issues: readonly SchemaIssue[] };

export type Schema<A, Optional extends boolean = false> = {
  readonly _tag: "Schema";
  readonly kind: string;
  readonly name?: string;
  readonly isOptional: Optional;
  readonly _parse: (input: unknown, path: readonly SchemaPathPart[]) => SchemaResult<A>;
  readonly safeParse: (input: unknown) => SchemaResult<A>;
  readonly parse: (input: unknown) => A;
  readonly optional: () => Schema<A | undefined, true>;
  readonly nullable: () => Schema<A | null, Optional>;
  readonly array: () => Schema<A[], false>;
  readonly refine: (predicate: (value: A) => boolean, message?: string) => Schema<A, Optional>;
  readonly transform: <B>(fn: (value: A) => B, expected?: string) => Schema<B, false>;
};

export type AnySchema = Schema<any, any>;
export type InferSchema<S> = S extends Schema<infer A, any> ? A : never;
export type SchemaShape = Record<string, AnySchema>;

type OptionalKeys<Shape extends SchemaShape> = {
  [K in keyof Shape]: Shape[K] extends Schema<any, true> ? K : never;
}[keyof Shape];

type RequiredKeys<Shape extends SchemaShape> = Exclude<keyof Shape, OptionalKeys<Shape>>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferObject<Shape extends SchemaShape> = Simplify<
  { [K in RequiredKeys<Shape>]: InferSchema<Shape[K]> } &
    { [K in OptionalKeys<Shape>]?: Exclude<InferSchema<Shape[K]>, undefined> }
>;

export type JsonValidatorResult<A> =
  | { readonly success: true; readonly data: A }
  | { readonly success: false; readonly error: string; readonly issues?: readonly SchemaIssue[] };

export type JsonValidator<A> = (data: unknown) => JsonValidatorResult<A>;
export type JsonSchemaLike<A> = Schema<A, any> | JsonValidator<A>;
export type AnyJsonSchemaLike = JsonSchemaLike<any>;
export type InferJsonSchema<V> =
  V extends Schema<infer A, any> ? A :
  V extends JsonValidator<infer A> ? A :
  never;

export type StringSchemaOptions = {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly name?: string;
};

export type NumberSchemaOptions = {
  readonly min?: number;
  readonly max?: number;
  readonly int?: boolean;
  readonly finite?: boolean;
  readonly name?: string;
};

export type ObjectSchemaOptions = {
  readonly unknownKeys?: "strip" | "passthrough" | "strict";
  readonly name?: string;
};

export class SchemaValidationException extends Error {
  readonly issues: readonly SchemaIssue[];

  constructor(issues: readonly SchemaIssue[]) {
    super(formatIssues(issues));
    this.name = "SchemaValidationException";
    this.issues = issues;
  }
}

export class ConfigValidationError extends Error {
  readonly _tag = "ConfigValidationError";
  readonly configName: string;
  readonly issues: readonly SchemaIssue[];

  constructor(configName: string, issues: readonly SchemaIssue[]) {
    super(`${configName} failed validation: ${formatIssues(issues)}`);
    this.name = "ConfigValidationError";
    this.configName = configName;
    this.issues = issues;
  }
}

const ok = <A>(data: A): SchemaResult<A> => ({ success: true, data });
const fail = (issues: readonly SchemaIssue[]): SchemaResult<never> => ({ success: false, issues });

const receivedKind = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return typeof value;
};

const pathLabel = (path: readonly SchemaPathPart[]): string =>
  path.length === 0
    ? "$"
    : path.reduce<string>((acc, part) => (
        typeof part === "number" ? `${acc}[${part}]` : `${acc}.${part}`
      ), "$");

export const makeSchemaIssue = (
  path: readonly SchemaPathPart[],
  expected: string,
  received: unknown,
  message?: string,
): SchemaIssue => ({
  path,
  expected,
  received: receivedKind(received),
  message: message ?? `Expected ${expected} at ${pathLabel(path)}, received ${receivedKind(received)}`,
});

export function formatIssues(issues: readonly SchemaIssue[]): string {
  if (issues.length === 0) return "Validation failed";
  const preview = issues
    .slice(0, 3)
    .map((issue) => `${pathLabel(issue.path)}: ${issue.message}`)
    .join("; ");
  return issues.length > 3 ? `${preview}; +${issues.length - 3} more` : preview;
}

function makeSchema<A, Optional extends boolean>(
  kind: string,
  isOptional: Optional,
  parser: (input: unknown, path: readonly SchemaPathPart[]) => SchemaResult<A>,
  name?: string,
): Schema<A, Optional> {
  const self: Schema<A, Optional> = {
    _tag: "Schema",
    kind,
    name,
    isOptional,
    _parse: parser,
    safeParse: (input) => parser(input, []),
    parse: (input) => {
      const result = parser(input, []);
      if (result.success) return result.data;
      throw new SchemaValidationException(result.issues);
    },
    optional: () =>
      makeSchema<A | undefined, true>(
        `${kind}.optional`,
        true,
        (input, path) => input === undefined ? ok(undefined) : parser(input, path),
        name,
      ),
    nullable: () =>
      makeSchema<A | null, Optional>(
        `${kind}.nullable`,
        isOptional,
        (input, path) => input === null ? ok(null) : parser(input, path),
        name,
      ),
    array: () => arraySchema(self),
    refine: (predicate, message) =>
      makeSchema<A, Optional>(
        `${kind}.refine`,
        isOptional,
        (input, path) => {
          const result = parser(input, path);
          if (!result.success) return result;
          return predicate(result.data)
            ? result
            : fail([makeSchemaIssue(path, name ?? kind, result.data, message ?? `Failed refinement for ${name ?? kind}`)]);
        },
        name,
      ),
    transform: (fn, expected) =>
      makeSchema(
        `${kind}.transform`,
        false,
        (input, path) => {
          const result = parser(input, path);
          if (!result.success) return result;
          try {
            return ok(fn(result.data));
          } catch (error) {
            return fail([
              makeSchemaIssue(
                path,
                expected ?? `transform(${name ?? kind})`,
                result.data,
                error instanceof Error ? error.message : String(error),
              ),
            ]);
          }
        },
        expected ?? name,
      ),
  };
  return self;
}

function stringSchema(options: StringSchemaOptions = {}): Schema<string> {
  return makeSchema("string", false, (input, path) => {
    if (typeof input !== "string") return fail([makeSchemaIssue(path, options.name ?? "string", input)]);
    if (options.minLength !== undefined && input.length < options.minLength) {
      return fail([makeSchemaIssue(path, `string length >= ${options.minLength}`, input, `Expected at least ${options.minLength} characters`)]);
    }
    if (options.maxLength !== undefined && input.length > options.maxLength) {
      return fail([makeSchemaIssue(path, `string length <= ${options.maxLength}`, input, `Expected at most ${options.maxLength} characters`)]);
    }
    if (options.pattern && !options.pattern.test(input)) {
      return fail([makeSchemaIssue(path, `string matching ${String(options.pattern)}`, input)]);
    }
    return ok(input);
  }, options.name);
}

function nonEmptyStringSchema(options: Omit<StringSchemaOptions, "minLength"> = {}): Schema<string> {
  return stringSchema({
    ...options,
    minLength: 1,
    name: options.name ?? "non-empty string",
  });
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function emailSchema(): Schema<string> {
  return stringSchema({ pattern: EMAIL_PATTERN, name: "email" });
}

function uuidSchema(): Schema<string> {
  return stringSchema({ pattern: UUID_PATTERN, name: "uuid" });
}

function urlSchema(): Schema<string> {
  return stringSchema({ name: "url" }).refine((value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, "Expected valid URL");
}

function dateIsoSchema(): Schema<string> {
  return stringSchema({ pattern: ISO_DATE_PATTERN, name: "ISO date" })
    .refine((value) => Number.isFinite(Date.parse(value)), "Expected valid ISO date string");
}

function numberSchema(options: NumberSchemaOptions = {}): Schema<number> {
  const finite = options.finite ?? true;
  return makeSchema("number", false, (input, path) => {
    if (typeof input !== "number" || Number.isNaN(input)) return fail([makeSchemaIssue(path, options.name ?? "number", input)]);
    if (finite && !Number.isFinite(input)) return fail([makeSchemaIssue(path, "finite number", input)]);
    if (options.int && !Number.isInteger(input)) return fail([makeSchemaIssue(path, "integer", input)]);
    if (options.min !== undefined && input < options.min) return fail([makeSchemaIssue(path, `number >= ${options.min}`, input)]);
    if (options.max !== undefined && input > options.max) return fail([makeSchemaIssue(path, `number <= ${options.max}`, input)]);
    return ok(input);
  }, options.name);
}

function intSchema(options: Omit<NumberSchemaOptions, "int"> = {}): Schema<number> {
  return numberSchema({
    ...options,
    int: true,
    name: options.name ?? "integer",
  });
}

function positiveSchema(options: NumberSchemaOptions = {}): Schema<number> {
  const min = Math.max(options.min ?? 0, 0);
  return numberSchema({
    ...options,
    min,
    name: options.name ?? "positive number",
  }).refine((value) => value > 0, "Expected positive number");
}

function booleanSchema(name?: string): Schema<boolean> {
  return makeSchema("boolean", false, (input, path) =>
    typeof input === "boolean" ? ok(input) : fail([makeSchemaIssue(path, name ?? "boolean", input)]),
  name);
}

function unknownSchema(): Schema<unknown> {
  return makeSchema("unknown", false, (input) => ok(input));
}

function anySchema(): Schema<any> {
  return makeSchema("any", false, (input) => ok(input));
}

function literalSchema<const Value extends string | number | boolean | null>(value: Value): Schema<Value> {
  return makeSchema(`literal(${JSON.stringify(value)})`, false, (input, path) =>
    Object.is(input, value)
      ? ok(value)
      : fail([makeSchemaIssue(path, JSON.stringify(value), input)]),
  );
}

function enumSchema<const Values extends readonly [string | number, ...(string | number)[]]>(
  values: Values,
): Schema<Values[number]> {
  const allowed = new Set<string | number>(values);
  const expected = values.map((value) => JSON.stringify(value)).join(" | ");
  return makeSchema(`enum(${expected})`, false, (input, path) =>
    (typeof input === "string" || typeof input === "number") && allowed.has(input)
      ? ok(input as Values[number])
      : fail([makeSchemaIssue(path, expected, input)]),
  );
}

function arraySchema<S extends AnySchema>(item: S): Schema<Array<InferSchema<S>>> {
  return makeSchema("array", false, (input, path) => {
    if (!Array.isArray(input)) return fail([makeSchemaIssue(path, "array", input)]);

    const out: Array<InferSchema<S>> = [];
    const issues: SchemaIssue[] = [];
    input.forEach((value, index) => {
      const result = item._parse(value, [...path, index]);
      if (result.success) {
        out.push(result.data);
      } else {
        issues.push(...result.issues);
      }
    });
    return issues.length > 0 ? fail(issues) : ok(out);
  });
}

function objectSchema<Shape extends SchemaShape>(
  shape: Shape,
  options: ObjectSchemaOptions = {},
): Schema<InferObject<Shape>> {
  const unknownKeys = options.unknownKeys ?? "strip";
  return makeSchema("object", false, (input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return fail([makeSchemaIssue(path, options.name ?? "object", input)]);
    }

    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = unknownKeys === "passthrough" ? { ...source } : {};
    const issues: SchemaIssue[] = [];
    const knownKeys = new Set(Object.keys(shape));

    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (!(key in source)) {
        if (!fieldSchema.isOptional) {
          issues.push(makeSchemaIssue([...path, key], fieldSchema.name ?? fieldSchema.kind, undefined, "Required field is missing"));
        }
        continue;
      }

      const result = fieldSchema._parse(source[key], [...path, key]);
      if (result.success) {
        out[key] = result.data;
      } else {
        issues.push(...result.issues);
      }
    }

    if (unknownKeys === "strict") {
      for (const key of Object.keys(source)) {
        if (!knownKeys.has(key)) {
          issues.push(makeSchemaIssue([...path, key], "known key", source[key], "Unknown key is not allowed"));
        }
      }
    }

    return issues.length > 0 ? fail(issues) : ok(out as InferObject<Shape>);
  }, options.name);
}

function recordSchema<S extends AnySchema>(valueSchema: S): Schema<Record<string, InferSchema<S>>> {
  return makeSchema("record", false, (input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return fail([makeSchemaIssue(path, "record", input)]);
    }

    const out: Record<string, InferSchema<S>> = {};
    const issues: SchemaIssue[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const result = valueSchema._parse(value, [...path, key]);
      if (result.success) {
        out[key] = result.data;
      } else {
        issues.push(...result.issues);
      }
    }
    return issues.length > 0 ? fail(issues) : ok(out);
  });
}

function unionSchema<const Members extends readonly [AnySchema, AnySchema, ...AnySchema[]]>(
  members: Members,
): Schema<InferSchema<Members[number]>> {
  const expected = members.map((member) => member.name ?? member.kind).join(" | ");
  return makeSchema("union", false, (input, path) => {
    const branchIssues: Array<readonly SchemaIssue[]> = [];
    for (const member of members) {
      const result = member._parse(input, path);
      if (result.success) return ok(result.data as InferSchema<Members[number]>);
      branchIssues.push(result.issues);
    }

    const mostSpecific = branchIssues
      .flatMap((issues) => issues)
      .filter((issue) => issue.path.length > path.length)
      .sort((a, b) => b.path.length - a.path.length);
    if (mostSpecific.length > 0) return fail(mostSpecific);

    return fail([makeSchemaIssue(path, expected, input)]);
  });
}

function customSchema<A>(
  guard: (input: unknown) => input is A,
  expected: string,
  message?: string,
): Schema<A> {
  return makeSchema(expected, false, (input, path) =>
    guard(input) ? ok(input) : fail([makeSchemaIssue(path, expected, input, message)]),
  expected);
}

export const schema = Object.freeze({
  string: stringSchema,
  nonEmptyString: nonEmptyStringSchema,
  email: emailSchema,
  url: urlSchema,
  uuid: uuidSchema,
  dateIso: dateIsoSchema,
  number: numberSchema,
  int: intSchema,
  positive: positiveSchema,
  boolean: booleanSchema,
  literal: literalSchema,
  enum: enumSchema,
  array: arraySchema,
  object: objectSchema,
  record: recordSchema,
  union: unionSchema,
  optional: <S extends AnySchema>(inner: S): Schema<InferSchema<S> | undefined, true> => inner.optional(),
  nullable: <S extends AnySchema>(inner: S): Schema<InferSchema<S> | null, S["isOptional"]> => inner.nullable(),
  unknown: unknownSchema,
  any: anySchema,
  custom: customSchema,
});

export const s = schema;
export const Schema = schema;

export function isSchema(value: unknown): value is AnySchema {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any)._tag === "Schema" &&
    typeof (value as any).safeParse === "function" &&
    typeof (value as any)._parse === "function"
  );
}

export function validateValue<A>(data: unknown, validator: JsonSchemaLike<A>): SchemaResult<A> {
  if (isSchema(validator)) return validator.safeParse(data) as SchemaResult<A>;

  const result = validator(data);
  if (result.success) return ok(result.data);
  return fail(result.issues ?? [makeSchemaIssue([], "valid JSON shape", data, result.error)]);
}

export function parseConfig<A>(
  configName: string,
  validator: JsonSchemaLike<A>,
  value: unknown,
): A {
  const result = validateValue(value, validator);
  if (result.success) return result.data;
  throw new ConfigValidationError(configName, result.issues);
}
