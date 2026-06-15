// Manually watched PRs: a user-curated list of GitHub PR URLs whose CI
// runs should appear in the canvas alongside the user's authored PRs.
// Persisted as JSON under <artifacts>/watched-prs.json; fetched in a single
// batched GraphQL call (aliased fields, similar to sessions.fetchLivePrInfo)
// and shaped identically to fetchPrsWithChecks so the renderer can reuse
// the same row template.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { summarizeAzdoRuns } from "./azdo.mjs";
import {
    ARTIFACTS_DIR,
    CHECKS_CACHE_TTL_MS,
} from "./constants.mjs";
import { summarizeGhaRuns } from "./gha.mjs";
import { runGh } from "./github.mjs";

export const WATCHED_LIST_PATH = join(ARTIFACTS_DIR, "watched-prs.json");
export const MAX_WATCHED = 100;

// Test seam: lets watched.test.mjs redirect persistence at a tmp dir without
// touching the user's real artifacts folder. Defaults to WATCHED_LIST_PATH /
// ARTIFACTS_DIR; restored by __resetWatchedCacheForTests().
let listPath = WATCHED_LIST_PATH;
let listDir = ARTIFACTS_DIR;

// Accept https://github.com/<owner>/<repo>/pull/<number> with optional
// trailing path (/files, /commits/<sha>, etc.), query string, or fragment.
// Owner / repo follow GitHub's allowed character set (alphanumerics, dash,
// underscore, dot). Returns the canonical "https://github.com/o/r/pull/N"
// URL so the persisted entry is normalized regardless of what the user
// pasted.
export function parseGitHubPrUrl(input) {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    let u;
    try { u = new URL(trimmed); } catch { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.hostname.toLowerCase() !== "github.com") return null;
    const segments = u.pathname.split("/").filter(Boolean);
    // Expect at least: <owner>/<repo>/pull/<number>
    if (segments.length < 4) return null;
    const [owner, repo, kind, numberRaw] = segments;
    if (kind !== "pull") return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
    if (!/^\d{1,10}$/.test(numberRaw)) return null;
    const number = Number(numberRaw);
    if (!Number.isFinite(number) || number <= 0) return null;
    const key = `${owner}/${repo}#${number}`.toLowerCase();
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;
    return { owner, repo, number, url, key };
}

export function watchedKey(owner, repo, number) {
    return `${owner}/${repo}#${number}`.toLowerCase();
}

// Sanitize a raw on-disk list: drop entries that don't parse, drop dupes
// (keeping the first occurrence), enforce MAX_WATCHED. The resulting items
// have a stable shape { owner, repo, number, url, key, addedAt }.
export function sanitizeWatchedList(raw) {
    const arr = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    for (const entry of arr) {
        if (!entry) continue;
        const parsed = parseGitHubPrUrl(entry.url);
        if (!parsed) continue;
        if (seen.has(parsed.key)) continue;
        seen.add(parsed.key);
        const addedAt = typeof entry.addedAt === "string" ? entry.addedAt : new Date(0).toISOString();
        out.push({ ...parsed, addedAt });
        if (out.length >= MAX_WATCHED) break;
    }
    return out;
}

// In-process cache of the on-disk list. Reads are lazy; writes update both
// disk and this in-memory copy under a serialized lock so concurrent
// POST/DELETE requests don't race.
let watchedCache = null;
let writeLock = Promise.resolve();

export async function loadWatchedList({ force = false } = {}) {
    if (watchedCache && !force) return watchedCache;
    try {
        const text = await readFile(listPath, "utf8");
        const parsed = JSON.parse(text);
        watchedCache = sanitizeWatchedList(parsed);
    } catch (err) {
        if (err?.code !== "ENOENT") {
            console.error("ci-runs: failed to load watched list", err);
        }
        watchedCache = [];
    }
    return watchedCache;
}

async function persistWatchedList(items) {
    await mkdir(listDir, { recursive: true });
    await writeFile(listPath, JSON.stringify({ items }, null, 2), "utf8");
    watchedCache = items;
    // Invalidate the checks cache so the next GET picks up the new list.
    invalidateChecksCache();
    return items;
}

