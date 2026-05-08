import { describe, expect, it } from "vitest";

import * as root from "../index";
import * as core from "../core";
import * as engine from "../core/runtime/engine";
import * as http from "../http";
import * as compression from "../http/compression";
import * as lifecycle from "../http/lifecycle";

describe("public barrel modules", () => {
  it("load the runtime, core, engine, HTTP, compression, and lifecycle barrels", async () => {
    await import("../core/runtime/events");
    await import("../core/runtime/engine/types");
    await import("../http/lifecycle/types");

    expect(root.Runtime).toBe(core.Runtime);
    expect(root.asyncSucceed).toBe(core.asyncSucceed);
    expect(engine.JsFiberEngine).toBeTypeOf("function");
    expect(http.makeHttpClient).toBeTypeOf("function");
    expect(http.makeCompressionMiddleware).toBe(compression.makeCompressionMiddleware);
    expect(http.makeLifecycleClient).toBe(lifecycle.makeLifecycleClient);
  });
});
