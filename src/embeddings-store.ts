import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL_ID,
  EMBEDDINGS_DB,
} from "./config";

export type StoredEmbedding = {
  promptHash: string;
  modelId: string;
  vector: Float32Array;
  updatedAt: number;
};

let dbInstance: Database.Database | null = null;

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Lazily open (and create if needed) the embeddings sqlite database. The
 * `vector` column is a packed Float32Array (little-endian, native order). We
 * keep dims/model_id alongside the row so we can detect stale embeddings if
 * we ever swap the model.
 */
export async function getEmbeddingsDb(): Promise<Database.Database> {
  if (dbInstance) return dbInstance;
  await ensureParentDir(EMBEDDINGS_DB);
  const db = new Database(EMBEDDINGS_DB);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      prompt_hash TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS embeddings_model_idx ON embeddings(model_id);
  `);
  dbInstance = db;
  return db;
}

export function closeEmbeddingsDb(): void {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
}

function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function bufferToVector(buf: Buffer, dims: number): Float32Array {
  if (buf.byteLength !== dims * 4) {
    throw new Error(`embedding blob byte length ${buf.byteLength} mismatches dims ${dims}`);
  }
  // Slice copy — buf may share an underlying ArrayBuffer with other rows
  // returned in the same query, and Float32Array would otherwise be unsafe to
  // hand out.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, dims);
}

/**
 * Of the supplied prompt hashes, return only those that have NOT been embedded
 * by `modelId` yet. Used by the rebuild loop so we can resume after a crash
 * without re-encoding everything.
 */
export async function getMissingHashes(
  promptHashes: string[],
  modelId: string = EMBEDDING_MODEL_ID
): Promise<string[]> {
  if (promptHashes.length === 0) return [];
  const db = await getEmbeddingsDb();
  const stmt = db.prepare(
    "SELECT prompt_hash FROM embeddings WHERE model_id = ? AND prompt_hash IN (" +
      promptHashes.map(() => "?").join(",") +
      ")"
  );
  const rows = stmt.all(modelId, ...promptHashes) as Array<{ prompt_hash: string }>;
  const present = new Set(rows.map((row) => row.prompt_hash));
  return promptHashes.filter((hash) => !present.has(hash));
}

export async function upsertEmbedding(
  promptHash: string,
  vector: Float32Array,
  modelId: string = EMBEDDING_MODEL_ID
): Promise<void> {
  if (vector.length !== EMBEDDING_DIMS) {
    throw new Error(
      `embedding dims ${vector.length} mismatches expected ${EMBEDDING_DIMS}`
    );
  }
  const db = await getEmbeddingsDb();
  const stmt = db.prepare(
    "INSERT INTO embeddings (prompt_hash, model_id, dims, vector, updated_at) VALUES (?, ?, ?, ?, ?)" +
      " ON CONFLICT(prompt_hash) DO UPDATE SET model_id = excluded.model_id, dims = excluded.dims, vector = excluded.vector, updated_at = excluded.updated_at"
  );
  stmt.run(promptHash, modelId, vector.length, vectorToBuffer(vector), Math.floor(Date.now() / 1000));
}

export async function upsertEmbeddingsBatch(
  rows: Array<{ promptHash: string; vector: Float32Array }>,
  modelId: string = EMBEDDING_MODEL_ID
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getEmbeddingsDb();
  const stmt = db.prepare(
    "INSERT INTO embeddings (prompt_hash, model_id, dims, vector, updated_at) VALUES (?, ?, ?, ?, ?)" +
      " ON CONFLICT(prompt_hash) DO UPDATE SET model_id = excluded.model_id, dims = excluded.dims, vector = excluded.vector, updated_at = excluded.updated_at"
  );
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction((items: Array<{ promptHash: string; vector: Float32Array }>) => {
    for (const item of items) {
      if (item.vector.length !== EMBEDDING_DIMS) continue;
      stmt.run(item.promptHash, modelId, item.vector.length, vectorToBuffer(item.vector), now);
    }
  });
  tx(rows);
}

/**
 * Load every embedding for `modelId`. Suitable for in-memory cosine search
 * when the prompt corpus is in the low tens of thousands. Allocates one
 * Float32Array per row.
 */
export async function loadAllEmbeddings(
  modelId: string = EMBEDDING_MODEL_ID
): Promise<StoredEmbedding[]> {
  const db = await getEmbeddingsDb();
  const rows = db
    .prepare(
      "SELECT prompt_hash, model_id, dims, vector, updated_at FROM embeddings WHERE model_id = ?"
    )
    .all(modelId) as Array<{
    prompt_hash: string;
    model_id: string;
    dims: number;
    vector: Buffer;
    updated_at: number;
  }>;
  return rows.map((row) => ({
    promptHash: row.prompt_hash,
    modelId: row.model_id,
    vector: bufferToVector(row.vector, row.dims),
    updatedAt: row.updated_at,
  }));
}

/**
 * Cheap row count for `modelId`. Used by the status endpoint that polls every
 * 1s during an active rebuild — `loadAllEmbeddings` here would re-decode every
 * Float32Array on every poll and stall the main process.
 */
export async function countEmbeddings(
  modelId: string = EMBEDDING_MODEL_ID
): Promise<number> {
  const db = await getEmbeddingsDb();
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE model_id = ?")
    .get(modelId) as { c: number } | undefined;
  return row?.c ?? 0;
}

export async function getEmbedding(
  promptHash: string,
  modelId: string = EMBEDDING_MODEL_ID
): Promise<StoredEmbedding | null> {
  const db = await getEmbeddingsDb();
  const row = db
    .prepare(
      "SELECT prompt_hash, model_id, dims, vector, updated_at FROM embeddings WHERE model_id = ? AND prompt_hash = ?"
    )
    .get(modelId, promptHash) as
    | {
        prompt_hash: string;
        model_id: string;
        dims: number;
        vector: Buffer;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    promptHash: row.prompt_hash,
    modelId: row.model_id,
    vector: bufferToVector(row.vector, row.dims),
    updatedAt: row.updated_at,
  };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export type TopKMatch = {
  promptHash: string;
  score: number;
};

/**
 * Brute-force cosine top-K against `pool`. We accept an optional
 * `excludeHash` so the query prompt itself doesn't show up in its own
 * "similar" list. `threshold` filters out weak matches before sorting.
 */
export function findTopK(
  query: Float32Array,
  pool: StoredEmbedding[],
  options: { topK?: number; threshold?: number; excludeHash?: string } = {}
): TopKMatch[] {
  const topK = options.topK ?? 10;
  const threshold = options.threshold ?? 0;
  const excludeHash = options.excludeHash;
  const scored: TopKMatch[] = [];
  for (const entry of pool) {
    if (excludeHash && entry.promptHash === excludeHash) continue;
    const score = cosineSimilarity(query, entry.vector);
    if (score < threshold) continue;
    scored.push({ promptHash: entry.promptHash, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
