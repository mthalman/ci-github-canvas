// GitHub Actions (and other non-AzDO) check-run summarization.
//
// Group non-AzDO check runs per workflow, mirroring how AzDO runs are grouped
// per pipeline build. Each Actions workflow run becomes one card listing its
// jobs; checks that don't belong to a workflow (GitHub App checks like
// "license/cla") each become their own single-check group.
// Returns { hasAny, workflows: [...], runs: [...], summary: {...} }.
//
// The grouping/workflow data comes from each check run's check suite:
//   workflowName  - suite.workflowRun.workflow.name (null for non-Actions)
//   workflowUrl   - suite.workflowRun.url
//   workflowRunId - suite.workflowRun.databaseId
// The flatten step in github.mjs / watched.mjs copies these onto each run.
//
// Dedup: GitHub keeps every check-run a commit ever had, so re-running a
// workflow (or close/reopen triggering one) leaves the older check-runs on the
// commit too. Within a group we keep only the newest workflow invocation
// (highest run id), so each workflow's latest run wins. For non-workflow checks
// the group key is the check name, which preserves the old "latest run per job
// name" dedupe behaviour.

import { AZDO_URL_RE } from "./constants.mjs";

function classify(summary, r) {
    summary.total++;
    if (r.status !== "COMPLETED") summary.inProgress++;
    else if (r.conclusion === "NEUTRAL" || r.conclusion === "SKIPPED") summary.skipped++;
    else if (r.conclusion === "SUCCESS") summary.success++;
    else if (r.conclusion === "FAILURE" || r.conclusion === "TIMED_OUT" || r.conclusion === "STARTUP_FAILURE" || r.conclusion === "ACTION_REQUIRED") summary.failure++;
    else summary.other++;
}

function overallOf(summary) {
    return summary.failure > 0 ? "failure" :
        summary.inProgress > 0 ? "in_progress" :
        summary.success > 0 ? "success" :
        summary.skipped > 0 ? "skipped" : "other";
}

function startTime(r) {
    return r.startedAt ? new Date(r.startedAt).getTime() : Infinity;
}

function byStartThenName(a, b) {
    const ta = startTime(a), tb = startTime(b);
    if (ta !== tb) return ta - tb;
    return String(a.name).localeCompare(String(b.name));
}

export function summarizeGhaRuns(runs) {
    const ghaRuns = runs.filter((r) => r?.detailsUrl && !AZDO_URL_RE.test(r.detailsUrl));
    if (ghaRuns.length === 0) {
        return { hasAny: false, workflows: [], runs: [], summary: null };
    }

    // Group by workflow (Actions) or by check name (non-workflow GitHub App
    // checks). Within a group, keep only the newest invocation's runs.
    const groups = new Map();
    for (const r of ghaRuns) {
        const runIdMatch = typeof r.detailsUrl === "string" ? r.detailsUrl.match(/\/actions\/runs\/(\d+)\b/) : null;
        const parsedRunId = runIdMatch ? Number(runIdMatch[1]) : 0;
        const runId = r.workflowRunId != null ? Number(r.workflowRunId) : parsedRunId;
        const wfName = r.workflowName || null;
        const wfUrl = r.workflowUrl
            || (runIdMatch && typeof r.detailsUrl === "string" ? r.detailsUrl.replace(/\/job\/.*$/, "") : null);
        const key = wfName ? `w:${wfName}` : `c:${r.name}`;
        let g = groups.get(key);
        if (!g) {
            g = { name: wfName || r.name, url: wfName ? wfUrl : r.detailsUrl, isWorkflow: !!wfName, runId, runsByName: new Map() };
            groups.set(key, g);
        }
        if (runId > g.runId) {
            // A newer invocation supersedes everything we collected so far.
            g.runId = runId;
            g.runsByName = new Map();
            if (wfName) g.url = wfUrl;
        } else if (runId < g.runId) {
            continue; // stale invocation
        }
        if (!g.runsByName.has(r.name)) {
            g.runsByName.set(r.name, {
                name: r.name,
                status: r.status,
                conclusion: r.conclusion,
                detailsUrl: r.detailsUrl,
                startedAt: r.startedAt,
                completedAt: r.completedAt,
            });
        }
    }

    const summary = { total: 0, success: 0, failure: 0, inProgress: 0, skipped: 0, other: 0 };
    const workflows = [];
    const flat = [];
    for (const g of groups.values()) {
        const gRuns = [...g.runsByName.values()].sort(byStartThenName);
        const gSummary = { total: 0, success: 0, failure: 0, inProgress: 0, skipped: 0, other: 0 };
        for (const r of gRuns) {
            classify(summary, r);
            classify(gSummary, r);
            flat.push(r);
        }
        gSummary.overall = overallOf(gSummary);
        workflows.push({
            name: g.name,
            url: g.url,
            isWorkflow: g.isWorkflow,
            runs: gRuns,
            summary: gSummary,
            overall: gSummary.overall,
        });
    }
    summary.overall = overallOf(summary);

    // Workflows first (alphabetical), then standalone checks; each by name.
    workflows.sort((a, b) => {
        if (a.isWorkflow !== b.isWorkflow) return a.isWorkflow ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
    });
    flat.sort(byStartThenName);

    return { hasAny: true, workflows, runs: flat, summary };
}
