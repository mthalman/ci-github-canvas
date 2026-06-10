// Tests for lib/gha.mjs: GitHub Actions check-run summarization.
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeGhaRuns } from "../lib/gha.mjs";

test("summarizeGhaRuns: returns hasAny=false when nothing matches", () => {
    const got = summarizeGhaRuns([
        { name: "azdo", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=1", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.deepEqual(got, { hasAny: false, runs: [], summary: null });
});

test("summarizeGhaRuns: empty input → hasAny=false", () => {
    const got = summarizeGhaRuns([]);
    assert.equal(got.hasAny, false);
});

test("summarizeGhaRuns: dedupes by name keeping the highest runId", () => {
    const runs = [
        { name: "build", detailsUrl: "https://github.com/o/r/actions/runs/10/job/100", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2024-01-01T00:00:00Z" },
        { name: "build", detailsUrl: "https://github.com/o/r/actions/runs/20/job/200", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2024-01-02T00:00:00Z" },
        { name: "lint",  detailsUrl: "https://github.com/o/r/actions/runs/15/job/150", status: "IN_PROGRESS", conclusion: null,    startedAt: "2024-01-01T00:00:00Z" },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.hasAny, true);
    assert.equal(got.runs.length, 2);
    const buildRun = got.runs.find((r) => r.name === "build");
    assert.equal(buildRun.conclusion, "SUCCESS", "should keep the newer run (higher id)");
    assert.equal(got.summary.total, 2);
    assert.equal(got.summary.success, 1);
    assert.equal(got.summary.inProgress, 1);
    assert.equal(got.summary.overall, "in_progress");
});

test("summarizeGhaRuns: sorts by startedAt then by name", () => {
    const runs = [
        { name: "z", detailsUrl: "https://github.com/o/r/actions/runs/1", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2024-01-02T00:00:00Z" },
        { name: "a", detailsUrl: "https://github.com/o/r/actions/runs/2", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2024-01-01T00:00:00Z" },
        { name: "b", detailsUrl: "https://github.com/o/r/actions/runs/3", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2024-01-01T00:00:00Z" },
    ];
    const got = summarizeGhaRuns(runs);
    assert.deepEqual(got.runs.map((r) => r.name), ["a", "b", "z"]);
});

test("summarizeGhaRuns: missing startedAt sorts to the end", () => {
    const runs = [
        { name: "withTime", detailsUrl: "https://github.com/o/r/actions/runs/1", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2024-01-02T00:00:00Z" },
        { name: "nullTime", detailsUrl: "https://github.com/o/r/actions/runs/2", status: "COMPLETED", conclusion: "SUCCESS", startedAt: null },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.runs[0].name, "withTime");
    assert.equal(got.runs[1].name, "nullTime");
});

test("summarizeGhaRuns: classification matches azdo's (failure dominates over success for overall)", () => {
    const runs = [
        { name: "a", detailsUrl: "https://github.com/o/r/actions/runs/1", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "b", detailsUrl: "https://github.com/o/r/actions/runs/2", status: "COMPLETED", conclusion: "FAILURE" },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.summary.overall, "failure");
});

test("summarizeGhaRuns: failure dominates over in_progress for overall", () => {
    const runs = [
        { name: "a", detailsUrl: "https://github.com/o/r/actions/runs/1", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "b", detailsUrl: "https://github.com/o/r/actions/runs/2", status: "QUEUED",    conclusion: null },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.summary.inProgress, 1);
    assert.equal(got.summary.overall, "failure");
});

test("summarizeGhaRuns: in_progress wins when there are no failures", () => {
    const runs = [
        { name: "a", detailsUrl: "https://github.com/o/r/actions/runs/1", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "b", detailsUrl: "https://github.com/o/r/actions/runs/2", status: "QUEUED",    conclusion: null },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.summary.overall, "in_progress");
});

test("summarizeGhaRuns: CANCELLED counts as 'other'", () => {
    const got = summarizeGhaRuns([
        { name: "x", detailsUrl: "https://github.com/o/r/actions/runs/1", status: "COMPLETED", conclusion: "CANCELLED" },
    ]);
    assert.equal(got.summary.other, 1);
    assert.equal(got.summary.overall, "other");
});

test("summarizeGhaRuns: dedupe falls back to runId=0 when no runId in URL", () => {
    const runs = [
        { name: "j", detailsUrl: "https://example.com/whatever",           status: "COMPLETED", conclusion: "FAILURE", startedAt: "2024-01-01T00:00:00Z" },
        { name: "j", detailsUrl: "https://github.com/o/r/actions/runs/5",  status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2024-01-01T00:00:00Z" },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.runs.length, 1);
    assert.equal(got.runs[0].conclusion, "SUCCESS");
});

test("summarizeGhaRuns: ignores items with no detailsUrl", () => {
    const got = summarizeGhaRuns([{ name: "n", status: "COMPLETED", conclusion: "SUCCESS" }, null]);
    assert.equal(got.hasAny, false);
});
