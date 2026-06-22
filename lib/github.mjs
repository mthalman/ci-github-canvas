// GitHub data access: the `gh` CLI shells, the GraphQL queries, and the
// `agents/tasks` REST endpoint. All caches live here so the rest of the
// extension talks to GitHub through these fetcher functions only.

import { spawn } from "node:child_process";

import {
    CHECKS_CACHE_TTL_MS,
    GH_CACHE_TTL_MS,
    TASKS_CACHE_TTL_MS,
} from "./constants.mjs";
import { summarizeAzdoRuns } from "./azdo.mjs";
import { summarizeGhaRuns } from "./gha.mjs";
import { filterPrsByRepo } from "./repo-filter.mjs";

// Spawn the `gh` CLI with the given args and parse stdout as JSON. Returns
// either { data } on success or { error } on failure (non-zero exit, parse
// error, or process spawn failure). Used as the low-level building block for
// the higher-level fetcher functions below.
export function runGh(args) {
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

// Spawns `gh search prs --author=@me --state=open` and parses the JSON.
// Cached for GH_CACHE_TTL_MS to stay polite with the API.
let ghCache = { at: 0, value: null, error: null };
export async function fetchAuthoredPrs({ force = false } = {}) {
    const now = Date.now();
    if (!force && ghCache.value && now - ghCache.at < GH_CACHE_TTL_MS) {
        return { data: filterPrsByRepo(ghCache.value), cachedAt: ghCache.at, error: ghCache.error };
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
        return { data: filterPrsByRepo(ghCache.value ?? []), cachedAt: now, error: result.error };
    }
    ghCache = { at: now, value: result.data, error: null };
    return { data: filterPrsByRepo(result.data), cachedAt: now, error: null };
}

// Pull author's open PRs with their head-commit check runs in one GraphQL call.
// This is the source of truth for CI/pipeline status; the simpler search-prs
// path above is kept as a fast fallback if GraphQL fails (e.g. SAML).
export const CHECKS_QUERY = `
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
                  workflowRun { databaseId url workflow { name } }
                  checkRuns(first: 100) {
                    nodes { name status conclusion detailsUrl databaseId startedAt completedAt }
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

// Shape one PullRequest GraphQL node (with its head-commit check suites) into
// the flat row the renderer consumes: { number, title, ..., azdo, gha }. The
// same shape is produced by the author search (fetchPrsWithChecks) and the
// per-ref query (fetchChecksForRefs), so they share this helper. Returns null
// for an absent / malformed node (e.g. a GraphQL alias that errored).
export function shapePrChecksNode(pr) {
    if (!pr || !pr.number) return null;
    const commit = pr.commits?.nodes?.[0]?.commit;
    const allRuns = [];
    for (const suite of commit?.checkSuites?.nodes ?? []) {
        const wf = suite?.workflowRun;
        const workflowName = wf?.workflow?.name ?? null;
        const workflowUrl = wf?.url ?? null;
        const workflowRunId = wf?.databaseId ?? null;
        for (const run of suite?.checkRuns?.nodes ?? []) {
            allRuns.push(workflowName || workflowUrl || workflowRunId != null
                ? { ...run, workflowName, workflowUrl, workflowRunId }
                : run);
        }
    }
    return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        isDraft: pr.isDraft,
        state: pr.state,
        updatedAt: pr.updatedAt,
        repository: pr.repository,
        headSha: commit?.oid,
        azdo: summarizeAzdoRuns(allRuns, { prUrl: pr.url }),
        gha: summarizeGhaRuns(allRuns),
    };
}

let checksCache = { at: 0, value: null, error: null };
export async function fetchPrsWithChecks({ force = false } = {}) {
    const now = Date.now();
    if (!force && checksCache.value && now - checksCache.at < CHECKS_CACHE_TTL_MS) {
        return { data: filterPrsByRepo(checksCache.value), cachedAt: checksCache.at, error: checksCache.error };
    }
    const result = await runGh([
        "api", "graphql",
        "--field", `query=${CHECKS_QUERY}`,
    ]);
    if (result.error) {
        checksCache = { at: now, value: checksCache.value, error: result.error };
        return { data: filterPrsByRepo(checksCache.value ?? null), cachedAt: now, error: result.error };
    }
    // GraphQL may return partial data with non-fatal errors (e.g. SAML on `app`).
    // We ignore those because we never read `app`; we identify AzDO via URL.
    const prs = result.data?.data?.search?.nodes ?? [];
    const shaped = prs.map(shapePrChecksNode).filter(Boolean);
    checksCache = { at: now, value: shaped, error: null };
    return { data: filterPrsByRepo(shaped), cachedAt: now, error: null };
}

// Build a single batched GraphQL query that pulls head-commit check runs for an
// arbitrary set of PR refs ({ owner, name|repo, number }) via aliased
// `repository(owner,name){ pullRequest(number) }` fields — the same per-PR
// shape CHECKS_QUERY asks for, but addressed by ref instead of `author:@me`.
// JSON.stringify handles owner/name escaping.
export function buildChecksQueryForRefs(refs) {
    const fields = (refs ?? [])
        .map((ref, i) => {
            const name = ref.name ?? ref.repo;
            return `  pr${i}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(name)}) {\n    pullRequest(number: ${Number(ref.number)}) {\n      number title url isDraft state updatedAt\n      repository { nameWithOwner }\n      commits(last: 1) {\n        nodes {\n          commit {\n            oid\n            checkSuites(first: 30) {\n              nodes {\n                status conclusion\n                workflowRun { databaseId url workflow { name } }\n                checkRuns(first: 100) {\n                  nodes { name status conclusion detailsUrl databaseId startedAt completedAt }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }`;
        })
        .join("\n");
    return `query {\n${fields}\n}`;
}

// Fetch check runs for a specific set of PR refs (used by the Copilot tab to
// surface run trees for sessions whose PR isn't authored by @me, which the
// `author:@me` CHECKS_QUERY misses). Cached for CHECKS_CACHE_TTL_MS keyed by
// the exact ref set so toggling the panel doesn't re-spend the rate limit. NOT
// repo-filtered: the caller already restricts to (repo-filtered) session refs,
// and these are explicitly requested PRs.
let refChecksCache = { key: "", at: 0, value: null, error: null };
export async function fetchChecksForRefs(refs, { force = false } = {}) {
    const list = Array.isArray(refs) ? refs.filter((r) => r && r.owner && (r.name ?? r.repo) && r.number != null) : [];
    if (list.length === 0) {
        return { data: [], cachedAt: Date.now(), error: null };
    }
    // Cache identity = the sorted set of ref keys. Any change to which PRs are
    // requested invalidates the cache so we never serve a stale subset.
    const cacheKey = list
        .map((r) => `${r.owner}/${r.name ?? r.repo}#${r.number}`.toLowerCase())
        .sort()
        .join(",");
    const now = Date.now();
    if (!force && refChecksCache.value && refChecksCache.key === cacheKey && now - refChecksCache.at < CHECKS_CACHE_TTL_MS) {
        return { data: refChecksCache.value, cachedAt: refChecksCache.at, error: refChecksCache.error };
    }
    const query = buildChecksQueryForRefs(list);
    const result = await runGh(["api", "graphql", "--field", `query=${query}`]);
    if (result.error) {
        // Keep any prior value for this same ref set; otherwise report empty.
        const keep = refChecksCache.key === cacheKey ? refChecksCache.value : null;
        refChecksCache = { key: cacheKey, at: now, value: keep, error: result.error };
        return { data: keep ?? [], cachedAt: now, error: result.error };
    }
    const data = result.data?.data ?? {};
    const shaped = list
        .map((_, i) => shapePrChecksNode(data?.[`pr${i}`]?.pullRequest))
        .filter(Boolean);
    refChecksCache = { key: cacheKey, at: now, value: shaped, error: null };
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
export async function fetchAgentTasks({ force = false } = {}) {
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
