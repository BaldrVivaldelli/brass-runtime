import { toPromise } from "../core/runtime/runtime";
import { collectStream } from "../core/stream/stream";
import { httpClientStream } from "../http/index";

function chunksToString(chunks: Uint8Array[]): string {
    const dec = new TextDecoder();
    return chunks.map((c) => dec.decode(c, { stream: true })).join("") + dec.decode();
}

async function main() {
    console.log("Running JSONPlaceholder integration...");

    const client = httpClientStream({ baseUrl: "https://jsonplaceholder.typicode.com" });

    const res = await toPromise(client.get("/posts/1"), {});
    console.log("status:", res.status);

    const bytes = await toPromise(collectStream(res.body), {});
    const text = chunksToString(bytes);
    const json = JSON.parse(text);

    console.log("post:", json);
}

main().catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
});
