// Tests for lib/watched.mjs:
//   - parseGitHubPrUrl (pure)
//   - sanitizeWatchedList (pure)
//   - loadWatchedList / addWatchedPr / removeWatchedPr (via tmp dir)
// Network-touching fetchWatchedPrsWithChecks isn't covered here — its happy
// path requires the gh CLI; the routing layer that calls it is exercised by
// server.test.mjs.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    addWatchedPr,
    loadWatchedList,
    parseGitHubPrUrl,
    removeWatchedPr,
    sanitizeWatchedList,
    watchedKey,
    MAX_WATCHED,
    __resetWatchedCacheForTests,
} from "../lib/watched.mjs";

// --- parseGitHubPrUrl ------------------------------------------------------

test("parseGitHubPrUrl: accepts canonical PR URL", () => {
    const out = parseGitHubPrUrl("https://github.com/owner/repo/pull/42");
    assert.deepEqual(out, {
        owner: "owner",
        repo: "repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        key: "owner/repo#42",
    });
});

test("parseGitHubPrUrl: tolerates trailing slash, /files, /commits/<sha>, query, hash", () => {
    const cases = [
        "https://github.com/owner/repo/pull/42/",
        "https://github.com/owner/repo/pull/42/files",
        "https://github.com/owner/repo/pull/42/commits/deadbeef",
        "https://github.com/owner/repo/pull/42?diff=split",
        "https://github.com/owner/repo/pull/42#discussion_r1",
        "  https://github.com/owner/repo/pull/42  ",
    ];
    for (const input of cases) {
        const out = parseGitHubPrUrl(input);
        assert.equal(out?.key, "owner/repo#42", `failed for ${input}`);
        assert.equal(out?.url, "https://github.com/owner/repo/pull/42", `failed for ${input}`);
    }
});

test("parseGitHubPrUrl: normalizes owner+repo casing only in the key (not the url)", () => {
    const out = parseGitHubPrUrl("https://github.com/Mthalman/MyRepo/pull/7");
    assert.equal(out?.owner, "Mthalman");
    assert.equal(out?.repo, "MyRepo");
    assert.equal(out?.key, "mthalman/myrepo#7");
    assert.equal(out?.url, "https://github.com/Mthalman/MyRepo/pull/7");
});

test("parseGitHubPrUrl: rejects non-PR URLs and garbage", () => {
    const bad = [
        null,
        undefined,
        "",
        "not a url",
        "https://github.com/owner/repo",
        "https://github.com/owner/repo/issues/42",
        "https://github.com/owner/repo/pull/notanumber",
        "https://gitlab.com/owner/repo/pull/42",
        "ftp://github.com/owner/repo/pull/42",
        "https://github.com/owner//pull/42",
        "https://github.com/owner/repo/pull/0",
        "https://github.com/owner/repo/pull/-1",
        "https://example.com/owner/repo/pull/42",
    ];
    for (const input of bad) {
        assert.equal(parseGitHubPrUrl(input), null, `should reject ${JSON.stringify(input)}`);
    }
});

// --- sanitizeWatchedList ---------------------------------------------------

test("sanitizeWatchedList: accepts { items: [...] } or bare array shapes", () => {
    const items = [{ url: "https://github.com/a/b/pull/1", addedAt: "2024-01-01T00:00:00.000Z" }];
    const fromObject = sanitizeWatchedList({ items });
    const fromArray  = sanitizeWatchedList(items);
    assert.equal(fromObject.length, 1);
    assert.equal(fromArray.length, 1);
    assert.equal(fromObject[0].key, "a/b#1");
});

test("sanitizeWatchedList: drops invalid urls and duplicates, keeps first", () => {
    const out = sanitizeWatchedList({
        items: [
            { url: "https://github.com/a/b/pull/1", addedAt: "2024-01-01T00:00:00.000Z" },
            { url: "not-a-url" },
            { url: "https://github.com/a/b/pull/1", addedAt: "2025-06-01T00:00:00.000Z" },
            { url: "https://github.com/c/d/pull/9" },
        ],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].key, "a/b#1");
    assert.equal(out[0].addedAt, "2024-01-01T00:00:00.000Z");
    assert.equal(out[1].key, "c/d#9");
});

