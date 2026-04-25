import { promises as fs } from "node:fs";
import { ANNOTATION_TAG_MAX, ANNOTATIONS_FILE } from "./config";
import { atomicWriteFile, ensureDataDir } from "./lib/fs";
import type { AnnotationsFile, Session, SessionAnnotation } from "./types";

const ANNOTATION_VERSION = 2;

let inMemoryAnnotations: Record<string, SessionAnnotation> | null = null;
let inMemoryVersion = 0;
let isSavingAnnotations = false;

export function normalizeTag(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.toLowerCase().trim().replace(/[^\w\u4e00-\u9fff_-]+/g, "");
  if (!cleaned) return null;
  return cleaned.slice(0, ANNOTATION_TAG_MAX);
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const norm = normalizeTag(tag);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

export function isAnnotationEmpty(a: SessionAnnotation): boolean {
  if (a.starred) return false;
  if (a.tags && a.tags.length > 0) return false;
  if (a.notes && a.notes.trim()) return false;
  return true;
}

export async function loadAnnotations(): Promise<Record<string, SessionAnnotation>> {
  if (inMemoryAnnotations) return inMemoryAnnotations;
  try {
    const raw = await fs.readFile(ANNOTATIONS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as AnnotationsFile;
    inMemoryAnnotations =
      parsed.annotations && typeof parsed.annotations === "object" ? parsed.annotations : {};
    inMemoryVersion = typeof parsed.version === "number" ? parsed.version : 1;
  } catch {
    inMemoryAnnotations = {};
    inMemoryVersion = ANNOTATION_VERSION;
  }
  return inMemoryAnnotations;
}

export async function saveAnnotations(): Promise<void> {
  if (!inMemoryAnnotations) return;
  while (isSavingAnnotations) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  isSavingAnnotations = true;
  try {
    await ensureDataDir();
    const data: AnnotationsFile = {
      version: inMemoryVersion || ANNOTATION_VERSION,
      annotations: inMemoryAnnotations,
    };
    await atomicWriteFile(ANNOTATIONS_FILE, JSON.stringify(data, null, 2));
  } finally {
    isSavingAnnotations = false;
  }
}

export function buildTagSummary(
  annotations: Record<string, SessionAnnotation>
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const ann of Object.values(annotations)) {
    for (const tag of ann.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function projectAnnotation(
  annotations: Record<string, SessionAnnotation>,
  sessionKey: string
) {
  const ann = annotations[sessionKey];
  return {
    starred: Boolean(ann?.starred),
    tags: Array.isArray(ann?.tags) ? ann!.tags! : [],
    notes: typeof ann?.notes === "string" ? ann.notes : "",
  };
}

export async function migrateAnnotationKeys(
  annotations: Record<string, SessionAnnotation>,
  sessions: Session[]
): Promise<void> {
  if (inMemoryVersion >= ANNOTATION_VERSION) return;
  if (!sessions || sessions.length === 0) return;

  const oldKeys = Object.keys(annotations).filter((key) => key.split(":").length === 2);
  if (oldKeys.length === 0) {
    inMemoryVersion = ANNOTATION_VERSION;
    await saveAnnotations();
    return;
  }

  const byRepoSid = new Map<string, Session[]>();
  for (const session of sessions) {
    const lookup = `${session.repo}:${session.sessionId}`;
    const list = byRepoSid.get(lookup) || [];
    list.push(session);
    byRepoSid.set(lookup, list);
  }

  let migrated = 0;
  for (const oldKey of oldKeys) {
    const matches = byRepoSid.get(oldKey) || [];
    if (matches.length !== 1) continue;
    const newKey = matches[0].sessionKey;
    if (newKey === oldKey || newKey in annotations) continue;
    annotations[newKey] = annotations[oldKey];
    delete annotations[oldKey];
    migrated += 1;
  }

  inMemoryVersion = ANNOTATION_VERSION;
  await saveAnnotations();
  if (migrated > 0) {
    console.log(`annotations: migrated ${migrated} legacy keys to source-aware format`);
  }
}
