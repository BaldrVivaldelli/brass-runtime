// src/resourceExample.ts

import {
    acquireRelease,
    async,
    Async,
    asyncFlatMap,
    asyncSucceed,
    asyncTotal,
} from "../core/types/asyncEffect";
import { Exit } from "../core/types/effect";
import { Runtime } from "../core/runtime/runtime";
import { withScope } from "../core/runtime/scope";

type Env = {};

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
        },
    };
}

function sleep(ms: number): Async<unknown, never, void> {
    return async((_, cb: (exit: Exit<never, void>) => void) => {
        const t = setTimeout(() => cb({ _tag: "Success", value: undefined }), ms);
        return () => clearTimeout(t);
    });
}

function main() {
    const env: Env = {};
    const runtime = new Runtime({ env });

    withScope(runtime, (scope) => {
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
                asyncFlatMap(sleep(1000), () => asyncSucceed(`Using ${fh.name}`))
            )
        );

        // cancel whole scope early (to force cleanup)
        setTimeout(() => {
            console.log("Cancelling scope manually...");
            scope.close();
        }, 500);
    });
}

main();