test("sanitizeWatchedList: caps at MAX_WATCHED entries", () => {
    const items = [];
    for (let i = 0; i < MAX_WATCHED + 25; i++) {
        items.push({ url: `https://github.com/a/b/pull/${i + 1}` });
    }
    const out = sanitizeWatchedList({ items });
    assert.equal(out.length, MAX_WATCHED);
});

// --- watchedKey ------------------------------------------------------------

test("watchedKey: lowercases and concatenates", () => {
    assert.equal(watchedKey("Owner", "Repo", 42), "owner/repo#42");
});

// --- add/remove/load (tmp-dir backed) --------------------------------------

let tmpDir;
let tmpPath;

beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "watched-test-"));
    tmpPath = join(tmpDir, "watched-prs.json");
    __resetWatchedCacheForTests({ path: tmpPath, dir: tmpDir });
});

afterEach(async () => {
    __resetWatchedCacheForTests();
    await rm(tmpDir, { recursive: true, force: true });
});

test("loadWatchedList: missing file yields empty list (no error)", async () => {
    const list = await loadWatchedList();
    assert.deepEqual(list, []);
});

test("loadWatchedList: parses existing on-disk file", async () => {
    await writeFile(tmpPath, JSON.stringify({
        items: [{ url: "https://github.com/a/b/pull/1", addedAt: "2024-06-01T00:00:00.000Z" }],
    }));
    const list = await loadWatchedList({ force: true });
    assert.equal(list.length, 1);
    assert.equal(list[0].key, "a/b#1");
});

test("addWatchedPr: persists a new PR and returns it", async () => {
    const result = await addWatchedPr("https://github.com/a/b/pull/42");
    assert.equal(result.error, undefined);
    assert.equal(result.item.key, "a/b#42");
    assert.equal(result.items.length, 1);
    // Sanity-check on-disk shape.
    const onDisk = JSON.parse(await readFile(tmpPath, "utf8"));
    assert.equal(onDisk.items.length, 1);
    assert.equal(onDisk.items[0].url, "https://github.com/a/b/pull/42");
});

test("addWatchedPr: rejects malformed URLs", async () => {
    const r = await addWatchedPr("not a url");
    assert.match(r.error ?? "", /valid GitHub PR URL/i);
});

test("addWatchedPr: duplicate add returns error message but still includes item", async () => {
    await addWatchedPr("https://github.com/a/b/pull/1");
    const dup = await addWatchedPr("https://github.com/a/b/pull/1");
    assert.match(dup.error ?? "", /already/i);
    assert.equal(dup.item.key, "a/b#1");
    assert.equal(dup.items.length, 1);
});

test("addWatchedPr: enforces MAX_WATCHED cap", async () => {
    // Pre-seed the list at the cap.
    const items = [];
    for (let i = 0; i < MAX_WATCHED; i++) items.push({ url: `https://github.com/a/b/pull/${i + 1}` });
    await writeFile(tmpPath, JSON.stringify({ items }));
    __resetWatchedCacheForTests({ path: tmpPath, dir: tmpDir });
    const r = await addWatchedPr(`https://github.com/a/b/pull/${MAX_WATCHED + 1}`);
    assert.match(r.error ?? "", /full/i);
});

test("removeWatchedPr: removes by key and persists the new list", async () => {
    await addWatchedPr("https://github.com/a/b/pull/1");
    await addWatchedPr("https://github.com/a/b/pull/2");
    const r = await removeWatchedPr("a/b#1");
    assert.equal(r.removed, true);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].key, "a/b#2");
    const onDisk = JSON.parse(await readFile(tmpPath, "utf8"));
    assert.equal(onDisk.items.length, 1);
});

test("removeWatchedPr: unknown key reports removed=false without touching list", async () => {
    await addWatchedPr("https://github.com/a/b/pull/1");
    const r = await removeWatchedPr("z/z#999");
    assert.equal(r.removed, false);
    assert.equal(r.items.length, 1);
});

test("removeWatchedPr: missing/empty key returns error", async () => {
    const r = await removeWatchedPr("");
    assert.match(r.error ?? "", /key/i);
});

test("removeWatchedPr: matches case-insensitively", async () => {
    await addWatchedPr("https://github.com/Owner/Repo/pull/7");
    const r = await removeWatchedPr("OWNER/REPO#7");
    assert.equal(r.removed, true);
});
