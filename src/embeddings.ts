import { promises as fs } from "node:fs";
import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL_ID,
  MODELS_DIR,
} from "./config";

/**
 * Public-facing embedder lifecycle. The renderer polls /api/embeddings/status
 * and renders a banner based on this exact shape, so changes here are a
 * frontend contract.
 */
export type EmbedderStatus =
  | "idle" // never initialised this process
  | "downloading" // model files are streaming in
  | "loading" // files done, instantiating session
  | "ready" // pipeline usable
  | "error" // unrecoverable load failure
  | "unsupported"; // platform/arch lacks a usable native binding

export type EmbedderState = {
  status: EmbedderStatus;
  modelId: string;
  dims: number;
  /** 0..1 of the *current* download / load. Resets each init attempt. */
  progress: number;
  /** Concrete file in flight (e.g. `model_quantized.onnx`). Optional. */
  currentFile?: string;
  /** Last error message, populated on `status === 'error'`. */
  error?: string;
  /** Wall-clock ms since epoch of the last successful load. */
  readyAt?: number;
  /**
   * True when the host platform/arch has no usable onnxruntime-node binary.
   * Currently this is the case for darwin/x64 with onnxruntime-node >= 1.24.x
   * (upstream stopped shipping the prebuild — see microsoft/onnxruntime#27961).
   */
  unsupported?: boolean;
  /** Why the platform is unsupported, surfaced as a hint in the banner. */
  unsupportedReason?: string;
};

/**
 * Returns null when the host can run the embedder, or a human-readable reason
 * when it cannot. We bail out before we touch transformers.js so the user gets
 * a clear "not supported on Intel Mac" hint instead of an opaque
 * `Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'`.
 */
export function getPlatformUnsupportedReason(): string | null {
  if (process.platform === "darwin" && process.arch === "x64") {
    return "onnxruntime-node 1.24+ no longer ships an Intel-Mac binary; smart clustering uses lite mode here.";
  }
  // Other platforms either have a working binary or we'd surface the failure
  // through ensureEmbedder()'s catch block.
  return null;
}

/** Reflects {@link getPlatformUnsupportedReason} into an EmbedderState patch. */
function applyUnsupportedToInitial(state: EmbedderState): EmbedderState {
  const reason = getPlatformUnsupportedReason();
  if (!reason) return state;
  return {
    ...state,
    status: "unsupported",
    unsupported: true,
    unsupportedReason: reason,
  };
}

const initialState: EmbedderState = applyUnsupportedToInitial({
  status: "idle",
  modelId: EMBEDDING_MODEL_ID,
  dims: EMBEDDING_DIMS,
  progress: 0,
});

let currentState: EmbedderState = { ...initialState };
let pipelinePromise: Promise<EmbedderPipeline> | null = null;

type EmbedderPipeline = (
  texts: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean }
) => Promise<{
  data: Float32Array;
  dims: number[];
  tolist: () => number[][] | number[][][];
}>;

export function getEmbedderState(): EmbedderState {
  return { ...currentState };
}

function setState(patch: Partial<EmbedderState>) {
  currentState = { ...currentState, ...patch };
}

/**
 * Track per-file progress so we can report a stable single 0..1 progress
 * even though transformers.js streams events for every shard.
 */
type ProgressEvent =
  | { status: "initiate" | "download"; name?: string; file?: string }
  | { status: "progress"; name?: string; file?: string; progress?: number; loaded?: number; total?: number }
  | { status: "done"; name?: string; file?: string }
  | { status: "ready"; task?: string; model?: string };

function makeProgressTracker() {
  const fileProgress = new Map<string, number>();
  return (event: ProgressEvent) => {
    if (event.status === "ready") {
      setState({ status: "loading", progress: 1, currentFile: undefined });
      return;
    }
    const file = event.file ?? event.name;
    if (!file) return;
    if (event.status === "initiate" || event.status === "download") {
      if (!fileProgress.has(file)) fileProgress.set(file, 0);
      setState({ status: "downloading", currentFile: file });
      return;
    }
    if (event.status === "progress") {
      let pct = 0;
      if (typeof event.progress === "number") {
        pct = event.progress > 1 ? event.progress / 100 : event.progress;
      } else if (event.total && event.loaded) {
        pct = event.loaded / event.total;
      }
      pct = Math.max(0, Math.min(1, pct));
      fileProgress.set(file, pct);
    } else if (event.status === "done") {
      fileProgress.set(file, 1);
    }
    if (fileProgress.size === 0) return;
    let sum = 0;
    for (const value of fileProgress.values()) sum += value;
    const overall = sum / fileProgress.size;
    setState({ status: "downloading", progress: overall, currentFile: file });
  };
}

