import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  Crown,
  ExternalLink,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  deleteOpenAiAccount,
  fetchAiAccounts,
  fetchAiModels,
  logoutCursor,
  refreshOpenAiAccount,
  setDefaultOpenAiAccount,
  startCursorLogin,
  startOpenAiLogin,
  updateAiSettings,
  type AiAccountsSnapshot,
  type AiCursorState,
  type AiModelOption,
  type AiOpenAiAccount,
  type AiProvider,
  type AiReasoningEffort,
  type AiServiceTier,
  type AiSettingsView,
} from "@/lib/api";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface OpenAiCardProps {
  account: AiOpenAiAccount;
  isDefault: boolean;
  busy: boolean;
  onSetDefault: (id: string) => void;
  onRefresh: (id: string) => void;
  onRemove: (id: string) => void;
  onRelogin: (id: string) => void;
}

const PLAN_LABEL: Record<string, string> = {
  pro: "Pro",
  plus: "Plus",
  team: "Team",
  free: "Free",
  enterprise: "Enterprise",
};

function planBadge(plan: string | null): { label: string; className: string } {
  if (!plan) return { label: "—", className: "bg-muted text-muted-foreground" };
  const key = plan.toLowerCase();
  const label = PLAN_LABEL[key] ?? plan;
  if (key === "pro" || key === "team" || key === "enterprise") {
    return { label, className: "bg-primary-soft text-primary" };
  }
  if (key === "plus") return { label, className: "bg-accent-soft text-accent" };
  return { label, className: "bg-muted text-muted-foreground" };
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "never";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function QuotaBar({
  label,
  remainingPct,
  resetAt,
}: {
  label: string;
  remainingPct: number | null;
  resetAt: string | null;
}) {
  if (remainingPct == null) {
    return (
      <div className="text-[11px] text-muted-foreground">
        <span className="font-mono uppercase tracking-overline">{label}</span>{" "}
        <span className="opacity-70">unknown</span>
      </div>
    );
  }
  const tone =
    remainingPct >= 60
      ? "bg-emerald-500"
      : remainingPct >= 25
        ? "bg-amber-500"
        : "bg-rose-500";
  const reset = resetAt ? formatRelative(resetAt) : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-mono uppercase tracking-overline text-muted-foreground">
          {label}
        </span>
        <span className="text-foreground tabular-nums">{remainingPct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-background-soft">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${Math.max(2, remainingPct)}%` }}
        />
      </div>
      {reset ? (
        <div className="text-[10px] font-mono uppercase tracking-overline text-muted-foreground">
          resets {reset}
        </div>
      ) : null}
    </div>
  );
}

function OpenAiCard({
  account,
  isDefault,
  busy,
  onSetDefault,
  onRefresh,
  onRemove,
  onRelogin,
}: OpenAiCardProps) {
  const plan = planBadge(account.lastCheck?.planType ?? null);
  const checkError = account.lastCheck?.error ?? null;
  return (
    <div
      className={cn(
        "rounded-lg border bg-surface p-4 transition-colors",
        isDefault
          ? "border-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.2)]"
          : "border-border"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium text-foreground">
              {account.email || account.label}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]",
                plan.className
              )}
            >
              {plan.label}
            </span>
            {isDefault ? (
              <span className="inline-flex items-center gap-1 rounded-sm bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
                <Crown className="h-3 w-3" /> default
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[11px] font-mono uppercase tracking-overline text-muted-foreground">
            <span>id {account.id.slice(0, 12)}</span>
            <span className="opacity-50"> · </span>
            <span>used {formatRelative(account.lastUsedAt)}</span>
            <span className="opacity-50"> · </span>
            <span>checked {formatRelative(account.lastCheck?.checkedAt ?? null)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {!isDefault ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onSetDefault(account.id)}
              title="Set as default OpenAI account"
            >
              <Crown className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Set default</span>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onRefresh(account.id)}
            title="Re-check plan / quota"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Refresh</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onRelogin(account.id)}
            title="Re-run codex login for this account"
          >
            <LogIn className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Re-login</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onRemove(account.id)}
            title="Remove this account"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Remove</span>
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <QuotaBar
          label="primary window"
          remainingPct={account.lastCheck?.primaryRemainingPercent ?? null}
          resetAt={account.lastCheck?.primaryResetAt ?? null}
        />
        <QuotaBar
          label="secondary window"
          remainingPct={account.lastCheck?.secondaryRemainingPercent ?? null}
          resetAt={account.lastCheck?.secondaryResetAt ?? null}
        />
      </div>

      {checkError ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <AlertCircle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>{checkError}</span>
        </div>
      ) : null}
    </div>
  );
}

