// Tests for lib/display.mjs.
//
// sanitizeDisplayConfig is pure; init/save delegate to the unified settings
// store (lib/settings.mjs) whose disk round-trip is covered in
// test/settings.test.mjs. We exercise sanitize directly and verify init/save
// round-trip through the settings test seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    sanitizeDisplayConfig,
    initDisplayConfig,
    saveDisplayConfig,
    displayConfig,
} from "../lib/display.mjs";
import {
    initSettings,
    getSettingsSection,
    __setSettingsForTests,
} from "../lib/settings.mjs";

test("sanitizeDisplayConfig: defaults to showOtherSessions=false", () => {
    const off = { showOtherSessions: false };
    assert.deepEqual(sanitizeDisplayConfig(undefined), off);
    assert.deepEqual(sanitizeDisplayConfig(null), off);
    assert.deepEqual(sanitizeDisplayConfig("nope"), off);
    assert.deepEqual(sanitizeDisplayConfig({}), off);
    assert.deepEqual(sanitizeDisplayConfig({ showOtherSessions: 0 }), off);
});

test("sanitizeDisplayConfig: coerces truthy/boolean to a real boolean", () => {
    assert.deepEqual(sanitizeDisplayConfig({ showOtherSessions: true }), { showOtherSessions: true });
    // Non-boolean truthy values are coerced to true (defensive, like notify).
    assert.deepEqual(sanitizeDisplayConfig({ showOtherSessions: "yes" }), { showOtherSessions: true });
    assert.deepEqual(sanitizeDisplayConfig({ showOtherSessions: false }), { showOtherSessions: false });
});

test("initDisplayConfig + saveDisplayConfig: round-trip through the settings store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-runs-display-"));
    try {
        __setSettingsForTests({
            path: join(dir, "settings.json"),
            dir,
            legacy: {},
        });
        await initSettings();

        // No prior section → defaults.
        const initial = await initDisplayConfig();
        assert.deepEqual(initial, { showOtherSessions: false });
        assert.equal(displayConfig.showOtherSessions, false);

        // Save flips it and persists into the "display" settings section.
        const saved = await saveDisplayConfig({ showOtherSessions: true });
        assert.deepEqual(saved, { showOtherSessions: true });
        assert.deepEqual(getSettingsSection("display"), { showOtherSessions: true });

        // A fresh init reads the persisted value back.
        const reloaded = await initDisplayConfig();
        assert.deepEqual(reloaded, { showOtherSessions: true });
    } finally {
        __setSettingsForTests({});
        await rm(dir, { recursive: true, force: true });
    }
});
