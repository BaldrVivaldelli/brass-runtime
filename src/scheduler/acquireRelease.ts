import {Async, asyncFlatMap, asyncSucceed} from "../types/asyncEffect";
import {Exit} from "../types/effect";
import {Scope} from "./scope";

/**
 * acquireRelease:
 *   acquire: Async<R, E, A>
 *   release: (A, Exit) => Async<R, never, void>
 */
export function acquireRelease<R, E, A>(
    acquire: Async<R, E, A>,
    release: (res: A, exit: Exit<E, any>) => Async<R, any, any>,
    scope: Scope<R>
): Async<R, E, A> {
    return asyncFlatMap(acquire, (resource) => {
        // registrar finalizer
        scope.addFinalizer((exit) => release(resource, exit));

        return asyncSucceed(resource);
    });
}
