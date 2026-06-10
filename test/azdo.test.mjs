// Tests for lib/azdo.mjs: URL parsing, run summarization, and timeline fetch
// (with globalThis.fetch stubbed).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { parseAzdoUrl, summarizeAzdoRuns, fetchAzdoTimeline } from "../lib/azdo.mjs";

test("parseAzdoUrl: dev.azure.com extracts org and project", () => {
    const got = parseAzdoUrl("https://dev.azure.com/myorg/My%20Project/_build/results?buildId=1");
    assert.deepEqual(got, { org: "myorg", project: "My Project" });
});

test("parseAzdoUrl: legacy *.visualstudio.com extracts org from hostname", () => {
    const got = parseAzdoUrl("https://myorg.visualstudio.com/Proj/_build/results?buildId=42");
    assert.deepEqual(got, { org: "myorg", project: "Proj" });
});

test("parseAzdoUrl: unknown host returns nulls", () => {
    assert.deepEqual(parseAzdoUrl("https://github.com/o/r/actions"), { org: null, project: null });
});

test("parseAzdoUrl: malformed URL returns nulls", () => {
    assert.deepEqual(parseAzdoUrl("not a url"), { org: null, project: null });
});

test("parseAzdoUrl: dev.azure.com missing project segment yields null project", () => {
    const got = parseAzdoUrl("https://dev.azure.com/justorg");
    assert.equal(got.org, "justorg");
    assert.equal(got.project, null);
});

