import { toPromise } from "../types/asyncEffect";
import { makeHttp } from "../http";
import { globalScheduler } from "../scheduler/scheduler";

type Post = {
    userId: number;
    id: number;
    title: string;
    body: string;
};

async function main() {
    const http = makeHttp({ baseUrl: "https://jsonplaceholder.typicode.com" });

    console.log("== start ==");
    console.log("toPromise.length:", toPromise.length);
    console.log("globalScheduler keys:", Object.keys(globalScheduler ?? {}));

    // ---------- GET ----------
    console.log("\n== GET /posts/1 ==");
    const getEff = http.get("/posts/1");

    const p1: any = toPromise(getEff, {});
    console.log("returned isPromise:", p1 && typeof p1.then === "function");

    const r1 = await p1;
    console.log("status:", r1.status, r1.statusText ?? "");
    console.log("ms:", r1.ms);

    const post = JSON.parse(r1.bodyText) as Post;
    console.log("title:", post.title);

    // ---------- POST (JSON) ----------
    console.log("\n== POST /posts ==");
    const postEff = http.post(
        "/posts",
        JSON.stringify({
            userId: 1,
            title: "Hola Brass",
            body: "Probando POST desde Brass HTTP client",
        }),
        { headers: { "content-type": "application/json", accept: "application/json" } }
    );

    const p2: any = toPromise(postEff, {});
    console.log("returned isPromise:", p2 && typeof p2.then === "function");

    const r2 = await p2;
    console.log("status:", r2.status, r2.statusText ?? "");
    console.log("ms:", r2.ms);
    console.log("bodyText:", r2.bodyText);

    // ---------- GET JSON helper (si lo tenés) ----------
    // Si makeHttp expone getJson<T>, podés usar esto:
    // const post1 = await toPromise(http.getJson<Post>("/posts/1"), {});
    // console.log("post1.title:", post1.title);
}

main().catch((e) => {
    console.error("Unhandled:", e);
    process.exit(1);
});
