// Unified settings store.
//
// All user-editable extension settings live in a single JSON document at
// <artifacts>/settings.json, keyed by domain section ("notify", "repoFilter").
// Each domain module (notify.mjs, repo-filter.mjs) owns the shape, defaults,
// and sanitize/migration rules of its own section; this module only handles
// whole-document IO and keeps the in-memory document as the single source of
// truth so that writing one section never clobbers another.
//
// The watched-PR list is deliberately NOT stored here — it's an append-heavy
// data collection rather than configuration, so it keeps its own
// watched-prs.json (see watched.mjs).

import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
    ARTIFACTS_DIR,
    LEGACY_NOTIFY_CONFIG_PATH,
    LEGACY_REPO_FILTER_CONFIG_PATH,
    SETTINGS_PATH,
} from "./constants.mjs";

// Maps each settings section to the legacy standalone file it used to live in,
// so a user upgrading from before the consolidation doesn't lose settings.
const LEGACY_SECTION_FILES = {
    notify: LEGACY_NOTIFY_CONFIG_PATH,
    repoFilter: LEGACY_REPO_FILTER_CONFIG_PATH,
};

// In-memory mirror of settings.json — the single source of truth once
// initSettings() has run. Section values are stored raw/unsanitized; each
// domain module sanitizes its own section on read.
let settingsDoc = {};

// Test seam: lets settings.test.mjs redirect persistence + migration sources
// to a tmp dir. Restored to the real paths by calling with no overrides.
let settingsPath = SETTINGS_PATH;
let settingsDir = ARTIFACTS_DIR;
let legacyFiles = LEGACY_SECTION_FILES;

async function readJsonFile(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
        // ENOENT just means the file has never been written — return undefined
        // so callers fall through to defaults. Other errors (corrupt JSON,
        // perms) are logged but don't block startup.
        if (err?.code !== "ENOENT") {
            console.error("ci-runs: failed to read settings file", path, err);
        }
        return undefined;
    }
}

async function persist() {
    try {
        // The artifacts dir doesn't exist on a fresh install; the first write
        // is what creates it.
        await mkdir(settingsDir, { recursive: true });
        await writeFile(settingsPath, JSON.stringify(settingsDoc, null, 2), "utf8");
    } catch (err) {
        console.error("ci-runs: failed to persist settings", err);
    }
}

// Load the unified document and fold in any legacy standalone files whose
// section isn't already present. Must run before the domain modules read
// their sections. Returns the in-memory document.
export async function initSettings() {
    const loaded = await readJsonFile(settingsPath);
    settingsDoc = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
    let migrated = false;
    for (const [section, legacyPath] of Object.entries(legacyFiles)) {
        if (settingsDoc[section] !== undefined) continue;
        const legacy = await readJsonFile(legacyPath);
        if (legacy !== undefined) {
            settingsDoc[section] = legacy;
            migrated = true;
        }
    }
    // Materialize the migration once so the unified file becomes canonical and
    // subsequent loads don't re-read the legacy files.
    if (migrated) await persist();
    return settingsDoc;
}

// Raw (unsanitized) value of one section, or undefined if unset.
export function getSettingsSection(section) {
    return settingsDoc?.[section];
}

// Replace one section and rewrite the whole document. Because settingsDoc is
// the single in-memory source of truth, the other sections are preserved
// verbatim — a section write can never clobber a sibling section.
export async function writeSettingsSection(section, value) {
    settingsDoc = { ...settingsDoc, [section]: value };
    await persist();
    return settingsDoc[section];
}

// Test seam: redirect persistence + migration sources to a tmp location and
// reset the in-memory document. Passing no overrides restores real paths.
export function __setSettingsForTests({ path, dir, legacy } = {}) {
    settingsDoc = {};
    settingsPath = path ?? SETTINGS_PATH;
    settingsDir = dir ?? ARTIFACTS_DIR;
    legacyFiles = legacy ?? LEGACY_SECTION_FILES;
}