interface CursorPanelProps {
  state: AiCursorState | null;
  busy: boolean;
  loginUrl: string | null;
  onLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
}

function CursorPanel({ state, busy, loginUrl, onLogin, onLogout, onRefresh }: CursorPanelProps) {
  if (!state) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-[13px] text-muted-foreground">
        Loading Cursor account state…
      </div>
    );
  }
  if (!state.installed) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <div className="flex items-start gap-2 text-[13px] text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-[1px] h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">cursor-agent CLI not found</div>
            <p className="mt-1 text-muted-foreground">
              Install Cursor desktop and ensure <code>cursor-agent</code> is on PATH.
              Then come back and click "Login Cursor".
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {state.loggedIn ? (
              <span className="inline-flex items-center gap-1 rounded-sm bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> logged in
              </span>
            ) : (
              <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                signed out
              </span>
            )}
            {state.plan ? (
              <span className="inline-flex items-center rounded-sm bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
                {state.plan}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[14px] font-medium text-foreground">
            {state.email || (state.loggedIn ? "Account email unavailable" : "Not signed in")}
          </div>
          <div className="mt-1 text-[11px] font-mono uppercase tracking-overline text-muted-foreground">
            tokens stored in macOS Keychain by cursor-agent
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {state.loggedIn ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onRefresh}
                title="Re-query cursor-agent (otherwise cached for ~60s)"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Refresh</span>
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={onLogin}>
                <LogIn className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Re-login</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onLogout}
                className="text-destructive hover:text-destructive"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Logout</span>
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={onLogin}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogIn className="h-3.5 w-3.5" />
              )}
              Login Cursor
            </Button>
          )}
        </div>
      </div>

      {state.warning ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>{state.warning}</span>
        </div>
      ) : null}

      {loginUrl ? (
        <div className="mt-3 rounded-md border border-primary/30 bg-primary-soft/40 px-3 py-2 text-[12px] text-foreground">
          <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
            login url
          </div>
          <div className="mt-1 flex items-center gap-2">
            <a
              href={loginUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-primary underline-offset-4 hover:underline"
            >
              {loginUrl}
            </a>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface DefaultProviderControlProps {
  settings: AiSettingsView;
  hasOpenAi: boolean;
  hasCursor: boolean;
  onChange: (provider: AiProvider) => void;
}

function DefaultProviderControl({
  settings,
  hasOpenAi,
  hasCursor,
  onChange,
}: DefaultProviderControlProps) {
  return (
    <div className="rounded-lg border border-border bg-background-soft p-4">
      <div className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
        Default provider
      </div>
      <div className="mt-1 text-[13px] text-muted-foreground">
        Smart Export and Ask AI both fall back to this provider when no override is
        specified.
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ProviderRadio
          provider="openai"
          active={settings.defaultProvider === "openai"}
          available={hasOpenAi}
          title="OpenAI / ChatGPT"
          subtitle={
            hasOpenAi
              ? "Routes to your default ChatGPT account."
              : "Add a ChatGPT account first."
          }
          onSelect={() => onChange("openai")}
        />
        <ProviderRadio
          provider="cursor"
          active={settings.defaultProvider === "cursor"}
          available={hasCursor}
          title="Cursor Agent"
          subtitle={
            hasCursor
              ? "Uses the signed-in Cursor account."
              : "Login to Cursor first."
          }
          onSelect={() => onChange("cursor")}
        />
      </div>
    </div>
  );
}

interface ModelPickerProps {
  provider: AiProvider;
  /** Active default model id (settings.defaultModel). null means "CLI default". */
  value: string | null;
  models: AiModelOption[];
  loading: boolean;
  warning: string | null;
  onChange: (next: string | null) => void;
}

function ModelPicker({
  provider,
  value,
  models,
  loading,
  warning,
  onChange,
}: ModelPickerProps) {
  const cliDefault = models.find((m) => m.isDefault);
  const cliDefaultLabel = cliDefault
    ? `Provider default · ${cliDefault.label}`
    : "Provider default";
  return (
    <div className="mt-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
          Default model · {provider}
        </span>
        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground transition-colors hover:text-foreground"
          >
            reset
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
        Smart Export and Ask AI fall back to this model. Leave on the provider
        default to mirror the CLI's <code>/model</code> selection.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <select
          value={value ?? ""}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === "" ? null : next);
          }}
          disabled={loading || models.length === 0}
          className={cn(
            "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            "disabled:cursor-not-allowed disabled:opacity-60"
          )}
        >
          <option value="">{cliDefaultLabel}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.id}
            </option>
          ))}
        </select>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
      </div>
      {warning ? (
        <div className="mt-2 flex items-start gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      ) : null}
      {!loading && models.length === 0 && !warning ? (
        <div className="mt-2 text-[11.5px] text-muted-foreground">
          No models reported by the CLI yet — sign in or run{" "}
          <code>cursor-agent --list-models</code> manually to verify.
        </div>
      ) : null}
    </div>
  );
}

