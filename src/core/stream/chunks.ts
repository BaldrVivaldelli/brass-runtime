import {
  Async,
  asyncFail,
  asyncFold,
  asyncMapError,
  asyncSucceed,
} from "../types/asyncEffect";
import { none, Option } from "../types/option";
import { fromPull, uncons, widenOpt, ZStream } from "./stream";
import { resolveWasmModule } from "../runtime/wasmModule";
import type { EngineStats } from "../runtime/engineStats";

export type StreamChunkEngine = "ts" | "wasm";

export type StreamChunkOptions = {
  /**
   * ts: always use the TypeScript array chunker.
   * wasm: require BrassWasmChunkBuffer from wasm/pkg.
   *
   * Strict mode never falls back between engines.
   */
  engine?: StreamChunkEngine;
};

export type StreamChunkStats = {
  len: number;
  maxChunkSize: number;
  emittedChunks: number;
  emittedItems: number;
  flushes: number;
};

type Chunker<A> = {
  readonly length: number;
  readonly maxChunkSize: number;
  push(value: A): boolean;
  isFull(): boolean;
  isEmpty(): boolean;
  takeChunk(): readonly A[];
  clear(): void;
  stats(): EngineStats<StreamChunkStats>;
};

type WasmChunkBufferCtor = new (maxChunkSize: number) => {
  len(): number;
  max_chunk_size(): number;
  is_empty(): boolean;
  is_full(): boolean;
  push(value: unknown): boolean;
  take_chunk(): unknown;
  clear(): void;
  stats_json(): string;
};

let cachedWasmChunkCtor: WasmChunkBufferCtor | null | undefined;

function resolveWasmChunkBuffer(): WasmChunkBufferCtor | null {
  if (cachedWasmChunkCtor !== undefined) return cachedWasmChunkCtor;
  const mod = resolveWasmModule() as { BrassWasmChunkBuffer?: WasmChunkBufferCtor } | null;
  cachedWasmChunkCtor = mod?.BrassWasmChunkBuffer ?? null;
  return cachedWasmChunkCtor;
}

class TsChunker<A> implements Chunker<A> {
  readonly engine = "ts" as const;
  private values: A[] = [];
  private emittedChunks = 0;
  private emittedItems = 0;
  private flushes = 0;

  constructor(readonly maxChunkSize: number) {}

  get length(): number {
    return this.values.length;
  }

  push(value: A): boolean {
    if (this.values.length >= this.maxChunkSize) return false;
    this.values.push(value);
    return true;
  }

  isFull(): boolean {
    return this.values.length >= this.maxChunkSize;
  }

  isEmpty(): boolean {
    return this.values.length === 0;
  }

  takeChunk(): readonly A[] {
    this.flushes += 1;
    const chunk = this.values;
    this.values = [];
    if (chunk.length > 0) {
      this.emittedChunks += 1;
      this.emittedItems += chunk.length;
    }
    return chunk;
  }

  clear(): void {
    this.values = [];
  }

  stats(): EngineStats<StreamChunkStats> {
    return {
      engine: "ts",
      fallbackUsed: false,
      data: {
        len: this.values.length,
        maxChunkSize: this.maxChunkSize,
        emittedChunks: this.emittedChunks,
        emittedItems: this.emittedItems,
        flushes: this.flushes,
      },
    };
  }
}

class WasmChunker<A> implements Chunker<A> {
  readonly engine = "wasm" as const;
  readonly fallbackUsed = false;
  private readonly inner: InstanceType<WasmChunkBufferCtor>;

  constructor(maxChunkSize: number) {
    const Ctor = resolveWasmChunkBuffer();
    if (!Ctor) {
      throw new Error("brass-runtime wasm chunk buffer is not available. Run npm run build:wasm first.");
    }
    this.inner = new Ctor(maxChunkSize);
  }

  get length(): number {
    return this.inner.len();
  }

  get maxChunkSize(): number {
    return this.inner.max_chunk_size();
  }

  push(value: A): boolean {
    return this.inner.push(value);
  }

  isFull(): boolean {
    return this.inner.is_full();
  }

  isEmpty(): boolean {
    return this.inner.is_empty();
  }

  takeChunk(): readonly A[] {
    return Array.from(this.inner.take_chunk() as ArrayLike<A>);
  }

  clear(): void {
    this.inner.clear();
  }

