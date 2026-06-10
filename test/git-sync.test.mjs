// Tests for lib/git-sync.mjs's pure helper, `mapLimit`. enrichSessionsWithSyncState
// is intentionally not unit-tested here because it shells out to real git
// against real checkouts; its caching layer is exercised indirectly via
// mapLimit and computeSyncState's per-path coalescing (covered by integration).
import { test } from "node:test";
import assert from "node:assert/strict";

import { mapLimit } from "../lib/git-sync.mjs";

test("mapLimit: returns results in input order", async () => {
    const out = await mapLimit([1, 2, 3, 4], 2, async (n) => n * 10);
    assert.deepEqual(out, [10, 20, 30, 40]);
});

test("mapLimit: respects the concurrency cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fn = async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return null;
    };
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, fn);
    assert.ok(maxInFlight <= 3, `expected <= 3 in-flight, saw ${maxInFlight}`);
    assert.ok(maxInFlight >= 1);
});

test("mapLimit: empty input returns empty array", async () => {
    const out = await mapLimit([], 4, async () => 1);
    assert.deepEqual(out, []);
});

test("mapLimit: limit > items.length still works", async () => {
    const out = await mapLimit([1, 2], 10, async (n) => n + 1);
    assert.deepEqual(out, [2, 3]);
});

test("mapLimit: passes index as the second argument", async () => {
    const out = await mapLimit(["a", "b", "c"], 2, async (v, i) => `${i}:${v}`);
    assert.deepEqual(out, ["0:a", "1:b", "2:c"]);
});

test("mapLimit: rejects if any worker throws", async () => {
    await assert.rejects(
        mapLimit([1, 2, 3], 2, async (n) => {
            if (n === 2) throw new Error("boom");
            return n;
        }),
        /boom/,
    );
});
