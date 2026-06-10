// Tests for lib/sessions.mjs pure helpers. filterSessionsByLivePrState is
// covered with `globalThis.fetch` stubbed indirectly via runGh's spawn (too
// fiddly to mock cleanly here without mock.module), so we keep these focused
// on pure transforms and the empty-input branch of filterSessionsByLivePrState.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    sessionPrRefs,
    prKey,
    buildSessionPrIndex,
    filterSessionsByLivePrState,
} from "../lib/sessions.mjs";

test("sessionPrRefs: extracts source and created PRs as separate refs", () => {
    const got = sessionPrRefs({
        repo_full_name: "Foo/Bar",
        source_pr_number: 1,
        created_pr_repo: "Foo/Bar",
        created_pr_number: 2,
    });
    assert.equal(got.length, 2);
    assert.deepEqual(got[0], { owner: "Foo", name: "Bar", number: 1, key: "foo/bar#1" });
    assert.deepEqual(got[1], { owner: "Foo", name: "Bar", number: 2, key: "foo/bar#2" });
});

test("sessionPrRefs: dedupes when source and created point at same PR", () => {
    const got = sessionPrRefs({
        repo_full_name: "foo/bar",
        source_pr_number: 5,
        created_pr_repo: "FOO/BAR",
        created_pr_number: 5,
    });
    assert.equal(got.length, 1);
    assert.equal(got[0].key, "foo/bar#5");
});

test("sessionPrRefs: skips refs missing repo or number", () => {
    assert.deepEqual(sessionPrRefs({}), []);
    assert.deepEqual(sessionPrRefs({ repo_full_name: "o/r" }), []);
    assert.deepEqual(sessionPrRefs({ source_pr_number: 7 }), []);
    assert.deepEqual(sessionPrRefs({
        repo_full_name: "o/r",
        source_pr_number: 1,
    }).map((r) => r.key), ["o/r#1"]);
});

test("sessionPrRefs: rejects malformed repo_full_name", () => {
    assert.deepEqual(sessionPrRefs({ repo_full_name: "nopath", source_pr_number: 1 }), []);
    assert.deepEqual(sessionPrRefs({ repo_full_name: "/r", source_pr_number: 1 }), []);
    assert.deepEqual(sessionPrRefs({ repo_full_name: "o/", source_pr_number: 1 }), []);
});

test("sessionPrRefs: source_pr_number 0 is allowed (number coercion)", () => {
    // Defensive: source_pr_number == null check is `== null`, so 0 should pass.
    const got = sessionPrRefs({ repo_full_name: "o/r", source_pr_number: 0 });
    assert.equal(got.length, 1);
    assert.equal(got[0].number, 0);
});

test("prKey: lowercases repo, requires both args", () => {
    assert.equal(prKey("Foo/Bar", 42), "foo/bar#42");
    assert.equal(prKey(null, 1), null);
    assert.equal(prKey("o/r", null), null);
    assert.equal(prKey("o/r", 0), null); // 0 is falsy → null per impl
});

test("buildSessionPrIndex: indexes by both source and created keys", () => {
    const sessions = [
        { repo_full_name: "o/r1", source_pr_number: 1, created_pr_repo: "o/r1", created_pr_number: 2 },
        { repo_full_name: "o/r2", source_pr_number: 3, created_pr_repo: null,   created_pr_number: null },
    ];
    const idx = buildSessionPrIndex(sessions);
    assert.equal(idx.size, 3);
    assert.equal(idx.get("o/r1#1"), sessions[0]);
    assert.equal(idx.get("o/r1#2"), sessions[0]);
    assert.equal(idx.get("o/r2#3"), sessions[1]);
});

test("buildSessionPrIndex: skips sessions with no usable keys", () => {
    const idx = buildSessionPrIndex([{ repo_full_name: null, source_pr_number: null }]);
    assert.equal(idx.size, 0);
});

test("filterSessionsByLivePrState: passes through empty / non-array input", async () => {
    assert.deepEqual(await filterSessionsByLivePrState([]), []);
    assert.equal(await filterSessionsByLivePrState(null), null);
    assert.equal(await filterSessionsByLivePrState(undefined), undefined);
});

test("filterSessionsByLivePrState: rows with no PR refs pass through unchanged", async () => {
    // No PR refs means we short-circuit before any gh call.
    const rows = [{ repo_full_name: null, source_pr_number: null }];
    const got = await filterSessionsByLivePrState(rows);
    assert.equal(got, rows);
});
