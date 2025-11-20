export type None = { readonly _tag: "None" };
export type Some<A> = { readonly _tag: "Some"; readonly value: A };

export type Option<A> = None | Some<A>;

export const none: Option<never> = { _tag: "None" };

export const some = <A>(value: A): Option<A> => ({ _tag: "Some", value });
