import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "@/i18n";
import {
  fetchAnnotations,
  putAnnotation as putAnnotationApi,
  type AnnotationPatch,
  type AnnotationUpdateResponse,
} from "@/lib/api";
import type { SessionAnnotation, SessionDetail, SearchResult, TagSummary } from "@/lib/types";
import { normalizeTagInput } from "@/lib/format";

interface UseAnnotationsArgs {
  setResults: (updater: (prev: SearchResult[]) => SearchResult[]) => void;
  setDetail: (updater: (prev: SessionDetail | null) => SessionDetail | null) => void;
  onError: (message: string) => void;
}

export function useAnnotations({ setResults, setDetail, onError }: UseAnnotationsArgs) {
  const [annotations, setAnnotations] = useState<Record<string, SessionAnnotation>>({});
  const [allTags, setAllTags] = useState<TagSummary[]>([]);
  // Distinguishes "not yet fetched" from "fetched and the user has zero tags"
  // so callers can safely reconcile persisted tag selections without nuking
  // them during the initial render.
  const [loaded, setLoaded] = useState(false);
  const annotationsRef = useRef<Record<string, SessionAnnotation>>({});

  const refreshTagsFromMap = useCallback((map: Record<string, SessionAnnotation>) => {
    const counts = new Map<string, number>();
    for (const ann of Object.values(map)) {
      for (const tag of ann.tags || []) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    setAllTags(
      Array.from(counts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    );
  }, []);

  const applyLocal = useCallback(
    (
      sessionKey: string,
      annotation: SessionAnnotation | null,
      serverTags?: TagSummary[]
    ) => {
      setAnnotations((prev) => {
        const next = { ...prev };
        if (annotation) next[sessionKey] = annotation;
        else delete next[sessionKey];
        annotationsRef.current = next;
        if (!serverTags) refreshTagsFromMap(next);
        return next;
      });
      if (serverTags) setAllTags(serverTags);

      const flat = {
        starred: Boolean(annotation?.starred),
        tags: annotation?.tags || [],
        ai_tag_set: annotation?.aiTagSet || [],
        ai_tagged_at:
          typeof annotation?.aiTaggedAt === "number" ? annotation.aiTaggedAt : null,
      };
      setResults((prev) =>
        prev.map((item) => (item.session_key === sessionKey ? { ...item, ...flat } : item))
      );
      setDetail((prev) => (prev && prev.session_key === sessionKey ? { ...prev, ...flat } : prev));
    },
    [refreshTagsFromMap, setResults, setDetail]
  );

  const put = useCallback(
    async (sessionKey: string, patch: AnnotationPatch) => {
      const prev = annotationsRef.current[sessionKey];
      const nextTags = Array.isArray(patch.tags) ? patch.tags : prev?.tags;
      // Mirror backend behaviour: removing a tag from `tags` should also
      // strip it from `aiTagSet` so the AI subset never drifts past the
      // surviving tag list. Adding a manual tag does not touch aiTagSet.
      const survivedAiSet =
        prev?.aiTagSet && nextTags
          ? prev.aiTagSet.filter((t) => nextTags.includes(t))
          : prev?.aiTagSet;
      const optimistic: SessionAnnotation = {
        starred: typeof patch.starred === "boolean" ? patch.starred : prev?.starred,
        tags: nextTags,
        aiTagSet: survivedAiSet && survivedAiSet.length > 0 ? survivedAiSet : undefined,
        aiTaggedAt: prev?.aiTaggedAt,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      const isEmpty =
        !optimistic.starred &&
        (!optimistic.tags || optimistic.tags.length === 0) &&
        typeof optimistic.aiTaggedAt !== "number";
      applyLocal(sessionKey, isEmpty ? null : optimistic);

      try {
        const data: AnnotationUpdateResponse = await putAnnotationApi(sessionKey, patch);
        applyLocal(sessionKey, data.annotation, data.tags);
        return data;
      } catch (error) {
        applyLocal(sessionKey, prev || null);
        onError(i18n.t("common.annotationSaveFailed", { error: String(error) }));
        return null;
      }
    },
    [applyLocal, onError]
  );

  const toggleStar = useCallback(
    (sessionKey: string) => {
      const prev = annotationsRef.current[sessionKey];
      void put(sessionKey, { starred: !prev?.starred });
    },
    [put]
  );

  const addTag = useCallback(
    (sessionKey: string, tag: string) => {
      const norm = normalizeTagInput(tag);
      if (!norm) return false;
      const prev = annotationsRef.current[sessionKey]?.tags || [];
      if (prev.includes(norm)) return false;
      void put(sessionKey, { tags: [...prev, norm] });
      return true;
    },
    [put]
  );

  const removeTag = useCallback(
    (sessionKey: string, tag: string) => {
      const prev = annotationsRef.current[sessionKey]?.tags || [];
      void put(sessionKey, { tags: prev.filter((item) => item !== tag) });
    },
    [put]
  );

  /**
   * Apply a single AI auto-tagging result optimistically. Used by the
   * AI tagger SSE loop so the UI scrolls real-time as each session
   * completes — the final `setAllTagsSummary` call (driven by the
   * server's `done` event) reconciles any drift.
   */
  const applyAiTagResult = useCallback(
    (
      sessionKey: string,
      payload: { allTags: string[]; aiTags: string[]; aiTaggedAt: number }
    ) => {
      const prev = annotationsRef.current[sessionKey];
      const next: SessionAnnotation = {
        ...(prev || {}),
        tags: payload.allTags,
        aiTagSet: payload.aiTags.length > 0 ? payload.aiTags : undefined,
        aiTaggedAt: payload.aiTaggedAt,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      applyLocal(sessionKey, next);
    },
    [applyLocal]
  );

  /**
   * Replace the global tag summary in one shot. Called once at the end
   * of an AI tagging run with the server's authoritative count so we
   * don't accumulate small drift from per-progress refreshes.
   */
  const setAllTagsSummary = useCallback((tags: TagSummary[]) => {
    setAllTags(tags);
  }, []);

  const loadOnce = useCallback(async () => {
    try {
      const data = await fetchAnnotations();
      const map = data.annotations || {};
      annotationsRef.current = map;
      setAnnotations(map);
      setAllTags(data.tags || []);
    } catch {
      // ignore load failure; user can retry via reindex
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  return {
    annotations,
    allTags,
    loaded,
    toggleStar,
    addTag,
    removeTag,
    put,
    applyLocal,
    applyAiTagResult,
    setAllTagsSummary,
    loadOnce,
    annotationsRef,
  };
}
