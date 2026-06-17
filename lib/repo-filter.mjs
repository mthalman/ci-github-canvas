// Repo filter config.
//
// Lets the user narrow which repositories are queried for PR CI status using
// a single list of glob patterns. Applies to the user's authored PRs (both
// the search and the checks query) and to the Copilot sessions tab. It
// intentionally does NOT apply to the Watched tab — that list is an explicit,
// user-curated allowlist of individual PRs and should never be silently
// hidden by a repo filter.
//
// Pattern syntax (gitignore-style, case-insensitive — GitHub repo names are
// effectively case-insensitive):
//   - A glob `*` matches any run of characters (including `/` and empty).
//   - A glob `?` matches exactly one character.
//   - Everything else is matched literally.
//   - A leading `!` marks the pattern as an EXCLUSION; without it, the
//     pattern is an inclusion. (Repo names can't start with `!`, so the
//     prefix is unambiguous.)
//   - A repo is INCLUDED iff:
//       (there are no inclusion patterns OR the repo matches at least one)
//       AND the repo matches NO exclusion pattern.
//     Exclusion therefore always wins over inclusion.
//
// Defaults are an empty pattern list, i.e. "no filtering" — every repo is
// queried, preserving the pre-filter behavior.
//
// The on-disk config lives at <artifacts>/repo-filter.json and is mirrored
// into the live `repoFilterConfig` binding so the synchronous fetch helpers
// in github.mjs / sessions.mjs can read it without awaiting a disk read.

import { readFile, writeFile, mkdir } from "node:fs/promises";

import { ARTIFACTS_DIR, REPO_FILTER_CONFIG_PATH } from "./constants.mjs";

// Hard cap on the number of patterns, so a corrupt or hostile config file
// can't make matching pathologically slow.
export const MAX_REPO_FILTER_PATTERNS = 400;

// In-memory mirror of the on-disk config. Loaded eagerly at startup via
// initRepoFilterConfig(); POST /api/repo-filter updates both this and the
// JSON file through saveRepoFilterConfig().
//
// Exported as a live `let` binding so the fetch helpers can read the current
// value directly. Only saveRepoFilterConfig() / initRepoFilterConfig() in
// this module ever reassign it.
export let repoFilterConfig = { patterns: [] };

// Normalize one raw pattern list: keep only non-empty trimmed strings, dedupe
// case-insensitively (preserving the first-seen casing), and cap the length.
function sanitizePatternList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of raw) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
        if (out.length >= MAX_REPO_FILTER_PATTERNS) break;
    }
    return out;
}

export function sanitizeRepoFilterConfig(raw) {
    if (!raw || typeof raw !== "object") return { patterns: [] };
    let list = raw.patterns;
    if (!Array.isArray(list)) {
        // Migrate the older { include, exclude } shape: inclusions pass
        // through verbatim, exclusions gain the `!` prefix.
        const include = Array.isArray(raw.include) ? raw.include : [];
        const exclude = Array.isArray(raw.exclude) ? raw.exclude : [];
        list = [
            ...include,
            ...exclude.map((p) => (typeof p === "string" ? `!${p}` : p)),
        ];
    }
    return { patterns: sanitizePatternList(list) };
}

// Split a flat pattern list into inclusion and exclusion buckets. A leading
// `!` (after trimming) marks an exclusion; the remainder is the glob. Empty
// globs (e.g. a bare "!") are dropped.
export function splitPatterns(patterns) {
    const include = [];
    const exclude = [];
    for (const raw of patterns ?? []) {
        if (typeof raw !== "string") continue;
        const p = raw.trim();
        if (!p) continue;
        if (p.startsWith("!")) {
            const body = p.slice(1).trim();
            if (body) exclude.push(body);
        } else {
            include.push(p);
        }
    }
    return { include, exclude };
}

// Translate a glob pattern into an anchored, case-insensitive RegExp where
// `*` => `.*` and `?` => `.` and every other character is escaped literally.
export function globToRegExp(pattern) {
    let body = "";
    for (const ch of String(pattern)) {
        if (ch === "*") body += ".*";
        else if (ch === "?") body += ".";
        else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${body}$`, "i");
}

// True if `repo` matches any pattern in `patterns`.
export function matchesAnyGlob(repo, patterns) {
    if (typeof repo !== "string" || !repo) return false;
    for (const pattern of patterns ?? []) {
        if (globToRegExp(pattern).test(repo)) return true;
    }
    return false;
}

// Decide whether a single repo (e.g. "owner/name") passes the filter.
// Missing / non-string repos default to included — we'd rather show a row we
// can't classify than silently drop it.
export function repoMatchesFilter(repo, config = repoFilterConfig) {
    const { include, exclude } = splitPatterns(config?.patterns ?? []);
    if (typeof repo !== "string" || !repo) return true;
    if (include.length > 0 && !matchesAnyGlob(repo, include)) return false;
    if (matchesAnyGlob(repo, exclude)) return false;
    return true;
}

// Filter an array of PR-shaped objects (anything with
// `repository.nameWithOwner`) against the active config. Objects whose repo
// can't be resolved are kept.
export function filterPrsByRepo(prs, config = repoFilterConfig) {
    if (!Array.isArray(prs)) return prs;
    return prs.filter((p) => repoMatchesFilter(p?.repository?.nameWithOwner, config));
}

// Filter Copilot session rows. A session may carry a source repo and/or a
// created-PR repo; keep the row if EITHER repo passes the filter (so a
// session whose source repo is filtered out but whose created PR lives in an
// included repo still shows). Rows with no resolvable repo are kept.
export function filterSessionsByRepo(rows, config = repoFilterConfig) {
    if (!Array.isArray(rows)) return rows;
    return rows.filter((row) => {
        const repos = [row?.repo_full_name, row?.created_pr_repo].filter(
            (r) => typeof r === "string" && r,
        );
        if (repos.length === 0) return true;
        return repos.some((r) => repoMatchesFilter(r, config));
    });
}

export async function initRepoFilterConfig() {
    try {
        const text = await readFile(REPO_FILTER_CONFIG_PATH, "utf8");
        repoFilterConfig = sanitizeRepoFilterConfig(JSON.parse(text));
    } catch (err) {
        // ENOENT just means the user has never saved a config yet — fall
        // through to the empty defaults. Other errors (corrupt JSON, perms)
        // are logged but don't block startup.
        if (err?.code !== "ENOENT") {
            console.error("ci-runs: failed to load repo filter config", err);
        }
    }
    return repoFilterConfig;
}

export async function saveRepoFilterConfig(next) {
    repoFilterConfig = sanitizeRepoFilterConfig(next);
    try {
        // The artifacts dir doesn't exist on a fresh install; the first save
        // is what creates it.
        await mkdir(ARTIFACTS_DIR, { recursive: true });
        await writeFile(REPO_FILTER_CONFIG_PATH, JSON.stringify(repoFilterConfig, null, 2), "utf8");
    } catch (err) {
        console.error("ci-runs: failed to persist repo filter config", err);
    }
    return repoFilterConfig;
}

// Test seam: reset the live binding without touching disk.
export function __setRepoFilterConfigForTests(config) {
    repoFilterConfig = sanitizeRepoFilterConfig(config);
    return repoFilterConfig;
}
