// Tests for lib/azdo.mjs: URL parsing, run summarization, and timeline fetch
// (with globalThis.fetch stubbed).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { parseAzdoUrl, parseAzdoBuildUrl, summarizeAzdoRuns, fetchAzdoTimeline, getAzdoAccessToken, fetchAzdoBuild, createSharedTokenGetter } from "../lib/azdo.mjs";

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

// --- parseAzdoBuildUrl ------------------------------------------------------

test("parseAzdoBuildUrl: dev.azure.com build-results URL extracts org/project/buildId", () => {
    const got = parseAzdoBuildUrl("https://dev.azure.com/myorg/My%20Project/_build/results?buildId=123&view=logs");
    assert.deepEqual(got, { org: "myorg", project: "My Project", buildId: "123" });
});

test("parseAzdoBuildUrl: legacy *.visualstudio.com works", () => {
    const got = parseAzdoBuildUrl("https://myorg.visualstudio.com/Proj/_build/results?buildId=42");
    assert.deepEqual(got, { org: "myorg", project: "Proj", buildId: "42" });
});

test("parseAzdoBuildUrl: missing buildId returns null", () => {
    assert.equal(parseAzdoBuildUrl("https://dev.azure.com/org/Proj/_build/results"), null);
});

test("parseAzdoBuildUrl: non-numeric buildId suffix returns null", () => {
    // The shared extraction regex would partial-match "123" from "123abc";
    // the validator must reject it rather than silently inspect build 123.
    assert.equal(parseAzdoBuildUrl("https://dev.azure.com/org/Proj/_build/results?buildId=123abc"), null);
    assert.equal(parseAzdoBuildUrl("https://dev.azure.com/org/Proj/_build/results?buildId=12.3"), null);
});

test("parseAzdoBuildUrl: numeric buildId followed by another param is accepted", () => {
    const got = parseAzdoBuildUrl("https://dev.azure.com/org/Proj/_build/results?buildId=123&view=logs");
    assert.deepEqual(got, { org: "org", project: "Proj", buildId: "123" });
});

test("parseAzdoBuildUrl: non-AzDO host returns null", () => {
    assert.equal(parseAzdoBuildUrl("https://github.com/o/r/actions/runs/1"), null);
});

test("parseAzdoBuildUrl: blank / non-string returns null", () => {
    assert.equal(parseAzdoBuildUrl("   "), null);
    assert.equal(parseAzdoBuildUrl(null), null);
    assert.equal(parseAzdoBuildUrl(42), null);
});

// --- getAzdoAccessToken (Azure CLI, runAz stubbed) -------------------------

test("getAzdoAccessToken: ENOENT spawn error → not_installed", async () => {
    const runAz = async () => ({ code: null, stdout: "", stderr: "", spawnError: Object.assign(new Error("spawn az ENOENT"), { code: "ENOENT" }) });
    const r = await getAzdoAccessToken({ runAz });
    assert.equal(r.token, undefined);
    assert.equal(r.errorKind, "not_installed");
    assert.match(r.error, /Azure CLI .*not found|az login/i);
});

test("getAzdoAccessToken: non-zero exit → not_logged_in (and surfaces stderr)", async () => {
    const runAz = async () => ({ code: 1, stdout: "", stderr: "Please run 'az login'", spawnError: null });
    const r = await getAzdoAccessToken({ runAz });
    assert.equal(r.errorKind, "not_logged_in");
    assert.match(r.error, /az login/i);
    assert.match(r.error, /Please run 'az login'/);
});

test("getAzdoAccessToken: non-zero exit with 'is not recognized' stderr → not_installed (Windows shell:true)", async () => {
    // On Windows `az` runs via cmd.exe, so a missing CLI exits non-zero with a
    // "is not recognized" message rather than an ENOENT spawn error.
    const runAz = async () => ({ code: 1, stdout: "", stderr: "'az' is not recognized as an internal or external command,\noperable program or batch file.", spawnError: null });
    const r = await getAzdoAccessToken({ runAz });
    assert.equal(r.token, undefined);
    assert.equal(r.errorKind, "not_installed");
    assert.match(r.error, /not found|aka\.ms\/azure-cli/i);
});


test("getAzdoAccessToken: success returns the token", async () => {
    const runAz = async (args) => {
        assert.ok(args.includes("get-access-token"));
        assert.ok(args.includes("499b84ac-1321-427f-aa17-267ca6975798"));
        return { code: 0, stdout: JSON.stringify({ accessToken: "tok-123", expiresOn: "2099-01-01" }), stderr: "", spawnError: null };
    };
    const r = await getAzdoAccessToken({ runAz });
    assert.equal(r.token, "tok-123");
    assert.equal(r.error, undefined);
});