test("summarizeAzdoRuns: no AzDO runs → hasAny false", () => {
    const got = summarizeAzdoRuns([
        { name: "GHA job", detailsUrl: "https://github.com/o/r/actions/runs/1", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.deepEqual(got, { hasAny: false, builds: [], summary: null });
});

test("summarizeAzdoRuns: groups by buildId and computes overall", () => {
    const runs = [
        // build 100 — 1 success, 1 failure → overall failure
        { name: "leg-a", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=100&view=logs", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "leg-b", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=100&view=logs&jobId=x", status: "COMPLETED", conclusion: "FAILURE" },
        // build 200 — all success
        { name: "only", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=200", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    const got = summarizeAzdoRuns(runs);
    assert.equal(got.hasAny, true);
    assert.equal(got.builds.length, 2);
    // Sorted by buildId desc
    assert.equal(got.builds[0].buildId, "200");
    assert.equal(got.builds[1].buildId, "100");
    assert.equal(got.builds[1].runs.length, 2);
    assert.equal(got.summary.total, 3);
    assert.equal(got.summary.success, 2);
    assert.equal(got.summary.failure, 1);
    assert.equal(got.summary.overall, "failure");
    // summaryUrl strips &view= and &jobId=
    assert.ok(!got.builds[1].summaryUrl.includes("view="));
    assert.ok(!got.builds[1].summaryUrl.includes("jobId="));
});

test("summarizeAzdoRuns: failure dominates over in_progress for overall", () => {
    const runs = [
        { name: "running", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=1", status: "IN_PROGRESS", conclusion: null },
        { name: "done", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=1", status: "COMPLETED", conclusion: "FAILURE" },
    ];
    const got = summarizeAzdoRuns(runs);
    assert.equal(got.summary.inProgress, 1);
    assert.equal(got.summary.failure, 1);
    // azdo summary.overall: failure wins. (notify.mjs uses a different policy
    // for per-build state where in_progress wins; see notify.test.mjs.)
    assert.equal(got.summary.overall, "failure");
});

test("summarizeAzdoRuns: in_progress wins when there are no failures", () => {
    const runs = [
        { name: "running", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=2", status: "IN_PROGRESS", conclusion: null },
        { name: "ok", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=2", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    const got = summarizeAzdoRuns(runs);
    assert.equal(got.summary.overall, "in_progress");
});

test("summarizeAzdoRuns: SKIPPED/NEUTRAL count as success", () => {
    const runs = [
        { name: "a", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=9", status: "COMPLETED", conclusion: "SKIPPED" },
        { name: "b", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=9", status: "COMPLETED", conclusion: "NEUTRAL" },
    ];
    const got = summarizeAzdoRuns(runs);
    assert.equal(got.summary.success, 2);
    assert.equal(got.summary.overall, "success");
});

test("summarizeAzdoRuns: TIMED_OUT/STARTUP_FAILURE/ACTION_REQUIRED count as failure", () => {
    for (const conclusion of ["TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]) {
        const got = summarizeAzdoRuns([
            { name: "x", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=1", status: "COMPLETED", conclusion },
        ]);
        assert.equal(got.summary.failure, 1, `${conclusion} should count as failure`);
    }
});

test("summarizeAzdoRuns: unknown conclusion counted as 'other'", () => {
    const got = summarizeAzdoRuns([
        { name: "weird", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=1", status: "COMPLETED", conclusion: "CANCELLED" },
    ]);
    assert.equal(got.summary.other, 1);
    assert.equal(got.summary.overall, "other");
});

test("summarizeAzdoRuns: URL without buildId still grouped (by origin)", () => {
    const got = summarizeAzdoRuns([
        { name: "x", detailsUrl: "https://dev.azure.com/o/p/some/other/path", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.equal(got.builds.length, 1);
    assert.equal(got.builds[0].buildId, null);
});

// --- fetchAzdoTimeline -----------------------------------------------------
//
// Stub global fetch so we don't reach the network. The cache is module-level
// so each test uses a unique (org, project, buildId) triple to avoid bleed.

let origFetch;
let fetchCalls;
let fetchPlan;

beforeEach(() => {
    origFetch = globalThis.fetch;
    fetchCalls = [];
    fetchPlan = [];
    globalThis.fetch = async (url) => {
        fetchCalls.push(url);
        if (fetchPlan.length === 0) throw new Error(`no fetch plan for ${url}`);
        const next = fetchPlan.shift();
        return next(url);
    };
});

afterEach(() => {
    globalThis.fetch = origFetch;
});

function jsonResp(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
}

test("fetchAzdoTimeline: success path returns shaped data and caches it", async () => {
    const buildBody = {
        status: "completed",
        result: "succeeded",
        startTime: "2024-01-01T00:00:00Z",
        finishTime: "2024-01-01T00:10:00Z",
        buildNumber: "20240101.1",
        _links: { web: { href: "https://dev.azure.com/org/Project/_build/results?buildId=9001" } },
    };
    const timelineBody = {
        records: [
            { id: "r1", parentId: null, type: "Stage", name: "Stage A", state: "completed", result: "succeeded", order: 1, startTime: null, finishTime: null, percentComplete: 100, log: { url: "https://log/1" } },
            { id: "r2", parentId: "r1", type: "Job", name: "Job A", state: "completed", result: "succeeded", order: 1, startTime: null, finishTime: null, percentComplete: 100, log: null },
        ],
    };
    fetchPlan = [
        (url) => url.includes("/timeline") ? jsonResp(timelineBody) : jsonResp(buildBody),
        (url) => url.includes("/timeline") ? jsonResp(timelineBody) : jsonResp(buildBody),
    ];
    const r1 = await fetchAzdoTimeline({ org: "org", project: "Project", buildId: "9001" });
    assert.equal(r1.error, null);
    assert.equal(r1.data.build.buildNumber, "20240101.1");
    assert.equal(r1.data.build.url, buildBody._links.web.href);
    assert.equal(r1.data.records.length, 2);
    assert.equal(r1.data.records[0].log.url, "https://log/1");
    assert.equal(r1.data.records[1].log, null);
    assert.equal(fetchCalls.length, 2);

    // Second call hits the cache → no new fetches.
    const r2 = await fetchAzdoTimeline({ org: "org", project: "Project", buildId: "9001" });
    assert.equal(fetchCalls.length, 2);
    assert.equal(r2.data.build.buildNumber, "20240101.1");
});

test("fetchAzdoTimeline: 203 sign-in response surfaces friendly error", async () => {
    fetchPlan = [
        async () => new Response("<html>signin</html>", { status: 203, headers: { "content-type": "text/html" } }),
        async () => new Response("<html>signin</html>", { status: 203, headers: { "content-type": "text/html" } }),
    ];
    const r = await fetchAzdoTimeline({ org: "org", project: "Priv", buildId: "9002" });
    assert.equal(r.data, null);
    assert.match(r.error, /sign-in required|203/);
});

test("fetchAzdoTimeline: force bypasses cache", async () => {
    const ok = { status: "completed", result: "succeeded" };
    fetchPlan = [
        () => jsonResp(ok),
        () => jsonResp({ records: [] }),
        () => jsonResp(ok),
        () => jsonResp({ records: [] }),
    ];
    await fetchAzdoTimeline({ org: "org", project: "ProjF", buildId: "9003" });
    assert.equal(fetchCalls.length, 2);
    await fetchAzdoTimeline({ org: "org", project: "ProjF", buildId: "9003", force: true });
    assert.equal(fetchCalls.length, 4);
});

test("fetchAzdoTimeline: HTTP error response surfaces error", async () => {
    fetchPlan = [
        async () => new Response("{}", { status: 500, statusText: "Server Error", headers: { "content-type": "application/json" } }),
        async () => new Response("{}", { status: 500, statusText: "Server Error", headers: { "content-type": "application/json" } }),
    ];
    const r = await fetchAzdoTimeline({ org: "org", project: "Bad", buildId: "9004" });
    assert.equal(r.data, null);
    assert.match(r.error, /HTTP 500/);
});
