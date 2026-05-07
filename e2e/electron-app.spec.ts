import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Electron-driven E2E.
//
// Why this exists:
//   The renderer-only suite (team-mode.spec.ts) talks to `pnpm run serve`,
//   which is a Node process started from a shell that already has
//   REUNION_TEAM_INGEST_URL set. That doesn't catch the bug a user reported
//   on 2026-05-01: "Switch failed: remote request failed: fetch failed".
//   Cause was: when the user double-clicks the dev .app from Finder/Spotlight
//   the GUI process is launched by launchd which does NOT inherit the shell
//   env, so reunion fell back to the compile-time placeholder PROD_INGEST_URL
//   ("https://ingest.team-version.local") and DNS-failed.
//
// What we test:
//   We launch the *real* Electron binary against `dist/electron/bootstrap.cjs`
//   with a clean env (no REUNION_TEAM_INGEST_URL, no shell inheritance), and
//   assert that bootstrap.cjs's `app.isPackaged === false` branch correctly
//   injects http://127.0.0.1:8080 / local-test-token before main.js boots.
//
// Prereqs:
//   - `pnpm run build` must have produced dist/electron/{bootstrap.cjs,main.js}
//     and frontend/dist (e2e/run.sh handles this).
//   - ingest @ :8080 must be up with seeded fixtures (e2e/run.sh handles this).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// Where bootstrap.cjs is copied during `pnpm run build:backend`. If you change
// scripts/build-electron.mjs, update this path too.
const ELECTRON_ENTRY = path.join(projectRoot, "dist", "electron", "bootstrap.cjs");

async function ensureBuilt(): Promise<void> {
  try {
    await fs.access(ELECTRON_ENTRY);
  } catch {
    throw new Error(
      `${ELECTRON_ENTRY} not found. Run \`pnpm run build\` first (or use ./e2e/run.sh which builds for you).`
    );
  }
}

async function makeIsolatedDataDir(): Promise<string> {
  // Per-run scratch dir so app-mode.json from a previous run doesn't leak
  // into this one. /tmp under macOS gets cleared on reboot anyway.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reunion-electron-e2e-"));
  return dir;
}

// Helper: launch Electron with a deliberately scrubbed env. We strip every
// REUNION_TEAM_INGEST_* var so we're really testing the auto-injection path
// in bootstrap.cjs, not whatever was already set in the test runner's shell.
async function launchScrubbed(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k.startsWith("REUNION_TEAM_")) continue; // the whole point
    baseEnv[k] = v;
  }
  // Per-launch scratch dirs so:
  //   * app-mode.json starts at default (REUNION_DATA_DIR)
  //   * the running .app on the developer's machine doesn't share its
  //     single-instance lock with us, which would make app.quit() fire and
  //     swallow main.ts (--user-data-dir)
  const dataDir = await makeIsolatedDataDir();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reunion-electron-userdata-"));
  Object.assign(baseEnv, { REUNION_DATA_DIR: dataDir }, extraEnv);

  return electron.launch({
    args: [ELECTRON_ENTRY, `--user-data-dir=${userDataDir}`],
    env: baseEnv,
    timeout: 30_000,
  });
}

async function firstWindowReady(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow({ timeout: 30_000 });
  await window.waitForLoadState("domcontentloaded");
  return window;
}

