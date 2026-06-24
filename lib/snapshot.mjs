// Server-side, disk-persisted panel snapshots.
//
// The canvas renders its panels client-side, then the desktop app can tear down
// the webview/extension host and recreate it on a brand-new ephemeral port when
// the user returns after a while. Browser localStorage is keyed by origin
// (host+port), so it's lost across that port change and the freshly loaded page
// repaints empty "Loading…" placeholders — the recurring "Loading flash".
//
// To make the last-rendered content survive a host/port change, the page POSTs
// a compact snapshot of its rendered panels here; the server writes it to disk
// keyed by the STABLE canvas instanceId and inlines it into the served HTML on
// the next load (SSR), so the page paints prior content before any fetch. The
// client's normal loads then reconcile it inline. Snapshots are display cache,
// not configuration — they live under artifacts/snapshots/ and are safe to
// delete at any time.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SNAPSHOTS_DIR } from "./constants.mjs";

// Only these container ids may carry persisted HTML and only these badge ids may
// carry persisted counts. Allow-listing keeps a malicious or buggy POST from
// seeding arbitrary element ids (and arbitrary markup) into the SSR'd page.
const ALLOWED_PANEL_IDS = new Set(["panel-cirun", "panel-copilot", "panel-all", "watched-list"]);
const ALLOWED_COUNT_IDS = new Set(["copilot-count", "all-count", "watched-count"]);
const ALLOWED_TABS = new Set(["copilot", "all", "watched"]);
// Per-panel HTML cap. Rendered lists are small (a few KB); cap defensively so
// a runaway payload can't bloat the snapshot file or the served page. Measured
// in real UTF-8 bytes (not UTF-16 code units) so multi-byte content can't slip
// past the cap. Kept well under a quarter of readJsonBody's 1MB cap in
// server.mjs so that even a full snapshot of all four panels (plus JSON
// escaping overhead) can't structurally exceed the POST body limit and get
// silently rejected.
const MAX_HTML_BYTES = 200 * 1024;
// Count badges are tiny strings like "3"; reject anything implausibly long.
const MAX_COUNT_LEN = 32;

// In-memory mirror so GET / doesn't hit disk on every page load and a write is
// immediately visible to the next read within the same host process. Maps
// instanceId -> sanitized snapshot (or null when none/empty).
const cache = new Map();
// Serialize writes per instance (mirrors settings.mjs' persistChain) so an
// older POST can't land after a newer one and clobber the latest snapshot.
const writeChains = new Map();

// Test seam: redirect persistence to a tmp dir. Restored by calling
// __setSnapshotDirForTests() with no argument.
let snapshotsDir = SNAPSHOTS_DIR;

// Map an arbitrary instanceId to a safe, collision-resistant filename. A
// readable slug of the original id keeps the file debuggable; a short hash of
// the full id is appended so two ids that slugify to the same string can't
// share a file.
export function snapshotFileName(instanceId) {
    const raw = String(instanceId ?? "");
    const slug = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default";
    let h = 5381;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
    return `${slug}.${h.toString(16)}.json`;
}

// Validate and trim an incoming snapshot to the known shape. Returns null when
// there's nothing worth persisting so callers can delete a stale file instead
// of writing an empty document.
export function sanitizeSnapshot(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out = {};
    if (raw.html && typeof raw.html === "object" && !Array.isArray(raw.html)) {
        const html = {};
        for (const [id, val] of Object.entries(raw.html)) {
            if (!ALLOWED_PANEL_IDS.has(id)) continue;
            if (typeof val !== "string" || Buffer.byteLength(val, "utf8") > MAX_HTML_BYTES) continue;
            html[id] = val;
        }
        if (Object.keys(html).length) out.html = html;
    }
    if (raw.counts && typeof raw.counts === "object" && !Array.isArray(raw.counts)) {
        const counts = {};
        for (const [id, val] of Object.entries(raw.counts)) {
            if (!ALLOWED_COUNT_IDS.has(id)) continue;
            if (typeof val !== "string" || val.length > MAX_COUNT_LEN) continue;
            counts[id] = val;
        }
        if (Object.keys(counts).length) out.counts = counts;
    }
    if (typeof raw.activeTab === "string" && ALLOWED_TABS.has(raw.activeTab)) out.activeTab = raw.activeTab;
    if (raw.inspect === true) out.inspect = true;
    return Object.keys(out).length ? out : null;
}

// Load the persisted snapshot for an instance (or null). Cached in-process.
export async function loadSnapshot(instanceId) {
    if (!instanceId) return null;
    if (cache.has(instanceId)) return cache.get(instanceId);
    const file = join(snapshotsDir, snapshotFileName(instanceId));
    let data = null;
    try {
        data = sanitizeSnapshot(JSON.parse(await readFile(file, "utf8")));
    } catch (err) {
        // ENOENT just means nothing has been persisted yet.
        if (err?.code !== "ENOENT") console.error("ci-runs: failed to read snapshot", file, err);
        data = null;
    }
    cache.set(instanceId, data);
    return data;
}

// Persist (or, when the payload is empty/invalid, delete) the snapshot for an
// instance. Returns the sanitized snapshot that was stored.
export async function saveSnapshot(instanceId, raw) {
    if (!instanceId) return null;
    const data = sanitizeSnapshot(raw);
    cache.set(instanceId, data);
    const file = join(snapshotsDir, snapshotFileName(instanceId));
    const payload = data ? JSON.stringify(data) : null;
    const prev = writeChains.get(instanceId) || Promise.resolve();
    const next = prev.then(async () => {
        try {
            if (payload == null) {
                await rm(file, { force: true });
            } else {
                // The snapshots dir doesn't exist on a fresh install; the first
                // write is what creates it.
                await mkdir(snapshotsDir, { recursive: true });
                await writeFile(file, payload, "utf8");
            }
        } catch (err) {
            console.error("ci-runs: failed to persist snapshot", file, err);
        }
    });
    writeChains.set(instanceId, next);
    await next;
    return data;
}

// Build the inline <script> that seeds window.__CIRUNS_SNAPSHOT for SSR. The
// snapshot's HTML strings can contain "<" (and the page-terminating
// "</script>"), so escape "<" to its JS/JSON unicode form — this both prevents
// the literal "</script>" from closing the inline script early and blocks any
// tag injection while remaining valid JSON the browser parses back verbatim.
// U+2028/U+2029 are also escaped since they're valid JSON but illegal raw in JS
// string literals.
export function snapshotInlineScript(snapshot) {
    if (!snapshot) return "";
    const json = JSON.stringify(snapshot)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    return `<script>window.__CIRUNS_SNAPSHOT=${json};</script>`;
}

// Test seam: redirect persistence to a tmp dir and reset in-memory state.
// Passing no argument restores the real path.
export function __setSnapshotDirForTests(dir) {
    snapshotsDir = dir ?? SNAPSHOTS_DIR;
    cache.clear();
    writeChains.clear();
}
