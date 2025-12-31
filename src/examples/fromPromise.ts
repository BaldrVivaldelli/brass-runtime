import {asyncFail, asyncSucceed, asyncFlatMap, fromPromiseAbortable, toPromise} from "../types/asyncEffect";
import { none } from "../types/option";
import {collectStream, fromPull, ZStream} from "../stream/stream";
import {buffer} from "../stream/buffer";

// delay abortable en Promise
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((res, rej) => {
        const t = setTimeout(res, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(t);
            rej(new Error("aborted"));
        });
    });
}

export function slowRangeFromPromise(
    start: number,
    end: number,
    msPerElem: number
): ZStream<unknown, never, number> {
    const go = (i: number): ZStream<unknown, never, number> =>
        fromPull(
            i > end
                ? asyncFail(none)
                : asyncFlatMap(
                    fromPromiseAbortable(
                        async (signal: AbortSignal) => {
                            await sleepAbortable(msPerElem, signal);
                            return i;
                        },
                        // en este stream no queremos “errores reales”, solo fin => never
                        () => (undefined as never)
                    ),
                    (v) => asyncSucceed([v, go(i + 1)] as [number, ZStream<unknown, never, number>])
                )
        );

    return go(start);
}


async function test_fromPromise_buffer() {
    const s = slowRangeFromPromise(1, 10, 30);
    const sb = buffer(s, 4, "backpressure");

    const out = await toPromise(collectStream(sb), undefined as any);

    console.log("buffered out length =", out.length);
    console.log(out);
}
async function test_fromPromise_emits() {
    const s = slowRangeFromPromise(1, 5, 10);

    const out = await toPromise(collectStream(s), undefined as any);

    console.log("out =", out);
    // esperado: [1,2,3,4,5]
}

test_fromPromise_emits().catch(console.error);

test_fromPromise_buffer().catch(console.error);