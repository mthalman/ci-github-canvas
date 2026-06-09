// Extension: pr-pipelines (v0.3)
//
// User-scoped canvas: side-panel dashboard with two tabs.
//   1. "Copilot" tab  - workspaces currently open in the desktop app, with
//                       their PR or issue origin. Source: ~/.copilot/data.db.
//   2. "All PRs" tab  - every open PR the user authored across all of GitHub.
//                       Source: `gh search prs --author=@me --state=open`.
// Cross-link: PRs that appear in both tabs get a "session" badge in tab 2.
//
// CI status: shows both Azure Pipelines and GitHub Actions workflow runs.
//
// Runtime: Node 24+ (uses node:sqlite, no npm deps).

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const DB_PATH = join(homedir(), ".copilot", "data.db");
// `gh search prs` is rate-limited (30/min for code search). Cache results so
// every tab switch / refresh doesn't re-hit the API.
const GH_CACHE_TTL_MS = 60_000;
// GraphQL-with-checks is heavier and more expensive on the rate limit.
const CHECKS_CACHE_TTL_MS = 90_000;
// Agent tasks list is used to map local session_ids to remote task URLs.
const TASKS_CACHE_TTL_MS = 60_000;
// Azure DevOps check runs are identified by detailsUrl host. Covers
// dev.azure.com/<org> as well as legacy <org>.visualstudio.com URLs.
const AZDO_URL_RE = /^https?:\/\/(dev\.azure\.com|[^/]+\.visualstudio\.com)\//i;
// Extract build id from an AzDO results URL: ".../_build/results?buildId=12345..."
const AZDO_BUILD_ID_RE = /[?&]buildId=(\d+)/i;
// Per-build timeline responses change quickly while a build runs, so keep
// the cache short. Combined with the 60s auto-poll, this means a poll cycle
// always returns fresh data without hammering AzDO when the UI re-renders.
const AZDO_TIMELINE_CACHE_TTL_MS = 20_000;
// Sync-state badge (up_to_date / behind / ahead / diverged) is derived by
// shelling out to `git rev-list` per session. Cache for a short window so
// the UI's ~60s auto-poll doesn't repeatedly spawn git for the same path.
// We cache nulls/errors too — a workspace with no upstream shouldn't
// re-spawn git on every poll just to fail again.
const SYNC_STATE_CACHE_TTL_MS = 15_000;
// Hard cap on concurrent git invocations. On a machine with many sessions
// this prevents `/api/sessions` from spawning a thundering herd of git.exe.
const SYNC_STATE_GIT_CONCURRENCY = 4;
// Each git invocation gets its own timeout in case the worktree is on a
// slow drive or git wedges on a lock.
const SYNC_STATE_GIT_TIMEOUT_MS = 5_000;

// Parse {org, project} from an AzDO check-run detailsUrl. Returns nulls when
// the URL doesn't match a known shape (e.g. unexpected legacy collection URL).
// Project names may be percent-encoded (e.g. "My%20Project"); we keep the
// decoded form for display/cache keys and re-encode when calling the API.
function parseAzdoUrl(detailsUrl) {
    try {
        const u = new URL(detailsUrl);
        const segments = u.pathname.split("/").filter(Boolean);
        if (/^dev\.azure\.com$/i.test(u.hostname)) {
            // dev.azure.com/{org}/{project}/_build/results?buildId=N
            return {
                org: segments[0] ?? null,
                project: segments[1] ? decodeURIComponent(segments[1]) : null,
            };
        }
        const vsMatch = u.hostname.match(/^([^.]+)\.visualstudio\.com$/i);
        if (vsMatch) {
            // {org}.visualstudio.com/{project}/_build/results?buildId=N
            return {
                org: vsMatch[1],
                project: segments[0] ? decodeURIComponent(segments[0]) : null,
            };
        }
    } catch {
        // fall through
    }
    return { org: null, project: null };
}

const servers = new Map();
let db = null;

function getDb() {
    if (db) return db;
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    return db;
}

// Probe for an optional table once per db handle. The Copilot desktop app's
// schema is internal and may add/remove tables between versions; we use this
// to degrade gracefully (e.g. omit checkout_path when the bindings table is
// missing) instead of erroring the whole tab.
const tableExistsCache = new Map();
function tableExists(name) {
    if (tableExistsCache.has(name)) return tableExistsCache.get(name);
    try {
        const row = getDb()
            .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1")
            .get(name);
        const exists = !!row?.ok;
        tableExistsCache.set(name, exists);
        return exists;
    } catch {
        tableExistsCache.set(name, false);
        return false;
    }
}

// Run an async task with bounded concurrency. Lightweight in-process limiter
// so we don't pull in p-limit for a single use site.
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    return out;
}

// Compute a coarse local-vs-upstream sync state for a checkout. Compares
// HEAD against its configured upstream (`@{u}`), which is whatever the
// worktree was last told to track. We deliberately do NOT `git fetch` here
// — that would mutate the workspace and contact the network on every poll
// — so this reflects the state as of the last fetch, not GitHub's live tip.
const syncStateCache = new Map(); // checkoutPath -> { at, state }
const syncStateInflight = new Map(); // checkoutPath -> Promise<state>

function runGitForSync(args, cwd) {
    return new Promise((resolve) => {
        execFile(
            "git",
            ["-C", cwd, "--no-optional-locks", ...args],
            {
                shell: false,
                windowsHide: true,
                timeout: SYNC_STATE_GIT_TIMEOUT_MS,
                env: {
                    ...process.env,
                    // Defense-in-depth: rev-list shouldn't prompt or contact the
                    // network, but make sure we never accidentally block on a
                    // credential helper.
                    GIT_TERMINAL_PROMPT: "0",
                    GCM_INTERACTIVE: "Never",
                },
            },
            (err, stdout, stderr) => {
                if (err) resolve({ error: (stderr || err.message || "").toString().trim() });
                else resolve({ stdout: stdout.toString().trim() });
            },
        );
    });
}

async function computeSyncState(checkoutPath) {
    if (!checkoutPath) return null;
    const now = Date.now();
    const cached = syncStateCache.get(checkoutPath);
    if (cached && now - cached.at < SYNC_STATE_CACHE_TTL_MS) return cached.state;
    const pending = syncStateInflight.get(checkoutPath);
    if (pending) return pending;

    const work = (async () => {
        const r = await runGitForSync(
            ["rev-list", "--left-right", "--count", "@{u}...HEAD"],
            checkoutPath,
        );
        let state = null;
        if (!r.error && r.stdout) {
            // Output is "<behind>\t<ahead>" — left side is commits in @{u}
            // not in HEAD (behind); right side is commits in HEAD not in
            // @{u} (ahead).
            const parts = r.stdout.split(/\s+/);
            const behind = Number(parts[0]) || 0;
            const ahead = Number(parts[1]) || 0;
            if (behind === 0 && ahead === 0) state = "up_to_date";
            else if (behind > 0 && ahead === 0) state = "behind";
            else if (behind === 0 && ahead > 0) state = "ahead";
            else state = "diverged";
        }
        syncStateCache.set(checkoutPath, { at: Date.now(), state });
        return state;
    })();

    syncStateInflight.set(checkoutPath, work);
    try {
        return await work;
    } finally {
        syncStateInflight.delete(checkoutPath);
    }
}

async function enrichSessionsWithSyncState(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    // De-dupe by checkout_path so multiple sessions pointing at the same
    // checkout (rare, but possible for in_place bindings) only spawn git once.
    const uniquePaths = [...new Set(rows.map((r) => r.checkout_path).filter(Boolean))];
    const results = await mapLimit(uniquePaths, SYNC_STATE_GIT_CONCURRENCY, async (p) => [
        p,
        await computeSyncState(p),
    ]);
    const byPath = new Map(results);
    for (const r of rows) {
        r.sync_state = r.checkout_path ? byPath.get(r.checkout_path) ?? null : null;
    }
    return rows;
}