test("getAzdoAccessToken: unparsable stdout → parse_failed", async () => {
    const runAz = async () => ({ code: 0, stdout: "not json", stderr: "", spawnError: null });
    const r = await getAzdoAccessToken({ runAz });
    assert.equal(r.errorKind, "parse_failed");
});

test("getAzdoAccessToken: empty token → empty_token", async () => {
    const runAz = async () => ({ code: 0, stdout: JSON.stringify({ accessToken: "" }), stderr: "", spawnError: null });
    const r = await getAzdoAccessToken({ runAz });
    assert.equal(r.errorKind, "empty_token");
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

test("summarizeAzdoRuns: SKIPPED/NEUTRAL count as skipped (not success)", () => {
    const runs = [
        { name: "a", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=9", status: "COMPLETED", conclusion: "SKIPPED" },
        { name: "b", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=9", status: "COMPLETED", conclusion: "NEUTRAL" },
    ];
    const got = summarizeAzdoRuns(runs);
    assert.equal(got.summary.success, 0);
    assert.equal(got.summary.skipped, 2);
    assert.equal(got.summary.overall, "skipped");
});

test("summarizeAzdoRuns: success outranks skipped for overall", () => {
    const got = summarizeAzdoRuns([
        { name: "a", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=9", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "b", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=9", status: "COMPLETED", conclusion: "SKIPPED" },
    ]);
    assert.equal(got.summary.success, 1);
    assert.equal(got.summary.skipped, 1);
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

test("summarizeAzdoRuns: URL without buildId grouped per definition URL", () => {
    const got = summarizeAzdoRuns([
        { name: "x", detailsUrl: "https://dev.azure.com/o/p/some/other/path", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.equal(got.builds.length, 1);
    assert.equal(got.builds[0].buildId, null);
});

test("summarizeAzdoRuns: distinct definition URLs without buildId stay separate", () => {
    const got = summarizeAzdoRuns([
        { name: "pipe-a", detailsUrl: "https://dev.azure.com/o/p/_build/definition?definitionId=1", status: "COMPLETED", conclusion: "NEUTRAL" },
        { name: "pipe-b", detailsUrl: "https://dev.azure.com/o/p/_build/definition?definitionId=2", status: "COMPLETED", conclusion: "NEUTRAL" },
    ]);
    assert.equal(got.builds.length, 2);
    assert.ok(got.builds.every((b) => b.buildId === null));
});

test("summarizeAzdoRuns: definition-only build gets a GitHub checks deep-link from prUrl", () => {
    const got = summarizeAzdoRuns(
        [
            { name: "dotnet-unified-build", detailsUrl: "https://dev.azure.com/o/p/_build/definition?definitionId=278", status: "COMPLETED", conclusion: "NEUTRAL", databaseId: 81456047644 },
        ],
        { prUrl: "https://github.com/dotnet/dotnet/pull/7085" },
    );
    assert.equal(got.builds.length, 1);
    assert.equal(got.builds[0].buildId, null);
    assert.equal(got.builds[0].githubUrl, "https://github.com/dotnet/dotnet/pull/7085/checks?check_run_id=81456047644");
});

test("summarizeAzdoRuns: no githubUrl when prUrl absent or no databaseId", () => {
    const noPrUrl = summarizeAzdoRuns([
        { name: "pipe", detailsUrl: "https://dev.azure.com/o/p/_build/definition?definitionId=1", status: "COMPLETED", conclusion: "NEUTRAL", databaseId: 99 },
    ]);
    assert.equal(noPrUrl.builds[0].githubUrl, null);

    const noId = summarizeAzdoRuns(
        [{ name: "pipe", detailsUrl: "https://dev.azure.com/o/p/_build/definition?definitionId=1", status: "COMPLETED", conclusion: "NEUTRAL" }],
        { prUrl: "https://github.com/o/r/pull/1" },
    );
    assert.equal(noId.builds[0].githubUrl, null);
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

// --- fetchAzdoBuild (anonymous + Azure CLI fallback) ----------------------

const buildOk = {
    status: "completed",
    result: "succeeded",
    buildNumber: "20240101.1",
    _links: { web: { href: "https://dev.azure.com/org/Project/_build/results?buildId=1" } },
};
const timelineOk = { records: [{ id: "j1", type: "Job", name: "Job A", state: "completed", result: "succeeded" }] };

function signinResp() {
    return new Response("<html>signin</html>", { status: 203, headers: { "content-type": "text/html" } });
}

test("fetchAzdoBuild: anonymous success does not touch the Azure CLI", async () => {
    let azCalls = 0;
    const runAz = async () => { azCalls++; return { code: 0, stdout: "{}", stderr: "", spawnError: null }; };
    fetchPlan = [
        (url) => url.includes("/timeline") ? jsonResp(timelineOk) : jsonResp(buildOk),
        (url) => url.includes("/timeline") ? jsonResp(timelineOk) : jsonResp(buildOk),
    ];
    const r = await fetchAzdoBuild({ org: "org", project: "PubProj", buildId: "8001", runAz });
    assert.equal(r.error, null);
    assert.equal(r.auth, "anonymous");
    assert.equal(r.data.build.buildNumber, "20240101.1");
    assert.equal(r.data.records.length, 1);
    assert.equal(azCalls, 0);
});

test("fetchAzdoBuild: anonymous non-auth error surfaces without trying the Azure CLI", async () => {
    let azCalls = 0;
    const runAz = async () => { azCalls++; return { code: 0, stdout: "{}", stderr: "", spawnError: null }; };
    fetchPlan = [
        async () => new Response("{}", { status: 500, statusText: "Server Error", headers: { "content-type": "application/json" } }),
        async () => new Response("{}", { status: 500, statusText: "Server Error", headers: { "content-type": "application/json" } }),
    ];
    const r = await fetchAzdoBuild({ org: "org", project: "ErrProj", buildId: "8002", runAz });
    assert.equal(r.data, null);
    assert.equal(r.errorKind, "fetch_failed");
    assert.equal(azCalls, 0);
});

test("fetchAzdoBuild: auth-required falls back to Azure CLI token and succeeds", async () => {
    let azCalls = 0;
    const runAz = async () => { azCalls++; return { code: 0, stdout: JSON.stringify({ accessToken: "tok" }), stderr: "", spawnError: null }; };
    fetchPlan = [
        signinResp,
        signinResp,
        (url) => url.includes("/timeline") ? jsonResp(timelineOk) : jsonResp(buildOk),
        (url) => url.includes("/timeline") ? jsonResp(timelineOk) : jsonResp(buildOk),
    ];
    const r = await fetchAzdoBuild({ org: "org", project: "PrivProj", buildId: "8003", runAz });
    assert.equal(r.error, null);
    assert.equal(r.auth, "azure-cli");
    assert.equal(r.data.build.buildNumber, "20240101.1");
    assert.equal(azCalls, 1);
    // The authenticated fetch carried a Bearer token.
    assert.equal(fetchCalls.length, 4);
});

test("createSharedTokenGetter spawns az at most once across concurrent callers", async () => {
    let azCalls = 0;
    const runAz = async () => { azCalls++; return { code: 0, stdout: JSON.stringify({ accessToken: "shared-tok" }), stderr: "", spawnError: null }; };
    const getToken = createSharedTokenGetter({ runAz });
    const [a, b, c] = await Promise.all([getToken(), getToken(), getToken()]);
    assert.equal(azCalls, 1);
    assert.equal(a.token, "shared-tok");
    assert.equal(b.token, "shared-tok");
    assert.equal(c.token, "shared-tok");
});

test("fetchAzdoBuild: auth-required + az not installed → not_installed error", async () => {
    const runAz = async () => ({ code: null, stdout: "", stderr: "", spawnError: Object.assign(new Error("spawn az ENOENT"), { code: "ENOENT" }) });
    fetchPlan = [signinResp, signinResp];
    const r = await fetchAzdoBuild({ org: "org", project: "PrivProj2", buildId: "8004", runAz });
    assert.equal(r.data, null);
    assert.equal(r.errorKind, "not_installed");
    assert.equal(r.auth, "azure-cli");
    assert.match(r.error, /Azure CLI/i);
});

test("fetchAzdoBuild: passes Bearer token on the authenticated retry", async () => {
    const runAz = async () => ({ code: 0, stdout: JSON.stringify({ accessToken: "secret-tok" }), stderr: "", spawnError: null });
    const seenAuth = [];
    // Override the stub fetch to capture headers for this test.
    globalThis.fetch = async (url, opts) => {
        fetchCalls.push(url);
        seenAuth.push(opts?.headers?.Authorization ?? null);
        // First two (anonymous) → sign-in; next two (authed) → json.
        if (seenAuth.length <= 2) return signinResp();
        return url.includes("/timeline") ? jsonResp(timelineOk) : jsonResp(buildOk);
    };
    const r = await fetchAzdoBuild({ org: "org", project: "PrivProj3", buildId: "8005", runAz });
    assert.equal(r.auth, "azure-cli");
    assert.equal(seenAuth[0], null);
    assert.equal(seenAuth[1], null);
    assert.equal(seenAuth[2], "Bearer secret-tok");
    assert.equal(seenAuth[3], "Bearer secret-tok");
});
