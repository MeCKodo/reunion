import { tokenize } from "./lib/text";
import type { PromptEntry } from "./prompts";

/**
 * Tokenize for similarity. We dedupe to a Set so each token contributes once
 * — Jaccard works on set membership, not multiset frequency.
 */
export function tokenizePrompt(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type SimilarPrompt = {
  promptHash: string;
  score: number;
};

/**
 * Compare `query` against every entry in `pool` and return the top-K matches
 * above `threshold`. Self-match (same hash) is excluded. Caller-provided
 * tokens avoid re-tokenizing the same prompt across calls.
 */
export function findSimilarJaccard(
  query: PromptEntry,
  pool: PromptEntry[],
  options: { topK?: number; threshold?: number } = {}
): SimilarPrompt[] {
  const topK = options.topK ?? 10;
  const threshold = options.threshold ?? 0.4;
  const queryTokens = tokenizePrompt(query.text);
  if (queryTokens.size === 0) return [];

  const scored: SimilarPrompt[] = [];
  for (const entry of pool) {
    if (entry.promptHash === query.promptHash) continue;
    const tokens = tokenizePrompt(entry.text);
    if (tokens.size === 0) continue;
    const score = jaccardSimilarity(queryTokens, tokens);
    if (score < threshold) continue;
    scored.push({ promptHash: entry.promptHash, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export type PromptCluster = {
  clusterId: string;
  leadPromptHash: string;
  memberHashes: string[];
  method: "jaccard" | "embedding";
};

/**
 * Union-find clustering: pairs above `threshold` end up in the same cluster.
 * Singleton clusters are emitted too — callers that only want grouped
 * prompts should filter on `memberHashes.length > 1`.
 *
 * O(n²) tokenize + compare. For n in the few-thousand range this completes
 * in well under a second; we bail out gracefully on `tokenize` empty cases.
 */
export function clusterPromptsJaccard(
  prompts: PromptEntry[],
  options: { threshold?: number } = {}
): PromptCluster[] {
  const threshold = options.threshold ?? 0.6;

  const parent = prompts.map((_, idx) => idx);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const tokenSets = prompts.map((entry) => tokenizePrompt(entry.text));

  for (let i = 0; i < prompts.length; i++) {
    if (tokenSets[i].size === 0) continue;
    for (let j = i + 1; j < prompts.length; j++) {
      if (tokenSets[j].size === 0) continue;
      const score = jaccardSimilarity(tokenSets[i], tokenSets[j]);
      if (score >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < prompts.length; i++) {
    const root = find(i);
    const arr = groups.get(root) ?? [];
    arr.push(i);
    groups.set(root, arr);
  }

  return Array.from(groups.values()).map((indices) => {
    indices.sort((a, b) => prompts[b].occurrences.length - prompts[a].occurrences.length);
    const leadIdx = indices[0];
    return {
      clusterId: prompts[leadIdx].promptHash,
      leadPromptHash: prompts[leadIdx].promptHash,
      memberHashes: indices.map((idx) => prompts[idx].promptHash),
      method: "jaccard" as const,
    };
  });
}

export function serializeCluster(
  cluster: PromptCluster,
  promptsByHash: Map<string, PromptEntry>,
  serializeEntry: (entry: PromptEntry) => unknown
) {
  const members = cluster.memberHashes
    .map((hash) => promptsByHash.get(hash))
    .filter((entry): entry is PromptEntry => Boolean(entry));
  const lead = promptsByHash.get(cluster.leadPromptHash);
  return {
    cluster_id: cluster.clusterId,
    lead_prompt: lead ? serializeEntry(lead) : null,
    members: members.map((entry) => serializeEntry(entry)),
    method: cluster.method,
  };
}
