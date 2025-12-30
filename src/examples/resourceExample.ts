// src/resourceExample.ts

import {withScope} from "../scheduler/scope";
import {acquireRelease, async, Async, asyncFlatMap, asyncSucceed, asyncTotal} from "../types/asyncEffect";
import {Exit} from "../types/effect";

type FileHandle = {
    name: string;
    closed: boolean;
    close: () => void;
};

function openFile(name: string): FileHandle {
    console.log("OPEN FILE:", name);
    return {
        name,
        closed: false,
        close() {
            console.log("CLOSE FILE:", name);
            this.closed = true;
        }
    };
}

function main() {
    withScope(scope => {
        const env = {};
        const program =
            acquireRelease(
                asyncTotal(() => openFile("data.txt")),
                (file, exit: Exit<any, any>) =>
                    asyncTotal(() => {
                        console.log("Finalizer running due to:", exit._tag);
                        file.close();
                    }),
                scope
            );

        // use the resource
        scope.fork(
            asyncFlatMap(program, (fh) =>
                asyncFlatMap(sleep(1000), () =>
                    asyncSucceed(`Using ${fh.name}`)
                )
            ),
            env
        );

        // cancel whole scope early (to force cleanup)
        setTimeout(() => {
            console.log("Cancelling scope manually...");
            scope.close();
        }, 500);
    });
}
function sleep(ms: number): Async<unknown, never, void> {
    return async((_, cb: (exit: Exit<never, void>) => void) => {
        setTimeout(() => {
            cb({ _tag: "Success", value: undefined });
        }, ms);
    });
}
main();
