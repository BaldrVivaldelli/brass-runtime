import { globalScheduler } from "../core/runtime/scheduler";
import { toPromise } from "../core/runtime/runtime";
import {httpClient} from "../http";
import {mergeHeaders, setHeaderIfMissing} from "../http/optics/request";

type Post = {
    userId: number;
    id: number;
    title: string;
    body: string;
};

async function main() {
    // Client base: SIN meta
    const http = httpClient({
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
    console.log("status:", r1.status);
    console.log("title:", r1.body.title);

    // ---------- POST JSON ----------
    console.log("\n== POST /posts (json) ==");
    const postData =http.postJson(
            "/posts",
            {
                userId: 1,
                title: "Hola Brass",
                body: "Probando POST desde Brass HTTP client",
            },
            { headers: { accept: "application/json" } }
        )
    const p2: any = toPromise( postData
        ,
        {}
    );
    console.log("returned isPromise:", p2 && typeof p2.then === "function");

    const wire = await p2;
    console.log("status:", wire.status);
    console.log("bodyText:", wire.bodyText);

    // Si querés parsear el body:
    const created = JSON.parse(wire.bodyText) as Post;
    console.log("created id:", created.id);

    // ---------- RAW WIRE ----------
    // const raw = await toPromise(http.get("/posts/1"), {});
    // console.log("wire.status:", raw.status);
    // console.log("wire.bodyText:", raw.bodyText);

    const req = mergeHeaders({ accept: "application/json" })(
        setHeaderIfMissing("content-type", "application/json")({
            method: "POST",
            url: "/posts",
            body: JSON.stringify({
                userId: 1,
                title: "Hola Brass",
                body: "Probando POST desde Brass HTTP client",
            }),
        })
    );

    const response_tres = await http.request(req).toPromise({});
    console.log("response_tres.bodyText:", response_tres.bodyText);
}

main().catch((e) => {
    console.error("Unhandled:", e);
    process.exit(1);
});
