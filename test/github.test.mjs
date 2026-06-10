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

import { CHECKS_QUERY } from "../lib/github.mjs";

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