export async function addWatchedPr(url) {
    const parsed = parseGitHubPrUrl(url);
    if (!parsed) return { error: "Not a valid GitHub PR URL." };
    const result = (writeLock = writeLock.then(async () => {
        const items = await loadWatchedList();
        if (items.some((i) => i.key === parsed.key)) {
            return { error: "Already watched.", item: items.find((i) => i.key === parsed.key), items };
        }
        if (items.length >= MAX_WATCHED) {
            return { error: `Watched list is full (max ${MAX_WATCHED}).`, items };
        }
        const item = { ...parsed, addedAt: new Date().toISOString() };
        const next = [...items, item];
        await persistWatchedList(next);
        return { item, items: next };
    }));
    return result;
}

export async function removeWatchedPr(key) {
    if (typeof key !== "string" || !key) return { error: "Missing key." };
    const lower = key.toLowerCase();
    const result = (writeLock = writeLock.then(async () => {
        const items = await loadWatchedList();
        const next = items.filter((i) => i.key !== lower);
        if (next.length === items.length) return { removed: false, items };
        await persistWatchedList(next);
        return { removed: true, items: next };
    }));
    return result;
}

// Shape that mirrors CHECKS_QUERY's per-PR fields. Built dynamically so the
// query only asks for the PRs currently in the watched list.
function buildWatchedChecksQuery(items) {
    const fields = items
        .map(
            (it, i) =>
                `  pr${i}: repository(owner: ${JSON.stringify(it.owner)}, name: ${JSON.stringify(it.repo)}) {\n    pullRequest(number: ${it.number}) {\n      number title url isDraft state updatedAt\n      repository { nameWithOwner }\n      commits(last: 1) {\n        nodes {\n          commit {\n            oid\n            checkSuites(first: 30) {\n              nodes {\n                status conclusion\n                checkRuns(first: 100) {\n                  nodes { name status conclusion detailsUrl startedAt completedAt }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }`,
        )
        .join("\n");
    return `query {\n${fields}\n}`;
}

function shapePrNode(pr) {
    if (!pr || !pr.number) return null;
    const commit = pr.commits?.nodes?.[0]?.commit;
    const allRuns = [];
    for (const suite of commit?.checkSuites?.nodes ?? []) {
        for (const run of suite?.checkRuns?.nodes ?? []) allRuns.push(run);
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
        azdo: summarizeAzdoRuns(allRuns),
        gha: summarizeGhaRuns(allRuns),
    };
}

let checksCache = { at: 0, value: null, error: null };
function invalidateChecksCache() {
    checksCache = { at: 0, value: null, error: null };
}

export async function fetchWatchedPrsWithChecks({ force = false } = {}) {
    const items = await loadWatchedList();
    if (items.length === 0) {
        return { data: [], cachedAt: Date.now(), error: null };
    }
    const now = Date.now();
    if (!force && checksCache.value && now - checksCache.at < CHECKS_CACHE_TTL_MS) {
        return { data: checksCache.value, cachedAt: checksCache.at, error: checksCache.error };
    }
    const query = buildWatchedChecksQuery(items);
    const result = await runGh(["api", "graphql", "--field", `query=${query}`]);
    if (result.error) {
        checksCache = { at: now, value: checksCache.value, error: result.error };
        return { data: checksCache.value ?? [], cachedAt: now, error: result.error };
    }
    const data = result.data?.data ?? {};
    const shaped = items
        .map((_, i) => shapePrNode(data?.[`pr${i}`]?.pullRequest))
        .filter(Boolean);
    checksCache = { at: now, value: shaped, error: null };
    return { data: shaped, cachedAt: now, error: null };
}

// Test seam: lets unit tests redirect persistence to a tmp file without
// poking at module internals.
export function __resetWatchedCacheForTests({ path, dir } = {}) {
    watchedCache = null;
    invalidateChecksCache();
    writeLock = Promise.resolve();
    listPath = path ?? WATCHED_LIST_PATH;
    listDir = dir ?? ARTIFACTS_DIR;
}