// One row per non-archived workspace. PR / issue fields are coalesced from
// both `workspaces` (older shape) and `workspace_repo_contexts` (newer shape)
// so we work on either app version.
//
// Also pulls a representative `checkout_path` for the workspace via a
// correlated subquery on `workspace_checkout_bindings`. For multi-repo
// workspaces we prefer the binding whose `repo_full_name` matches the PR's
// repo (case-insensitive — GitHub repo names are effectively case-insensitive
// but SQLite `=` is not). The path is later used to derive a local-vs-upstream
// sync-state badge via git. When the bindings table doesn't exist on this
// app version we fall back to a query without that column.
function fetchCopilotSessions() {
    const hasBindings = tableExists("workspace_checkout_bindings");
    const checkoutPathSelect = hasBindings
        ? `,
            COALESCE(
                (SELECT cb.checkout_path
                   FROM workspace_checkout_bindings cb
                  WHERE cb.workspace_id = w.id
                    AND LOWER(cb.repo_full_name) = LOWER(COALESCE(
                            w.source_pr_repo_full_name,
                            w.created_pr_repo_full_name,
                            c.repo_full_name))
                  LIMIT 1),
                (SELECT cb.checkout_path
                   FROM workspace_checkout_bindings cb
                  WHERE cb.workspace_id = w.id
                  LIMIT 1)
            ) AS checkout_path`
        : `,
            NULL AS checkout_path`;
    const sql = `
        SELECT
            w.id          AS workspace_id,
            w.session_id  AS session_id,
            w.name        AS workspace_name,
            w.branch      AS branch,
            w.updated_at  AS updated_at,
            p.name        AS project_name,

            COALESCE(w.source_pr_repo_full_name, c.repo_full_name) AS repo_full_name,
            COALESCE(w.source_pr_number,         c.source_pr_number) AS source_pr_number,
            COALESCE(w.source_pr_html_url,       c.source_pr_html_url) AS source_pr_html_url,
            COALESCE(w.source_pr_title,          c.source_pr_title) AS source_pr_title,
            COALESCE(w.source_pr_state,          c.source_pr_state) AS source_pr_state,
            COALESCE(w.source_pr_author_login,   c.source_pr_author_login) AS source_pr_author_login,
            COALESCE(w.source_pr_head_ref,       c.source_pr_head_ref) AS source_pr_head_ref,
            COALESCE(w.source_pr_base_ref,       c.source_pr_base_ref) AS source_pr_base_ref,

            COALESCE(w.created_pr_repo_full_name, c.repo_full_name) AS created_pr_repo,
            COALESCE(w.created_pr_number,        c.created_pr_number) AS created_pr_number,
            COALESCE(w.created_pr_html_url,      c.created_pr_html_url) AS created_pr_html_url,
            COALESCE(w.created_pr_state,         c.created_pr_state) AS created_pr_state${checkoutPathSelect}
        FROM workspaces w
        LEFT JOIN projects p                ON p.id = w.project_id
        LEFT JOIN workspace_repo_contexts c ON c.workspace_id = w.id
        WHERE w.archived_at IS NULL
          AND (
                w.source_pr_number  IS NOT NULL
             OR w.created_pr_number IS NOT NULL
             OR c.source_pr_number  IS NOT NULL
             OR c.created_pr_number IS NOT NULL
          )
        ORDER BY datetime(w.updated_at) DESC
    `;
    try {
        return getDb().prepare(sql).all();
    } catch (err) {
        return { __error: err.message };
    }
}

