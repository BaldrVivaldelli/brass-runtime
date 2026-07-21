import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  NATIVE_SERVICE_MAX_MESSAGE_BYTES,
  NativeServiceTransportError,
  type NativeServiceTransport,
} from "../native/protocol";

export type NodeNativeServiceTransportOptions = {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly maxMessageBytes?: number;
  readonly shutdownGraceMs?: number;
};

export function createNodeNativeServiceTransport(
  options: NodeNativeServiceTransportOptions = {},
): NativeServiceTransport {
  const command = options.command ?? resolveNativeServiceCommand();
  const child = spawn(command, [...(options.args ?? [])], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: nativeServiceEnvironment(),
  });
  return new NodeNativeServiceTransport(child, {
    maxMessageBytes: options.maxMessageBytes ?? NATIVE_SERVICE_MAX_MESSAGE_BYTES,
    shutdownGraceMs: options.shutdownGraceMs ?? 1_000,
  });
}

export function resolveNativeServiceCommand(): string {
  const configured = process.env.BRASS_NATIVE_SERVICE_BIN?.trim();
  if (configured) return configured;
  const executable = process.platform === "win32" ? "brass-native-service.exe" : "brass-native-service";
  const platformArtifact = resolve(
    process.cwd(),
    "native",
    `${process.platform}-${process.arch}`,
    executable,
  );
  if (existsSync(platformArtifact)) return platformArtifact;
  const debugArtifact = resolve(process.cwd(), "target", "debug", executable);
  const releaseArtifact = resolve(process.cwd(), "target", "release", executable);
  if (existsSync(releaseArtifact)) return releaseArtifact;
  if (existsSync(debugArtifact)) return debugArtifact;
  return executable;
}

class NodeNativeServiceTransport implements NativeServiceTransport {
  private readonly frameListeners = new Set<(frame: string) => void>();
  private readonly exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  private buffer = "";
  private exited = false;
  private exitInfo: { code: number | null; signal: string | null } = { code: null, signal: null };

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: { readonly maxMessageBytes: number; readonly shutdownGraceMs: number },
  ) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.acceptChunk(chunk));
    // Drain stderr without forwarding potentially sensitive host diagnostics.
    child.stderr.on("data", () => undefined);
    child.once("error", () => this.finishExit(null, "spawn-error"));
    child.once("exit", (code, signal) => this.finishExit(code, signal));
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  send(frame: string): Promise<void> {
    if (this.exited || !this.child.stdin.writable) {
      return Promise.reject(new NativeServiceTransportError("PROCESS_EXIT", "native service process is not writable"));
    }
    if (Buffer.byteLength(frame, "utf8") > this.options.maxMessageBytes || frame.includes("\n") || frame.includes("\r")) {
      return Promise.reject(new NativeServiceTransportError("INVALID_FRAME", "native service frame is invalid or too large"));
    }
    return new Promise((resolveSend, rejectSend) => {
      this.child.stdin.write(`${frame}\n`, "utf8", (error) => {
        if (error) rejectSend(new NativeServiceTransportError("SEND_FAILED", "native service stdin write failed"));
        else resolveSend();
      });
    });
  }

  onFrame(listener: (frame: string) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onExit(listener: (info: { readonly code: number | null; readonly signal: string | null }) => void): () => void {
    if (this.exited) {
      queueMicrotask(() => listener(this.exitInfo));
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        if (!this.exited) this.child.kill("SIGKILL");
        resolveClose();
      }, this.options.shutdownGraceMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }

  private acceptChunk(chunk: string): void {
    if (this.exited) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.options.maxMessageBytes && !this.buffer.includes("\n")) {
      this.finishExit(null, "message-too-large");
      this.child.kill("SIGTERM");
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let frame = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (frame.endsWith("\r")) frame = frame.slice(0, -1);
      if (!frame) continue;
      if (Buffer.byteLength(frame, "utf8") > this.options.maxMessageBytes) {
        this.finishExit(null, "message-too-large");
        this.child.kill("SIGTERM");
        return;
      }
      for (const listener of [...this.frameListeners]) listener(frame);
    }
  }

  private finishExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    for (const listener of [...this.exitListeners]) listener(this.exitInfo);
    this.exitListeners.clear();
    this.frameListeners.clear();
  }
}

function nativeServiceEnvironment(): NodeJS.ProcessEnv {
  const keep = ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"] as const;
  const environment: NodeJS.ProcessEnv = { RUST_BACKTRACE: "0" };
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
