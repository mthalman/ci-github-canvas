// Display preferences.
//
// User-facing toggles that only affect what the canvas renders (not which data
// the host-side notifier acts on). Currently a single flag:
//
//   showOtherSessions — when true, the Copilot tab also lists sessions whose PR
//     you did NOT author (e.g. codeflow / bot PRs) and fetches their CI run
//     trees. Default false: the tab shows only your authored session PRs.
//
// Lives in the unified <artifacts>/settings.json document under the "display"
// section (see settings.mjs); mirrored into the live `displayConfig` binding so
// callers can read the current value without awaiting a disk read.

import { getSettingsSection, writeSettingsSection } from "./settings.mjs";

// In-memory mirror of the on-disk display config. Loaded eagerly at startup via
// initDisplayConfig(); POST /api/display-config updates both this and the JSON
// file through saveDisplayConfig(). Only those two functions reassign it.
export let displayConfig = { showOtherSessions: false };

export function sanitizeDisplayConfig(raw) {
    return { showOtherSessions: !!(raw && typeof raw === "object" && raw.showOtherSessions) };
}

export async function initDisplayConfig() {
    displayConfig = sanitizeDisplayConfig(getSettingsSection("display"));
    return displayConfig;
}

export async function saveDisplayConfig(next) {
    displayConfig = sanitizeDisplayConfig(next);
    await writeSettingsSection("display", displayConfig);
    return displayConfig;
}
