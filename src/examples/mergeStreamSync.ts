import { collectStream, fromArray, merge } from "../stream/stream";
import {toPromise} from "../runtime/runtime";
import {Async} from "../types/asyncEffect";

async function main() {
    console.log("== merge test start ==");

    const s1 = fromArray([1, 2, 3]);
    const s2 = fromArray([10, 20, 30]);

    const merged = merge(s1, s2);

    console.log("before toPromise");

    const eff = collectStream(merged) as any as Async<any, any, number[]>;
    const out = await toPromise(eff, {} as any);


    console.log("after toPromise");
    console.log("raw:", out);

    const sorted = [...out].sort((a, b) => a - b);
    console.log("sorted:", sorted);

    const ok = JSON.stringify(sorted) === JSON.stringify([1, 2, 3, 10, 20, 30]);
    console.log("ok:", ok);

    console.log("== merge test end ==");
}

main().catch((e) => {
    console.error("Unhandled:", e);
    process.exit(1);
});
