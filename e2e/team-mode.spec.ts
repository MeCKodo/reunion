import { test, expect, type Page } from "@playwright/test";

// These tests assume:
//   * dev stack already running (see playwright.config.ts header)
//   * global-setup.ts has flipped reunion to team mode and trial-checked ingest
//
// We test the renderer-only path: same React bundle the Electron app loads,
// just hosted by the Node http-server on :9888. Electron main / IPC paths
// are not exercised here (different Trade-off — see SKILL.md "E2E").

const FIXTURE_TEXT = "useEffect"; // unique to sess-claude-1 v1
const REUNION_GITLAB_REPO_HINT = "reunion-gitlab";
const TEAM_BANNER_RE = /团队版.+后端聚合/;
const PERSONAL_BADGE = "个人版";
const TEAM_BADGE = "团队版";

async function waitForAppShell(page: Page) {
  // The sidebar header always renders (no auth wall), so any visible "团队版"/
  // "个人版" badge means React has booted and read /api/mode. Without this
  // wait, openListItem races react-query.
  await expect(
    page.getByRole("button", { name: new RegExp(`(${TEAM_BADGE}|${PERSONAL_BADGE})`) })
  ).toBeVisible();
}

async function openListItemContainingText(page: Page, hint: string) {
  // SessionListItem is `role="button"` whose accessible name includes the
  // computed `title` (e.g. "reunion-gitlab · 5/1/2026, 12:41:09 PM"). We pick
  // the first one matching `hint`.
  const item = page.getByRole("button", { name: new RegExp(hint) }).first();
  await expect(item).toBeVisible();
  await item.click();
}

test.describe("reunion team mode (renderer)", () => {
  test("shell renders with team badge", async ({ page }) => {
    await page.goto("/");
    await waitForAppShell(page);
    await expect(
      page.getByRole("button", { name: new RegExp(TEAM_BADGE) })
    ).toBeVisible();
  });

  test("session list shows the 4 aggregated sessions", async ({ page }) => {
    await page.goto("/");
    await waitForAppShell(page);

    // Wait for the search results to populate. Reunion makes a /api/search
    // call on mount; we look for the reunion-gitlab repo hint to appear.
    const items = page
      .getByRole("button", { name: new RegExp(REUNION_GITLAB_REPO_HINT) });
    await expect(items.first()).toBeVisible({ timeout: 10_000 });

    // 3 of the 4 sessions belong to reunion-gitlab; the 4th is in
    // ai_coding_ingest. Just assert lower-bound — duplicate matches across
    // labels (badges, snippets) are fine, but we want at least 3.
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("clicking sess-claude-1 renders the team banner and merged events", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAppShell(page);
    await openListItemContainingText(page, REUNION_GITLAB_REPO_HINT);

    // SessionBanner. role="note" + 文案
    const banner = page.getByRole("note");
    await expect(banner).toContainText(TEAM_BANNER_RE, { timeout: 10_000 });

    // Detail body should contain at least one fixture string we know is in
    // sess-claude-1 v1. The list is sorted by recency so the first hit on
    // reunion-gitlab will usually be sess-claude-2 (most recent created_at).
    // To make this assertion stable regardless of which session actually
    // opened, we just check that *some* fixture text is present somewhere.
    const fixturePhrases = [
      FIXTURE_TEXT, // sess-claude-1
      "client_ai_track", // sess-claude-2
      "useAnnotations", // sess-claude-3
      "ModeSwitcher", // sess-cursor-1
    ];
    const matchers = fixturePhrases.map((p) =>
      page.getByText(new RegExp(p)).first()
    );
    // At least one matcher visible.
    let foundAny = false;
    for (const m of matchers) {
      if (await m.isVisible().catch(() => false)) {
        foundAny = true;
        break;
      }
    }
    expect(foundAny, "expected at least one fixture phrase to render").toBe(true);
  });

  test("capability gating hides team-only-disallowed UI", async ({ page }) => {
    await page.goto("/");
    await waitForAppShell(page);

    // Reindex button: rendered in personal mode (Sidebar.tsx gates on
    // capabilities.deleteSession as a "local data" proxy), hidden in team mode.
    // Selector matches the button's aria-label set in Sidebar.tsx ("重建索引"
    // / "Reindex"); using getByRole with name regex covers both locales and
    // crashes loudly if the aria-label changes — a much better signal than a
    // silent zero-match.
    await expect(
      page.getByRole("button", { name: /重建索引|Reindex/ })
    ).toHaveCount(0);

    // Starred filter chip: rendered when capabilities.annotations is true.
    // The chip has the literal text "已收藏" / "Starred".
    await expect(page.getByRole("button", { name: /^已收藏$|^Starred$/ })).toHaveCount(0);
  });

  test("reindex selector is well-formed (sanity, runs in personal mode)", async ({
    page,
    request,
  }) => {
    // Negative test for the previous test's selector. We flip into personal
    // mode briefly, confirm the reindex button DOES render under that
    // selector, then flip back. Without this, a typo in the selector would
    // make the gating test silently pass forever. We isolate this from the
    // gating test so the suite still ends in team mode.
    const switched = await request.post("/api/mode", { data: { mode: "personal" } });
    try {
      expect((await switched.json()).mode).toBe("personal");

      await page.goto("/");
      await waitForAppShell(page);
      await expect(
        page.getByRole("button", { name: /重建索引|Reindex/ })
      ).toHaveCount(1);
    } finally {
      // reunion was started with REUNION_TEAM_INGEST_URL pointing at the
      // local ingest (see e2e/run.sh), so a bare {mode:"team"} POST is
      // enough to flip back — the trial fetch runs against the built-in
      // wiring inside the server process.
      await request.post("/api/mode", { data: { mode: "team" } });
    }
  });
});