// Mirrors codex-rs effort_rank ordering: more effort = more "thinking time".
// Labels chosen to match codex CLI's `/model` picker so muscle memory transfers.
const EFFORT_LABELS: Record<AiReasoningEffort, { title: string; hint: string }> = {
  none: { title: "None", hint: "Skip reasoning · fastest, lowest cost" },
  minimal: { title: "Minimal", hint: "Tiny scratchpad · low latency" },
  low: { title: "Low", hint: "Quick think · efficient" },
  medium: { title: "Medium", hint: "Balanced quality / speed (CLI default)" },
  high: { title: "High", hint: "Deeper plan · slower" },
  xhigh: { title: "X-High", hint: "Maximum effort · multi-minute responses" },
};

interface ReasoningEffortPickerProps {
  efforts: AiReasoningEffort[];
  /** Active value; null = "model default" (codex CLI behaviour). */
  value: AiReasoningEffort | null;
  onChange: (next: AiReasoningEffort | null) => void;
  /** Active model id; used to remind the user when the current model ignores effort. */
  activeModelId: string | null;
  modelSupportsReasoning: boolean | undefined;
}

function ReasoningEffortPicker({
  efforts,
  value,
  onChange,
  activeModelId,
  modelSupportsReasoning,
}: ReasoningEffortPickerProps) {
  if (efforts.length === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
          Reasoning effort · openai
        </span>
        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground transition-colors hover:text-foreground"
          >
            reset
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
        How hard the model "thinks" before answering. Mirrors{" "}
        <code>model_reasoning_effort</code> in <code>~/.codex/config.toml</code>.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn(
            "flex flex-col items-start gap-0.5 rounded-md border bg-background px-2.5 py-1.5 text-left transition-colors",
            value === null
              ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.18)]"
              : "border-border hover:border-foreground/30"
          )}
        >
          <span className="text-[12.5px] font-medium text-foreground">Model default</span>
          <span className="text-[11px] leading-snug text-muted-foreground">
            Don't override · let the API decide
          </span>
        </button>
        {efforts.map((effort) => {
          const meta = EFFORT_LABELS[effort];
          const active = value === effort;
          return (
            <button
              key={effort}
              type="button"
              onClick={() => onChange(effort)}
              className={cn(
                "flex flex-col items-start gap-0.5 rounded-md border bg-background px-2.5 py-1.5 text-left transition-colors",
                active
                  ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.18)]"
                  : "border-border hover:border-foreground/30"
              )}
            >
              <span className="text-[12.5px] font-medium text-foreground">{meta.title}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{meta.hint}</span>
            </button>
          );
        })}
      </div>
      {modelSupportsReasoning === false && activeModelId ? (
        <div className="mt-2 flex items-start gap-1.5 text-[11.5px] text-muted-foreground">
          <TriangleAlert className="mt-[1px] h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>
            <code>{activeModelId}</code> is not a reasoning model — effort will be silently
            ignored by the API. Pick a gpt-5.5 family model to enable thinking.
          </span>
        </div>
      ) : null}
    </div>
  );
}

