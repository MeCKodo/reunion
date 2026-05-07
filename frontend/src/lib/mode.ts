// Frontend wrappers for the team-mode `/api/mode` endpoints. Capabilities are
// the source of truth for "should this button render": every destructive /
// LLM / file-system action consults `capabilities.<flag>` before rendering
// instead of guessing from `mode`.

export type AppMode = "personal" | "team";

export type ProviderCapabilities = {
  annotations: boolean;
  aiTagging: boolean;
  smartExport: boolean;
  deleteSession: boolean;
  downloadJsonl: boolean;
  openLocalFile: boolean;
  subagents: boolean;
  fullTranscript: boolean;
  fullTextSearch: boolean;
};

/** Build-time edition. `personal` bundles never expose the team-mode UI. */
export type AppEdition = "personal" | "team";

export type ModeState = {
  mode: AppMode;
  /** Build-time edition baked into the bundle; controls whether the team-mode
   *  UI is allowed to render at all. */
  edition: AppEdition;
  capabilities: ProviderCapabilities;
  /** Whether team-config.json exists on disk (for "first-time setup" flow). */
  team_config_present: boolean;
  /** Last failure message from provider initialization, if any. */
  last_error?: string;
};

/** Fallback used before the first /api/mode response lands. We default
 *  edition to `personal` so a slow first response never briefly flashes
 *  the team-mode entry point in a personal-edition build; team-edition
 *  builds will swap it in within ~1 RTT. */
export const DEFAULT_MODE_STATE: ModeState = {
  mode: "personal",
  edition: "personal",
  capabilities: {
    annotations: true,
    aiTagging: true,
    smartExport: true,
    deleteSession: true,
    downloadJsonl: true,
    openLocalFile: true,
    subagents: true,
    fullTranscript: true,
    fullTextSearch: true,
  },
  team_config_present: false,
};

export async function fetchMode(): Promise<ModeState> {
  const res = await fetch("/api/mode");
  if (!res.ok) throw new Error(`mode fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as { ok?: boolean } & ModeState;
  if (!data.ok) throw new Error("mode fetch failed");
  return data;
}

// Team-mode wiring is built into the bundle (see backend src/config.ts
// TEAM_INGEST_URL / TEAM_INGEST_TOKEN); the toggle is a single boolean from
// the user's perspective.
export type SwitchModePayload = { mode: "personal" | "team" };

export type SwitchModeResult =
  | { ok: true; state: ModeState }
  | { ok: false; status: number; error: string };

export async function switchMode(body: SwitchModePayload): Promise<SwitchModeResult> {
  const res = await fetch("/api/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: { ok?: boolean; error?: string } & ModeState;
  try {
    data = await res.json();
  } catch {
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  }
  if (!res.ok || !data.ok) {
    return { ok: false, status: res.status, error: data.error || `HTTP ${res.status}` };
  }
  return { ok: true, state: data };
}
