import {
  EMBEDDING_MODEL_ID,
  EMBEDDING_DIMS,
} from "./config";
import {
  embedBatch,
  embedText,
  ensureEmbedder,
  getEmbedderState,
  type EmbedderState,
} from "./embeddings";
import {
  cosineSimilarity,
  findTopK,
  getEmbedding,
  getMissingHashes,
  loadAllEmbeddings,
  upsertEmbeddingsBatch,
  type StoredEmbedding,
  type TopKMatch,
} from "./embeddings-store";
import type { PromptEntry } from "./prompts";

/**
 * Layered status reported to the frontend banner. We split rebuild progress
 * from the embedder lifecycle so the user can see "model ready, encoding 42%
 * of prompts" as two distinct moving parts.
 */
export type RebuildState = {
  status: "idle" | "running" | "done" | "error";
  processed: number;
  total: number;
  /** Last error message; populated on `status === 'error'`. */
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

export type EmbeddingsServiceState = {
  embedder: EmbedderState;
  rebuild: RebuildState;
  storedCount: number;
  modelId: string;
  dims: number;
};

const initialRebuild: RebuildState = {
  status: "idle",
  processed: 0,
  total: 0,
};

let rebuildState: RebuildState = { ...initialRebuild };
let rebuildPromise: Promise<void> | null = null;

function setRebuild(patch: Partial<RebuildState>) {
  rebuildState = { ...rebuildState, ...patch };
}

async function getStoredCount(): Promise<number> {
  try {
    const all = await loadAllEmbeddings();
    return all.length;
  } catch {
    return 0;
  }
}

export async function getServiceState(): Promise<EmbeddingsServiceState> {
  const embedder = getEmbedderState();
  const storedCount = await getStoredCount();
  return {
    embedder,
    rebuild: { ...rebuildState },
    storedCount,
    modelId: EMBEDDING_MODEL_ID,
    dims: EMBEDDING_DIMS,
  };
}

/**
 * Trigger the embedder to load, but do not block the request — the renderer
 * polls /status to advance the banner. Returns immediately.
 */
export function triggerInit(): void {
  // Best-effort; failures already mutate embedder state via ensureEmbedder.
  ensureEmbedder().catch(() => undefined);
}

/**
 * Encode every prompt that lacks a stored vector. Idempotent: if a rebuild is
 * in flight we return the same promise, so two concurrent /rebuild requests
 * don't double up.
 */
export function triggerRebuild(allPrompts: PromptEntry[]): void {
  if (rebuildPromise) return;
  if (allPrompts.length === 0) {
    setRebuild({ ...initialRebuild, status: "done", processed: 0, total: 0 });
    return;
  }
  rebuildPromise = (async () => {
    setRebuild({
      status: "running",
      processed: 0,
      total: allPrompts.length,
      error: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
    });
    try {
      await ensureEmbedder();
      const allHashes = allPrompts.map((entry) => entry.promptHash);
      const missing = await getMissingHashes(allHashes);
      const missingSet = new Set(missing);
      const todo = allPrompts.filter((entry) => missingSet.has(entry.promptHash));
      const alreadyDone = allPrompts.length - todo.length;
      setRebuild({ processed: alreadyDone, total: allPrompts.length });
      if (todo.length === 0) {
        setRebuild({ status: "done", finishedAt: Date.now() });
        return;
      }
      const batchSize = 16;
      for (let offset = 0; offset < todo.length; offset += batchSize) {
        const chunk = todo.slice(offset, offset + batchSize);
        const vectors = await embedBatch(
          chunk.map((entry) => entry.normalizedText),
          { batchSize }
        );
        const rows = chunk.map((entry, idx) => ({
          promptHash: entry.promptHash,
          vector: vectors[idx],
        }));
        await upsertEmbeddingsBatch(rows);
        setRebuild({ processed: alreadyDone + offset + chunk.length });
      }
      setRebuild({ status: "done", finishedAt: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRebuild({ status: "error", error: message, finishedAt: Date.now() });
    } finally {
      rebuildPromise = null;
    }
  })();
}

/**
 * Look up — or compute on-demand — the embedding for a single prompt. Returns
 * null if the embedder isn't usable so callers can fall back cleanly.
 */
async function getOrComputeEmbedding(
  prompt: PromptEntry
): Promise<Float32Array | null> {
  const stored = await getEmbedding(prompt.promptHash);
  if (stored) return stored.vector;
  const state = getEmbedderState();
  if (state.status !== "ready") {
    return null;
  }
  try {
    const vec = await embedText(prompt.normalizedText);
    await upsertEmbeddingsBatch([{ promptHash: prompt.promptHash, vector: vec }]);
    return vec;
  } catch {
    return null;
  }
}

export type SimilarMatch = {
  promptHash: string;
  score: number;
};

/**
 * Embedding-backed similar prompts. Returns null when the embedder is not
 * ready *or* when the corpus has too few stored vectors to be useful — in
 * either case the caller should fall back to Jaccard.
 */
export async function findSimilarFromEmbedding(
  prompt: PromptEntry,
  allPrompts: PromptEntry[],
  options: { topK?: number; threshold?: number }
): Promise<SimilarMatch[] | null> {
  const state = getEmbedderState();
  if (state.status !== "ready") return null;
  const stored = await loadAllEmbeddings();
  if (stored.length === 0) return null;
  const allowedHashes = new Set(allPrompts.map((entry) => entry.promptHash));
  const pool = stored.filter((entry) => allowedHashes.has(entry.promptHash));
  if (pool.length === 0) return null;
  const queryVec = await getOrComputeEmbedding(prompt);
  if (!queryVec) return null;
  const topK = options.topK ?? 10;
  const threshold = options.threshold ?? 0.6;
  const matches: TopKMatch[] = findTopK(queryVec, pool, {
    topK,
    threshold,
    excludeHash: prompt.promptHash,
  });
  return matches.map((match) => ({ promptHash: match.promptHash, score: match.score }));
}

export type EmbeddingCluster = {
  clusterId: string;
  leadHash: string;
  memberHashes: string[];
};

/**
 * Embedding-backed clusters via the same union-find shape as the Jaccard
 * variant. We keep the algorithm naïve (O(n²) cosine) because n is in the
 * low thousands; if that ceiling rises we'll swap in HNSW.
 */
export async function clusterFromEmbedding(
  allPrompts: PromptEntry[],
  options: { threshold?: number }
): Promise<EmbeddingCluster[] | null> {
  const state = getEmbedderState();
  if (state.status !== "ready") return null;
  const stored = await loadAllEmbeddings();
  if (stored.length === 0) return null;
  const allowedHashes = new Set(allPrompts.map((entry) => entry.promptHash));
  const pool: StoredEmbedding[] = stored.filter((entry) => allowedHashes.has(entry.promptHash));
  if (pool.length === 0) return null;
  const threshold = options.threshold ?? 0.85;
  const parent = new Map<string, string>();
  pool.forEach((entry) => parent.set(entry.promptHash, entry.promptHash));
  const find = (hash: string): string => {
    let cur = hash;
    while (parent.get(cur) !== cur) cur = parent.get(cur) as string;
    let next = hash;
    while (parent.get(next) !== cur) {
      const tmp = parent.get(next) as string;
      parent.set(next, cur);
      next = tmp;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const score = cosineSimilarity(pool[i].vector, pool[j].vector);
      if (score >= threshold) union(pool[i].promptHash, pool[j].promptHash);
    }
  }
  const groups = new Map<string, string[]>();
  pool.forEach((entry) => {
    const root = find(entry.promptHash);
    const arr = groups.get(root) ?? [];
    arr.push(entry.promptHash);
    groups.set(root, arr);
  });
  // Promote the entry with the highest occurrence count to lead, falling
  // back to lexicographic hash for stability.
  const promptByHash = new Map(allPrompts.map((entry) => [entry.promptHash, entry]));
  const out: EmbeddingCluster[] = [];
  let counter = 0;
  for (const [root, members] of groups.entries()) {
    if (members.length < 2) continue;
    members.sort((a, b) => {
      const ea = promptByHash.get(a);
      const eb = promptByHash.get(b);
      const oa = ea?.occurrences.length ?? 0;
      const ob = eb?.occurrences.length ?? 0;
      if (ob !== oa) return ob - oa;
      return a.localeCompare(b);
    });
    out.push({
      clusterId: `embedding:${counter++}:${root.slice(0, 8)}`,
      leadHash: members[0],
      memberHashes: members,
    });
  }
  out.sort((a, b) => b.memberHashes.length - a.memberHashes.length);
  return out;
}

export function resetEmbeddingsServiceForTests(): void {
  rebuildState = { ...initialRebuild };
  rebuildPromise = null;
}
