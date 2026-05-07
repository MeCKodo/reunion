import { defineConfig, devices } from "@playwright/test";

// E2E tests for reunion team mode.
//
// Two projects:
//   * "renderer"  — drives a headless Chromium against `pnpm run serve`
//                   on :9888. Fast (~10s for 5 tests). Covers the React
//                   bundle and Node http-server routes; does NOT cover the
//                   Electron main process or the bootstrap.cjs env-injection
//                   path.
//   * "electron"  — launches the actual Electron binary against
//                   `dist/electron/bootstrap.cjs` with a scrubbed env, so
//                   we exercise the same code path as a user double-clicking
//                   the .app from Finder/Spotlight. Heavier (~30s for 3
//                   tests, each spins up a fresh Electron process).
//
// Prereqs (see ai_coding_ingest/docs/dev.md):
//   1. docker compose -f docker-compose.dev.yml up -d   (in ai_coding_ingest)
//   2. go run ./cmd/server-dev/                          (port 8080)
//   3. ./scripts/dev-seed.sh                             (5 fixtures)
//   4. REUNION_DATA_DIR=/tmp/reunion-team-test/data \
//        REUNION_TEAM_INGEST_URL=http://127.0.0.1:8080 \
//        REUNION_TEAM_INGEST_TOKEN=local-test-token \
//        pnpm run serve --port 9888                      (this repo)
//   5. pnpm run build                                    (for the electron project)
//
// Or just:  ./e2e/run.sh
const REUNION_URL = process.env.REUNION_URL || "http://127.0.0.1:9888";

// Filter to a single project from the CLI: `pnpm run test:e2e -- --project=electron`.
// Default runs both.
export default defineConfig({
  testDir: "./",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  globalSetup: "./global-setup.ts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "zh-CN",
  },
  projects: [
    {
      name: "renderer",
      testMatch: /team-mode\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: REUNION_URL,
      },
    },
    {
      name: "electron",
      testMatch: /electron-app\.spec\.ts/,
      // No baseURL / Chromium device: this project drives a real Electron
      // binary via the _electron API, the spec acquires its own page from
      // app.firstWindow() so devices["Desktop Chrome"] would be ignored.
    },
  ],
});
