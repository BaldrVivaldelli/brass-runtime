import type { Async, RestoreInterruptibility } from "./asyncEffect";
import { asyncFail, asyncFlatMap, asyncFold, asyncMap, asyncMapError, asyncSucceed, asyncSync } from "./asyncEffect";
import type { Option } from "./option";
import { none, some } from "./option";

export type Cause<E> =
    | { readonly _tag: "Fail"; readonly error: E }
    | { readonly _tag: "Interrupt" }
    | { readonly _tag: "Die"; readonly defect: unknown }
    | { readonly _tag: "Then"; readonly left: Cause<E>; readonly right: Cause<E> }
    | { readonly _tag: "Both"; readonly left: Cause<E>; readonly right: Cause<E> };

export type CausePrettyOptions<E = unknown> = {
    readonly renderError?: (error: E) => string;
    readonly renderDefect?: (defect: unknown) => string;
    readonly indent?: string;
    readonly singleLine?: boolean;
};

export const Cause = {
    fail: <E>(error: E): Cause<E> => ({ _tag: "Fail", error }),
    interrupt: <E = never>(): Cause<E> => ({ _tag: "Interrupt" }),
    die: <E = never>(defect: unknown): Cause<E> => ({ _tag: "Die", defect }),
    then: <E, E2>(left: Cause<E>, right: Cause<E2>): Cause<E | E2> => ({ _tag: "Then", left, right } as Cause<E | E2>),
    both: <E, E2>(left: Cause<E>, right: Cause<E2>): Cause<E | E2> => ({ _tag: "Both", left, right } as Cause<E | E2>),
    isCause: isCauseValue,
    failures: causeFailures,
    defects: causeDefects,
    firstFailure: firstCauseFailure,
    firstDefect: firstCauseDefect,
    containsFailure: causeContainsFailure,
    containsDefect: causeContainsDefect,
    containsInterrupt: causeContainsInterrupt,
    isInterruptedOnly: causeIsInterruptedOnly,
    isFailureOnly: causeIsFailureOnly,
    squash: squashCause,
    toError: causeToError,
    pretty: prettyCause,
    format: prettyCause,
};

export function isCause(value: unknown): value is Cause<unknown> {
    return isCauseValue(value);
}

export function prettyCause<E>(cause: Cause<E>, options: CausePrettyOptions<E> = {}): string {
    const indent = options.indent ?? "  ";
    const renderError = options.renderError ?? ((error: E) => formatCauseValue(error));
    const renderDefect = options.renderDefect ?? formatCauseValue;
    const lines: string[] = [];

    const visit = (current: Cause<E>, depth: number, label?: string): void => {
        const prefix = indent.repeat(depth);
        const head = label ? `${label}: ` : "";
        switch (current._tag) {
            case "Fail":
                lines.push(`${prefix}${head}Fail(${renderError(current.error)})`);
                return;
            case "Die":
                lines.push(`${prefix}${head}Die(${renderDefect(current.defect)})`);
                return;
            case "Interrupt":
                lines.push(`${prefix}${head}Interrupt`);
                return;
            case "Then":
                lines.push(`${prefix}${head}Then`);
                visit(current.left, depth + 1, "left");
                visit(current.right, depth + 1, "right");
                return;
            case "Both":
                lines.push(`${prefix}${head}Both`);
                visit(current.left, depth + 1, "left");
                visit(current.right, depth + 1, "right");
                return;
        }
    };

    visit(cause, 0);
    if (options.singleLine) return lines.map((line) => line.trim()).join("; ");
    return lines.join("\n");
}

export const formatCause = prettyCause;

function isCauseValue(value: unknown): value is Cause<unknown> {
    if (typeof value !== "object" || value === null || !("_tag" in value)) return false;
    const tag = (value as any)._tag;
    switch (tag) {
        case "Fail":
            return "error" in value;
        case "Die":
            return "defect" in value;
        case "Interrupt":
            return true;
        case "Then":
        case "Both":
            return isCauseValue((value as any).left) && isCauseValue((value as any).right);
        default:
            return false;
    }
}

function causeFailures<E>(cause: Cause<E>): readonly E[] {
    const failures: E[] = [];
    collectFailures(cause, failures);
    return failures;
}

function collectFailures<E>(cause: Cause<E>, out: E[]): void {
    switch (cause._tag) {
        case "Fail":
            out.push(cause.error);
            return;
        case "Then":
        case "Both":
            collectFailures(cause.left, out);
            collectFailures(cause.right, out);
            return;
        case "Die":
        case "Interrupt":
            return;
    }
}

function causeDefects<E>(cause: Cause<E>): readonly unknown[] {
    const defects: unknown[] = [];
    collectDefects(cause, defects);
    return defects;
}

function collectDefects<E>(cause: Cause<E>, out: unknown[]): void {
    switch (cause._tag) {
        case "Die":
            out.push(cause.defect);
            return;
        case "Then":
        case "Both":
            collectDefects(cause.left, out);
            collectDefects(cause.right, out);
            return;
        case "Fail":
        case "Interrupt":
            return;
    }
}

