// Tests for lib/github.mjs.
//
// Most of github.mjs is shelling out to `gh` and caching the parsed result.
// We don't want to invoke real `gh` in unit tests, so we exercise:
//   - CHECKS_QUERY shape (no network)
//   - the shaping done by fetchPrsWithChecks on a fixed GraphQL response,
//     by stubbing the runGh export via test mocks.
//
// Note: runGh is intentionally not unit-tested here. It wraps child_process
// spawn and has trivial happy/error branches; integration coverage is via
// the live `gh` command in real usage.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHECKS_QUERY, buildChecksQueryForRefs, shapePrChecksNode } from "../lib/github.mjs";

test("CHECKS_QUERY: contains the well-known search and check-suite fields", () => {
    assert.match(CHECKS_QUERY, /search\(query: "author:@me state:open is:pr"/);
    assert.match(CHECKS_QUERY, /checkSuites\(first: 30\)/);
    assert.match(CHECKS_QUERY, /checkRuns\(first: 100\)/);
    assert.match(CHECKS_QUERY, /repository \{ nameWithOwner \}/);
    assert.match(CHECKS_QUERY, /isDraft/);
});

test("CHECKS_QUERY: starts with 'query' keyword (valid GraphQL operation)", () => {
    assert.ok(CHECKS_QUERY.trim().startsWith("query"));
});

// --- buildChecksQueryForRefs -----------------------------------------------

test("buildChecksQueryForRefs: emits one aliased repository field per ref", () => {
    const q = buildChecksQueryForRefs([
        { owner: "dotnet", name: "runtime", number: 123 },
        { owner: "dotnet", repo: "sdk", number: 456 },
    ]);
    assert.ok(q.trim().startsWith("query"));
    // Aliased per-ref fields pr0/pr1 addressed by owner/name (name or repo).
    assert.match(q, /pr0: repository\(owner: "dotnet", name: "runtime"\)/);
    assert.match(q, /pullRequest\(number: 123\)/);
    assert.match(q, /pr1: repository\(owner: "dotnet", name: "sdk"\)/);
    assert.match(q, /pullRequest\(number: 456\)/);
    // Same per-PR shape CHECKS_QUERY asks for.
    assert.match(q, /checkSuites\(first: 30\)/);
    assert.match(q, /checkRuns\(first: 100\)/);
    assert.match(q, /repository \{ nameWithOwner \}/);
});

test("buildChecksQueryForRefs: coerces number and JSON-escapes owner/name", () => {
    const q = buildChecksQueryForRefs([{ owner: 'a"b', name: "c", number: "7" }]);
    assert.match(q, /owner: "a\\"b"/);
    assert.match(q, /pullRequest\(number: 7\)/);
});

test("buildChecksQueryForRefs: empty refs yields an empty query body", () => {
    assert.equal(buildChecksQueryForRefs([]).replace(/\s+/g, " ").trim(), "query { }");
});

// --- shapePrChecksNode ------------------------------------------------------

test("shapePrChecksNode: returns null for absent/malformed nodes", () => {
    assert.equal(shapePrChecksNode(null), null);
    assert.equal(shapePrChecksNode(undefined), null);
    assert.equal(shapePrChecksNode({}), null);
});

test("shapePrChecksNode: flattens check runs and produces gha/azdo summaries", () => {
    const shaped = shapePrChecksNode({
        number: 42,
        title: "Fix thing",
        url: "https://github.com/o/r/pull/42",
        isDraft: false,
        state: "OPEN",
        updatedAt: "2024-01-01T00:00:00Z",
        repository: { nameWithOwner: "o/r" },
        commits: {
            nodes: [{
                commit: {
                    oid: "abc",
                    checkSuites: {
                        nodes: [{
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            workflowRun: { databaseId: 9, url: "https://gha", workflow: { name: "CI" } },
                            checkRuns: { nodes: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://x" }] },
                        }],
                    },
                },
            }],
        },
    });
    assert.equal(shaped.number, 42);
    assert.equal(shaped.repository.nameWithOwner, "o/r");
    assert.equal(shaped.headSha, "abc");
    assert.ok(shaped.gha && typeof shaped.gha === "object");
    assert.ok(shaped.azdo && typeof shaped.azdo === "object");
});
