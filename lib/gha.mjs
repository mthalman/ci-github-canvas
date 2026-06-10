// GitHub Actions (and other non-AzDO) check-run summarization.
//
// Flatten non-AzDO check runs into a single list. Each GHA check run becomes
// one row; we used to group by workflow name (the part before " / " in the
// check name) but that produced spurious parent/child cards for GitHub App
// checks like "license/cla" whose name happens to contain "/".
// Returns { runs: [...], summary: {...}, hasAny }.
//
// Dedup: GitHub keeps every check-run a commit ever had, so re-running a
// workflow (or close/reopen triggering one) leaves the older check-runs on
// the commit too. We dedupe by job name, keeping the entry whose workflow
// run id (parsed from detailsUrl `/actions/runs/{id}/job/...`) is highest,
// so each workflow's latest invocation wins. Jobs with unique names across
// workflows are unaffected.

import { AZDO_URL_RE } from "./constants.mjs";

export function summarizeGhaRuns(runs) {
    const ghaRuns = runs.filter((r) => r?.detailsUrl && !AZDO_URL_RE.test(r.detailsUrl));
    if (ghaRuns.length === 0) {
        return { hasAny: false, runs: [], summary: null };
    }
    const dedupedByName = new Map();
    for (const r of ghaRuns) {
        const runIdMatch = typeof r.detailsUrl === "string"
            ? r.detailsUrl.match(/\/actions\/runs\/(\d+)\b/)
            : null;
        const runId = runIdMatch ? Number(runIdMatch[1]) : 0;
        const existing = dedupedByName.get(r.name);
        if (!existing || runId > existing.__runId) {
            dedupedByName.set(r.name, Object.assign({}, r, { __runId: runId }));
        }
    }
    const summary = { total: 0, success: 0, failure: 0, inProgress: 0, other: 0 };
    const shaped = [...dedupedByName.values()].map((r) => {
        summary.total++;
        if (r.status !== "COMPLETED") summary.inProgress++;
        else if (r.conclusion === "SUCCESS" || r.conclusion === "NEUTRAL" || r.conclusion === "SKIPPED") summary.success++;
        else if (r.conclusion === "FAILURE" || r.conclusion === "TIMED_OUT" || r.conclusion === "STARTUP_FAILURE" || r.conclusion === "ACTION_REQUIRED") summary.failure++;
        else summary.other++;
        return {
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            detailsUrl: r.detailsUrl,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
        };
    });
    summary.overall =
        summary.failure > 0 ? "failure" :
        summary.inProgress > 0 ? "in_progress" :
        summary.success > 0 ? "success" : "other";
    // Sort by start time for parity with AzDO job ordering.
    shaped.sort((a, b) => {
        const ta = a.startedAt ? new Date(a.startedAt).getTime() : Infinity;
        const tb = b.startedAt ? new Date(b.startedAt).getTime() : Infinity;
        if (ta !== tb) return ta - tb;
        return String(a.name).localeCompare(String(b.name));
    });
    return { hasAny: true, runs: shaped, summary };
}
