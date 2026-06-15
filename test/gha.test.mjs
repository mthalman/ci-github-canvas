// Tests for lib/gha.mjs: GitHub Actions check-run summarization.
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeGhaRuns } from "../lib/gha.mjs";

test("summarizeGhaRuns: returns hasAny=false when nothing matches", () => {
    const got = summarizeGhaRuns([
        { name: "azdo", detailsUrl: "https://dev.azure.com/o/p/_build/results?buildId=1", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.deepEqual(got, { hasAny: false, workflows: [], runs: [], summary: null });
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

test("summarizeGhaRuns: SKIPPED/NEUTRAL count as skipped (not success)", () => {
    const got = summarizeGhaRuns([
        { name: "a", detailsUrl: "https://github.com/o/r/actions/runs/1", status: "COMPLETED", conclusion: "SKIPPED" },
        { name: "b", detailsUrl: "https://github.com/o/r/actions/runs/2", status: "COMPLETED", conclusion: "NEUTRAL" },
    ]);
    assert.equal(got.summary.success, 0);
    assert.equal(got.summary.skipped, 2);
    assert.equal(got.summary.overall, "skipped");
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

test("summarizeGhaRuns: groups jobs by workflow", () => {
    const runs = [
        { name: "CI / build", workflowName: "CI", workflowRunId: 100, workflowUrl: "https://github.com/o/r/actions/runs/100", detailsUrl: "https://github.com/o/r/actions/runs/100/job/1", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "CI / test",  workflowName: "CI", workflowRunId: 100, workflowUrl: "https://github.com/o/r/actions/runs/100", detailsUrl: "https://github.com/o/r/actions/runs/100/job/2", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "Lint / lint", workflowName: "Lint", workflowRunId: 200, workflowUrl: "https://github.com/o/r/actions/runs/200", detailsUrl: "https://github.com/o/r/actions/runs/200/job/3", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.workflows.length, 2);
    const ci = got.workflows.find((w) => w.name === "CI");
    assert.equal(ci.isWorkflow, true);
    assert.equal(ci.url, "https://github.com/o/r/actions/runs/100");
    assert.equal(ci.runs.length, 2);
    assert.equal(ci.overall, "failure");
    const lint = got.workflows.find((w) => w.name === "Lint");
    assert.equal(lint.runs.length, 1);
    assert.equal(lint.overall, "success");
    assert.equal(got.summary.total, 3);
    assert.equal(got.summary.overall, "failure");
});

test("summarizeGhaRuns: same-named jobs in different workflows stay separate", () => {
    const runs = [
        { name: "build", workflowName: "A", workflowRunId: 1, detailsUrl: "https://github.com/o/r/actions/runs/1/job/1", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "build", workflowName: "B", workflowRunId: 2, detailsUrl: "https://github.com/o/r/actions/runs/2/job/2", status: "COMPLETED", conclusion: "FAILURE" },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.workflows.length, 2);
    assert.equal(got.summary.total, 2);
});

test("summarizeGhaRuns: newer workflow invocation supersedes the older one", () => {
    const runs = [
        { name: "CI / build", workflowName: "CI", workflowRunId: 10, detailsUrl: "https://github.com/o/r/actions/runs/10/job/1", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "CI / build", workflowName: "CI", workflowRunId: 20, detailsUrl: "https://github.com/o/r/actions/runs/20/job/1", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    const got = summarizeGhaRuns(runs);
    assert.equal(got.workflows.length, 1);
    assert.equal(got.workflows[0].runs.length, 1);
    assert.equal(got.workflows[0].runs[0].conclusion, "SUCCESS");
    assert.equal(got.workflows[0].url, "https://github.com/o/r/actions/runs/20");
});

test("summarizeGhaRuns: non-workflow checks become standalone groups", () => {
    const runs = [
        { name: "CI / build", workflowName: "CI", workflowRunId: 1, detailsUrl: "https://github.com/o/r/actions/runs/1/job/1", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "license/cla", detailsUrl: "https://cla.example.com/check", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    const got = summarizeGhaRuns(runs);
    const cla = got.workflows.find((w) => w.name === "license/cla");
    assert.ok(cla, "standalone check should be its own group");
    assert.equal(cla.isWorkflow, false);
    assert.equal(cla.runs.length, 1);
    // Workflows sort before standalone checks.
    assert.equal(got.workflows[0].name, "CI");
});
