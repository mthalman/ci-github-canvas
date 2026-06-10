// Azure DevOps helpers: URL parsing, build-timeline fetch, and per-PR
// summarization of AzDO check runs (grouped by build).

import {
    AZDO_BUILD_ID_RE,
    AZDO_TIMELINE_CACHE_TTL_MS,
    AZDO_URL_RE,
} from "./constants.mjs";

// Parse {org, project} from an AzDO check-run detailsUrl. Returns nulls when
// the URL doesn't match a known shape (e.g. unexpected legacy collection URL).
// Project names may be percent-encoded (e.g. "My%20Project"); we keep the
// decoded form for display/cache keys and re-encode when calling the API.
export function parseAzdoUrl(detailsUrl) {
    try {
        const u = new URL(detailsUrl);
        const segments = u.pathname.split("/").filter(Boolean);
        if (/^dev\.azure\.com$/i.test(u.hostname)) {
            // dev.azure.com/{org}/{project}/_build/results?buildId=N
            return {
                org: segments[0] ?? null,
                project: segments[1] ? decodeURIComponent(segments[1]) : null,
            };
        }
        const vsMatch = u.hostname.match(/^([^.]+)\.visualstudio\.com$/i);
        if (vsMatch) {
            // {org}.visualstudio.com/{project}/_build/results?buildId=N
            return {
                org: vsMatch[1],
                project: segments[0] ? decodeURIComponent(segments[0]) : null,
            };
        }
    } catch {
        // fall through
    }
    return { org: null, project: null };
}

// Fetch the AzDO build timeline + top-level build info for one build.
// Anonymous only: public orgs (e.g. dnceng-public) work; private orgs will
// surface the AzDO error (typically 203 redirect / 401) in the timeline panel.
const azdoTimelineCache = new Map(); // key -> { at, value, error }
const azdoTimelineInFlight = new Map(); // key -> Promise

async function fetchAzdoJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const contentType = res.headers.get("content-type") ?? "";
    // AzDO sign-in / auth-required responses are typically 203 with an HTML
    // body, or 401/403. Detect those before trying to parse JSON.
    if (!contentType.includes("application/json")) {
        const status = res.status === 203 ? "203 (sign-in required)" : res.status;
        throw new Error(`Azure DevOps returned ${status} — build may be in a private project (anonymous access only).`);
    }
    if (!res.ok) {
        throw new Error(`Azure DevOps HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
}

export async function fetchAzdoTimeline({ org, project, buildId, force = false }) {
    const key = `${org}|${project}|${buildId}`;
    const now = Date.now();
    if (!force) {
        const cached = azdoTimelineCache.get(key);
        if (cached && now - cached.at < AZDO_TIMELINE_CACHE_TTL_MS) {
            return { data: cached.value, cachedAt: cached.at, error: cached.error };
        }
        const inflight = azdoTimelineInFlight.get(key);
        if (inflight) return inflight;
    }
    const promise = (async () => {
        const projectEnc = encodeURIComponent(project);
        const orgEnc = encodeURIComponent(org);
        const buildUrl = `https://dev.azure.com/${orgEnc}/${projectEnc}/_apis/build/builds/${buildId}?api-version=7.1`;
        const timelineUrl = `https://dev.azure.com/${orgEnc}/${projectEnc}/_apis/build/builds/${buildId}/timeline?api-version=7.1`;
        try {
            const [build, timeline] = await Promise.all([
                fetchAzdoJson(buildUrl),
                fetchAzdoJson(timelineUrl),
            ]);
            const value = {
                build: {
                    status: build.status,
                    result: build.result,
                    startTime: build.startTime,
                    finishTime: build.finishTime,
                    url: build._links?.web?.href ?? null,
                    buildNumber: build.buildNumber,
                },
                records: (timeline?.records ?? []).map((r) => ({
                    id: r.id,
                    parentId: r.parentId,
                    type: r.type,
                    name: r.name,
                    state: r.state,
                    result: r.result,
                    order: r.order,
                    startTime: r.startTime,
                    finishTime: r.finishTime,
                    percentComplete: r.percentComplete,
                    log: r.log ? { url: r.log.url } : null,
                })),
            };
            azdoTimelineCache.set(key, { at: now, value, error: null });
            return { data: value, cachedAt: now, error: null };
        } catch (err) {
            azdoTimelineCache.set(key, { at: now, value: null, error: err.message });
            return { data: null, cachedAt: now, error: err.message };
        } finally {
            azdoTimelineInFlight.delete(key);
        }
    })();
    azdoTimelineInFlight.set(key, promise);
    return promise;
}

// Reduce a flat list of check runs into AzDO-only buckets, grouped by buildId.
// Returns { builds: [...], summary: { total, success, failure, inProgress, ... }, hasAny }.
export function summarizeAzdoRuns(runs) {
    const azdoRuns = runs.filter((r) => r?.detailsUrl && AZDO_URL_RE.test(r.detailsUrl));
    if (azdoRuns.length === 0) {
        return { hasAny: false, builds: [], summary: null };
    }
    const builds = new Map();
    for (const r of azdoRuns) {
        const idMatch = r.detailsUrl.match(AZDO_BUILD_ID_RE);
        const key = idMatch ? `b:${idMatch[1]}` : `u:${new URL(r.detailsUrl).origin}`;
        const { org, project } = parseAzdoUrl(r.detailsUrl);
        let entry = builds.get(key);
        if (!entry) {
            entry = {
                buildId: idMatch?.[1] ?? null,
                org,
                project,
                summaryUrl: idMatch ? r.detailsUrl.replace(/&view=.*$/, "").replace(/&jobId=.*$/, "") : r.detailsUrl,
                runs: [],
            };
            builds.set(key, entry);
        }
        entry.runs.push({
            name: r.name,
            status: r.status,           // QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING
            conclusion: r.conclusion,   // SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STARTUP_FAILURE | STALE | null
            detailsUrl: r.detailsUrl,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
        });
    }
    const summary = { total: 0, success: 0, failure: 0, inProgress: 0, other: 0 };
    for (const b of builds.values()) {
        for (const r of b.runs) {
            summary.total++;
            if (r.status !== "COMPLETED") summary.inProgress++;
            else if (r.conclusion === "SUCCESS" || r.conclusion === "NEUTRAL" || r.conclusion === "SKIPPED") summary.success++;
            else if (r.conclusion === "FAILURE" || r.conclusion === "TIMED_OUT" || r.conclusion === "STARTUP_FAILURE" || r.conclusion === "ACTION_REQUIRED") summary.failure++;
            else summary.other++;
        }
    }
    summary.overall =
        summary.failure > 0 ? "failure" :
        summary.inProgress > 0 ? "in_progress" :
        summary.success > 0 ? "success" : "other";
    return {
        hasAny: true,
        builds: [...builds.values()].sort((a, b) => Number(b.buildId ?? 0) - Number(a.buildId ?? 0)),
        summary,
    };
}