function firstCauseFailure<E>(cause: Cause<E>): Option<E> {
    switch (cause._tag) {
        case "Fail":
            return some(cause.error);
        case "Then":
        case "Both": {
            const left = firstCauseFailure(cause.left);
            return left._tag === "Some" ? left : firstCauseFailure(cause.right);
        }
        case "Die":
        case "Interrupt":
            return none;
    }
}

function firstCauseDefect<E>(cause: Cause<E>): Option<unknown> {
    switch (cause._tag) {
        case "Die":
            return some(cause.defect);
        case "Then":
        case "Both": {
            const left = firstCauseDefect(cause.left);
            return left._tag === "Some" ? left : firstCauseDefect(cause.right);
        }
        case "Fail":
        case "Interrupt":
            return none;
    }
}

function causeContainsFailure<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case "Fail":
            return true;
        case "Then":
        case "Both":
            return causeContainsFailure(cause.left) || causeContainsFailure(cause.right);
        case "Die":
        case "Interrupt":
            return false;
    }
}

function causeContainsDefect<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case "Die":
            return true;
        case "Then":
        case "Both":
            return causeContainsDefect(cause.left) || causeContainsDefect(cause.right);
        case "Fail":
        case "Interrupt":
            return false;
    }
}

function causeContainsInterrupt<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case "Interrupt":
            return true;
        case "Then":
        case "Both":
            return causeContainsInterrupt(cause.left) || causeContainsInterrupt(cause.right);
        case "Fail":
        case "Die":
            return false;
    }
}

function causeIsInterruptedOnly<E>(cause: Cause<E>): boolean {
    return causeContainsInterrupt(cause) && !causeContainsFailure(cause) && !causeContainsDefect(cause);
}

function causeIsFailureOnly<E>(cause: Cause<E>): boolean {
    return causeContainsFailure(cause) && !causeContainsInterrupt(cause) && !causeContainsDefect(cause);
}

function squashCause<E>(cause: Cause<E>): unknown {
    const failure = firstCauseFailure(cause);
    if (failure._tag === "Some") return failure.value;
    const defect = firstCauseDefect(cause);
    if (defect._tag === "Some") return defect.value instanceof Error ? defect.value : new Error(String(defect.value));
    if (causeContainsInterrupt(cause)) return new Error("Interrupted");
    return new Error(prettyCause(cause, { singleLine: true }));
}

function causeToError<E>(cause: Cause<E>): Error {
    const squashed = squashCause(cause);
    if (squashed instanceof Error) return squashed;
    return new Error(formatCauseValue(squashed));
}

function formatCauseValue(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export type Exit<E, A> =
    | { _tag: "Success"; value: A }
    | { _tag: "Failure"; cause: Cause<E> };


export const Exit = {
    succeed: <E = never, A = never>(value: A): Exit<E, A> => ({
        _tag: "Success",
        value,
    }),

    failCause: <E = never, A = never>(cause: Cause<E>): Exit<E, A> => ({
        _tag: "Failure",
        cause,
    }),
};
export type ZIO<R, E, A> = Async<R, E, A>;

export const succeed = <A>(value: A): ZIO<unknown, never, A> => asyncSucceed(value);
export const fail = <E>(error: E): ZIO<unknown, E, never> => asyncFail(error);

export const sync = <R, A>(thunk: (env: R) => A): ZIO<R, unknown, A> =>
    asyncSync((env) => thunk(env));

export const map = <R, E, A, B>(fa: ZIO<R, E, A>, f: (a: A) => B) => asyncMap(fa, f);

export const flatMap = <R, E, A, R2, E2, B>(
    fa: ZIO<R, E, A>,
    f: (a: A) => ZIO<R2, E2, B>
): ZIO<R & R2, E | E2, B> =>
    asyncFlatMap(fa, f);

export const mapError = <R, E, E2, A>(fa: ZIO<R, E, A>, f: (e: E) => E2): ZIO<R, E2, A> =>
    asyncMapError(fa, f);

export const catchAll = <R, E, A, R2, E2, B>(
    fa: ZIO<R, E, A>,
    handler: (e: E) => ZIO<R2, E2, B>
): ZIO<R & R2, E2, A | B> =>
    asyncFold(fa, handler, asyncSucceed);

export const uninterruptible = <R, E, A>(effect: ZIO<R, E, A>): ZIO<R, E, A> => ({
    _tag: "Interruptibility",
    mode: "uninterruptible",
    effect,
});

export const interruptible = <R, E, A>(effect: ZIO<R, E, A>): ZIO<R, E, A> => ({
    _tag: "Interruptibility",
    mode: "interruptible",
    effect,
});

export function uninterruptibleMask<R, E, A>(
    body: (restore: RestoreInterruptibility) => ZIO<R, E, A>
): ZIO<R, E, A> {
    return { _tag: "InterruptibilityMask", body };
}

export function orElseOptional<R, E, A, R2, A2>(
    fa: ZIO<R, Option<E>, A>,
    that: () => ZIO<R2, Option<E>, A2>
): ZIO<R & R2, Option<E>, A | A2> {
    return asyncFold(
        fa,
        (opt) => (opt._tag === "Some" ? asyncFail(opt) : that()),
        asyncSucceed
    );
}

export const end = <E>(): ZIO<unknown, Option<E>, never> => fail(none as Option<E>);