// Spawns `gh search prs --author=@me --state=open` and parses the JSON.
// Cached for GH_CACHE_TTL_MS to stay polite with the API.
let ghCache = { at: 0, value: null, error: null };
function runGh(args) {
    return new Promise((resolve) => {
        const child = spawn("gh", args, { shell: false, windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (err) => resolve({ error: err.message }));
        child.on("close", (code) => {
            if (code === 0) {
                try {
                    resolve({ data: JSON.parse(stdout) });
                } catch (e) {
                    resolve({ error: `Failed to parse gh JSON: ${e.message}` });
                }
            } else {
                resolve({ error: stderr.trim() || `gh exited with code ${code}` });
            }
        });
    });
}
async function fetchAuthoredPrs({ force = false } = {}) {
    const now = Date.now();
    if (!force && ghCache.value && now - ghCache.at < GH_CACHE_TTL_MS) {
        return { data: ghCache.value, cachedAt: ghCache.at, error: ghCache.error };
    }
    const result = await runGh([
        "search", "prs",
        "--author=@me",
        "--state=open",
        "--limit=100",
        "--json", "number,title,repository,state,updatedAt,url,isDraft",
    ]);
    if (result.error) {
        ghCache = { at: now, value: ghCache.value, error: result.error };
        return { data: ghCache.value ?? [], cachedAt: now, error: result.error };
    }
    ghCache = { at: now, value: result.data, error: null };
    return { data: result.data, cachedAt: now, error: null };
}

// Pull author's open PRs with their head-commit check runs in one GraphQL call.
// This is the source of truth for CI/pipeline status; the simpler search-prs
// path above is kept as a fast fallback if GraphQL fails (e.g. SAML).
const CHECKS_QUERY = `
query {
  search(query: "author:@me state:open is:pr", type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        state
        updatedAt
        repository { nameWithOwner }
        commits(last: 1) {
          nodes {
            commit {
              oid
              checkSuites(first: 30) {
                nodes {
                  status
                  conclusion
                  checkRuns(first: 100) {
                    nodes { name status conclusion detailsUrl startedAt completedAt }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`.trim();

let checksCache = { at: 0, value: null, error: null };
async function fetchPrsWithChecks({ force = false } = {}) {
    const now = Date.now();
    if (!force && checksCache.value && now - checksCache.at < CHECKS_CACHE_TTL_MS) {
        return { data: checksCache.value, cachedAt: checksCache.at, error: checksCache.error };
    }
    const result = await runGh([
        "api", "graphql",
        "--field", `query=${CHECKS_QUERY}`,
    ]);
    if (result.error) {
        checksCache = { at: now, value: checksCache.value, error: result.error };
        return { data: checksCache.value ?? null, cachedAt: now, error: result.error };
    }
    // GraphQL may return partial data with non-fatal errors (e.g. SAML on `app`).
    // We ignore those because we never read `app`; we identify AzDO via URL.
    const prs = result.data?.data?.search?.nodes ?? [];
    const shaped = prs
        .filter((p) => p && p.number)
        .map((p) => {
            const commit = p.commits?.nodes?.[0]?.commit;
            const allRuns = [];
            for (const suite of commit?.checkSuites?.nodes ?? []) {
                for (const run of suite?.checkRuns?.nodes ?? []) allRuns.push(run);
            }
            const azdo = summarizeAzdoRuns(allRuns);
            const gha = summarizeGhaRuns(allRuns);
            return {
                number: p.number,
                title: p.title,
                url: p.url,
                isDraft: p.isDraft,
                state: p.state,
                updatedAt: p.updatedAt,
                repository: p.repository,
                headSha: commit?.oid,
                azdo,
                gha,
            };
        });
    checksCache = { at: now, value: shaped, error: null };
    return { data: shaped, cachedAt: now, error: null };
}

// Map local Copilot session_ids to remote task URLs by querying the
// `api.githubcopilot.com/agents/tasks` endpoint. The desktop app exports each
// local session to a server-side task whose UUID is what shows up in the
// `github.com/<owner>/<repo>/tasks/<task-id>` web URL. Tasks are linked back
// to local sessions through `agent_collaborators[].agent_task_id`.
let tasksCache = { at: 0, value: null, error: null };
function runGhAuthToken() {
    return new Promise((resolve) => {
        const child = spawn("gh", ["auth", "token"], { shell: false, windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (err) => resolve({ error: err.message }));
        child.on("close", (code) => {
            if (code === 0) resolve({ token: stdout.trim() });
            else resolve({ error: stderr.trim() || `gh auth token exited with code ${code}` });
        });
    });
}
async function fetchAgentTasks({ force = false } = {}) {
    const now = Date.now();
    if (!force && tasksCache.value && now - tasksCache.at < TASKS_CACHE_TTL_MS) {
        return { data: tasksCache.value, cachedAt: tasksCache.at, error: tasksCache.error };
    }
    const tokenResult = await runGhAuthToken();
    if (tokenResult.error) {
        tasksCache = { at: now, value: tasksCache.value, error: tokenResult.error };
        return { data: tasksCache.value ?? new Map(), cachedAt: now, error: tokenResult.error };
    }
    try {
        const res = await fetch("https://api.githubcopilot.com/agents/tasks", {
            headers: {
                Authorization: `Bearer ${tokenResult.token}`,
                "Copilot-Integration-Id": "copilot-developer-app",
                "Editor-Version": "copilot-cli-extension/1.0",
                Accept: "application/json",
            },
        });
        if (!res.ok) {
            const msg = `tasks API HTTP ${res.status}`;
            tasksCache = { at: now, value: tasksCache.value, error: msg };
            return { data: tasksCache.value ?? new Map(), cachedAt: now, error: msg };
        }
        const body = await res.json();
        // Build session_id -> task_id map
        const map = new Map();
        for (const t of body.tasks ?? []) {
            for (const c of t.agent_collaborators ?? []) {
                if (c.agent_task_id) map.set(c.agent_task_id, t.id);
            }
        }
        tasksCache = { at: now, value: map, error: null };
        return { data: map, cachedAt: now, error: null };
    } catch (err) {
        tasksCache = { at: now, value: tasksCache.value, error: err.message };
        return { data: tasksCache.value ?? new Map(), cachedAt: now, error: err.message };
    }
}

// Fetch the AzDO build timeline + top-level build info for one build.
// Anonymous only: public orgs (e.g. dnceng-public) work; private orgs will
// surface the AzDO error (typically 203 redirect / 401) in the timeline panel.
const azdoTimelineCache = new Map(); // key -> { at, value, error }
const azdoTimelineInFlight = new Map(); // key -> Promise

async function fetchAzdoJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const contentType = res.headers.get("content-type") ?? "";
    // AzDO sign-in / auth-required responses are typically 203 with an HTML
    // body, or 401/403. Detect those before trying to parse JSON.
    if (!contentType.includes("application/json")) {
        const status = res.status === 203 ? "203 (sign-in required)" : res.status;
        throw new Error(`Azure DevOps returned ${status} — build may be in a private project (anonymous access only).`);
    }
    if (!res.ok) {
        throw new Error(`Azure DevOps HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
}

async function fetchAzdoTimeline({ org, project, buildId, force = false }) {
    const key = `${org}|${project}|${buildId}`;
    const now = Date.now();
    if (!force) {
        const cached = azdoTimelineCache.get(key);
        if (cached && now - cached.at < AZDO_TIMELINE_CACHE_TTL_MS) {
            return { data: cached.value, cachedAt: cached.at, error: cached.error };
        }
        const inflight = azdoTimelineInFlight.get(key);
        if (inflight) return inflight;
    }
    const promise = (async () => {
        const projectEnc = encodeURIComponent(project);
        const orgEnc = encodeURIComponent(org);
        const buildUrl = `https://dev.azure.com/${orgEnc}/${projectEnc}/_apis/build/builds/${buildId}?api-version=7.1`;
        const timelineUrl = `https://dev.azure.com/${orgEnc}/${projectEnc}/_apis/build/builds/${buildId}/timeline?api-version=7.1`;
        try {
            const [build, timeline] = await Promise.all([
                fetchAzdoJson(buildUrl),
                fetchAzdoJson(timelineUrl),
            ]);
            const value = {
                build: {
                    status: build.status,
                    result: build.result,
                    startTime: build.startTime,
                    finishTime: build.finishTime,
                    url: build._links?.web?.href ?? null,
                    buildNumber: build.buildNumber,
                },
                records: (timeline?.records ?? []).map((r) => ({
                    id: r.id,
                    parentId: r.parentId,
                    type: r.type,
                    name: r.name,
                    state: r.state,
                    result: r.result,
                    order: r.order,
                    startTime: r.startTime,
                    finishTime: r.finishTime,
                    percentComplete: r.percentComplete,
                    log: r.log ? { url: r.log.url } : null,
                })),
            };
            azdoTimelineCache.set(key, { at: now, value, error: null });
            return { data: value, cachedAt: now, error: null };
        } catch (err) {
            azdoTimelineCache.set(key, { at: now, value: null, error: err.message });
            return { data: null, cachedAt: now, error: err.message };
        } finally {
            azdoTimelineInFlight.delete(key);
        }
    })();
    azdoTimelineInFlight.set(key, promise);
    return promise;
}

// Reduce a flat list of check runs into AzDO-only buckets, grouped by buildId.
// Returns { builds: [...], summary: { total, success, failure, inProgress, ... }, hasAny }.
function summarizeAzdoRuns(runs) {
    const azdoRuns = runs.filter((r) => r?.detailsUrl && AZDO_URL_RE.test(r.detailsUrl));
    if (azdoRuns.length === 0) {
        return { hasAny: false, builds: [], summary: null };
    }
    const builds = new Map();
    for (const r of azdoRuns) {
        const idMatch = r.detailsUrl.match(AZDO_BUILD_ID_RE);
        const key = idMatch ? `b:${idMatch[1]}` : `u:${new URL(r.detailsUrl).origin}`;
        const { org, project } = parseAzdoUrl(r.detailsUrl);
        let entry = builds.get(key);
        if (!entry) {
            entry = {
                buildId: idMatch?.[1] ?? null,
                org,
                project,
                summaryUrl: idMatch ? r.detailsUrl.replace(/&view=.*$/, "").replace(/&jobId=.*$/, "") : r.detailsUrl,
                runs: [],
            };
            builds.set(key, entry);
        }
        entry.runs.push({
            name: r.name,
            status: r.status,           // QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING
            conclusion: r.conclusion,   // SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STARTUP_FAILURE | STALE | null
            detailsUrl: r.detailsUrl,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
        });
    }
    const summary = { total: 0, success: 0, failure: 0, inProgress: 0, other: 0 };
    for (const b of builds.values()) {
        for (const r of b.runs) {
            summary.total++;
            if (r.status !== "COMPLETED") summary.inProgress++;
            else if (r.conclusion === "SUCCESS" || r.conclusion === "NEUTRAL" || r.conclusion === "SKIPPED") summary.success++;
            else if (r.conclusion === "FAILURE" || r.conclusion === "TIMED_OUT" || r.conclusion === "STARTUP_FAILURE" || r.conclusion === "ACTION_REQUIRED") summary.failure++;
            else summary.other++;
        }
    }
    summary.overall =
        summary.failure > 0 ? "failure" :
        summary.inProgress > 0 ? "in_progress" :
        summary.success > 0 ? "success" : "other";
    return {
        hasAny: true,
        builds: [...builds.values()].sort((a, b) => Number(b.buildId ?? 0) - Number(a.buildId ?? 0)),
        summary,
    };
}

// Flatten non-AzDO check runs into a single list. Each GHA check run becomes
// one row; we used to group by workflow name (the part before " / " in the
// check name) but that produced spurious parent/child cards for GitHub App
// checks like "license/cla" whose name happens to contain "/".
// Returns { runs: [...], summary: {...}, hasAny }.
function summarizeGhaRuns(runs) {
    const ghaRuns = runs.filter((r) => r?.detailsUrl && !AZDO_URL_RE.test(r.detailsUrl));
    if (ghaRuns.length === 0) {
        return { hasAny: false, runs: [], summary: null };
    }
    const summary = { total: 0, success: 0, failure: 0, inProgress: 0, other: 0 };
    const shaped = ghaRuns.map((r) => {
        summary.total++;
        if (r.status !== "COMPLETED") summary.inProgress++;
        else if (r.conclusion === "SUCCESS" || r.conclusion === "NEUTRAL" || r.conclusion === "SKIPPED") summary.success++;
        else if (r.conclusion === "FAILURE" || r.conclusion === "TIMED_OUT" || r.conclusion === "STARTUP_FAILURE" || r.conclusion === "ACTION_REQUIRED") summary.failure++;
        else summary.other++;
        return {
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            detailsUrl: r.detailsUrl,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
        };
    });
    summary.overall =
        summary.failure > 0 ? "failure" :
        summary.inProgress > 0 ? "in_progress" :
        summary.success > 0 ? "success" : "other";
    // Sort by start time for parity with AzDO job ordering.
    shaped.sort((a, b) => {
        const ta = a.startedAt ? new Date(a.startedAt).getTime() : Infinity;
        const tb = b.startedAt ? new Date(b.startedAt).getTime() : Infinity;
        if (ta !== tb) return ta - tb;
        return String(a.name).localeCompare(String(b.name));
    });
    return { hasAny: true, runs: shaped, summary };
}

// Build a quick lookup key for cross-referencing tab 2 against tab 1.
// Format: "<repo_full_name>#<pr_number>".
function prKey(repo, number) {
    if (!repo || !number) return null;
    return `${repo.toLowerCase()}#${number}`;
}
function buildSessionPrIndex(sessions) {
    const index = new Map();
    for (const s of sessions) {
        const k1 = prKey(s.repo_full_name, s.source_pr_number);
        const k2 = prKey(s.created_pr_repo, s.created_pr_number);
        if (k1) index.set(k1, s);
        if (k2) index.set(k2, s);
    }
    return index;
}

function jsonResponse(res, body, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
}

const PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>CI Runs</title>
  <style>
    /* Semantic Primer-aligned color tokens. The canvas iframe is cross-origin
       so we can't read CSS variables from the host frame; instead we mirror
       GitHub Primer's light/dark palettes and switch via prefers-color-scheme.
       All visual colors below are expressed in terms of these tokens so the
       canvas reskins cleanly when the system theme changes. */
    :root {
      color-scheme: light dark;
      /* Light mode (Primer light) */
      --canvas-default:  #ffffff;
      --canvas-subtle:   #f6f8fa;
      --fg-default:      #1f2328;
      --fg-muted:        #59636e;
      --fg-subtle:       #818b98;
      --border-default:  #d1d9e0;
      --border-muted:    #d1d9e0b3;
      --accent-fg:       #0969da;
      --success-fg:      #1a7f37;
      --attention-fg:    #9a6700;
      --danger-fg:       #d1242f;
      --done-fg:         #8250df;
      --neutral-fg:      #59636e;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --canvas-default:  #0d1117;
        --canvas-subtle:   #161b22;
        --fg-default:      #f0f6fc;
        --fg-muted:        #9198a1;
        --fg-subtle:       #6e7681;
        --border-default:  #3d444d;
        --border-muted:    #3d444db3;
        --accent-fg:       #4493f7;
        --success-fg:      #3fb950;
        --attention-fg:    #d29922;
        --danger-fg:       #f85149;
        --done-fg:         #a371f7;
        --neutral-fg:      #9198a1;
      }
    }

    body { font: 14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; padding: 1rem; background: var(--canvas-default); color: var(--fg-default); }
    header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
    h1 { margin: 0; font-size: 1.1rem; flex: 1; }
    .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border-default); margin-bottom: 0.75rem; }
    .tab { padding: 0.35rem 0.75rem; cursor: pointer; border: none; background: none; color: inherit; font: inherit; border-bottom: 2px solid transparent; }
    .tab.active { border-bottom-color: var(--accent-fg); font-weight: 600; }
    .tab .count { color: var(--fg-muted); font-size: 0.8rem; margin-left: 0.25rem; }
    button.refresh { cursor: pointer; background: none; border: 1px solid var(--border-default); color: inherit; padding: 0.2rem 0.5rem; border-radius: 4px; font: inherit; font-size: 0.8rem; }
    button.refresh:hover { background: var(--canvas-subtle); }
    .panel { display: none; }
    .panel.active { display: block; }
    ul.list { list-style: none; padding: 0; margin: 0; }
    li.row { border: 1px solid var(--border-default); border-radius: 6px; padding: 0.6rem 0.75rem; margin-bottom: 0.5rem; background: var(--canvas-default); }
    .row-head { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; font-size: 0.85rem; }
    .row-title { font-weight: 600; margin-top: 0.25rem; }
    .row-meta { color: var(--fg-muted); font-size: 0.8rem; margin-top: 0.15rem; font-family: ui-monospace, Consolas, monospace; }
    .project, .repo, .badge { padding: 0.05rem 0.4rem; border-radius: 999px; font-size: 0.7rem; }
    .project { background: var(--canvas-subtle); font-size: 0.75rem; }
    .repo { color: var(--fg-muted); font-family: ui-monospace, Consolas, monospace; font-size: 0.8rem; background: none; padding: 0; }
    .badge { text-transform: uppercase; letter-spacing: 0.03em; }
    /* Badge backgrounds are derived from their fg token via color-mix so the
       tinted fill tracks the same hue when the theme switches. */
    .badge.draft   { background: color-mix(in srgb, var(--neutral-fg)   25%, transparent); color: var(--neutral-fg); }
    .badge.session { background: color-mix(in srgb, var(--attention-fg) 20%, transparent); color: var(--attention-fg); }
    .badge.closed  { background: color-mix(in srgb, var(--danger-fg)    20%, transparent); color: var(--danger-fg); }
    .badge.merged  { background: color-mix(in srgb, var(--done-fg)      20%, transparent); color: var(--done-fg); }
    .badge.sync-up_to_date { background: color-mix(in srgb, var(--success-fg)   15%, transparent); color: var(--success-fg); }
    .badge.sync-behind     { background: color-mix(in srgb, var(--attention-fg) 20%, transparent); color: var(--attention-fg); }
    .badge.sync-ahead      { background: color-mix(in srgb, var(--accent-fg)    20%, transparent); color: var(--accent-fg); }
    .badge.sync-diverged   { background: color-mix(in srgb, var(--danger-fg)    20%, transparent); color: var(--danger-fg); }
    .azdo { margin-top: 0.4rem; display: flex; flex-direction: column; gap: 0.25rem; }
    .azdo-build { display: flex; flex-direction: column; gap: 0.15rem; }
    .azdo-line { display: flex; gap: 0.4rem; align-items: center; font-size: 0.8rem; flex-wrap: wrap; }
    .azdo-line .label { color: var(--fg-muted); }
    .azdo-line .count-fail { color: var(--danger-fg); }
    .azdo-line .count-progress { color: var(--attention-fg); }
    .ci-dot { width: 0.65rem; height: 0.65rem; border-radius: 50%; display: inline-block; }
    .ci-dot.success     { background: var(--success-fg); }
    .ci-dot.failure     { background: var(--danger-fg); }
    .ci-dot.in_progress { background: var(--attention-fg); animation: pulse 1.6s ease-in-out infinite; }
    .ci-dot.other       { background: var(--neutral-fg); }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }
    .toggle { cursor: pointer; background: none; border: none; color: var(--accent-fg); font: inherit; font-size: 0.8rem; padding: 0; }
    .toggle:hover { text-decoration: underline; }
    details.azdo-jobs { margin-top: 0.2rem; }
    details.azdo-jobs summary { cursor: pointer; font-size: 0.75rem; color: var(--fg-muted); list-style: revert; }
    details.azdo-jobs ul { list-style: none; padding-left: 1rem; margin: 0.25rem 0 0; }
    details.azdo-jobs li { font-size: 0.75rem; font-family: ui-monospace, Consolas, monospace; padding: 0.1rem 0; display: flex; gap: 0.4rem; align-items: center; }
    .azdo-timeline { margin: 0.25rem 0 0; }
    .azdo-timeline .tl-fallback-note { color: var(--attention-fg); font-size: 0.7rem; padding: 0.2rem 0; }
    .azdo-timeline .tl-loading { color: var(--fg-muted); font-size: 0.75rem; padding: 0.2rem 0; }
    .azdo-timeline .tl-error { color: var(--danger-fg); font-size: 0.75rem; padding: 0.2rem 0; white-space: pre-wrap; }

    /* Collapsible PR rows. Default-open unless every CI check passed. */
    li.row-collapsible { padding: 0; }
    li.row-collapsible > details > summary {
      cursor: pointer; list-style: none;
      padding: 0.6rem 0.75rem;
      display: flex; gap: 0.5rem; align-items: flex-start;
    }
    li.row-collapsible > details > summary::-webkit-details-marker { display: none; }
    li.row-collapsible > details > summary::marker { content: ''; }
    li.row-collapsible .caret {
      flex: 0 0 auto; color: var(--fg-muted); font-size: 0.7rem; line-height: 1.5;
      transition: transform 0.15s ease;
      transform: rotate(0deg);
      width: 0.7rem;
    }
    li.row-collapsible > details[open] > summary .caret { transform: rotate(90deg); }
    li.row-collapsible .row-summary-content { flex: 1 1 auto; min-width: 0; }
    li.row-collapsible > details > .row-body { padding: 0 0.75rem 0.6rem 1.95rem; }
    li.row-collapsible .ci-dot.overall { width: 0.7rem; height: 0.7rem; margin-left: auto; }
    a { color: var(--accent-fg); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty, .error, .loading { color: var(--fg-muted); padding: 1rem; text-align: center; }
    .error { color: var(--danger-fg); text-align: left; white-space: pre-wrap; font-family: ui-monospace, Consolas, monospace; font-size: 0.8rem; }
  </style>
</head>
<body>
  <header>
    <h1>CI Runs</h1>
    <button class="refresh" id="refresh">↻ Refresh</button>
  </header>
  <div class="tabs">
    <button class="tab active" data-tab="copilot">Copilot<span class="count" id="copilot-count"></span></button>
    <button class="tab" data-tab="all">All my PRs<span class="count" id="all-count"></span></button>
  </div>
  <div class="panel active" id="panel-copilot"><div class="loading">Loading…</div></div>
  <div class="panel" id="panel-all"><div class="loading">Loading…</div></div>

  <script>
    const esc = (s) => s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    const syncTooltips = {
      'up_to_date': 'Local session matches its tracked upstream (as of the last fetch)',
      'behind':     'Tracked upstream has commits not in your local branch (as of the last fetch)',
      'ahead':      'Local branch has commits not yet pushed to its tracked upstream (as of the last fetch)',
      'diverged':   'Local and upstream have diverged with different commits (as of the last fetch)',
    };

    const overallCiTooltips = {
      success: 'All CI checks passed',
      failure: 'One or more CI checks failed',
      in_progress: 'CI checks are running',
      other: 'CI checks in an unknown or mixed state',
    };

    // Combine GHA + AzDO summaries into a single worst-wins state.
    function overallCiState(gha, azdo) {
      const states = [];
      if (gha?.hasAny)  states.push(gha.summary.overall);
      if (azdo?.hasAny) states.push(azdo.summary.overall);
      if (!states.length) return null;
      if (states.includes('failure'))     return 'failure';
      if (states.includes('in_progress')) return 'in_progress';
      if (states.includes('other'))       return 'other';
      return 'success';
    }

    // Build a PR row that's collapsible when CI is present. Default-open unless
    // every check has passed. prKey (e.g. owner/repo#123) gives the details
    // element a stable identity so open/closed state survives auto-refresh
    // re-renders via snapshotPrRowState/restorePrRowState.
    function renderPrRow({ headerHtml, titleHtml, metaHtml, gha, azdo, prKey }) {
      const overall = overallCiState(gha, azdo);
      const overallDot = overall
        ? \`<span class="ci-dot \${overall} overall" title="\${esc(overallCiTooltips[overall] ?? '')}"></span>\`
        : '';
      const head = \`<div class="row-head">\${headerHtml}\${overallDot}</div>\`;
      const title = \`<div class="row-title">\${titleHtml}</div>\`;
      const meta = metaHtml ? \`<div class="row-meta">\${metaHtml}</div>\` : '';
      if (!overall) {
        return \`<li class="row">\${head}\${title}\${meta}</li>\`;
      }
      const openAttr = overall === 'success' ? '' : 'open';
      const keyAttr = prKey ? \` data-pr-key="\${esc(prKey)}"\` : '';
      const body = \`\${renderGha(gha)}\${renderAzdo(azdo)}\`;
      return \`<li class="row row-collapsible"><details\${keyAttr} \${openAttr}>
        <summary>
          <span class="caret">▶</span>
          <div class="row-summary-content">\${head}\${title}\${meta}</div>
        </summary>
        <div class="row-body">\${body}</div>
      </details></li>\`;
    }

    function renderCopilot(rows) {
      if (!rows.length) return '<div class="empty">No active Copilot sessions with PRs.</div>';
      return '<ul class="list">' + rows.map(s => {
        const num   = s.source_pr_number ?? s.created_pr_number;
        const url   = s.source_pr_html_url ?? s.created_pr_html_url;
        const repo  = s.repo_full_name ?? s.created_pr_repo ?? '(unknown repo)';
        const title = s._liveTitle ?? s.source_pr_title ?? s.workspace_name ?? '(untitled)';
        const head  = s.source_pr_head_ref ? \`\${esc(s.source_pr_head_ref)} → \${esc(s.source_pr_base_ref ?? '')}\` : esc(s.branch ?? '');
        const draftBadge = s._liveDraft ? '<span class="badge draft" title="This PR is still in draft">draft</span>' : '';
        const syncBadge  = s.sync_state ? \`<span class="badge sync-\${esc(s.sync_state)}" title="\${esc(syncTooltips[s.sync_state] ?? '')}">\${esc(s.sync_state.replace(/_/g,' '))}</span>\` : '';
        const link = url ? \`<a href="\${esc(url)}" target="_blank" rel="noopener">#\${esc(num)}</a>\` : (num ? \`#\${esc(num)}\` : '');
        const sessionInfo = s._taskUrl
          ? \`<a class="badge session" href="\${esc(s._taskUrl)}" target="_blank" rel="noopener" title="Open this session on github.com">session ↗</a>\`
          : (s.workspace_id ? \`<span class="badge session" title="Workspace ID: \${esc(s.workspace_id)}">session</span>\` : '');
        const updated = s._liveUpdatedAt ? \`updated \${new Date(s._liveUpdatedAt).toLocaleString()}\` : '';
        const meta = [head, updated].filter(Boolean).join(' · ');
        const prKey = repo && num ? (repo + '#' + num).toLowerCase() : null;
        return renderPrRow({
          headerHtml: \`<span class="repo">\${esc(repo)}</span>\${link}\${draftBadge}\${syncBadge}\${sessionInfo}\`,
          titleHtml: esc(title),
          metaHtml: '',
          gha: s._gha,
          azdo: s._azdo,
          prKey,
        });
      }).join('') + '</ul>';
    }

    function runStatusLabel(r) {
      if (r.status !== 'COMPLETED') return (r.status || 'pending').toLowerCase().replace(/_/g,' ');
      return (r.conclusion || 'unknown').toLowerCase().replace(/_/g,' ');
    }
    function runDotClass(r) {
      if (r.status !== 'COMPLETED') return 'in_progress';
      if (r.conclusion === 'SUCCESS' || r.conclusion === 'NEUTRAL' || r.conclusion === 'SKIPPED') return 'success';
      if (r.conclusion === 'FAILURE' || r.conclusion === 'TIMED_OUT' || r.conclusion === 'STARTUP_FAILURE' || r.conclusion === 'ACTION_REQUIRED') return 'failure';
      return 'other';
    }
    function renderAzdo(azdo) {
      if (!azdo || !azdo.hasAny) return '';
      const s = azdo.summary;
      const overallDot = '<span class="ci-dot ' + s.overall + '"></span>';
      const counts = [
        s.success     ? \`<span title="passed">✓ \${s.success}</span>\` : '',
        s.failure     ? \`<span title="failed" class="count-fail">✕ \${s.failure}</span>\` : '',
        s.inProgress  ? \`<span title="in progress" class="count-progress">⟳ \${s.inProgress}</span>\` : '',
        s.other       ? \`<span title="other">· \${s.other}</span>\` : '',
      ].filter(Boolean).join(' ');
      const buildLines = azdo.builds.map(b => {
        const label = b.buildId
          ? \`<a href="\${esc(b.summaryUrl)}" target="_blank" rel="noopener">build \${esc(b.buildId)}</a>\${b.org ? \` <span class="label">(\${esc(b.org)})</span>\` : ''}\`
          : \`<a href="\${esc(b.summaryUrl)}" target="_blank" rel="noopener">\${esc(b.summaryUrl)}</a>\`;
        const ghJobs = b.runs.map(r => \`<li><span class="ci-dot \${runDotClass(r)}"></span><a href="\${esc(r.detailsUrl)}" target="_blank" rel="noopener">\${esc(r.name)}</a> <span class="label">\${esc(runStatusLabel(r))}</span></li>\`).join('');
        // The <details> block is timeline-capable when we have org+project+buildId.
        // Inner content starts as the GitHub-derived list (immediate fallback);
        // on first open, the lazy loader replaces it with the live AzDO timeline.
        // If the AzDO call fails the loader puts the fallback list back with an
        // explanatory note.
        const timelineAttrs = (b.org && b.project && b.buildId)
          ? \` data-tl-org="\${esc(b.org)}" data-tl-project="\${esc(b.project)}" data-tl-build-id="\${esc(b.buildId)}" data-tl-summary-url="\${esc(b.summaryUrl)}"\`
          : '';
        return \`<div class="azdo-build">
          <div class="azdo-line">\${label} <span class="label">· \${b.runs.length} job\${b.runs.length === 1 ? '' : 's'}</span></div>
          <details class="azdo-jobs"\${timelineAttrs}><summary>show jobs</summary><div class="azdo-jobs-content"><ul>\${ghJobs}</ul></div></details>
        </div>\`;
      }).join('');
      return \`<div class="azdo">
        <div class="azdo-line">\${overallDot}<strong>Azure Pipelines</strong> <span class="label">\${counts}</span></div>
        \${buildLines}
      </div>\`;
    }

    function renderGha(gha) {
      if (!gha || !gha.hasAny) return '';
      const s = gha.summary;
      const overallDot = '<span class="ci-dot ' + s.overall + '"></span>';
      const counts = [
        s.success     ? \`<span title="passed">✓ \${s.success}</span>\` : '',
        s.failure     ? \`<span title="failed" class="count-fail">✕ \${s.failure}</span>\` : '',
        s.inProgress  ? \`<span title="in progress" class="count-progress">⟳ \${s.inProgress}</span>\` : '',
        s.other       ? \`<span title="other">· \${s.other}</span>\` : '',
      ].filter(Boolean).join(' ');
      const jobs = gha.runs.map(r => \`<li><span class="ci-dot \${runDotClass(r)}"></span><a href="\${esc(r.detailsUrl)}" target="_blank" rel="noopener">\${esc(r.name)}</a> <span class="label">\${esc(runStatusLabel(r))}</span></li>\`).join('');
      return \`<div class="azdo">
        <div class="azdo-line">\${overallDot}<strong>GitHub Actions</strong> <span class="label">\${counts}</span></div>
        <details class="azdo-jobs"><summary>show jobs</summary><div class="azdo-jobs-content"><ul>\${jobs}</ul></div></details>
      </div>\`;
    }

    function renderAll(prs, sessionIndex) {
      const withChecks = prs.filter(p => p.azdo?.hasAny || p.gha?.hasAny);
      if (!withChecks.length) return '<div class="empty">No open PRs with CI checks.</div>';
      return '<ul class="list">' + withChecks.map(p => {
        const repo = p.repository.nameWithOwner;
        const key  = (repo + '#' + p.number).toLowerCase();
        const session = sessionIndex.get(key);
        const draft = p.isDraft ? '<span class="badge draft" title="This PR is still in draft">draft</span>' : '';
        const sessionBadge = session
          ? (session._taskUrl
              ? \`<a class="badge session" href="\${esc(session._taskUrl)}" target="_blank" rel="noopener" title="Open this session on github.com">session ↗</a>\`
              : \`<span class="badge session" title="A Copilot session is open for this PR (workspace \${esc(session.workspace_id)})">session</span>\`)
          : '';
        const syncBadge = session?.sync_state ? \`<span class="badge sync-\${esc(session.sync_state)}" title="\${esc(syncTooltips[session.sync_state] ?? '')}">\${esc(session.sync_state.replace(/_/g,' '))}</span>\` : '';
        const head = session?.source_pr_head_ref ? \`\${esc(session.source_pr_head_ref)} → \${esc(session.source_pr_base_ref ?? '')}\` : '';
        const updated = new Date(p.updatedAt).toLocaleString();
        const meta = [head, \`updated \${updated}\`].filter(Boolean).join(' · ');
        return renderPrRow({
          headerHtml: \`<span class="repo">\${esc(repo)}</span><a href="\${esc(p.url)}" target="_blank" rel="noopener">#\${esc(p.number)}</a>\${draft}\${syncBadge}\${sessionBadge}\`,
          titleHtml: esc(p.title),
          metaHtml: '',
          gha: p.gha,
          azdo: p.azdo,
          prKey: key,
        });
      }).join('') + '</ul>';
    }

    let lastSessions = [];
    let lastChecks = [];

    async function loadCopilot() {
      const res = await fetch('/api/sessions').then(r => r.json());
      if (res.error) {
        document.getElementById('panel-copilot').innerHTML = \`<div class="error">\${esc(res.error)}</div>\`;
        document.getElementById('copilot-count').textContent = '';
        lastSessions = [];
        return;
      }
      lastSessions = res.rows;
      // Cross-reference CI data from the checks cache and task URLs from the tasks API
      const [checksRes, tasksRes] = await Promise.all([
        fetch('/api/prs-with-checks').then(r => r.json()),
        fetch('/api/tasks').then(r => r.json()),
      ]);
      lastChecks = checksRes.rows ?? [];
      const ciIndex = new Map();
      for (const p of lastChecks) {
        const key = (p.repository.nameWithOwner + '#' + p.number).toLowerCase();
        ciIndex.set(key, p);
      }
      const taskMap = new Map(Object.entries(tasksRes.tasks ?? {}));
      // Attach CI data and remote task URL to each session row
      const enriched = res.rows.map(s => {
        const prNum = s.source_pr_number ?? s.created_pr_number;
        const repo = s.repo_full_name ?? s.created_pr_repo;
        const key = repo && prNum ? (repo + '#' + prNum).toLowerCase() : null;
        const ci = key ? ciIndex.get(key) : null;
        const taskId = s.session_id ? taskMap.get(s.session_id) : null;
        const taskUrl = taskId && repo ? \`https://github.com/\${repo}/tasks/\${taskId}\` : null;
        return { ...s, _gha: ci?.gha ?? null, _azdo: ci?.azdo ?? null, _liveTitle: ci?.title ?? null, _liveUpdatedAt: ci?.updatedAt ?? null, _liveDraft: ci?.isDraft ?? false, _taskUrl: taskUrl };
      });
      // Stash the task map on the session rows for renderAll cross-reference
      window.__taskMap = taskMap;
      const openTimelines = snapshotOpenAzdoTimelines();
      const prRowState = snapshotPrRowState();
      document.getElementById('panel-copilot').innerHTML = renderCopilot(enriched);
      restorePrRowState(prRowState);
      restoreOpenAzdoTimelines(openTimelines);
      document.getElementById('copilot-count').textContent = ' (' + res.rows.length + ')';
    }

    async function loadAll(force=false) {
      const res = await fetch('/api/prs-with-checks' + (force ? '?force=1' : '')).then(r => r.json());
      const sessionIndex = new Map();
      const taskMap = window.__taskMap ?? new Map();
      for (const s of lastSessions) {
        const taskId = s.session_id ? taskMap.get(s.session_id) : null;
        const repoForTask = s.repo_full_name ?? s.created_pr_repo;
        const taskUrl = taskId && repoForTask ? \`https://github.com/\${repoForTask}/tasks/\${taskId}\` : null;
        const enriched = { ...s, _taskUrl: taskUrl };
        if (s.repo_full_name && s.source_pr_number)  sessionIndex.set((s.repo_full_name + '#' + s.source_pr_number).toLowerCase(), enriched);
        if (s.created_pr_repo && s.created_pr_number) sessionIndex.set((s.created_pr_repo + '#' + s.created_pr_number).toLowerCase(), enriched);
      }
      const errorBanner = res.error ? \`<div class="error">\${esc(res.error)}</div>\` : '';
      const openTimelines = snapshotOpenAzdoTimelines();
      const prRowState = snapshotPrRowState();
      document.getElementById('panel-all').innerHTML = errorBanner + renderAll(res.rows ?? [], sessionIndex);
      restorePrRowState(prRowState);
      restoreOpenAzdoTimelines(openTimelines);
      const visibleCount = (res.rows ?? []).filter(p => p.azdo?.hasAny || p.gha?.hasAny).length;
      document.getElementById('all-count').textContent = res.rows ? ' (' + visibleCount + ')' : '';
    }

    // ---- AzDO timeline (real per-job status from dev.azure.com REST API) ----
    //
    // Each <details class="azdo-jobs"> for a build with a known org/project/buildId
    // is timeline-capable. On open we lazy-load /api/azdo-timeline and replace
    // the GitHub-check-run fallback list inside .azdo-jobs-content with the
    // real AzDO record tree (stages → phases → jobs → tasks).
    //
    // Open-state survives the 60s auto-refresh: snapshotOpenAzdoTimelines() is
    // called before each panel re-render, and restoreOpenAzdoTimelines() reopens
    // matching details after the new DOM is in place and triggers a fresh load.

    function azdoTimelineKey(detailsEl) {
      const org = detailsEl.dataset.tlOrg;
      const project = detailsEl.dataset.tlProject;
      const buildId = detailsEl.dataset.tlBuildId;
      return org && project && buildId ? \`\${org}|\${project}|\${buildId}\` : null;
    }

    function snapshotOpenAzdoTimelines() {
      const keys = new Set();
      document.querySelectorAll('details.azdo-jobs[open]').forEach(d => {
        const k = azdoTimelineKey(d);
        if (k) keys.add(k);
      });
      return keys;
    }

    function restoreOpenAzdoTimelines(keys) {
      if (!keys || keys.size === 0) return;
      document.querySelectorAll('details.azdo-jobs').forEach(d => {
        const k = azdoTimelineKey(d);
        if (k && keys.has(k)) {
          d.open = true;
          loadAzdoTimeline(d, { force: true });
        }
      });
    }

    // Snapshot/restore the open/closed state of every PR-row <details> by key.
    // Without this, the 60s auto-refresh (and the manual Refresh button) wipes
    // the user's manual collapse/expand and forces every row back to the
    // default-open-unless-all-checks-passed state.
    function snapshotPrRowState() {
      const state = new Map();
      document.querySelectorAll('details[data-pr-key]').forEach(d => {
        state.set(d.dataset.prKey, d.open);
      });
      return state;
    }

    function restorePrRowState(state) {
      if (!state || state.size === 0) return;
      document.querySelectorAll('details[data-pr-key]').forEach(d => {
        if (state.has(d.dataset.prKey)) d.open = state.get(d.dataset.prKey);
      });
    }

    function tlDotClass(state, result) {
      if (state !== 'completed') return 'in_progress';
      if (result === 'succeeded' || result === 'skipped') return 'success';
      if (result === 'failed' || result === 'abandoned') return 'failure';
      return 'other';
    }
    function tlStatusLabel(state, result) {
      if (state !== 'completed') return (state || 'pending').toLowerCase();
      return (result || 'unknown').toLowerCase();
    }

    function renderTimelineJobs(records, summaryUrl) {
      if (!records || records.length === 0) {
        return '<div class="tl-loading">No timeline records yet — build may still be queuing.</div>';
      }
      // AzDO timelines contain Stage / Phase / Job / Task / Checkpoint records.
      // For parity with the GHA jobs list we only show Job records, flat, in
      // execution order. Parent Stage/Phase context is dropped to keep the UI
      // consistent across CI systems.
      const jobs = records
        .filter(r => r.type === 'Job')
        .sort((a, b) => {
          // Order by start time when present (most useful while a build runs),
          // fall back to the timeline 'order' field, then name.
          const ta = a.startTime ? new Date(a.startTime).getTime() : Infinity;
          const tb = b.startTime ? new Date(b.startTime).getTime() : Infinity;
          if (ta !== tb) return ta - tb;
          return (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name));
        });
      if (jobs.length === 0) {
        return '<div class="tl-loading">No job records yet — build may still be queuing.</div>';
      }
      // Build the AzDO web logs URL from the build summary URL by stripping
      // any pre-existing view/job query params we may have inherited.
      const baseLog = summaryUrl
        ? summaryUrl.replace(/&view=[^&]*/g, '').replace(/&j=[^&]*/g, '').replace(/&t=[^&]*/g, '')
        : null;
      return '<ul>' + jobs.map(r => {
        const dot = tlDotClass(r.state, r.result);
        const label = tlStatusLabel(r.state, r.result);
        const href = baseLog ? \`\${baseLog}&view=logs&j=\${encodeURIComponent(r.id)}\` : null;
        const nameHtml = href
          ? \`<a href="\${esc(href)}" target="_blank" rel="noopener">\${esc(r.name)}</a>\`
          : esc(r.name);
        return \`<li><span class="ci-dot \${dot}"></span>\${nameHtml} <span class="label">\${esc(label)}</span></li>\`;
      }).join('') + '</ul>';
    }

    // Per-details guard to avoid overlapping requests for the same panel.
    const tlInflight = new WeakSet();

    async function loadAzdoTimeline(detailsEl, { force = false } = {}) {
      if (tlInflight.has(detailsEl)) return;
      const org = detailsEl.dataset.tlOrg;
      const project = detailsEl.dataset.tlProject;
      const buildId = detailsEl.dataset.tlBuildId;
      const summaryUrl = detailsEl.dataset.tlSummaryUrl;
      if (!org || !project || !buildId) return;
      const content = detailsEl.querySelector('.azdo-jobs-content');
      if (!content) return;
      // Preserve the initial GitHub-check-run fallback once, so we can restore
      // it on error. Cached on the element so re-renders see fresh fallback.
      if (content.dataset.fallbackHtml == null) {
        content.dataset.fallbackHtml = content.innerHTML;
      }
      if (!force && detailsEl.dataset.tlLoaded === '1') return;
      tlInflight.add(detailsEl);
      const wrapper = document.createElement('div');
      wrapper.className = 'azdo-timeline';
      wrapper.innerHTML = '<div class="tl-loading">Loading Azure DevOps timeline…</div>';
      content.replaceChildren(wrapper);
      try {
        const params = new URLSearchParams({ org, project, buildId });
        if (force) params.set('force', '1');
        const res = await fetch('/api/azdo-timeline?' + params.toString()).then(r => r.json());
        if (!detailsEl.isConnected) return;
        if (res.error || !res.data) {
          // Show the error AND keep the GitHub check-run list visible so the
          // user still sees something useful (e.g. private-org builds where
          // anonymous access is blocked).
          wrapper.innerHTML = \`<div class="tl-error">\${esc(res.error || 'Failed to load timeline')}</div>
            <div class="tl-fallback-note">Showing GitHub check-run jobs instead:</div>
            \${content.dataset.fallbackHtml}\`;
        } else {
          wrapper.innerHTML = renderTimelineJobs(res.data.records, summaryUrl);
          detailsEl.dataset.tlLoaded = '1';
        }
      } catch (e) {
        if (!detailsEl.isConnected) return;
        wrapper.innerHTML = \`<div class="tl-error">\${esc(e.message)}</div>
          <div class="tl-fallback-note">Showing GitHub check-run jobs instead:</div>
          \${content.dataset.fallbackHtml}\`;
      } finally {
        tlInflight.delete(detailsEl);
      }
    }

    // Delegated toggle listener — every azdo-jobs details element on the page
    // triggers a lazy load when first opened.
    document.addEventListener('toggle', (e) => {
      const el = e.target;
      if (el && el.matches && el.matches('details.azdo-jobs') && el.open) {
        loadAzdoTimeline(el);
      }
    }, true);

    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + btn.dataset.tab));
      });
    });
    document.getElementById('refresh').addEventListener('click', async () => {
      await loadCopilot();
      await loadAll(true);
    });

    // Auto-poll every minute. Skip while hidden to spare the GitHub rate limit;
    // refresh immediately on becoming visible if a poll was missed. A flag
    // prevents overlapping refreshes if a previous one is still in flight.
    const POLL_INTERVAL_MS = 60_000;
    let refreshing = false;
    let lastPollAt = Date.now();
    async function autoRefresh() {
      if (refreshing || document.hidden) return;
      refreshing = true;
      try {
        await loadCopilot();
        await loadAll(true);
        lastPollAt = Date.now();
      } catch (e) {
        console.error('auto-refresh failed', e);
      } finally {
        refreshing = false;
      }
    }
    setInterval(autoRefresh, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastPollAt >= POLL_INTERVAL_MS) {
        autoRefresh();
      }
    });

    (async () => {
      await loadCopilot();
      await loadAll();
    })();
  </script>
</body>
</html>`;

async function startServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://127.0.0.1");
            if (url.pathname === "/") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(PAGE_HTML);
            } else if (url.pathname === "/api/sessions") {
                const rows = fetchCopilotSessions();
                if (rows && rows.__error) {
                    jsonResponse(res, { error: rows.__error });
                } else {
                    await enrichSessionsWithSyncState(rows);
                    jsonResponse(res, { rows });
                }
            } else if (url.pathname === "/api/prs") {
                const force = url.searchParams.get("force") === "1";
                const { data, cachedAt, error } = await fetchAuthoredPrs({ force });
                jsonResponse(res, { rows: data ?? [], cachedAt, error });
            } else if (url.pathname === "/api/prs-with-checks") {
                const force = url.searchParams.get("force") === "1";
                const { data, cachedAt, error } = await fetchPrsWithChecks({ force });
                jsonResponse(res, { rows: data ?? [], cachedAt, error });
            } else if (url.pathname === "/api/tasks") {
                const force = url.searchParams.get("force") === "1";
                const { data, cachedAt, error } = await fetchAgentTasks({ force });
                // Serialize Map as plain object for JSON
                const tasks = data ? Object.fromEntries(data) : {};
                jsonResponse(res, { tasks, cachedAt, error });
            } else if (url.pathname === "/api/azdo-timeline") {
                const org = url.searchParams.get("org") ?? "";
                const project = url.searchParams.get("project") ?? "";
                const buildId = url.searchParams.get("buildId") ?? "";
                const force = url.searchParams.get("force") === "1";
                // Validate: org names are restricted by Azure (alphanumerics,
                // dashes, underscores). Projects allow more characters and may
                // contain spaces, so we reject only path/query separators and
                // control chars. buildId must be digits.
                const orgOk = /^[A-Za-z0-9._-]{1,64}$/.test(org);
                const projectOk = project.length > 0 && project.length <= 128 && !/[\/\\?#\x00-\x1f]/.test(project);
                const buildIdOk = /^\d{1,12}$/.test(buildId);
                if (!orgOk || !projectOk || !buildIdOk) {
                    jsonResponse(res, { error: "invalid org/project/buildId" }, 400);
                } else {
                    const { data, cachedAt, error } = await fetchAzdoTimeline({ org, project, buildId, force });
                    jsonResponse(res, { data, cachedAt, error });
                }
            } else {
                res.statusCode = 404;
                res.end("not found");
            }
        } catch (err) {
            res.statusCode = 500;
            res.end(`<pre>${err.stack}</pre>`);
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "pr-pipelines",
            displayName: "CI Runs",
            description:
                "Side-panel dashboard with two tabs: (1) Copilot sessions currently open in the desktop app with their PR/issue origin; (2) all open pull requests the user authored across GitHub. Cross-links the two so the user can see which of their PRs already have a Copilot session.",
            actions: [
                {
                    name: "refresh",
                    description: "Re-read the local session store and re-fetch the user's open PRs from GitHub.",
                    handler: async () => {
                        const sessions = fetchCopilotSessions();
                        const checks = await fetchPrsWithChecks({ force: true });
                        return {
                            ok: !checks.error && !(sessions && sessions.__error),
                            sessionCount: Array.isArray(sessions) ? sessions.length : 0,
                            prCount: checks.data?.length ?? 0,
                            azdoBuilds: (checks.data ?? []).reduce((n, p) => n + (p.azdo?.builds?.length ?? 0), 0),
                            ghaRuns: (checks.data ?? []).reduce((n, p) => n + (p.gha?.runs?.length ?? 0), 0),
                            errors: [sessions?.__error, checks.error].filter(Boolean),
                        };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                }
                const rows = fetchCopilotSessions();
                const sessionCount = Array.isArray(rows) ? rows.length : 0;
                return { title: "CI Runs", url: entry.url, status: `${sessionCount} active session${sessionCount === 1 ? "" : "s"}` };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

await session.log("pr-pipelines extension ready (v0.3)");
