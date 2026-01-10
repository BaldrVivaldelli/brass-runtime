import { globalScheduler } from "../core/runtime/scheduler";
import { toPromise } from "../core/runtime/runtime";
import {httpClientWithMeta} from "../http";

type Post = {
    userId: number;
    id: number;
    title: string;
    body: string;
};

async function main() {
    // Transparente: construye makeHttp(cfg) + withMeta()
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
    console.log(r1)
    console.log("status:", r1.status, r1.meta.statusText ?? "");
    console.log("ms:", r1.meta.ms);
    console.log("title:", r1.title);
    console.log("body:", r1.body);

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

    // OJO: postJson hoy devuelve WIRE (HttpWireResponse) en el archivo que te pasé.
    // Si querés meta+json también para POST, abajo te dejo 2 opciones.
    console.log("wire.status:", r2.status, r2.statusText ?? "");
    console.log("wire.ms:", r2.ms);
    console.log("wire.bodyText:", r2.bodyText);

    // ---------- RAW WIRE ----------
    // const wire = await toPromise(http.get("/posts/1"), {});
    // console.log("wire.status:", wire.status, wire.statusText, "ms:", wire.ms);
    // console.log("wire.bodyText:", wire.bodyText);
}

main().catch((e) => {
    console.error("Unhandled:", e);
    process.exit(1);
});