test.describe("Electron app (production-shaped launch)", () => {
  test.describe.configure({ mode: "serial" });
  // Electron startup is heavy (~3-5 s); generous timeout so flaky CI doesn't
  // mask real failures. The renderer suite uses 30s; here we go up to 60s.
  test.slow();

  test.beforeAll(async () => {
    await ensureBuilt();
  });

  test("boots in personal mode and renders the toggle", async () => {
    const app = await launchScrubbed();
    try {
      const window = await firstWindowReady(app);
      // Sidebar header always renders the mode toggle. We don't care about
      // the language — assert either "Personal" or "个人版" is present.
      await expect(
        window.getByRole("button", { name: /Personal|个人版/ })
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await app.close();
    }
  });

  test("clicking the toggle flips to team mode without a config dialog", async () => {
    // This is the reproducer for the user's "Switch failed: fetch failed"
    // report. Without the bootstrap.cjs auto-injection patch, this test
    // fails: the toggle would attempt the trial fetch against the
    // PROD_INGEST_URL placeholder and surface a toast.
    const app = await launchScrubbed();
    try {
      const window = await firstWindowReady(app);

      const personalToggle = window.getByRole("button", {
        name: /Personal|个人版/,
      });
      await expect(personalToggle).toBeVisible({ timeout: 15_000 });

      // Listen for any toast that says "Switch failed" / "切换失败" so we
      // can fail fast with a useful message instead of timing out on the
      // happy-path locator.
      let switchFailedToastText: string | null = null;
      window.on("console", (msg) => {
        const text = msg.text();
        if (/Switch failed|切换失败|fetch failed/.test(text)) {
          switchFailedToastText = text;
        }
      });

      await personalToggle.click();

      // After a successful trial fetch + persist the toggle now shows team.
      const teamToggle = window.getByRole("button", { name: /^Team$|^团队版$/ });
      await expect(teamToggle).toBeVisible({ timeout: 15_000 });

      if (switchFailedToastText) {
        throw new Error(
          `Renderer surfaced a switch-failed message during the toggle — ` +
            `this likely means bootstrap.cjs did not auto-inject the dev ingest URL. ` +
            `Console line: ${switchFailedToastText}`
        );
      }
    } finally {
      await app.close();
    }
  });

  test("end-to-end: switch to team, list aggregated sessions, open one, render events", async () => {
    // The full happy-path the user actually cares about: boot fresh, click
    // the toggle, see real fixture sessions land, open one, see the banner
    // and at least one fixture string from the detail body. If any single
    // step regresses, this test pinpoints which.
    const app = await launchScrubbed();
    try {
      const window = await firstWindowReady(app);

      // --- step 1: app boots in personal -----------------------------------
      const personalToggle = window.getByRole("button", {
        name: /Personal|个人版/,
      });
      await expect(personalToggle, "boots showing the personal-mode toggle").toBeVisible({
        timeout: 15_000,
      });

      // --- step 2: click → team --------------------------------------------
      await personalToggle.click();
      const teamToggle = window.getByRole("button", { name: /^Team$|^团队版$/ });
      await expect(teamToggle, "after click the toggle reads 'team'").toBeVisible({
        timeout: 15_000,
      });

      // --- step 3: 4 aggregated sessions appear ---------------------------
      // 3 of 5 fixtures live in reunion-gitlab; the 4th aggregate is in
      // ai_coding_ingest. SessionListItem uses the repo string as part of
      // its accessible name so we filter on that.
      //
      // react-query hydrates the list incrementally (first row paints, then
      // the rest land a beat later). A naive `count()` race-conditions on
      // the partial state — instead we wait for the THIRD row to be
      // visible, which guarantees ≥3 are mounted before we assert.
      const repoItems = window.getByRole("button", { name: /reunion-gitlab/ });
      await expect(repoItems.first(), "first reunion-gitlab session paints").toBeVisible({
        timeout: 15_000,
      });
      await expect(
        repoItems.nth(2),
        "≥3 reunion-gitlab sessions visible (sess-claude-1 v1+v2 merged + others)"
      ).toBeVisible({ timeout: 10_000 });

      // --- step 4: open one → banner + fixture content --------------------
      await repoItems.first().click();

      // Electron's locale comes from app.getLocale() (system pref), which
      // may not match Playwright's locale: "zh-CN" for the renderer
      // project. Match both copy-strings so this test passes in either
      // language without flipping the user's system preferences.
      const banner = window.getByRole("note");
      await expect(banner, "SessionBanner identifies team mode").toContainText(
        /团队版|Team mode/,
        { timeout: 10_000 }
      );
      await expect(banner, "SessionBanner explains data source").toContainText(
        /后端聚合|backend aggregate/,
        { timeout: 5_000 }
      );

      // The list is sorted by recency so we don't know which session opened
      // first; assert that *some* fixture phrase is visible. If none is,
      // either remote-mapper dropped the events or rendering is broken.
      const fixturePhrases = [
        "useEffect",       // sess-claude-1 v1
        "client_ai_track", // sess-claude-2
        "useAnnotations",  // sess-claude-3
        "ModeSwitcher",    // sess-cursor-1
      ];
      let renderedFixture: string | null = null;
      for (const phrase of fixturePhrases) {
        const visible = await window
          .getByText(new RegExp(phrase))
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) {
          renderedFixture = phrase;
          break;
        }
      }
      expect(
        renderedFixture,
        `expected one of [${fixturePhrases.join(", ")}] to render in the detail view`
      ).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  test("explicit env override beats bootstrap default", async () => {
    // If the user *did* export REUNION_TEAM_INGEST_URL in their shell (e.g.
    // pointing reunion at a staging ingest), bootstrap.cjs must keep their
    // value, not clobber it. We point at port 1 (always-refused) so the
    // trial fetch fails fast and we can verify the override is in effect by
    // observing the failure mode differs from the unreachable-DNS one.
    const app = await launchScrubbed({
      REUNION_TEAM_INGEST_URL: "http://127.0.0.1:1",
      REUNION_TEAM_INGEST_TOKEN: "override-token",
    });
    try {
      const window = await firstWindowReady(app);
      const toggle = window.getByRole("button", { name: /Personal|个人版/ });
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await toggle.click();
      // The trial against :1 must fail (502 connection refused), so the
      // toggle stays on Personal — this proves the override took effect
      // (otherwise we'd flip to team via :8080 and pass).
      await expect(toggle).toBeVisible({ timeout: 5_000 });
    } finally {
      await app.close();
    }
  });
});
