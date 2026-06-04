// Extension: pr-pipelines (v0.3)
//
// User-scoped canvas: side-panel dashboard with two tabs.
//   1. "Copilot" tab  - workspaces currently open in the desktop app, with
//                       their PR or issue origin. Source: ~/.copilot/data.db.
//   2. "All PRs" tab  - every open PR the user authored across all of GitHub.
//                       Source: `gh search prs --author=@me --state=open`.
// Cross-link: PRs that appear in both tabs get a "in session" badge in tab 2.
//
// CI status: shows both Azure Pipelines and GitHub Actions workflow runs.
//
// Runtime: Node 24+ (uses node:sqlite, no npm deps).

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const DB_PATH = join(homedir(), ".copilot", "data.db");
// `gh search prs` is rate-limited (30/min for code search). Cache results so
// every tab switch / refresh doesn't re-hit the API.
const GH_CACHE_TTL_MS = 60_000;
// GraphQL-with-checks is heavier and more expensive on the rate limit.
const CHECKS_CACHE_TTL_MS = 90_000;
// Azure DevOps check runs are identified by detailsUrl host. Covers
// dev.azure.com/<org> as well as legacy <org>.visualstudio.com URLs.
const AZDO_URL_RE = /^https?:\/\/(dev\.azure\.com|[^/]+\.visualstudio\.com)\//i;
// Extract build id from an AzDO results URL: ".../_build/results?buildId=12345..."
const AZDO_BUILD_ID_RE = /[?&]buildId=(\d+)/i;

const servers = new Map();
let db = null;

function getDb() {
    if (db) return db;
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    return db;
}

