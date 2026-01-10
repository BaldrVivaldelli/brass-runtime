// src/http/optics/lens.ts
export type Lens<S, A> = {
    readonly get: (s: S) => A
    readonly set: (a: A) => (s: S) => S
}

export const Lens = {
    make<S, A>(get: (s: S) => A, set: (a: A) => (s: S) => S): Lens<S, A> {
        return { get, set }
    },

    over<S, A>(ln: Lens<S, A>, f: (a: A) => A): (s: S) => S {
        return (s) => ln.set(f(ln.get(s)))(s)
    },

    compose<S, A, B>(ab: Lens<A, B>, sa: Lens<S, A>): Lens<S, B> {
        return Lens.make(
            (s) => ab.get(sa.get(s)),
            (b) => (s) => sa.set(ab.set(b)(sa.get(s)))(s)
        )
    }
}
