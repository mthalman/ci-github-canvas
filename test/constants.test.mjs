// Smoke tests: constants exist and have sane shapes/ranges. Keeps anyone
// accidentally deleting or renaming a constant from breaking importers
// silently.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as C from "../lib/constants.mjs";

test("constants: paths are absolute strings", () => {
    assert.equal(typeof C.DB_PATH, "string");
    assert.ok(C.DB_PATH.length > 0);
    assert.equal(typeof C.NOTIFY_CONFIG_PATH, "string");
    assert.ok(C.NOTIFY_CONFIG_PATH.endsWith("ci-runs.json"));
});

test("constants: notify config lives under the extension's artifacts/ dir", () => {
    assert.equal(typeof C.EXTENSION_ROOT, "string");
    assert.equal(typeof C.ARTIFACTS_DIR, "string");
    assert.ok(C.ARTIFACTS_DIR.startsWith(C.EXTENSION_ROOT),
        "ARTIFACTS_DIR should live under EXTENSION_ROOT");
    assert.ok(C.ARTIFACTS_DIR.endsWith("artifacts"),
        "ARTIFACTS_DIR should be named 'artifacts'");
    assert.ok(C.NOTIFY_CONFIG_PATH.startsWith(C.ARTIFACTS_DIR),
        "NOTIFY_CONFIG_PATH should live under ARTIFACTS_DIR");
});

test("constants: TTLs are positive numbers", () => {
    for (const k of [
        "GH_CACHE_TTL_MS",
        "CHECKS_CACHE_TTL_MS",
        "TASKS_CACHE_TTL_MS",
        "AZDO_TIMELINE_CACHE_TTL_MS",
        "SYNC_STATE_CACHE_TTL_MS",
        "SYNC_STATE_GIT_TIMEOUT_MS",
        "PR_LIVE_STATE_CACHE_TTL_MS",
        "PR_LIVE_STATE_ERROR_CACHE_TTL_MS",
        "HOST_POLL_INTERVAL_MS",
    ]) {
        assert.equal(typeof C[k], "number", `${k} should be a number`);
        assert.ok(C[k] > 0, `${k} should be > 0`);
    }
});

test("constants: concurrency cap is a positive integer", () => {
    assert.equal(typeof C.SYNC_STATE_GIT_CONCURRENCY, "number");
    assert.ok(Number.isInteger(C.SYNC_STATE_GIT_CONCURRENCY));
    assert.ok(C.SYNC_STATE_GIT_CONCURRENCY > 0);
});

test("constants: AZDO_URL_RE matches dev.azure.com and *.visualstudio.com", () => {
    assert.ok(C.AZDO_URL_RE.test("https://dev.azure.com/foo/bar/_build/results?buildId=1"));
    assert.ok(C.AZDO_URL_RE.test("https://foo.visualstudio.com/bar/_build/results?buildId=1"));
    assert.ok(!C.AZDO_URL_RE.test("https://github.com/foo/bar/actions/runs/1"));
    assert.ok(!C.AZDO_URL_RE.test("https://example.com/whatever"));
});

test("constants: AZDO_BUILD_ID_RE extracts buildId param", () => {
    const m = "https://dev.azure.com/o/p/_build/results?buildId=12345&view=logs".match(C.AZDO_BUILD_ID_RE);
    assert.equal(m?.[1], "12345");
    const m2 = "?foo=bar&buildId=7".match(C.AZDO_BUILD_ID_RE);
    assert.equal(m2?.[1], "7");
    assert.equal("no build id here".match(C.AZDO_BUILD_ID_RE), null);
});
