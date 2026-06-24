// Tests for lib/snapshot.mjs — the server-side, disk-persisted panel snapshot
// store. Uses the __setSnapshotDirForTests seam to redirect persistence at a
// fresh tmp dir per test so nothing touches the user's real artifacts/ folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    sanitizeSnapshot,
    snapshotFileName,
    snapshotInlineScript,
    loadSnapshot,
    saveSnapshot,
    __setSnapshotDirForTests,
} from "../lib/snapshot.mjs";

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "ci-runs-snapshot-"));
    __setSnapshotDirForTests(dir);
    return dir;
}

function teardown(dir) {
    __setSnapshotDirForTests();
    return rm(dir, { recursive: true, force: true });
}

test("sanitizeSnapshot: keeps only allow-listed panels, counts, tabs", () => {
    const out = sanitizeSnapshot({
        html: { "panel-copilot": "<ul></ul>", "evil-id": "<script>x</script>", "panel-all": 42 },
        counts: { "copilot-count": "3", "evil-count": "9", "all-count": "x".repeat(99) },
        activeTab: "all",
        inspect: true,
        extra: "ignored",
    });
    assert.deepEqual(out, {
        html: { "panel-copilot": "<ul></ul>" },
        counts: { "copilot-count": "3" },
        activeTab: "all",
        inspect: true,
    });
});

test("sanitizeSnapshot: rejects oversize html and bad shapes", () => {
    assert.equal(sanitizeSnapshot(null), null);
    assert.equal(sanitizeSnapshot("nope"), null);
    assert.equal(sanitizeSnapshot([]), null);
    assert.equal(sanitizeSnapshot({}), null);
    // Oversize HTML is dropped, leaving nothing worth persisting.
    assert.equal(sanitizeSnapshot({ html: { "panel-all": "x".repeat(600 * 1024) } }), null);
    // The cap is measured in UTF-8 bytes, not UTF-16 code units: a multi-byte
    // string whose .length is under the cap but whose byte size is over it must
    // still be rejected. "€" is one code unit but three UTF-8 bytes, so 100K of
    // them = ~100K code units (under) but ~300KB (over).
    assert.equal(sanitizeSnapshot({ html: { "panel-all": "\u20ac".repeat(100 * 1024) } }), null);
    // A panel right under the byte cap is kept.
    assert.deepEqual(
        sanitizeSnapshot({ html: { "panel-all": "x".repeat(1024) } }),
        { html: { "panel-all": "x".repeat(1024) } },
    );
    // Unknown tab is dropped.
    assert.equal(sanitizeSnapshot({ activeTab: "bogus" }), null);
    // inspect only persists when strictly true.
    assert.equal(sanitizeSnapshot({ inspect: false }), null);
});

test("snapshotFileName: sanitizes and disambiguates by hash", () => {
    const a = snapshotFileName("ci-runs-3");
    assert.match(a, /^ci-runs-3\.[0-9a-f]+\.json$/);
    // Path-separator characters are neutralized so a snapshot can't escape its
    // dir; the name is always a single segment ending in .json.
    const evil = snapshotFileName("../../etc/passwd");
    assert.ok(!evil.includes("/") && !evil.includes("\\"));
    assert.match(evil, /\.json$/);
    // Two ids that slugify the same get distinct files via the hash suffix.
    assert.notEqual(snapshotFileName("a/b"), snapshotFileName("a:b"));
});

test("snapshotInlineScript: escapes < so </script> can't break out", () => {
    assert.equal(snapshotInlineScript(null), "");
    const script = snapshotInlineScript({ html: { "panel-all": "<li></li></script><b>" } });
    assert.ok(script.startsWith("<script>window.__CIRUNS_SNAPSHOT="));
    // No raw "<" survives in the payload — every one is unicode-escaped.
    const prefix = "<script>window.__CIRUNS_SNAPSHOT=";
    const suffix = ";</script>";
    const payload = script.slice(prefix.length, -suffix.length);
    assert.ok(!payload.includes("<"));
    assert.ok(payload.includes("\\u003c"));
    // And it round-trips back to the original HTML when parsed.
    const parsed = JSON.parse(payload.replace(/\\u003c/g, "<"));
    assert.equal(parsed.html["panel-all"], "<li></li></script><b>");
});

test("save then load round-trips through disk", async () => {
    const dir = await setup();
    try {
        const data = { html: { "panel-copilot": "<ul></ul>" }, activeTab: "copilot" };
        const saved = await saveSnapshot("inst-1", data);
        assert.deepEqual(saved, data);
        // Bypass the in-process cache by reloading from a fresh module state.
        __setSnapshotDirForTests(dir);
        const loaded = await loadSnapshot("inst-1");
        assert.deepEqual(loaded, data);
        // The file actually exists on disk under the hashed name.
        const file = join(dir, snapshotFileName("inst-1"));
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), data);
    } finally {
        await teardown(dir);
    }
});

test("saveSnapshot with empty payload removes any stale file", async () => {
    const dir = await setup();
    try {
        await saveSnapshot("inst-2", { html: { "panel-all": "<ul></ul>" } });
        const file = join(dir, snapshotFileName("inst-2"));
        await readFile(file, "utf8"); // exists
        await saveSnapshot("inst-2", { inspect: false }); // sanitizes to null
        await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
        __setSnapshotDirForTests(dir);
        assert.equal(await loadSnapshot("inst-2"), null);
    } finally {
        await teardown(dir);
    }
});

test("missing instanceId is a no-op (no persistence)", async () => {
    const dir = await setup();
    try {
        assert.equal(await saveSnapshot(null, { html: { "panel-all": "<ul></ul>" } }), null);
        assert.equal(await loadSnapshot(null), null);
    } finally {
        await teardown(dir);
    }
});

test("loadSnapshot: missing file yields null", async () => {
    const dir = await setup();
    try {
        assert.equal(await loadSnapshot("never-written"), null);
    } finally {
        await teardown(dir);
    }
});

test("loadSnapshot: corrupt file on disk yields null", async () => {
    const dir = await setup();
    try {
        await writeFile(join(dir, snapshotFileName("inst-3")), "{not json", "utf8");
        __setSnapshotDirForTests(dir);
        assert.equal(await loadSnapshot("inst-3"), null);
    } finally {
        await teardown(dir);
    }
});
