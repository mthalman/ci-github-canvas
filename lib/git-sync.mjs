// Compute a coarse local-vs-upstream sync state for a Copilot session's
// checkout. Runs `git rev-list --left-right --count @{u}...HEAD` per
// checkout, with caching/dedup and a hard concurrency cap so a session list
// with many workspaces doesn't spawn a thundering herd of git.exe.

import { execFile } from "node:child_process";

import {
    SYNC_STATE_CACHE_TTL_MS,
    SYNC_STATE_GIT_CONCURRENCY,
    SYNC_STATE_GIT_TIMEOUT_MS,
} from "./constants.mjs";

// Run an async task with bounded concurrency. Lightweight in-process limiter
// so we don't pull in p-limit for a single use site.
export async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    return out;
}

// Compute a coarse local-vs-upstream sync state for a checkout. Compares
// HEAD against its configured upstream (`@{u}`), which is whatever the
// worktree was last told to track. We deliberately do NOT `git fetch` here
// — that would mutate the workspace and contact the network on every poll
// — so this reflects the state as of the last fetch, not GitHub's live tip.
const syncStateCache = new Map(); // checkoutPath -> { at, state }
const syncStateInflight = new Map(); // checkoutPath -> Promise<state>

function runGitForSync(args, cwd) {
    return new Promise((resolve) => {
        execFile(
            "git",
            ["-C", cwd, "--no-optional-locks", ...args],
            {
                shell: false,
                windowsHide: true,
                timeout: SYNC_STATE_GIT_TIMEOUT_MS,
                env: {
                    ...process.env,
                    // Defense-in-depth: rev-list shouldn't prompt or contact the
                    // network, but make sure we never accidentally block on a
                    // credential helper.
                    GIT_TERMINAL_PROMPT: "0",
                    GCM_INTERACTIVE: "Never",
                },
            },
            (err, stdout, stderr) => {
                if (err) resolve({ error: (stderr || err.message || "").toString().trim() });
                else resolve({ stdout: stdout.toString().trim() });
            },
        );
    });
}

async function computeSyncState(checkoutPath) {
    if (!checkoutPath) return null;
    const now = Date.now();
    const cached = syncStateCache.get(checkoutPath);
    if (cached && now - cached.at < SYNC_STATE_CACHE_TTL_MS) return cached.state;
    const pending = syncStateInflight.get(checkoutPath);
    if (pending) return pending;

    const work = (async () => {
        const r = await runGitForSync(
            ["rev-list", "--left-right", "--count", "@{u}...HEAD"],
            checkoutPath,
        );
        let state = null;
        if (!r.error && r.stdout) {
            // Output is "<behind>\t<ahead>" — left side is commits in @{u}
            // not in HEAD (behind); right side is commits in HEAD not in
            // @{u} (ahead).
            const parts = r.stdout.split(/\s+/);
            const behind = Number(parts[0]) || 0;
            const ahead = Number(parts[1]) || 0;
            if (behind === 0 && ahead === 0) state = "up_to_date";
            else if (behind > 0 && ahead === 0) state = "behind";
            else if (behind === 0 && ahead > 0) state = "ahead";
            else state = "diverged";
        }
        syncStateCache.set(checkoutPath, { at: Date.now(), state });
        return state;
    })();

    syncStateInflight.set(checkoutPath, work);
    try {
        return await work;
    } finally {
        syncStateInflight.delete(checkoutPath);
    }
}

export async function enrichSessionsWithSyncState(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    // De-dupe by checkout_path so multiple sessions pointing at the same
    // checkout (rare, but possible for in_place bindings) only spawn git once.
    const uniquePaths = [...new Set(rows.map((r) => r.checkout_path).filter(Boolean))];
    const results = await mapLimit(uniquePaths, SYNC_STATE_GIT_CONCURRENCY, async (p) => [
        p,
        await computeSyncState(p),
    ]);
    const byPath = new Map(results);
    for (const r of rows) {
        r.sync_state = r.checkout_path ? byPath.get(r.checkout_path) ?? null : null;
    }
    return rows;
}
