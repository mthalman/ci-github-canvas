// Azure DevOps helpers: URL parsing, build-timeline fetch, and per-PR
// summarization of AzDO check runs (grouped by build).

import { spawn } from "node:child_process";

import {
    AZDO_BUILD_ID_RE,
    AZDO_RESOURCE_ID,
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

// Parse a full AzDO *build results* URL into { org, project, buildId }. Unlike
// parseAzdoUrl (which only needs org/project for the timeline API), this also
// requires a numeric buildId, so it's the validator for the ad-hoc "inspect a
// CI run by URL" entry point. Returns null when the URL isn't a recognizable
// dev.azure.com / *.visualstudio.com build-results URL carrying a buildId.
export function parseAzdoBuildUrl(input) {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (!AZDO_URL_RE.test(trimmed)) return null;
    const { org, project } = parseAzdoUrl(trimmed);
    if (!org || !project) return null;
    const idMatch = trimmed.match(/[?&]buildId=(\d{1,12})(?=$|[&#])/i);
    if (!idMatch) return null;
    const buildId = idMatch[1];
    // AZDO_BUILD_ID_RE (used elsewhere for grouping) only needs a numeric prefix,
    // but as the validator for a user-supplied ciRunUrl we require the buildId
    // parameter value to be *entirely* numeric (terminated by &, # or end of
    // string) so e.g. "buildId=123abc" is rejected instead of silently treated
    // as build 123.
    // Validate the extracted shapes the same way /api/azdo-timeline does, so a
    // crafted URL can't smuggle control chars/separators or absurd lengths into
    // the values that build the server-side dev.azure.com request.
    const orgOk = /^[A-Za-z0-9._-]{1,64}$/.test(org);
    const projectOk = project.length > 0 && project.length <= 128 && !/[\/\\?#\x00-\x1f]/.test(project);
    const buildIdOk = /^\d{1,12}$/.test(buildId);
    if (!orgOk || !projectOk || !buildIdOk) return null;
    return { org, project, buildId };
}

// Fetch the AzDO build timeline + top-level build info for one build.
// Anonymous by default: public orgs (e.g. dnceng-public) work without auth.
// A caller may pass a Bearer token (from the Azure CLI) to read private
// projects; auth-required failures set `err.authRequired` so the ad-hoc
// CI-run path can decide whether to retry with a token.
const azdoTimelineCache = new Map(); // key -> { at, value, error }
const azdoTimelineInFlight = new Map(); // key -> Promise

async function fetchAzdoJson(url, { token } = {}) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    const contentType = res.headers.get("content-type") ?? "";
    // AzDO sign-in / auth-required responses are typically 203 with an HTML
    // body, or 401/403. Detect those before trying to parse JSON.
    if (!contentType.includes("application/json")) {
        const status = res.status === 203 ? "203 (sign-in required)" : res.status;
        const err = new Error(`Azure DevOps returned ${status} — build may be in a private project.`);
        err.authRequired = res.status === 203 || res.status === 401 || res.status === 403;
        throw err;
    }
    if (!res.ok) {
        const err = new Error(`Azure DevOps HTTP ${res.status} ${res.statusText}`);
        err.authRequired = res.status === 401 || res.status === 403;
        throw err;
    }
    return res.json();
}

// Shape the raw build + timeline JSON into the compact form the UI consumes.
// Shared by fetchAzdoTimeline (PR-attached builds) and fetchAzdoBuild (ad-hoc
// CI-run-by-URL), so both produce identical record/build structures.
function shapeBuildTimeline(build, timeline) {
    return {
        build: {
            status: build.status,
            result: build.result,
            startTime: build.startTime,
            finishTime: build.finishTime,
            url: build._links?.web?.href ?? null,
            buildNumber: build.buildNumber,
            definition: build.definition?.name ?? null,
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
            const value = shapeBuildTimeline(build, timeline);
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

// Run the Azure CLI, capturing stdout/stderr/exit-code. Resolves (never
// rejects) so callers get a uniform shape; spawn failures (e.g. `az` not on
// PATH) come back as `spawnError`. Exposed as the default `runAz` injection
// point so tests can stub it without spawning a real process.
//
// On Windows `az` is a `.cmd`/`.bat` shim, which CreateProcess can't launch
// directly, so we go through the shell there. The argv is a fixed set of
// constants (no user input), so shell quoting can't be abused.
function defaultRunAz(args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn("az", args, { shell: process.platform === "win32" });
        } catch (spawnError) {
            resolve({ code: null, stdout: "", stderr: "", spawnError });
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        // Guard against a stalled `az` (e.g. a slow interactive AAD refresh)
        // hanging the HTTP response that awaits this token forever.
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* already exited */ }
            finish({ code: null, stdout, stderr, spawnError: new Error("Azure CLI (az) timed out after 30s.") });
        }, 30000);
        timer.unref?.();
        child.on("error", (spawnError) => finish({ code: null, stdout, stderr, spawnError }));
        child.stdout?.on("data", (d) => { stdout += d; });
        child.stderr?.on("data", (d) => { stderr += d; });
        child.on("close", (code) => finish({ code, stdout, stderr, spawnError: null }));
    });
}

// Acquire an Azure DevOps access token via the Azure CLI. Returns { token }
// on success, or { error, errorKind } with a user-facing message otherwise.
// errorKind ∈ not_installed | not_logged_in | spawn_failed | parse_failed | empty_token.
export async function getAzdoAccessToken({ runAz = defaultRunAz } = {}) {
    const res = await runAz([
        "account", "get-access-token",
        "--resource", AZDO_RESOURCE_ID,
        "--output", "json",
    ]);
    if (res.spawnError) {
        if (res.spawnError.code === "ENOENT") {
            return {
                error: "Azure CLI (az) was not found on your PATH. Install it from https://aka.ms/azure-cli, then run `az login` to view private Azure DevOps pipelines.",
                errorKind: "not_installed",
            };
        }
        return {
            error: `Failed to launch the Azure CLI (az): ${res.spawnError.message}`,
            errorKind: "spawn_failed",
        };
    }
    if (res.code !== 0) {
        const detail = (res.stderr || "").trim();
        // On Windows `az` is launched through cmd.exe (shell:true), so a missing
        // CLI surfaces as a normal non-zero exit ("'az' is not recognized…")
        // rather than an ENOENT spawn error. Sniff stderr so we still report the
        // actionable "not installed" message instead of "not signed in".
        if (/is not recognized|not recognized as an internal|command not found|no such file/i.test(detail)) {
            return {
                error: "Azure CLI (az) was not found on your PATH. Install it from https://aka.ms/azure-cli, then run `az login` to view private Azure DevOps pipelines.",
                errorKind: "not_installed",
            };
        }
        return {
            error: `Azure CLI is installed but couldn't get a token — you may not be signed in. Run \`az login\` to view private Azure DevOps pipelines.${detail ? `\n\n${detail}` : ""}`,
            errorKind: "not_logged_in",
        };
    }
    let token;
    try {
        token = JSON.parse(res.stdout)?.accessToken;
    } catch {
        return { error: "Could not parse the Azure CLI token response.", errorKind: "parse_failed" };
    }
    if (!token) {
        return { error: "The Azure CLI returned an empty access token.", errorKind: "empty_token" };
    }
    return { token };
}

// Build a token provider that calls getAzdoAccessToken at most once and shares
// the result (success or error) across every caller. Pass the returned function
// as fetchAzdoBuild's `getAccessToken` so a single refresh of many private runs
// spawns the Azure CLI once instead of once per run.
export function createSharedTokenGetter({ runAz = defaultRunAz } = {}) {
    let pending = null;
    return () => {
        if (!pending) pending = getAzdoAccessToken({ runAz });
        return pending;
    };
}

// Fetch a single build's info + timeline by org/project/buildId, transparently
// falling back to Azure CLI auth when anonymous access is refused. This backs
// the ad-hoc "inspect a CI run by URL" feature (a build that may belong to a
// private project, before any PR exists).
//
// Returns { data, cachedAt, error, errorKind, auth } where:
//   - auth      ∈ "anonymous" | "azure-cli" — how the data was obtained.
//   - errorKind ∈ the getAzdoAccessToken kinds, or "auth_required" / "fetch_failed".
const azdoBuildCache = new Map(); // key -> { at, value, error, errorKind, auth }
const azdoBuildInFlight = new Map(); // key -> Promise

export async function fetchAzdoBuild({ org, project, buildId, force = false, runAz = defaultRunAz, getAccessToken = null }) {
    // Acquire the Azure CLI token through the (optionally shared) provider so a
    // single refresh of N private runs spawns `az` once, not N times. Defaults
    // to a per-call acquisition when no shared provider is supplied.
    const acquireToken = getAccessToken ?? (() => getAzdoAccessToken({ runAz }));
    const key = `${org}|${project}|${buildId}`;
    const now = Date.now();
    if (!force) {
        const cached = azdoBuildCache.get(key);
        if (cached && now - cached.at < AZDO_TIMELINE_CACHE_TTL_MS) {
            return { data: cached.value, cachedAt: cached.at, error: cached.error, errorKind: cached.errorKind, auth: cached.auth };
        }
        const inflight = azdoBuildInFlight.get(key);
        if (inflight) return inflight;
    }
    const promise = (async () => {
        const projectEnc = encodeURIComponent(project);
        const orgEnc = encodeURIComponent(org);
        const buildUrl = `https://dev.azure.com/${orgEnc}/${projectEnc}/_apis/build/builds/${buildId}?api-version=7.1`;
        const timelineUrl = `https://dev.azure.com/${orgEnc}/${projectEnc}/_apis/build/builds/${buildId}/timeline?api-version=7.1`;
        const fetchBoth = async (opts) => {
            const [build, timeline] = await Promise.all([
                fetchAzdoJson(buildUrl, opts),
                fetchAzdoJson(timelineUrl, opts),
            ]);
            return shapeBuildTimeline(build, timeline);
        };
        // Cache the internal `value` (the shaped payload) and expose it to
        // callers as the documented `data` field — no redundant duplicate, and
        // no undocumented `value` leaking out in the response.
        const store = ({ value, error, errorKind, auth }) => {
            azdoBuildCache.set(key, { at: now, value, error, errorKind, auth });
            return { data: value, cachedAt: now, error, errorKind, auth };
        };
        // 1. Try anonymous first — public pipelines need no auth.
        try {
            const value = await fetchBoth();
            return store({ value, error: null, errorKind: null, auth: "anonymous" });
        } catch (anonErr) {
            if (!anonErr.authRequired) {
                return store({ value: null, error: anonErr.message, errorKind: "fetch_failed", auth: "anonymous" });
            }
            // 2. Anonymous was refused — fall back to Azure CLI auth (shared
            // across concurrent private runs so `az` is spawned at most once).
            const tok = await acquireToken();
            if (tok.error) {
                return store({ value: null, error: tok.error, errorKind: tok.errorKind, auth: "azure-cli" });
            }
            try {
                const value = await fetchBoth({ token: tok.token });
                return store({ value, error: null, errorKind: null, auth: "azure-cli" });
            } catch (authErr) {
                const errorKind = authErr.authRequired ? "auth_required" : "fetch_failed";
                const message = authErr.authRequired
                    ? `Azure DevOps denied access even with your Azure CLI sign-in. You may not have permission to view this pipeline.\n\n${authErr.message}`
                    : authErr.message;
                return store({ value: null, error: message, errorKind, auth: "azure-cli" });
            }
        } finally {
            azdoBuildInFlight.delete(key);
        }
    })();
    azdoBuildInFlight.set(key, promise);
    return promise;
}

// Reduce a flat list of check runs into AzDO-only buckets, grouped by buildId.
// Returns { builds: [...], summary: { total, success, failure, inProgress, ... }, hasAny }.
// prUrl (the PR's html_url) lets us build a GitHub checks deep-link for
// definition-only builds (skipped/queued pipelines with no buildId), where the
// AzDO link only points at the pipeline definition page rather than a run.
export function summarizeAzdoRuns(runs, { prUrl = null } = {}) {
    const azdoRuns = runs.filter((r) => r?.detailsUrl && AZDO_URL_RE.test(r.detailsUrl));
    if (azdoRuns.length === 0) {
        return { hasAny: false, builds: [], summary: null };
    }
    const builds = new Map();
    for (const r of azdoRuns) {
        const idMatch = r.detailsUrl.match(AZDO_BUILD_ID_RE);
        // Runs with a real buildId group by that id. Runs without one (e.g. a
        // pipeline that was skipped and only links to its `_build/definition`
        // page) group by their full detailsUrl so each definition stays its
        // own card rather than collapsing every definition-level check from
        // the same org into a single bucket.
        const key = idMatch ? `b:${idMatch[1]}` : `u:${r.detailsUrl}`;
        const { org, project } = parseAzdoUrl(r.detailsUrl);
        let entry = builds.get(key);
        if (!entry) {
            entry = {
                buildId: idMatch?.[1] ?? null,
                org,
                project,
                summaryUrl: idMatch ? r.detailsUrl.replace(/&view=.*$/, "").replace(/&jobId=.*$/, "") : r.detailsUrl,
                githubUrl: null,
                runs: [],
            };
            builds.set(key, entry);
        }
        entry.runs.push({
            name: r.name,
            status: r.status,           // QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING
            conclusion: r.conclusion,   // SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STARTUP_FAILURE | STALE | null
            detailsUrl: r.detailsUrl,
            checkRunId: r.databaseId ?? null,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
        });
    }
    const summary = { total: 0, success: 0, failure: 0, inProgress: 0, skipped: 0, other: 0 };
    for (const b of builds.values()) {
        for (const r of b.runs) {
            summary.total++;
            if (r.status !== "COMPLETED") summary.inProgress++;
            else if (r.conclusion === "NEUTRAL" || r.conclusion === "SKIPPED") summary.skipped++;
            else if (r.conclusion === "SUCCESS") summary.success++;
            else if (r.conclusion === "FAILURE" || r.conclusion === "TIMED_OUT" || r.conclusion === "STARTUP_FAILURE" || r.conclusion === "ACTION_REQUIRED") summary.failure++;
            else summary.other++;
        }
    }
    summary.overall =
        summary.failure > 0 ? "failure" :
        summary.inProgress > 0 ? "in_progress" :
        summary.success > 0 ? "success" :
        summary.skipped > 0 ? "skipped" : "other";
    // Definition-only builds (no buildId) never produced a run, so the AzDO
    // summaryUrl only points at the pipeline definition page. When we know the
    // PR url, prefer a GitHub checks deep-link to the underlying check run.
    if (prUrl) {
        for (const b of builds.values()) {
            if (b.buildId) continue;
            const withId = b.runs.find((r) => r.checkRunId != null);
            if (withId) b.githubUrl = `${prUrl}/checks?check_run_id=${withId.checkRunId}`;
        }
    }
    return {
        hasAny: true,
        builds: [...builds.values()].sort((a, b) => Number(b.buildId ?? 0) - Number(a.buildId ?? 0)),
        summary,
    };
}