/**
 * Configure transformers.js the first time we touch it. Pinning cacheDir
 * keeps the 100MB+ ONNX weights out of the dev workspace so uninstalls don't
 * accidentally nuke them.
 */
async function configureEnv() {
  await fs.mkdir(MODELS_DIR, { recursive: true });
  const transformers = await import("@huggingface/transformers");
  const env = transformers.env as {
    cacheDir: string;
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
  };
  env.cacheDir = MODELS_DIR;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  return transformers;
}

/**
 * Load (or return the cached) feature-extraction pipeline. Concurrent callers
 * share the in-flight promise so we never open two ONNX sessions.
 */
export function ensureEmbedder(): Promise<EmbedderPipeline> {
  if (pipelinePromise) return pipelinePromise;
  const unsupportedReason = getPlatformUnsupportedReason();
  if (unsupportedReason) {
    setState({
      status: "unsupported",
      unsupported: true,
      unsupportedReason,
      error: unsupportedReason,
      progress: 0,
    });
    return Promise.reject(new Error(unsupportedReason));
  }
  pipelinePromise = (async () => {
    setState({ status: "downloading", progress: 0, error: undefined, currentFile: undefined });
    try {
      const transformers = await configureEnv();
      const tracker = makeProgressTracker();
      // Cast to any: the package's type entry is a UMD-flavoured d.ts and the
      // `pipeline` re-export trips the strict check, but the runtime API is
      // stable.
      const pipelineFn = (transformers as any).pipeline as (
        task: string,
        model: string,
        options: Record<string, unknown>
      ) => Promise<EmbedderPipeline>;
      const pipe = await pipelineFn("feature-extraction", EMBEDDING_MODEL_ID, {
        progress_callback: tracker,
        // q8 is the default for sentence-transformer ONNX exports and keeps
        // the download under 130MB while preserving recall.
        dtype: "q8",
      });
      setState({ status: "ready", progress: 1, readyAt: Date.now(), currentFile: undefined });
      return pipe;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: "error", error: message, progress: 0 });
      pipelinePromise = null;
      throw err;
    }
  })();
  return pipelinePromise;
}

/**
 * E5 family models are trained with a "query: " / "passage: " prefix scheme.
 * For symmetric prompt-vs-prompt similarity we treat every input as a query;
 * deviations from the canonical prefix degrade recall noticeably so we always
 * apply this before tokenising.
 */
function withE5Prefix(text: string): string {
  return `query: ${text}`;
}

function tensorRowToFloat32(data: Float32Array, rowIndex: number, dims: number): Float32Array {
  const start = rowIndex * dims;
  const slice = data.subarray(start, start + dims);
  // Copy so callers can keep the view across pipeline invocations without
  // worrying about reuse of the underlying buffer.
  return new Float32Array(slice);
}

export async function embedText(text: string): Promise<Float32Array> {
  const pipe = await ensureEmbedder();
  const tensor = await pipe(withE5Prefix(text), { pooling: "mean", normalize: true });
  if (tensor.dims[tensor.dims.length - 1] !== EMBEDDING_DIMS) {
    throw new Error(
      `embedder produced dims ${tensor.dims.join("x")}, expected last dim ${EMBEDDING_DIMS}`
    );
  }
  return tensorRowToFloat32(tensor.data, 0, EMBEDDING_DIMS);
}

export type EmbedBatchOptions = {
  batchSize?: number;
  /** Reports `(processed, total)` after each batch. Called synchronously. */
  onBatch?: (processed: number, total: number) => void;
};

export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {}
): Promise<Float32Array[]> {
  const batchSize = Math.max(1, options.batchSize ?? 16);
  if (texts.length === 0) return [];
  const pipe = await ensureEmbedder();
  const result: Float32Array[] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const slice = texts.slice(offset, offset + batchSize);
    const prefixed = slice.map(withE5Prefix);
    const tensor = await pipe(prefixed, { pooling: "mean", normalize: true });
    const lastDim = tensor.dims[tensor.dims.length - 1];
    if (lastDim !== EMBEDDING_DIMS) {
      throw new Error(
        `embedder produced dims ${tensor.dims.join("x")}, expected last dim ${EMBEDDING_DIMS}`
      );
    }
    for (let i = 0; i < slice.length; i++) {
      result.push(tensorRowToFloat32(tensor.data, i, EMBEDDING_DIMS));
    }
    options.onBatch?.(result.length, texts.length);
  }
  return result;
}

/**
 * Used by tests to simulate a fresh process. Not used by production code.
 */
export function resetEmbedderForTests(): void {
  pipelinePromise = null;
  currentState = { ...initialState };
}
