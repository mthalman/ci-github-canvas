// Read-only access to the Copilot desktop app's local data.db and the live
// PR-state filtering layered on top.

import { DatabaseSync } from "node:sqlite";

import { DB_PATH, PR_LIVE_STATE_CACHE_TTL_MS, PR_LIVE_STATE_ERROR_CACHE_TTL_MS } from "./constants.mjs";
import { runGh } from "./github.mjs";
import { filterSessionsByRepo } from "./repo-filter.mjs";

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

// Per-PR live-state cache: "owner/name#num" (lower) -> { at, state, error }.
// State is GitHub's PullRequestState enum (OPEN / CLOSED / MERGED) or null
// if the lookup errored. Used to filter Copilot sessions whose local DB
// state lags behind GitHub.
const prLiveStateCache = new Map();

// Extract the set of (owner, name, number) PR refs a session is bound to.
// A session may track up to two PRs (source / created); both are checked
// when deciding whether to keep the row.
export function sessionPrRefs(row) {
    const refs = [];
    const seen = new Set();
    for (const [repoFull, num] of [
        [row.repo_full_name, row.source_pr_number],
        [row.created_pr_repo, row.created_pr_number],
    ]) {
        if (!repoFull || num == null) continue;
        const slash = repoFull.indexOf("/");
        if (slash <= 0 || slash === repoFull.length - 1) continue;
        const owner = repoFull.slice(0, slash);
        const name = repoFull.slice(slash + 1);
        const key = `${owner}/${name}#${num}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ owner, name, number: Number(num), key });
    }
    return refs;
}

// Fetch live PullRequest info (state, title, isDraft) for a set of PR refs in
// a single batched GraphQL call (using aliased fields). Returns a Map keyed
// by "owner/name#num" (lower) -> { state, title, isDraft, error }. Results
// are cached; only cache-misses (or expired entries) are queried.
//
// `state` drives session-row filtering (CLOSED/MERGED rows are hidden), while
// `title`/`isDraft` are surfaced in the Copilot tab so PRs not authored by
// @me (e.g. Copilot-agent-created PRs, which the CHECKS_QUERY misses) still
// show the real PR title instead of the local workspace name. `error` stays
// tied to `state` only — a row with a known state but a missing title is
// still a usable signal for filtering.
async function fetchLivePrInfo(refs) {
    const now = Date.now();
    const result = new Map();
    const toQuery = [];
    for (const ref of refs) {
        const cached = prLiveStateCache.get(ref.key);
        const ttl = cached?.error ? PR_LIVE_STATE_ERROR_CACHE_TTL_MS : PR_LIVE_STATE_CACHE_TTL_MS;
        if (cached && now - cached.at < ttl) {
            result.set(ref.key, cached);
        } else {
            toQuery.push(ref);
        }
    }
    if (toQuery.length === 0) return result;

    // Build one GraphQL query with aliased fields so all lookups go in a
    // single round-trip. JSON.stringify handles escaping for owner/name.
    const fields = toQuery
        .map(
            (ref, i) =>
                `  pr${i}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.name)}) { pullRequest(number: ${ref.number}) { state title isDraft } }`,
        )
        .join("\n");
    const query = `query {\n${fields}\n}`;

    const gqlResult = await runGh(["api", "graphql", "--field", `query=${query}`]);
    if (gqlResult.error) {
        // Cache the error per-ref so we don't spam gh on every poll.
        for (const ref of toQuery) {
            const entry = { at: now, state: null, title: null, isDraft: false, error: gqlResult.error };
            prLiveStateCache.set(ref.key, entry);
            result.set(ref.key, entry);
        }
        return result;
    }
    // GraphQL may return partial data with per-field errors (e.g. unknown
    // repo / SAML). We still want successful lookups to apply; missing fields
    // get a null state which the caller treats as "no signal".
    const data = gqlResult.data?.data ?? {};
    toQuery.forEach((ref, i) => {
        const pr = data?.[`pr${i}`]?.pullRequest;
        const state = pr?.state ?? null;
        const entry = {
            at: now,
            state,
            title: pr?.title ?? null,
            isDraft: pr?.isDraft ?? false,
            error: state ? null : "no data",
        };
        prLiveStateCache.set(ref.key, entry);
        result.set(ref.key, entry);
    });
    return result;
}

// Drop session rows whose every associated PR is CLOSED or MERGED according
// to live GitHub state. Rows whose PR can't be resolved (errors, missing
// data) are kept — we err toward showing rather than hiding stale state.
//
// Side effect: when a live title/isDraft are available, they're attached to
// the surviving rows as `_liveTitle` / `_liveDraft` so the renderer can show
// the real PR title (not the local workspace name) even for PRs not authored
// by @me. The source PR's title is preferred over the created PR's, matching
// the rest of the renderer's source-first display priority.
export async function filterSessionsByLivePrState(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const allRefs = [];
    const refsByRow = new Array(rows.length);
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
        const refs = sessionPrRefs(rows[i]);
        refsByRow[i] = refs;
        for (const ref of refs) {
            if (seen.has(ref.key)) continue;
            seen.add(ref.key);
            allRefs.push(ref);
        }
    }
    if (allRefs.length === 0) return rows;
    const states = await fetchLivePrInfo(allRefs);
    const kept = [];
    for (let i = 0; i < rows.length; i++) {
        const refs = refsByRow[i];
        // No PR refs — shouldn't happen given SQL filter, but keep defensively.
        if (!refs.length) { kept.push(rows[i]); continue; }
        let sawSignal = false;
        let isOpen = false;
        for (const ref of refs) {
            const entry = states.get(ref.key);
            if (!entry || entry.error) continue; // no usable signal for this ref
            sawSignal = true;
            if (entry.state === "OPEN") { isOpen = true; break; }
        }
        // Drop only if at least one PR returned a confirmed CLOSED/MERGED
        // signal AND no PR was OPEN. Otherwise keep (live lookup gave us no
        // useful data, fall back to local DB state).
        if (sawSignal && !isOpen) continue;
        // sessionPrRefs returns source PR first, created PR second; pick the
        // first ref that has a non-null live title/draft so the visible row
        // metadata matches the link/badge target in renderCopilot.
        let liveTitle = null;
        let liveDraft = false;
        for (const ref of refs) {
            const entry = states.get(ref.key);
            if (!entry) continue;
            if (liveTitle == null && entry.title) liveTitle = entry.title;
            if (entry.isDraft) liveDraft = true;
            if (liveTitle != null) break;
        }
        kept.push({ ...rows[i], _liveTitle: liveTitle, _liveDraft: liveDraft });
    }
    return kept;
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
export function fetchCopilotSessions() {
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
          -- Show the row only if at least one associated PR is still "active"
          -- (state is unknown / open / draft). PRs the Copilot app has synced
          -- as 'closed' or 'merged' shouldn't keep the session visible after
          -- the underlying work is done. State values in this DB are stored
          -- lowercase ('open', 'merged', 'closed'); LOWER() is defensive.
          AND (
                (w.source_pr_number  IS NOT NULL
                  AND (w.source_pr_state  IS NULL
                       OR LOWER(w.source_pr_state)  NOT IN ('closed','merged')))
             OR (w.created_pr_number IS NOT NULL
                  AND (w.created_pr_state IS NULL
                       OR LOWER(w.created_pr_state) NOT IN ('closed','merged')))
             OR (c.source_pr_number  IS NOT NULL
                  AND (c.source_pr_state  IS NULL
                       OR LOWER(c.source_pr_state)  NOT IN ('closed','merged')))
             OR (c.created_pr_number IS NOT NULL
                  AND (c.created_pr_state IS NULL
                       OR LOWER(c.created_pr_state) NOT IN ('closed','merged')))
          )
        ORDER BY datetime(w.updated_at) DESC
    `;
    try {
        // Apply the user's repo filter (include/exclude globs) before the
        // rows leave this function, so every caller — the canvas API and the
        // host-side notifier — sees the same filtered view.
        return filterSessionsByRepo(getDb().prepare(sql).all());
    } catch (err) {
        return { __error: err.message };
    }
}

// Build a quick lookup key for cross-referencing tab 2 against tab 1.
// Format: "<repo_full_name>#<pr_number>".
export function prKey(repo, number) {
    if (!repo || !number) return null;
    return `${repo.toLowerCase()}#${number}`;
}

export function buildSessionPrIndex(sessions) {
    const index = new Map();
    for (const s of sessions) {
        const k1 = prKey(s.repo_full_name, s.source_pr_number);
        const k2 = prKey(s.created_pr_repo, s.created_pr_number);
        if (k1) index.set(k1, s);
        if (k2) index.set(k2, s);
    }
    return index;
}