  stats(): EngineStats<StreamChunkStats> {
    return { engine: "wasm", fallbackUsed: false, data: JSON.parse(this.inner.stats_json()) as StreamChunkStats };
  }
}

export function makeStreamChunker<A>(
  chunkSize: number,
  options: StreamChunkOptions = {}
): Chunker<A> {
  const size = Math.max(1, chunkSize | 0);
  const engine = options.engine ?? "ts";

  if (engine === "ts") return new TsChunker<A>(size);
  if (engine === "wasm") return new WasmChunker<A>(size);

  throw new Error(`brass-runtime stream chunk engine must be 'ts' or 'wasm'; received '${String(engine)}'`);
}

/**
 * Re-chunk a stream so downstream operators receive arrays instead of single
 * items. This is the intended WASM boundary: pay the JS↔WASM crossing while
 * assembling chunks, then process bigger batches downstream.
 */
export function chunks<R, E, A>(
  input: ZStream<R, E, A>,
  chunkSize: number,
  options: StreamChunkOptions = {}
): ZStream<R, E, readonly A[]> {
  const size = Math.max(1, chunkSize | 0);

  const loop = (cur: ZStream<R, E, A>): ZStream<R, E, readonly A[]> =>
    fromPull(fillChunk(cur, makeStreamChunker<A>(size, options)) as any);

  const fillChunk = (
    cur: ZStream<R, E, A>,
    chunker: Chunker<A>
  ): Async<R, Option<E>, [readonly A[], ZStream<R, E, readonly A[]>]> =>
    asyncFold(
      uncons(cur),
      (opt: Option<E>) => {
        if (opt._tag === "None" && !chunker.isEmpty()) {
          return asyncSucceed([chunker.takeChunk(), fromPull(asyncFail(none))] as const) as any;
        }
        return asyncFail(opt);
      },
      ([a, tail]) => {
        chunker.push(a);
        if (chunker.isFull()) {
          return asyncSucceed([chunker.takeChunk(), loop(tail)] as const) as any;
        }
        return fillChunk(tail, chunker) as any;
      }
    ) as any;

  return loop(input);
}

export function mapChunks<R, E, A, B>(
  input: ZStream<R, E, A>,
  chunkSize: number,
  f: (chunk: readonly A[]) => readonly B[],
  options: StreamChunkOptions = {}
): ZStream<R, E, B> {
  const pullOne = (pending: readonly B[], rest: ZStream<R, E, readonly A[]>): ZStream<R, E, B> => {
    if (pending.length > 0) {
      const [head, ...tail] = pending;
      return fromPull(asyncSucceed([head as B, pullOne(tail, rest)] as const) as any);
    }
    return fromPull(
      asyncFold(
        uncons(rest),
        (opt: Option<E>) => asyncFail(opt),
        ([chunk, tail]) => {
          const mapped = f(chunk);
          return uncons(pullOne(mapped, tail)) as any;
        }
      ) as any
    );
  };

  return pullOne([], chunks(input, chunkSize, options));
}

export function mapChunksEffect<Rp, Ep, A, B>(
  chunkSize: number,
  f: (chunk: readonly A[]) => Async<Rp, Ep, readonly B[]>,
  options: StreamChunkOptions = {}
): <R, E>(input: ZStream<R, E, A>) => ZStream<R & Rp, E | Ep, B> {
  return (<R, E>(input: ZStream<R, E, A>) => {
    const chunked = chunks(input, chunkSize, options) as ZStream<R & Rp, E, readonly A[]>;

    const pullOne = (pending: readonly B[], rest: ZStream<R & Rp, E, readonly A[]>): ZStream<R & Rp, E | Ep, B> => {
      if (pending.length > 0) {
        const [head, ...tail] = pending;
        return fromPull(asyncSucceed([head as B, pullOne(tail, rest)] as const) as any);
      }
      return fromPull(
        asyncFold(
          asyncMapError(uncons(rest), (opt: Option<E>) => widenOpt<E, Ep>(opt)),
          (opt: Option<E | Ep>) => asyncFail(opt),
          ([chunk, tail]) =>
            asyncFold(
              asyncMapError(f(chunk), (e: Ep) => ({ _tag: "Some", value: e } as Option<E | Ep>)),
              (opt: Option<E | Ep>) => asyncFail(opt),
              (mapped) => uncons(pullOne(mapped, tail as any)) as any
            )
        ) as any
      );
    };

    return pullOne([], chunked);
  }) as any;
}
