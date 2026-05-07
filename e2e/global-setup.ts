import { request } from "@playwright/test";

// Pre-flight: force the renderer project's reunion serve into team mode. We
// drive /api/mode directly so a ModeSwitcher regression doesn't cascade into
// every renderer test. The dedicated electron project does NOT need this
// (each test launches its own Electron process from a clean state), so when
// reunion is offline we log a warning and continue rather than aborting —
// otherwise `pnpm exec playwright test --project=electron` from a cold dev
// machine would refuse to run.
//
// The reunion server is expected to have been started with:
//
//   REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080 \
//   REUNION_TEAM_INGEST_TOKEN=local-test-token \
//   pnpm run serve --port 9888
//
// e2e/run.sh does this for you.
export default async function globalSetup() {
  const reunion = process.env.REUNION_URL || "http://127.0.0.1:9888";

  const ctx = await request.newContext({ baseURL: reunion });
  try {
    const mode = await ctx.get("/api/mode").catch(() => null);
    if (!mode || !mode.ok()) {
      console.warn(
        `[global-setup] reunion @ ${reunion} not reachable; renderer tests will fail. ` +
          `(electron-project tests do not need reunion serve and will still run.)`
      );
      return;
    }

    const switched = await ctx.post("/api/mode", { data: { mode: "team" } });
    const body = await switched.json().catch(() => ({}));
    if (!body?.ok || body?.mode !== "team") {
      throw new Error(
        `failed to switch reunion to team mode. Response: ${JSON.stringify(body)}.\n` +
          `Make sure (1) reunion was started with REUNION_TEAM_INGEST_URL pointing at the local ingest\n` +
          `         (2) ingest is running and seeded:\n` +
          `             cd ../ai_coding_ingest && go run ./cmd/server-dev/ && ./scripts/dev-seed.sh`
      );
    }
  } finally {
    await ctx.dispose();
  }
}
