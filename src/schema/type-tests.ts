import { Schema, s, type InferSchema } from "./index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

type Expect<T extends true> = T;

const User = s.object({
  id: s.number({ int: true }),
  name: s.string(),
  role: s.enum(["admin", "user"] as const).optional(),
  tags: Schema.array(Schema.string()),
});

type User = InferSchema<typeof User>;

type _userShape = Expect<Equal<User, {
  id: number;
  name: string;
  tags: string[];
  role?: "admin" | "user";
}>>;

const userOk: User = {
  id: 1,
  name: "Ada",
  tags: ["ops"],
};

const userWithRole: User = {
  ...userOk,
  role: "admin",
};

void userWithRole;

// @ts-expect-error role is constrained by the enum schema.
const userBadRole: User = { ...userOk, role: "owner" };

void userBadRole;

// @ts-expect-error required fields remain required after inference.
const userMissingName: User = { id: 1, tags: [] };

void userMissingName;

const MaybePort = s.number({ int: true }).optional();

type _optionalShape = Expect<Equal<InferSchema<typeof MaybePort>, number | undefined>>;

const Transform = s.string().transform((value) => Number(value));

type _transformShape = Expect<Equal<InferSchema<typeof Transform>, number>>;
