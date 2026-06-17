// Tests for lib/repo-filter.mjs (all pure / in-memory — no disk or network).
//
// Disk persistence (initRepoFilterConfig / saveRepoFilterConfig) writes to a
// fixed REPO_FILTER_CONFIG_PATH that can't be redirected without editing the
// module, so — mirroring test/notify.test.mjs — we cover the same surface
// area through sanitizeRepoFilterConfig and the matching helpers instead.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    globToRegExp,
    matchesAnyGlob,
    splitPatterns,
    sanitizeRepoFilterConfig,
    repoMatchesFilter,
    filterPrsByRepo,
    filterSessionsByRepo,
    MAX_REPO_FILTER_PATTERNS,
} from "../lib/repo-filter.mjs";

// --- globToRegExp ----------------------------------------------------------

test("globToRegExp: '*' matches any run of characters including '/'", () => {
    assert.ok(globToRegExp("*").test("owner/repo"));
    assert.ok(globToRegExp("owner/*").test("owner/repo"));
    assert.ok(globToRegExp("owner/*").test("owner/"));
    assert.ok(globToRegExp("*/repo").test("any-owner/repo"));
    assert.ok(globToRegExp("owner/r*").test("owner/runtime"));
    assert.ok(!globToRegExp("owner/*").test("other/repo"));
});

test("globToRegExp: '?' matches exactly one character", () => {
    assert.ok(globToRegExp("owner/rep?").test("owner/repo"));
    assert.ok(!globToRegExp("owner/rep?").test("owner/rep"));
    assert.ok(!globToRegExp("owner/rep?").test("owner/repos"));
});

test("globToRegExp: matching is case-insensitive", () => {
    assert.ok(globToRegExp("Owner/Repo").test("owner/repo"));
    assert.ok(globToRegExp("owner/*").test("OWNER/REPO"));
});

test("globToRegExp: regex metacharacters are matched literally", () => {
    assert.ok(globToRegExp("owner/repo.js").test("owner/repo.js"));
    assert.ok(!globToRegExp("owner/repo.js").test("owner/repoxjs"));
    assert.ok(globToRegExp("owner/a+b").test("owner/a+b"));
    assert.ok(globToRegExp("owner/(x)").test("owner/(x)"));
});

test("globToRegExp: is anchored (no partial matches)", () => {
    assert.ok(!globToRegExp("owner/repo").test("xowner/repoy"));
    assert.ok(!globToRegExp("repo").test("owner/repo"));
});

// --- matchesAnyGlob --------------------------------------------------------

test("matchesAnyGlob: true if any pattern matches, false otherwise", () => {
    assert.ok(matchesAnyGlob("owner/repo", ["foo/*", "owner/*"]));
    assert.ok(!matchesAnyGlob("owner/repo", ["foo/*", "bar/*"]));
    assert.ok(!matchesAnyGlob("owner/repo", []));
    assert.ok(!matchesAnyGlob("", ["*"]));
    assert.ok(!matchesAnyGlob(null, ["*"]));
});

// --- splitPatterns ---------------------------------------------------------

test("splitPatterns: bare patterns are includes, '!'-prefixed are excludes", () => {
    assert.deepEqual(
        splitPatterns(["my-org/*", "!my-org/legacy-*", "foo/bar"]),
        { include: ["my-org/*", "foo/bar"], exclude: ["my-org/legacy-*"] },
    );
});

test("splitPatterns: trims whitespace around the pattern and after '!'", () => {
    assert.deepEqual(
        splitPatterns(["  my-org/*  ", "!  my-org/legacy-*  "]),
        { include: ["my-org/*"], exclude: ["my-org/legacy-*"] },
    );
});

test("splitPatterns: drops empties, bare '!' and non-strings", () => {
    assert.deepEqual(
        splitPatterns(["", "   ", "!", "!   ", 42, null, "ok/x"]),
        { include: ["ok/x"], exclude: [] },
    );
});

// --- sanitizeRepoFilterConfig ----------------------------------------------

test("sanitizeRepoFilterConfig: defaults to an empty pattern list", () => {
    const empty = { patterns: [] };
    assert.deepEqual(sanitizeRepoFilterConfig(undefined), empty);
    assert.deepEqual(sanitizeRepoFilterConfig(null), empty);
    assert.deepEqual(sanitizeRepoFilterConfig("nope"), empty);
    assert.deepEqual(sanitizeRepoFilterConfig({}), empty);
});

test("sanitizeRepoFilterConfig: trims, drops empties and non-strings", () => {
    assert.deepEqual(
        sanitizeRepoFilterConfig({
            patterns: ["  my-org/* ", "", "   ", 42, null, "!foo/bar"],
        }),
        { patterns: ["my-org/*", "!foo/bar"] },
    );
});

