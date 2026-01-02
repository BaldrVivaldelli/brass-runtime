import {buffer} from "../stream/buffer";
import {collectStream, rangeStream} from "../stream/stream";
import {toPromise} from "../runtime/runtime";


async function testBuffer() {
    const s = rangeStream(1, 10);
    const sb = buffer(s, 4, "backpressure");

    const out = await toPromise(collectStream(sb), undefined as any);
    console.log(out);
}

testBuffer().catch(console.error);
