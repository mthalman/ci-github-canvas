// Tunables and well-known paths shared across the extension modules.
// All values are kept here so they're easy to discover and adjust without
// hunting through call sites.

import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Read-only mirror of the Copilot desktop app's local data store.
export const DB_PATH = join(homedir(), ".copilot", "data.db");

// Extension install root — the directory containing extension.mjs. From
// lib/constants.mjs that's one level up. When the extension is installed
// normally this is ~/.copilot/extensions/<name>/; when dev-linked it
// resolves through the symlink back to the repo root.
export const EXTENSION_ROOT = dirname(import.meta.dirname);
// Per-extension scratch / config directory. Convention is that any state
// the extension persists across reloads lives under <install>/artifacts/
// instead of polluting the user's ~/.copilot/ root.
export const ARTIFACTS_DIR = join(EXTENSION_ROOT, "artifacts");

// `gh search prs` is rate-limited (30/min for code search). Cache results so
// every tab switch / refresh doesn't re-hit the API.
export const GH_CACHE_TTL_MS = 60_000;
// GraphQL-with-checks is heavier and more expensive on the rate limit.
export const CHECKS_CACHE_TTL_MS = 90_000;
// Agent tasks list is used to map local session_ids to remote task URLs.
export const TASKS_CACHE_TTL_MS = 60_000;

// Azure DevOps check runs are identified by detailsUrl host. Covers
// dev.azure.com/<org> as well as legacy <org>.visualstudio.com URLs.
export const AZDO_URL_RE = /^https?:\/\/(dev\.azure\.com|[^/]+\.visualstudio\.com)\//i;
// Extract build id from an AzDO results URL: ".../_build/results?buildId=12345..."
export const AZDO_BUILD_ID_RE = /[?&]buildId=(\d+)/i;
// Per-build timeline responses change quickly while a build runs, so keep
// the cache short. Combined with the 60s auto-poll, this means a poll cycle
// always returns fresh data without hammering AzDO when the UI re-renders.
export const AZDO_TIMELINE_CACHE_TTL_MS = 20_000;

// Sync-state badge (up_to_date / behind / ahead / diverged) is derived by
// shelling out to `git rev-list` per session. Cache for a short window so
// the UI's ~60s auto-poll doesn't repeatedly spawn git for the same path.
// We cache nulls/errors too — a workspace with no upstream shouldn't
// re-spawn git on every poll just to fail again.
export const SYNC_STATE_CACHE_TTL_MS = 15_000;
// Hard cap on concurrent git invocations. On a machine with many sessions
// this prevents `/api/sessions` from spawning a thundering herd of git.exe.
export const SYNC_STATE_GIT_CONCURRENCY = 4;
// Each git invocation gets its own timeout in case the worktree is on a
// slow drive or git wedges on a lock.
export const SYNC_STATE_GIT_TIMEOUT_MS = 5_000;

// Live PR state lookup. The local DB's PR-state columns can lag the real
// state on github.com by minutes; this cache stores per-PR live state so
// closed/merged PRs disappear from the Copilot tab even when the desktop
// app hasn't synced yet. Closed→merged is sticky so we cache aggressively;
// errors get a short cache so a transient GraphQL failure doesn't pin the
// row in a wrong state for long.
export const PR_LIVE_STATE_CACHE_TTL_MS = 5 * 60_000;
export const PR_LIVE_STATE_ERROR_CACHE_TTL_MS = 30_000;

// Notification config persists across extension reloads. Defaults are
// intentionally conservative: notifications OFF, build-level granularity
// (one alert per build that flips red, instead of one per failing job).
export const NOTIFY_CONFIG_PATH = join(ARTIFACTS_DIR, "ci-runs.json");
// Repo filter config persists across reloads. Defaults are empty include /
// exclude lists, which means "no filtering" — every repo is queried. Glob
// patterns in these lists narrow which repos' PRs (and Copilot sessions) are
// surfaced. See lib/repo-filter.mjs for the matching semantics.
export const REPO_FILTER_CONFIG_PATH = join(ARTIFACTS_DIR, "repo-filter.json");
// Host-side poll cadence. Runs whether or not the canvas is open, so the
// user gets alerts even when the side panel isn't visible. Matches the
// in-canvas auto-refresh interval to keep load symmetric.
export const HOST_POLL_INTERVAL_MS = 60_000;
