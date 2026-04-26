import { asyncFail, asyncFold, asyncSucceed, type Async } from "../../core/types/asyncEffect";

export const retry = <R, E, A>(
    make: () => Async<R, E, A>,
    options: { readonly times: number; readonly while: (error: E) => boolean }
): Async<R, E, A> => {
    const loop = (remaining: number): Async<R, E, A> =>
        asyncFold(
            make(),
            (error) => {
                if (remaining > 0 && options.while(error)) return loop(remaining - 1);
                return asyncFail(error) as any;
            },
            (value) => asyncSucceed(value) as any
        ) as any;

    return loop(options.times);
};
