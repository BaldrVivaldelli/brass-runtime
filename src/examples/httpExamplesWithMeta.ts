import { globalScheduler } from "../core/runtime/scheduler";
import { toPromise } from "../core/runtime/runtime";
import { httpClientWithMeta } from "../http";

type Post = {
    userId: number;
    id: number;
    title: string;
    body: string;
};

async function main() {
    const http = httpClientWithMeta({
        baseUrl: "https://jsonplaceholder.typicode.com",
    });

    console.log("== start ==");
    console.log("toPromise.length:", toPromise.length);
    console.log("globalScheduler keys:", Object.keys(globalScheduler ?? {}));

    // ---------- GET JSON ----------
    console.log("\n== GET /posts/1 (json) ==");
    const p1: any = toPromise(http.getJson<Post>("/posts/1"), {});
    console.log("returned isPromise:", p1 && typeof p1.then === "function");

    const r1 = await p1;

    console.log("status:", r1.response.status, r1.response.statusText ?? "");
    console.log("ms:", r1.meta.durationMs);
    console.log("urlFinal:", r1.meta.urlFinal);
    console.log("title:", r1.response.body.title);
    console.log("body:", r1.response.body);

    // si querés ver el wire crudo:
    // console.log("wire.status:", r1.wire.status);
    // console.log("wire.bodyText:", r1.wire.bodyText);

    // ---------- POST JSON ----------
    console.log("\n== POST /posts (json) ==");
    const p2: any = toPromise(
        http.postJson(
            "/posts",
            {
                userId: 1,
                title: "Hola Brass",
                body: "Probando POST desde Brass HTTP client",
            },
            { headers: { accept: "application/json" } }
        ),
        {}
    );
    console.log("returned isPromise:", p2 && typeof p2.then === "function");

    const r2 = await p2;

    // postJson(withMeta) => { wire, meta }
    console.log("wire.status:", r2.wire.status, r2.wire.statusText ?? "");
    console.log("ms:", r2.meta.durationMs);
    console.log("wire.bodyText:", r2.wire.bodyText);

    // si querés parsear el body del POST:
    const created = JSON.parse(r2.wire.bodyText) as Post;
    console.log("created id:", created.id);
}

main().catch((e) => {
    console.error("Unhandled:", e);
    process.exit(1);
});
