// Tests for lib/settings.mjs — the unified settings store. Uses the
// __setSettingsForTests seam to redirect persistence + legacy migration
// sources at a fresh tmp dir per test, so nothing touches the user's real
// artifacts/ folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    initSettings,
    getSettingsSection,
    writeSettingsSection,
    __setSettingsForTests,
} from "../lib/settings.mjs";

// Create a tmp dir and point the settings module at it. Returns the paths so
// the test can pre-seed files or assert on disk contents.
async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "ci-runs-settings-"));
    const path = join(dir, "settings.json");
    const legacy = {
        notify: join(dir, "ci-runs.json"),
        repoFilter: join(dir, "repo-filter.json"),
    };
    __setSettingsForTests({ path, dir, legacy });
    return { dir, path, legacy };
}

async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}

test("initSettings: missing file yields an empty document", async () => {
    const { dir } = await setup();
    try {
        const doc = await initSettings();
        assert.deepEqual(doc, {});
        assert.equal(getSettingsSection("notify"), undefined);
        assert.equal(getSettingsSection("repoFilter"), undefined);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("writeSettingsSection: round-trips a section to disk", async () => {
    const { dir, path } = await setup();
    try {
        await initSettings();
        await writeSettingsSection("repoFilter", { patterns: ["my-org/*"] });
        assert.deepEqual(getSettingsSection("repoFilter"), { patterns: ["my-org/*"] });
        assert.deepEqual(await readJson(path), { repoFilter: { patterns: ["my-org/*"] } });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("writeSettingsSection: writing one section preserves the others", async () => {
    const { dir, path } = await setup();
    try {
        await initSettings();
        await writeSettingsSection("notify", { notifyOnJobFailure: true });
        await writeSettingsSection("repoFilter", { patterns: ["a/b"] });
        // Overwrite just notify; repoFilter must survive untouched.
        await writeSettingsSection("notify", { notifyOnJobFailure: false });
        const onDisk = await readJson(path);
        assert.deepEqual(onDisk, {
            notify: { notifyOnJobFailure: false },
            repoFilter: { patterns: ["a/b"] },
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("initSettings: loads an existing unified document", async () => {
    const { dir, path } = await setup();
    try {
        await writeFile(path, JSON.stringify({ notify: { notifyOnRunCompletion: true } }), "utf8");
        await initSettings();
        assert.deepEqual(getSettingsSection("notify"), { notifyOnRunCompletion: true });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("initSettings: migrates legacy standalone files and materializes settings.json", async () => {
    const { dir, path, legacy } = await setup();
    try {
        await writeFile(legacy.notify, JSON.stringify({ enabled: true }), "utf8");
        await writeFile(legacy.repoFilter, JSON.stringify({ patterns: ["x/y"] }), "utf8");
        await initSettings();
        assert.deepEqual(getSettingsSection("notify"), { enabled: true });
        assert.deepEqual(getSettingsSection("repoFilter"), { patterns: ["x/y"] });
        // Migration is materialized so the unified file becomes canonical.
        assert.deepEqual(await readJson(path), {
            notify: { enabled: true },
            repoFilter: { patterns: ["x/y"] },
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("initSettings: a present section is not overwritten by a legacy file", async () => {
    const { dir, path, legacy } = await setup();
    try {
        await writeFile(path, JSON.stringify({ notify: { notifyOnJobFailure: true } }), "utf8");
        await writeFile(legacy.notify, JSON.stringify({ notifyOnJobFailure: false }), "utf8");
        await writeFile(legacy.repoFilter, JSON.stringify({ patterns: ["z/z"] }), "utf8");
        await initSettings();
        // Unified notify wins; missing repoFilter is still migrated in.
        assert.deepEqual(getSettingsSection("notify"), { notifyOnJobFailure: true });
        assert.deepEqual(getSettingsSection("repoFilter"), { patterns: ["z/z"] });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("initSettings: a non-object document is treated as empty", async () => {
    const { dir, path } = await setup();
    try {
        await writeFile(path, JSON.stringify(["not", "an", "object"]), "utf8");
        const doc = await initSettings();
        assert.deepEqual(doc, {});
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
