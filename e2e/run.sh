#!/usr/bin/env bash
# Convenience wrapper for the layered Playwright E2E suite.
#
# Two projects (see e2e/playwright.config.ts):
#   * renderer — needs MySQL + ingest + reunion serve up
#   * electron — needs MySQL + ingest + a fresh `pnpm run build` only
#
# Examples:
#   ./e2e/run.sh                                # both projects
#   ./e2e/run.sh --start                        # also auto-starts the stack
#   ./e2e/run.sh --project=renderer             # renderer only
#   ./e2e/run.sh --project=electron --headed    # electron only, see the window
#   ./e2e/run.sh --debug                        # Playwright Inspector
#   ./e2e/run.sh team-mode.spec.ts:42           # filter
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INGEST_DIR="$(cd "$REPO_ROOT/../ai_coding_ingest" && pwd)"
INGEST="${INGEST_URL:-http://127.0.0.1:8080}"
REUNION="${REUNION_URL:-http://127.0.0.1:9888}"
TOKEN="${TRACK_API_TOKEN:-local-test-token}"

START=0
PROJECT_FILTER=""
PW_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --start)
      START=1
      ;;
    --project=*)
      PROJECT_FILTER="${arg#*=}"
      PW_ARGS+=("$arg")
      ;;
    --project)
      # `--project foo`: bash can't peek next arg in this loop, just forward.
      PW_ARGS+=("$arg")
      ;;
    *)
      PW_ARGS+=("$arg")
      ;;
  esac
done

# Decide which services we need based on the project filter. If none was
# given we need everything (both projects run).
need_reunion=1
need_build=1
case "$PROJECT_FILTER" in
  renderer) need_build=0 ;;
  electron) need_reunion=0 ;;
  "")        ;;
  *)         echo "[run.sh] unknown --project=$PROJECT_FILTER (use renderer or electron)"; exit 2 ;;
esac

ingest_up()  { curl -fsS -m 2 -H "Authorization: Bearer $TOKEN" "$INGEST/repos" >/dev/null; }
reunion_up() { curl -fsS -m 2 "$REUNION/api/mode" >/dev/null; }

# --- ingest --------------------------------------------------------------
if ! ingest_up; then
  if (( START )); then
    echo "[run.sh] starting MySQL container..."
    (cd "$INGEST_DIR" && docker compose -f docker-compose.dev.yml up -d >/dev/null)
    for i in $(seq 1 12); do
      s=$(docker inspect --format='{{.State.Health.Status}}' reunion-ingest-mysql 2>/dev/null || echo missing)
      [[ "$s" == healthy ]] && break; sleep 3
    done
    echo "[run.sh] starting ingest dev server..."
    (cd "$INGEST_DIR" && go run ./cmd/server-dev/ &) >/dev/null 2>&1
    for i in $(seq 1 20); do
      ingest_up && break; sleep 1
    done
    echo "[run.sh] seeding fixtures..."
    (cd "$INGEST_DIR" && ./scripts/dev-seed.sh) >/dev/null
  else
    echo "ingest @ $INGEST not reachable. Start it with:"
    echo "  cd $INGEST_DIR"
    echo "  docker compose -f docker-compose.dev.yml up -d"
    echo "  go run ./cmd/server-dev/"
    echo "  ./scripts/dev-seed.sh"
    echo "or rerun this script with --start."
    exit 1
  fi
fi

# --- reunion serve (renderer project only) -------------------------------
if (( need_reunion )) && ! reunion_up; then
  if (( START )); then
    echo "[run.sh] starting reunion serve..."
    # Override the bundle's compile-time team wiring so reunion talks to the
    # local ingest. Without these env vars the trial fetch would hit
    # https://ingest.team-version.local and 502 on every test.
    (cd "$REPO_ROOT" && \
      REUNION_DATA_DIR=/tmp/reunion-team-test/data \
      REUNION_TEAM_INGEST_URL="$INGEST" \
      REUNION_TEAM_INGEST_TOKEN="$TOKEN" \
      pnpm run serve --port 9888 &) >/dev/null 2>&1
    for i in $(seq 1 20); do
      reunion_up && break; sleep 1
    done
  else
    echo "reunion @ $REUNION not reachable. Start it with:"
    echo "  cd $REPO_ROOT"
    echo "  REUNION_DATA_DIR=/tmp/reunion-team-test/data \\"
    echo "  REUNION_TEAM_INGEST_URL=$INGEST \\"
    echo "  REUNION_TEAM_INGEST_TOKEN=$TOKEN \\"
    echo "    pnpm run serve --port 9888"
    echo "or rerun this script with --start."
    exit 1
  fi
fi

# --- build artefacts (electron project only) -----------------------------
if (( need_build )); then
  if [[ ! -f "$REPO_ROOT/dist/electron/bootstrap.cjs" || ! -d "$REPO_ROOT/frontend/dist" ]]; then
    if (( START )); then
      echo "[run.sh] building electron + frontend bundles..."
      (cd "$REPO_ROOT" && pnpm run build >/dev/null)
    else
      echo "electron entrypoint missing (dist/electron/bootstrap.cjs). Build it with:"
      echo "  cd $REPO_ROOT && pnpm run build"
      echo "or rerun this script with --start."
      exit 1
    fi
  fi
fi

echo "[run.sh] preconditions met. Running Playwright..."
# `${arr[@]+"${arr[@]}"}` is the canonical bash idiom for "expand the array
# only if it's set", required under `set -u` when the array is empty.
exec pnpm exec playwright test --config "$REPO_ROOT/e2e/playwright.config.ts" \
  ${PW_ARGS[@]+"${PW_ARGS[@]}"}