// One row per non-archived workspace. PR / issue fields are coalesced from
// both `workspaces` (older shape) and `workspace_repo_contexts` (newer shape)
// so we work on either app version.
function fetchCopilotSessions() {
    const sql = `
        SELECT
            w.id          AS workspace_id,
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
            COALESCE(w.created_pr_state,         c.created_pr_state) AS created_pr_state,

            COALESCE(w.source_issue_repo_full_name, c.repo_full_name) AS issue_repo,
            COALESCE(w.source_issue_number,         c.source_issue_number) AS source_issue_number,

            s.state           AS sync_state,
            s.local_head_sha  AS local_head_sha,
            s.remote_head_sha AS remote_head_sha
        FROM workspaces w
        LEFT JOIN projects p                ON p.id = w.project_id
        LEFT JOIN workspace_repo_contexts c ON c.workspace_id = w.id
        LEFT JOIN workspace_pr_sync_status s ON s.workspace_id = w.id
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
        const orgMatch = r.detailsUrl.match(/dev\.azure\.com\/([^/]+)/i);
        let entry = builds.get(key);
        if (!entry) {
            entry = {
                buildId: idMatch?.[1] ?? null,
                org: orgMatch?.[1] ?? null,
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

// Reduce non-AzDO check runs into GitHub Actions workflow buckets, grouped by workflow name.
// Returns { workflows: [...], summary: { total, success, failure, inProgress, ... }, hasAny }.
function summarizeGhaRuns(runs) {
    const ghaRuns = runs.filter((r) => r?.detailsUrl && !AZDO_URL_RE.test(r.detailsUrl));
    if (ghaRuns.length === 0) {
        return { hasAny: false, workflows: [], summary: null };
    }
    // Group by workflow name (the part before the " / " separator in the check run name).
    const workflows = new Map();
    for (const r of ghaRuns) {
        const parts = r.name.split(" / ");
        const workflowName = parts.length > 1 ? parts[0] : r.name;
        let entry = workflows.get(workflowName);
        if (!entry) {
            // Derive workflow URL from detailsUrl (strip job-specific path segments)
            const workflowUrl = r.detailsUrl
                ? r.detailsUrl.replace(/\/job\/[^?#]*/, "")
                : null;
            entry = { name: workflowName, url: workflowUrl, runs: [] };
            workflows.set(workflowName, entry);
        }
        entry.runs.push({
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            detailsUrl: r.detailsUrl,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
        });
    }
    const summary = { total: 0, success: 0, failure: 0, inProgress: 0, other: 0 };
    for (const w of workflows.values()) {
        for (const r of w.runs) {
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
        workflows: [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name)),
        summary,
    };
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
    :root { color-scheme: light dark; }
    body { font: 14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; padding: 1rem; }
    header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
    h1 { margin: 0; font-size: 1.1rem; flex: 1; }
    .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); margin-bottom: 0.75rem; }
    .tab { padding: 0.35rem 0.75rem; cursor: pointer; border: none; background: none; color: inherit; font: inherit; border-bottom: 2px solid transparent; }
    .tab.active { border-bottom-color: #1f6feb; font-weight: 600; }
    .tab .count { color: #888; font-size: 0.8rem; margin-left: 0.25rem; }
    button.refresh { cursor: pointer; background: none; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); color: inherit; padding: 0.2rem 0.5rem; border-radius: 4px; font: inherit; font-size: 0.8rem; }
    .panel { display: none; }
    .panel.active { display: block; }
    ul.list { list-style: none; padding: 0; margin: 0; }
    li.row { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 6px; padding: 0.6rem 0.75rem; margin-bottom: 0.5rem; }
    .row-head { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; font-size: 0.85rem; }
    .row-title { font-weight: 600; margin-top: 0.25rem; }
    .row-meta { color: #888; font-size: 0.8rem; margin-top: 0.15rem; font-family: ui-monospace, Consolas, monospace; }
    .project, .repo, .badge { padding: 0.05rem 0.4rem; border-radius: 999px; font-size: 0.7rem; }
    .project { background: color-mix(in srgb, currentColor 8%, transparent); font-size: 0.75rem; }
    .repo { color: #888; font-family: ui-monospace, Consolas, monospace; font-size: 0.8rem; background: none; padding: 0; }
    .badge { text-transform: uppercase; letter-spacing: 0.03em; }
    .badge.pr      { background: rgba(46,160,67,0.2); color: #2ea043; }
    .badge.issue   { background: rgba(31,111,235,0.2); color: #1f6feb; }
    .badge.draft   { background: rgba(139,148,158,0.25); color: #8b949e; }
    .badge.session { background: rgba(210,153,34,0.2); color: #d29922; }
    .badge.closed  { background: rgba(248,81,73,0.2); color: #f85149; }
    .badge.merged  { background: rgba(163,113,247,0.2); color: #a371f7; }
    .badge.sync-up_to_date { background: rgba(46,160,67,0.15); color: #2ea043; }
    .badge.sync-behind     { background: rgba(210,153,34,0.2); color: #d29922; }
    .badge.sync-ahead      { background: rgba(31,111,235,0.2); color: #1f6feb; }
    .badge.sync-diverged   { background: rgba(248,81,73,0.2); color: #f85149; }
    .azdo { margin-top: 0.4rem; display: flex; flex-direction: column; gap: 0.25rem; }
    .azdo-build { display: flex; flex-direction: column; gap: 0.15rem; }
    .azdo-line { display: flex; gap: 0.4rem; align-items: center; font-size: 0.8rem; flex-wrap: wrap; }
    .azdo-line .label { color: #888; }
    .ci-dot { width: 0.65rem; height: 0.65rem; border-radius: 50%; display: inline-block; }
    .ci-dot.success     { background: #2ea043; }
    .ci-dot.failure     { background: #f85149; }
    .ci-dot.in_progress { background: #d29922; animation: pulse 1.6s ease-in-out infinite; }
    .ci-dot.other       { background: #8b949e; }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }
    .toggle { cursor: pointer; background: none; border: none; color: #1f6feb; font: inherit; font-size: 0.8rem; padding: 0; }
    .toggle:hover { text-decoration: underline; }
    details.azdo-jobs { margin-top: 0.2rem; }
    details.azdo-jobs summary { cursor: pointer; font-size: 0.75rem; color: #888; list-style: revert; }
    details.azdo-jobs ul { list-style: none; padding-left: 1rem; margin: 0.25rem 0 0; }
    details.azdo-jobs li { font-size: 0.75rem; font-family: ui-monospace, Consolas, monospace; padding: 0.1rem 0; display: flex; gap: 0.4rem; align-items: center; }
    a { color: #1f6feb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty, .error, .loading { color: #888; padding: 1rem; text-align: center; }
    .error { color: #f85149; text-align: left; white-space: pre-wrap; font-family: ui-monospace, Consolas, monospace; font-size: 0.8rem; }
    .footer { color: #888; font-size: 0.75rem; margin-top: 0.75rem; }
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
  <div class="footer" id="footer"></div>

  <script>
    const esc = (s) => s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    function renderCopilot(rows) {
      if (!rows.length) return '<div class="empty">No active Copilot sessions.</div>';
      return '<ul class="list">' + rows.map(s => {
        const isPr  = s.source_pr_number || s.created_pr_number;
        const isIss = !isPr && s.source_issue_number;
        const num   = s.source_pr_number ?? s.created_pr_number ?? s.source_issue_number;
        const url   = s.source_pr_html_url ?? s.created_pr_html_url ?? (s.issue_repo && s.source_issue_number ? \`https://github.com/\${s.issue_repo}/issues/\${s.source_issue_number}\` : null);
        const repo  = s.repo_full_name ?? s.created_pr_repo ?? s.issue_repo ?? '(unknown repo)';
        const title = s.source_pr_title ?? s.workspace_name ?? '(untitled)';
        const head  = s.source_pr_head_ref ? \`\${esc(s.source_pr_head_ref)} → \${esc(s.source_pr_base_ref ?? '')}\` : esc(s.branch ?? '');
        const author = s.source_pr_author_login ? \`by \${esc(s.source_pr_author_login)}\` : '';
        const typeBadge = isPr ? '<span class="badge pr">PR</span>' : isIss ? '<span class="badge issue">Issue</span>' : '';
        const stateBadge = s.source_pr_state ? \`<span class="badge \${esc(s.source_pr_state)}">\${esc(s.source_pr_state)}</span>\` : '';
        const syncBadge  = s.sync_state ? \`<span class="badge sync-\${esc(s.sync_state)}">\${esc(s.sync_state.replace(/_/g,' '))}</span>\` : '';
        const link = url ? \`<a href="\${esc(url)}" target="_blank" rel="noopener">#\${esc(num)}</a>\` : (num ? \`#\${esc(num)}\` : '');
        const project = s.project_name ? \`<span class="project">\${esc(s.project_name)}</span>\` : '';
        return \`<li class="row">
          <div class="row-head">\${project}<span class="repo">\${esc(repo)}</span>\${link}\${typeBadge}\${stateBadge}\${syncBadge}</div>
          <div class="row-title">\${esc(title)}</div>
          <div class="row-meta">\${head} \${author}</div>
          \${renderGha(s._gha)}
          \${renderAzdo(s._azdo)}
        </li>\`;
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
        s.failure     ? \`<span title="failed" style="color:#f85149">✕ \${s.failure}</span>\` : '',
        s.inProgress  ? \`<span title="in progress" style="color:#d29922">⟳ \${s.inProgress}</span>\` : '',
        s.other       ? \`<span title="other">· \${s.other}</span>\` : '',
      ].filter(Boolean).join(' ');
      const buildLines = azdo.builds.map(b => {
        const label = b.buildId
          ? \`<a href="\${esc(b.summaryUrl)}" target="_blank" rel="noopener">build \${esc(b.buildId)}</a>\${b.org ? \` <span class="label">(\${esc(b.org)})</span>\` : ''}\`
          : \`<a href="\${esc(b.summaryUrl)}" target="_blank" rel="noopener">\${esc(b.summaryUrl)}</a>\`;
        const jobs = b.runs.map(r => \`<li><span class="ci-dot \${runDotClass(r)}"></span><a href="\${esc(r.detailsUrl)}" target="_blank" rel="noopener">\${esc(r.name)}</a> <span class="label">\${esc(runStatusLabel(r))}</span></li>\`).join('');
        return \`<div class="azdo-build">
          <div class="azdo-line">\${label} <span class="label">· \${b.runs.length} job\${b.runs.length === 1 ? '' : 's'}</span></div>
          <details class="azdo-jobs"><summary>show jobs</summary><ul>\${jobs}</ul></details>
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
        s.failure     ? \`<span title="failed" style="color:#f85149">✕ \${s.failure}</span>\` : '',
        s.inProgress  ? \`<span title="in progress" style="color:#d29922">⟳ \${s.inProgress}</span>\` : '',
        s.other       ? \`<span title="other">· \${s.other}</span>\` : '',
      ].filter(Boolean).join(' ');
      const workflowLines = gha.workflows.map(w => {
        const label = w.url
          ? \`<a href="\${esc(w.url)}" target="_blank" rel="noopener">\${esc(w.name)}</a>\`
          : esc(w.name);
        const jobs = w.runs.map(r => \`<li><span class="ci-dot \${runDotClass(r)}"></span><a href="\${esc(r.detailsUrl)}" target="_blank" rel="noopener">\${esc(r.name)}</a> <span class="label">\${esc(runStatusLabel(r))}</span></li>\`).join('');
        return \`<div class="azdo-build">
          <div class="azdo-line">\${label} <span class="label">· \${w.runs.length} job\${w.runs.length === 1 ? '' : 's'}</span></div>
          <details class="azdo-jobs"><summary>show jobs</summary><ul>\${jobs}</ul></details>
        </div>\`;
      }).join('');
      return \`<div class="azdo">
        <div class="azdo-line">\${overallDot}<strong>GitHub Actions</strong> <span class="label">\${counts}</span></div>
        \${workflowLines}
      </div>\`;
    }

    function renderAll(prs, sessionKeys) {
      if (!prs.length) return '<div class="empty">No open PRs authored by you.</div>';
      return '<ul class="list">' + prs.map(p => {
        const repo = p.repository.nameWithOwner;
        const key  = (repo + '#' + p.number).toLowerCase();
        const hasSession = sessionKeys.has(key);
        const draft = p.isDraft ? '<span class="badge draft">draft</span>' : '';
        const session = hasSession ? '<span class="badge session" title="A Copilot session is open for this PR">in session</span>' : '';
        const updated = new Date(p.updatedAt).toLocaleString();
        return \`<li class="row">
          <div class="row-head"><span class="repo">\${esc(repo)}</span><a href="\${esc(p.url)}" target="_blank" rel="noopener">#\${esc(p.number)}</a>\${draft}\${session}</div>
          <div class="row-title">\${esc(p.title)}</div>
          <div class="row-meta">updated \${esc(updated)}</div>
          \${renderGha(p.gha)}
          \${renderAzdo(p.azdo)}
        </li>\`;
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
      // Cross-reference CI data from the checks cache
      const checksRes = await fetch('/api/prs-with-checks').then(r => r.json());
      lastChecks = checksRes.rows ?? [];
      const ciIndex = new Map();
      for (const p of lastChecks) {
        const key = (p.repository.nameWithOwner + '#' + p.number).toLowerCase();
        ciIndex.set(key, p);
      }
      // Attach CI data to each session row
      const enriched = res.rows.map(s => {
        const prNum = s.source_pr_number ?? s.created_pr_number;
        const repo = s.repo_full_name ?? s.created_pr_repo;
        const key = repo && prNum ? (repo + '#' + prNum).toLowerCase() : null;
        const ci = key ? ciIndex.get(key) : null;
        return { ...s, _gha: ci?.gha ?? null, _azdo: ci?.azdo ?? null };
      });
      document.getElementById('panel-copilot').innerHTML = renderCopilot(enriched);
      document.getElementById('copilot-count').textContent = ' (' + res.rows.length + ')';
    }

    async function loadAll(force=false) {
      const res = await fetch('/api/prs-with-checks' + (force ? '?force=1' : '')).then(r => r.json());
      const sessionKeys = new Set();
      for (const s of lastSessions) {
        if (s.repo_full_name && s.source_pr_number)  sessionKeys.add((s.repo_full_name + '#' + s.source_pr_number).toLowerCase());
        if (s.created_pr_repo && s.created_pr_number) sessionKeys.add((s.created_pr_repo + '#' + s.created_pr_number).toLowerCase());
      }
      const errorBanner = res.error ? \`<div class="error">\${esc(res.error)}</div>\` : '';
      document.getElementById('panel-all').innerHTML = errorBanner + renderAll(res.rows ?? [], sessionKeys);
      document.getElementById('all-count').textContent = res.rows ? ' (' + res.rows.length + ')' : '';
      const ageSec = res.cachedAt ? Math.round((Date.now() - res.cachedAt) / 1000) : null;
      document.getElementById('footer').textContent = ageSec != null ? \`PR + CI data \${ageSec}s old\` : '';
    }

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
                            ghaWorkflows: (checks.data ?? []).reduce((n, p) => n + (p.gha?.workflows?.length ?? 0), 0),
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