const SERVICE_TIER_LABELS: Record<AiServiceTier, { title: string; hint: string }> = {
  fast: { title: "Fast (Priority)", hint: "Lowest latency · uses faster pool" },
  flex: { title: "Flex", hint: "Higher quotas, slower · cheaper for batches" },
};

interface ServiceTierPickerProps {
  tiers: AiServiceTier[];
  value: AiServiceTier | null;
  onChange: (next: AiServiceTier | null) => void;
}

function ServiceTierPicker({ tiers, value, onChange }: ServiceTierPickerProps) {
  if (tiers.length === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
          Service tier · openai
        </span>
        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground transition-colors hover:text-foreground"
          >
            reset
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
        Routes the request to the priority or flex pool. Auto = leave it to your plan
        (matches codex CLI's <code>service_tier</code>).
      </p>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn(
            "flex flex-col items-start gap-0.5 rounded-md border bg-background px-2.5 py-1.5 text-left transition-colors",
            value === null
              ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.18)]"
              : "border-border hover:border-foreground/30"
          )}
        >
          <span className="text-[12.5px] font-medium text-foreground">Auto</span>
          <span className="text-[11px] leading-snug text-muted-foreground">Plan default</span>
        </button>
        {tiers.map((tier) => {
          const meta = SERVICE_TIER_LABELS[tier];
          const active = value === tier;
          return (
            <button
              key={tier}
              type="button"
              onClick={() => onChange(tier)}
              className={cn(
                "flex flex-col items-start gap-0.5 rounded-md border bg-background px-2.5 py-1.5 text-left transition-colors",
                active
                  ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.18)]"
                  : "border-border hover:border-foreground/30"
              )}
            >
              <span className="text-[12.5px] font-medium text-foreground">{meta.title}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{meta.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProviderRadio({
  provider,
  active,
  available,
  title,
  subtitle,
  onSelect,
}: {
  provider: AiProvider;
  active: boolean;
  available: boolean;
  title: string;
  subtitle: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!available}
      className={cn(
        "flex flex-col items-start gap-1 rounded-md border bg-surface p-3 text-left transition-colors",
        active
          ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.2)]"
          : "border-border hover:border-foreground/30",
        !available && "cursor-not-allowed opacity-60"
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <span
          className={cn(
            "h-3.5 w-3.5 shrink-0 rounded-full border",
            active
              ? "border-primary bg-primary shadow-[inset_0_0_0_3px_hsl(var(--background))]"
              : "border-border-strong"
          )}
          aria-hidden
        />
      </div>
      <span className="text-[11.5px] leading-snug text-muted-foreground">
        {subtitle}
      </span>
      <span className="font-mono text-[9.5px] uppercase tracking-overline text-muted-foreground/80">
        provider · {provider}
      </span>
    </button>
  );
}

function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [snapshot, setSnapshot] = React.useState<AiAccountsSnapshot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busyAccount, setBusyAccount] = React.useState<string | null>(null);
  const [openAiLoginBusy, setOpenAiLoginBusy] = React.useState(false);
  const [cursorBusy, setCursorBusy] = React.useState(false);
  const [openAiLoginUrl, setOpenAiLoginUrl] = React.useState<string | null>(null);
  const [cursorLoginUrl, setCursorLoginUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [models, setModels] = React.useState<AiModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [modelsWarning, setModelsWarning] = React.useState<string | null>(null);
  // OpenAI-only capabilities (reasoning effort + service tier enums) returned
  // by /api/ai/models. We render the pickers off these so backend-side enum
  // changes propagate without frontend code changes.
  const [reasoningEfforts, setReasoningEfforts] = React.useState<AiReasoningEffort[]>([]);
  const [serviceTiers, setServiceTiers] = React.useState<AiServiceTier[]>([]);
  const { push: pushToast, dismiss: dismissToast } = useToast();
  const abortRef = React.useRef<AbortController | null>(null);

  const refresh = React.useCallback(
    async (opts: { refreshCursor?: boolean } = {}) => {
      setLoading(true);
      try {
        const next = await fetchAiAccounts({ refresh: opts.refreshCursor });
        setSnapshot(next);
        setError(null);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleRefreshCursor = React.useCallback(async () => {
    setCursorBusy(true);
    try {
      await refresh({ refreshCursor: true });
      pushToast("Refreshed Cursor account state", "success");
    } catch (err) {
      pushToast(`Refresh failed: ${String(err)}`, "error");
    } finally {
      setCursorBusy(false);
    }
  }, [pushToast, refresh]);

  React.useEffect(() => {
    if (!open) return;
    void refresh();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [open, refresh]);

  // Reload available models whenever the selected provider changes. Cursor
  // models are pulled from the live CLI; OpenAI uses a curated fallback list.
  const activeProvider = snapshot?.settings.defaultProvider ?? null;
  React.useEffect(() => {
    if (!open || !activeProvider) return;
    let cancelled = false;
    setModelsLoading(true);
    setModelsWarning(null);
    fetchAiModels(activeProvider)
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        setModelsWarning(res.warning ?? null);
        setReasoningEfforts(res.capabilities?.reasoningEfforts ?? []);
        setServiceTiers(res.capabilities?.serviceTiers ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setModels([]);
        setReasoningEfforts([]);
        setServiceTiers([]);
        setModelsWarning(String(err));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeProvider]);

  const handleAddOpenAi = React.useCallback(async () => {
    setOpenAiLoginUrl(null);
    setOpenAiLoginBusy(true);
    const toastId = pushToast("Starting ChatGPT login…", "loading");
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    try {
      for await (const event of startOpenAiLogin({ signal: ac.signal })) {
        if (event.type === "url") {
          setOpenAiLoginUrl(event.url);
          window.open(event.url, "_blank", "noopener,noreferrer");
          dismissToast(toastId);
          pushToast("Browser opened — finish login there", "info");
        } else if (event.type === "success") {
          setSnapshot(event.snapshot);
          setOpenAiLoginUrl(null);
          pushToast("ChatGPT account added", "success");
        } else if (event.type === "error") {
          pushToast(`ChatGPT login failed: ${event.error}`, "error");
          setOpenAiLoginUrl(null);
          break;
        }
      }
    } catch (err) {
      pushToast(`ChatGPT login error: ${String(err)}`, "error");
    } finally {
      dismissToast(toastId);
      setOpenAiLoginBusy(false);
      abortRef.current = null;
    }
  }, [dismissToast, pushToast]);

  const handleSetDefault = React.useCallback(
    async (id: string) => {
      setBusyAccount(id);
      try {
        const next = await setDefaultOpenAiAccount(id);
        setSnapshot(next);
        pushToast("Default ChatGPT account updated", "success");
      } catch (err) {
        pushToast(`Set default failed: ${String(err)}`, "error");
      } finally {
        setBusyAccount(null);
      }
    },
    [pushToast]
  );

  const handleRefreshAccount = React.useCallback(
    async (id: string) => {
      setBusyAccount(id);
      try {
        const next = await refreshOpenAiAccount(id);
        setSnapshot(next);
        pushToast("Refreshed quota", "success");
      } catch (err) {
        pushToast(`Refresh failed: ${String(err)}`, "error");
      } finally {
        setBusyAccount(null);
      }
    },
    [pushToast]
  );

  const handleRemoveAccount = React.useCallback(
    async (id: string) => {
      const confirm = window.confirm(
        "Remove this ChatGPT account? Reunion will delete its codex-home and forget tokens."
      );
      if (!confirm) return;
      setBusyAccount(id);
      try {
        const next = await deleteOpenAiAccount(id);
        setSnapshot(next);
        pushToast("ChatGPT account removed", "success");
      } catch (err) {
        pushToast(`Remove failed: ${String(err)}`, "error");
      } finally {
        setBusyAccount(null);
      }
    },
    [pushToast]
  );

  const handleCursorLogin = React.useCallback(async () => {
    setCursorLoginUrl(null);
    setCursorBusy(true);
    const toastId = pushToast("Starting Cursor login…", "loading");
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    try {
      for await (const event of startCursorLogin({ signal: ac.signal })) {
        if (event.type === "url") {
          setCursorLoginUrl(event.url);
          window.open(event.url, "_blank", "noopener,noreferrer");
          dismissToast(toastId);
          pushToast("Browser opened — finish login there", "info");
        } else if (event.type === "success") {
          setSnapshot(event.snapshot);
          setCursorLoginUrl(null);
          pushToast("Cursor signed in", "success");
        } else if (event.type === "error") {
          pushToast(`Cursor login failed: ${event.error}`, "error");
          setCursorLoginUrl(null);
          break;
        }
      }
    } catch (err) {
      pushToast(`Cursor login error: ${String(err)}`, "error");
    } finally {
      dismissToast(toastId);
      setCursorBusy(false);
      abortRef.current = null;
    }
  }, [dismissToast, pushToast]);

  const handleCursorLogout = React.useCallback(async () => {
    setCursorBusy(true);
    try {
      const next = await logoutCursor();
      setSnapshot(next);
      pushToast("Cursor signed out", "success");
    } catch (err) {
      pushToast(`Logout failed: ${String(err)}`, "error");
    } finally {
      setCursorBusy(false);
    }
  }, [pushToast]);

  const handleProviderChange = React.useCallback(
    async (provider: AiProvider) => {
      try {
        // Switching provider invalidates the previous model selection (Cursor's
        // model ids do not exist on OpenAI and vice versa). Reset to provider
        // default so we never end up sending a stale model name to the wrong
        // backend.
        const next = await updateAiSettings({ provider, model: null });
        setSnapshot(next);
      } catch (err) {
        pushToast(`Update settings failed: ${String(err)}`, "error");
      }
    },
    [pushToast]
  );

  const handleModelChange = React.useCallback(
    async (model: string | null) => {
      try {
        const next = await updateAiSettings({ model });
        setSnapshot(next);
        if (model) {
          pushToast(`Default model set to ${model}`, "success");
        } else {
          pushToast("Default model cleared (using provider default)", "info");
        }
      } catch (err) {
        pushToast(`Update model failed: ${String(err)}`, "error");
      }
    },
    [pushToast]
  );

  const handleReasoningEffortChange = React.useCallback(
    async (effort: AiReasoningEffort | null) => {
      try {
        const next = await updateAiSettings({ reasoningEffort: effort });
        setSnapshot(next);
        pushToast(
          effort
            ? `Reasoning effort: ${effort}`
            : "Reasoning effort cleared (model default)",
          "info"
        );
      } catch (err) {
        pushToast(`Update reasoning failed: ${String(err)}`, "error");
      }
    },
    [pushToast]
  );

  const handleServiceTierChange = React.useCallback(
    async (tier: AiServiceTier | null) => {
      try {
        const next = await updateAiSettings({ serviceTier: tier });
        setSnapshot(next);
        pushToast(
          tier ? `Service tier: ${tier}` : "Service tier cleared (auto)",
          "info"
        );
      } catch (err) {
        pushToast(`Update service tier failed: ${String(err)}`, "error");
      }
    },
    [pushToast]
  );

  const settings: AiSettingsView | null = snapshot?.settings ?? null;
  const openAiAccounts = snapshot?.openai.accounts ?? [];
  const defaultOpenAiId =
    settings?.defaultOpenAiAccountId ?? snapshot?.openai.defaultAccountId ?? null;
  const cursorState = snapshot?.cursor ?? null;
  const hasOpenAi = openAiAccounts.length > 0;
  const hasCursor = Boolean(cursorState?.installed && cursorState.loggedIn);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" /> Settings
        </span>
      }
      description="Manage AI providers used by Smart Export, Ask AI, and future cross-session insights. Tokens stay with their CLI: codex stores them in isolated codex-homes, cursor-agent in macOS Keychain. Reunion never persists raw tokens."
      footer={
        <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-overline text-muted-foreground">
          <span>v0.2 · ai providers</span>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <AlertCircle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {settings ? (
        <DefaultProviderControl
          settings={settings}
          hasOpenAi={hasOpenAi}
          hasCursor={hasCursor}
          onChange={handleProviderChange}
        />
      ) : null}

      {settings ? (
        <ModelPicker
          provider={settings.defaultProvider}
          value={settings.defaultModel}
          models={models}
          loading={modelsLoading}
          warning={modelsWarning}
          onChange={handleModelChange}
        />
      ) : null}

      {settings && settings.defaultProvider === "openai" ? (
        <>
          <ReasoningEffortPicker
            efforts={reasoningEfforts}
            value={settings.defaultReasoningEffort}
            onChange={handleReasoningEffortChange}
            activeModelId={settings.defaultModel}
            modelSupportsReasoning={
              settings.defaultModel
                ? models.find((m) => m.id === settings.defaultModel)?.supportsReasoning
                : models.find((m) => m.isDefault)?.supportsReasoning
            }
          />
          <ServiceTierPicker
            tiers={serviceTiers}
            value={settings.defaultServiceTier}
            onChange={handleServiceTierChange}
          />
        </>
      ) : null}

      <section className="mt-6">
        <header className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="font-serif text-[15px] font-semibold tracking-tight text-foreground">
              OpenAI / ChatGPT accounts
            </h3>
            <p className="text-[12px] text-muted-foreground">
              Each account gets an isolated <code>CODEX_HOME</code>. Multi-account safe.
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleAddOpenAi}
            disabled={openAiLoginBusy}
            title="Run codex login in an isolated home"
          >
            {openAiLoginBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Add ChatGPT account
          </Button>
        </header>

        {openAiLoginUrl ? (
          <div className="mb-3 rounded-md border border-primary/30 bg-primary-soft/40 px-3 py-2 text-[12px]">
            <div className="font-mono text-[10px] uppercase tracking-overline text-muted-foreground">
              waiting for codex login
            </div>
            <div className="mt-1 flex items-center gap-2">
              <a
                href={openAiLoginUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate text-primary underline-offset-4 hover:underline"
              >
                {openAiLoginUrl}
              </a>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </div>
          </div>
        ) : null}

        {loading && !snapshot ? (
          <div className="rounded-lg border border-dashed border-border bg-background-soft p-6 text-center text-[13px] text-muted-foreground">
            Loading accounts…
          </div>
        ) : openAiAccounts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-background-soft p-6 text-center">
            <p className="text-[13px] font-medium text-foreground">
              No ChatGPT accounts yet
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Click "Add ChatGPT account" to spawn <code>codex login</code> against an
              isolated <code>CODEX_HOME</code>. Make sure the codex CLI is installed.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {openAiAccounts.map((account) => (
              <OpenAiCard
                key={account.id}
                account={account}
                isDefault={account.id === defaultOpenAiId}
                busy={busyAccount === account.id || openAiLoginBusy}
                onSetDefault={handleSetDefault}
                onRefresh={handleRefreshAccount}
                onRelogin={handleAddOpenAi}
                onRemove={handleRemoveAccount}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <header className="mb-3">
          <h3 className="font-serif text-[15px] font-semibold tracking-tight text-foreground">
            Cursor Agent
          </h3>
          <p className="text-[12px] text-muted-foreground">
            Single-account only — tokens live in macOS Keychain, managed by
            <code className="ml-1">cursor-agent</code>.
          </p>
        </header>
        <CursorPanel
          state={cursorState}
          busy={cursorBusy}
          loginUrl={cursorLoginUrl}
          onLogin={handleCursorLogin}
          onLogout={handleCursorLogout}
          onRefresh={handleRefreshCursor}
        />
      </section>
    </Modal>
  );
}

export { SettingsDialog };