test("sanitizeRepoFilterConfig: dedupes case-insensitively, keeps first casing", () => {
    assert.deepEqual(
        sanitizeRepoFilterConfig({ patterns: ["Owner/Repo", "owner/repo", "OWNER/REPO"] }),
        { patterns: ["Owner/Repo"] },
    );
});

test("sanitizeRepoFilterConfig: ignores a non-array patterns field", () => {
    assert.deepEqual(
        sanitizeRepoFilterConfig({ patterns: "my-org/*" }),
        { patterns: [] },
    );
});

test("sanitizeRepoFilterConfig: migrates legacy { include, exclude } shape", () => {
    assert.deepEqual(
        sanitizeRepoFilterConfig({ include: ["my-org/*"], exclude: ["my-org/legacy-*"] }),
        { patterns: ["my-org/*", "!my-org/legacy-*"] },
    );
});

test("sanitizeRepoFilterConfig: caps the list at MAX_REPO_FILTER_PATTERNS", () => {
    const many = Array.from({ length: MAX_REPO_FILTER_PATTERNS + 50 }, (_, i) => `o/r${i}`);
    const out = sanitizeRepoFilterConfig({ patterns: many });
    assert.equal(out.patterns.length, MAX_REPO_FILTER_PATTERNS);
});

// --- repoMatchesFilter -----------------------------------------------------

test("repoMatchesFilter: empty config includes everything", () => {
    assert.ok(repoMatchesFilter("owner/repo", { patterns: [] }));
});

test("repoMatchesFilter: bare patterns act as an allowlist", () => {
    const cfg = { patterns: ["my-org/*"] };
    assert.ok(repoMatchesFilter("my-org/api", cfg));
    assert.ok(!repoMatchesFilter("other/api", cfg));
});

test("repoMatchesFilter: '!' patterns exclude; exclude wins over include", () => {
    const cfg = { patterns: ["my-org/*", "!my-org/legacy-*"] };
    assert.ok(repoMatchesFilter("my-org/api", cfg));
    assert.ok(!repoMatchesFilter("my-org/legacy-svc", cfg));
});

test("repoMatchesFilter: exclude-only config still includes unmatched repos", () => {
    const cfg = { patterns: ["!my-org/legacy-*"] };
    assert.ok(repoMatchesFilter("my-org/api", cfg));
    assert.ok(!repoMatchesFilter("my-org/legacy-svc", cfg));
});

test("repoMatchesFilter: missing / non-string repo defaults to included", () => {
    const cfg = { patterns: ["my-org/*"] };
    assert.ok(repoMatchesFilter(null, cfg));
    assert.ok(repoMatchesFilter(undefined, cfg));
    assert.ok(repoMatchesFilter("", cfg));
});

// --- filterPrsByRepo -------------------------------------------------------

test("filterPrsByRepo: keeps only PRs whose repo passes the filter", () => {
    const prs = [
        { number: 1, repository: { nameWithOwner: "my-org/api" } },
        { number: 2, repository: { nameWithOwner: "other/api" } },
        { number: 3, repository: { nameWithOwner: "my-org/legacy-svc" } },
        { number: 4 }, // no repository — kept
    ];
    const cfg = { patterns: ["my-org/*", "!my-org/legacy-*"] };
    const out = filterPrsByRepo(prs, cfg);
    assert.deepEqual(out.map((p) => p.number), [1, 4]);
});

test("filterPrsByRepo: passes through non-arrays unchanged", () => {
    assert.equal(filterPrsByRepo(null, { patterns: [] }), null);
    assert.equal(filterPrsByRepo(undefined, { patterns: ["x"] }), undefined);
});

// --- filterSessionsByRepo --------------------------------------------------

test("filterSessionsByRepo: keeps a row if either source or created repo passes", () => {
    const rows = [
        { workspace_id: "a", repo_full_name: "my-org/api" },
        { workspace_id: "b", repo_full_name: "other/api" },
        // source filtered out, but created PR repo is included -> kept
        { workspace_id: "c", repo_full_name: "other/api", created_pr_repo: "my-org/tool" },
        { workspace_id: "d" }, // no repo -> kept
    ];
    const cfg = { patterns: ["my-org/*"] };
    const out = filterSessionsByRepo(rows, cfg);
    assert.deepEqual(out.map((r) => r.workspace_id), ["a", "c", "d"]);
});

test("filterSessionsByRepo: exclude drops a row even if included elsewhere", () => {
    const rows = [{ workspace_id: "a", repo_full_name: "my-org/legacy-svc" }];
    const cfg = { patterns: ["my-org/*", "!*/legacy-*"] };
    assert.deepEqual(filterSessionsByRepo(rows, cfg), []);
});

test("filterSessionsByRepo: passes through non-arrays unchanged", () => {
    const err = { __error: "boom" };
    assert.equal(filterSessionsByRepo(err, { patterns: [] }), err);
});
