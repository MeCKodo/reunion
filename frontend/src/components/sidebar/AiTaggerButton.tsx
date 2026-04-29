import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Sparkles, Loader2 } from "lucide-react";

import { ChipButton } from "./ChipButton";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useTaskCenter } from "@/lib/task-center";
import {
  AI_TAG_BATCH_LIMIT,
  AI_TAG_MAX_CONCURRENCY,
  fetchAiAccounts,
  fetchAiModels,
  type AiAccountsSnapshot,
  type AiModelOption,
  type AiProvider,
  type AiTagExtractStrategy,
} from "@/lib/api";
import type { SearchResult, TagSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AiTaggerButtonProps {
  filteredResults: SearchResult[];
  allTags: TagSummary[];
  /**
   * Forwarded to the toast helper inside the modal so failures from the
   * config screen (e.g. failing to fetch models) flow through the same
   * notification stack the rest of the app uses. Optional.
   */
  onError?: (message: string) => void;
}

const STRATEGIES: AiTagExtractStrategy[] = [
  "auto",
  "first",
  "first_last",
  "sample",
  "all",
];

/**
 * Per-session wall-clock estimate, by provider. Calibrated against real runs
 * with the user-message extraction strategy and a generic chat-class model:
 *   - OpenAI direct API streams ~6s per call
 *   - Cursor CLI buffers the whole reply before yielding (~20s per call)
 * Estimates round up so users aren't surprised by long batches.
 */
const SECONDS_PER_SESSION_BY_PROVIDER: Record<AiProvider, number> = {
  openai: 6,
  cursor: 20,
};

export function AiTaggerButton({
  filteredResults,
  allTags,
  onError,
}: AiTaggerButtonProps) {
  const { t } = useTranslation();
  const { submitAiTaggingTask, sidebarOpen, setSidebarOpen } = useTaskCenter();

  const [modalOpen, setModalOpen] = React.useState(false);
  const [accounts, setAccounts] = React.useState<AiAccountsSnapshot | null>(null);
  const [accountsLoading, setAccountsLoading] = React.useState(false);
  const [provider, setProvider] = React.useState<AiProvider>("openai");
  const [models, setModels] = React.useState<AiModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [model, setModel] = React.useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [includeAlreadyTagged, setIncludeAlreadyTagged] = React.useState(false);
  const [strategy, setStrategy] = React.useState<AiTagExtractStrategy>("auto");
  const [submitting, setSubmitting] = React.useState(false);

  // A session counts as "needs tagging" when the AI never ran on it OR the
  // user has since cleared its tag list (an implicit "please re-tag" signal).
  // Mirrors the backend skip logic in tag-runner.ts so the count we surface
  // matches exactly what the batch run will pick up.
  const needsTagging = React.useCallback(
    (r: SearchResult) => !r.ai_tagged_at || (r.tags?.length ?? 0) === 0,
    []
  );

  const eligibleAll = React.useMemo(() => {
    if (includeAlreadyTagged) return filteredResults;
    return filteredResults.filter(needsTagging);
  }, [filteredResults, includeAlreadyTagged, needsTagging]);

  // Cap at the backend batch limit so the server never has to reject our
  // request. Anything beyond the cap is surfaced in the UI as an overflow
  // hint so the user knows to run again for the rest.
  const eligibleSessions = React.useMemo(
    () => eligibleAll.slice(0, AI_TAG_BATCH_LIMIT),
    [eligibleAll]
  );
  const overflowCount = Math.max(0, eligibleAll.length - AI_TAG_BATCH_LIMIT);

  // "Already tagged" hint counts only sessions where the AI ran AND the tags
  // are still attached — clearing the tags is what flips them out of this
  // bucket and into the eligible set.
  const alreadyTaggedCount = React.useMemo(
    () =>
      filteredResults.filter(
        (r) => Boolean(r.ai_tagged_at) && (r.tags?.length ?? 0) > 0
      ).length,
    [filteredResults]
  );

  const buttonCount = React.useMemo(
    () => filteredResults.filter(needsTagging).length,
    [filteredResults, needsTagging]
  );

  // Lazy-load AI accounts the first time the modal is opened. We keep the
  // result around for the rest of the session so re-opening the modal is
  // instant; users can hit Settings -> account if they need to refresh.
  React.useEffect(() => {
    if (!modalOpen) return;
    if (accounts) return;
    let cancelled = false;
    setAccountsLoading(true);
    (async () => {
      try {
        const snapshot = await fetchAiAccounts();
        if (cancelled) return;
        setAccounts(snapshot);
        // Seed the modal with the user's defaults so the common path
        // requires zero clicks.
        const initialProvider = snapshot.settings.defaultProvider || "openai";
        setProvider(initialProvider);
        setModel(snapshot.settings.defaultModel ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onError?.(message);
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modalOpen, accounts, onError]);

  // Refresh model list whenever the selected provider changes (or the
  // modal opens for the first time once accounts are ready).
  React.useEffect(() => {
    if (!modalOpen) return;
    let cancelled = false;
    setModelsLoading(true);
    (async () => {
      try {
        const data = await fetchAiModels(provider);
        if (cancelled) return;
        setModels(data.models || []);
        // Only auto-select a default model if the user hasn't picked one
        // for this provider yet, otherwise we'd clobber an explicit choice
        // when re-opening the modal.
        setModel((prev) => {
          if (prev && (data.models || []).some((m) => m.id === prev)) {
            return prev;
          }
          const defaultModel = (data.models || []).find((m) => m.isDefault);
          return defaultModel?.id ?? null;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onError?.(message);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, modalOpen, onError]);

  const providerReady = React.useMemo(() => {
    if (!accounts) return false;
    if (provider === "openai") return (accounts.openai.accounts || []).length > 0;
    if (provider === "cursor") return Boolean(accounts.cursor.loggedIn);
    return false;
  }, [accounts, provider]);

  const canStart =
    !submitting &&
    providerReady &&
    eligibleSessions.length > 0 &&
    !accountsLoading;

  // Concurrency-aware estimate: ceil(total / concurrency) * per-session.
  // Per-session time depends on the provider (Cursor CLI is much slower
  // than OpenAI). Floors at one slot so 1-session runs still show a number.
  const estimateText = React.useMemo(() => {
    if (eligibleSessions.length === 0) return null;
    const perSession = SECONDS_PER_SESSION_BY_PROVIDER[provider] ?? 8;
    const slots = Math.max(1, Math.ceil(eligibleSessions.length / AI_TAG_MAX_CONCURRENCY));
    const seconds = slots * perSession;
    return formatDuration(seconds, t);
  }, [eligibleSessions.length, provider, t]);

  const handleStart = async () => {
    if (!canStart) return;
    setSubmitting(true);
    try {
      await submitAiTaggingTask({
        payload: {
          sessionKeys: eligibleSessions.map((s) => s.session_key),
          options: {
            includeAlreadyTagged,
            strategy,
            provider,
            model: model || undefined,
            maxConcurrency: AI_TAG_MAX_CONCURRENCY,
          },
        },
        label: t("aiTagger.runningTaskLabel", {
          count: eligibleSessions.length,
        }),
      });
      setModalOpen(false);
      if (!sidebarOpen) setSidebarOpen(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <ChipButton
        active={modalOpen}
        onClick={() => setModalOpen(true)}
        icon={<Sparkles className="h-3 w-3" />}
        title={t("aiTagger.buttonTooltip")}
      >
        {buttonCount > 0
          ? t("aiTagger.buttonLabelWithCount", { count: buttonCount })
          : t("aiTagger.buttonLabel")}
      </ChipButton>

      <Modal
        open={modalOpen}
        onClose={() => (submitting ? undefined : setModalOpen(false))}
        title={t("aiTagger.modalTitle")}
        description={t("aiTagger.modalDescription")}
        sizeClassName="max-w-xl"
        footer={
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              {eligibleSessions.length > 0 && estimateText
                ? t("aiTagger.estimateTime", { value: estimateText })
                : t("aiTagger.noEligible")}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setModalOpen(false)}
                disabled={submitting}
              >
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleStart} disabled={!canStart}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t("aiTagger.starting")}
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    {t("aiTagger.startButton")}
                  </>
                )}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          {/* Target summary */}
          <section className="rounded-lg border border-border bg-background-soft p-3">
            <div className="text-[13px] font-medium text-foreground">
              {t("aiTagger.targetSummary", { count: eligibleSessions.length })}
            </div>
            {overflowCount > 0 ? (
              <div className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-500">
                {t("aiTagger.overflowHint", {
                  limit: AI_TAG_BATCH_LIMIT,
                  remaining: overflowCount,
                })}
              </div>
            ) : null}
            {alreadyTaggedCount > 0 && !includeAlreadyTagged ? (
              <div className="mt-1 text-[11.5px] text-muted-foreground">
                {t("aiTagger.alreadyTaggedHint", { count: alreadyTaggedCount })}
              </div>
            ) : null}
          </section>

          {/* Provider / Model */}
          <section className="space-y-2.5">
            <SectionHeader title={t("aiTagger.providerSection")} />
            {accountsLoading ? (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("aiTagger.providerLoading")}
              </div>
            ) : !accounts ? (
              <div className="text-[12px] text-muted-foreground">
                {t("aiTagger.providerNotConfigured")}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <ProviderRadio
                    active={provider === "openai"}
                    label={t("aiTagger.providerOpenai")}
                    helper={
                      (accounts.openai.accounts || []).length === 0
                        ? t("aiTagger.providerOpenaiNotReady")
                        : undefined
                    }
                    onClick={() => setProvider("openai")}
                  />
                  <ProviderRadio
                    active={provider === "cursor"}
                    label={t("aiTagger.providerCursor")}
                    helper={
                      !accounts.cursor.loggedIn
                        ? t("aiTagger.providerCursorNotReady")
                        : undefined
                    }
                    onClick={() => setProvider("cursor")}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-mono uppercase tracking-overline text-muted-foreground">
                    {t("aiTagger.modelSection")}
                  </label>
                  <select
                    className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[12px] text-foreground"
                    value={model ?? ""}
                    onChange={(e) => setModel(e.target.value || null)}
                    disabled={modelsLoading || models.length === 0}
                  >
                    {modelsLoading ? (
                      <option>{t("aiTagger.modelLoading")}</option>
                    ) : models.length === 0 ? (
                      <option value="">{t("aiTagger.modelDefault")}</option>
                    ) : (
                      <>
                        <option value="">{t("aiTagger.modelDefault")}</option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                            {m.isDefault ? " ★" : ""}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  <p className="mt-1 text-[10.5px] text-muted-foreground">
                    {t(
                      provider === "cursor"
                        ? "aiTagger.modelRecommendCursor"
                        : "aiTagger.modelRecommendOpenai"
                    )}
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Privacy + vocab notices */}
          <section className="space-y-1.5 text-[11.5px] text-muted-foreground">
            <p>{t("aiTagger.privacyNotice")}</p>
            {allTags.length > 0 ? (
              <p>{t("aiTagger.vocabHint", { count: allTags.length })}</p>
            ) : (
              <p className="text-foreground/70">{t("aiTagger.vocabEmpty")}</p>
            )}
          </section>

          {/* Advanced panel */}
          <section className="rounded-lg border border-border">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-[12px] font-medium text-foreground hover:bg-background-soft"
            >
              <span className="inline-flex items-center gap-1.5">
                {advancedOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                {t("aiTagger.advanced")}
              </span>
            </button>
            {advancedOpen ? (
              <div className="space-y-3 border-t border-border px-3 py-3">
                <label className="flex items-start gap-2 text-[12px] text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={includeAlreadyTagged}
                    onChange={(e) => setIncludeAlreadyTagged(e.target.checked)}
                  />
                  <span className="flex-1">
                    <span className="block">
                      {t("aiTagger.includeAlreadyTagged")}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t("aiTagger.includeAlreadyTaggedDesc")}
                    </span>
                  </span>
                </label>

                <div>
                  <div className="mb-1.5 text-[11px] font-mono uppercase tracking-overline text-muted-foreground">
                    {t("aiTagger.extractStrategy")}
                  </div>
                  <div className="text-[11px] text-muted-foreground/80 mb-2">
                    {t("aiTagger.extractStrategyDesc")}
                  </div>
                  <div className="space-y-1.5">
                    {STRATEGIES.map((s) => (
                      <StrategyOption
                        key={s}
                        active={strategy === s}
                        label={t(`aiTagger.strategy${pascalCase(s)}` as const)}
                        hint={t(`aiTagger.strategy${pascalCase(s)}Hint` as const)}
                        onClick={() => setStrategy(s)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </Modal>
    </>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="text-[11px] font-mono uppercase tracking-overline text-muted-foreground">
      {title}
    </div>
  );
}

function ProviderRadio({
  active,
  label,
  helper,
  onClick,
}: {
  active: boolean;
  label: string;
  helper?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border-strong bg-surface text-foreground hover:bg-background-soft"
      )}
    >
      <span className="text-[12.5px] font-medium">{label}</span>
      {helper ? (
        <span
          className={cn(
            "text-[10.5px]",
            active ? "text-background/80" : "text-muted-foreground"
          )}
        >
          {helper}
        </span>
      ) : null}
    </button>
  );
}

function StrategyOption({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-foreground bg-foreground/5"
          : "border-border bg-surface hover:bg-background-soft"
      )}
    >
      <span
        className={cn(
          "mt-1 h-2.5 w-2.5 rounded-full border",
          active ? "border-foreground bg-foreground" : "border-border-strong"
        )}
      />
      <span className="flex-1">
        <span className="block text-[12px] font-medium text-foreground">
          {label}
        </span>
        <span className="block text-[10.5px] text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function pascalCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Pretty-print a wall-clock estimate. Sub-minute renders as "Xs", anything
 * longer as "X 分钟" / "X min" via i18n keys so we don't get awkward
 * "120s" labels for multi-minute batches.
 */
function formatDuration(
  seconds: number,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  if (seconds < 60) {
    return t("aiTagger.durationSeconds", { seconds });
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return t("aiTagger.durationMinutes", { minutes });
}
