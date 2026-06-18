// Local HTTP server that backs the canvas iframe. Each panel instance gets
// its own ephemeral 127.0.0.1 server; the canvas open handler in
// extension.mjs starts one per instanceId and closes it on onClose.

import { createServer } from "node:http";

import { fetchAzdoBuild, fetchAzdoTimeline, parseAzdoBuildUrl } from "./azdo.mjs";
import { enrichSessionsWithSyncState } from "./git-sync.mjs";
import { fetchAgentTasks, fetchAuthoredPrs, fetchPrsWithChecks } from "./github.mjs";
import { notifyConfig, saveNotifyConfig } from "./notify.mjs";
import { PAGE_HTML } from "./page.mjs";
import { repoFilterConfig, saveRepoFilterConfig } from "./repo-filter.mjs";
import { fetchCopilotSessions, filterSessionsByLivePrState } from "./sessions.mjs";
import {
    addWatchedPr,
    fetchWatchedPrsWithChecks,
    loadWatchedList,
    removeWatchedPr,
} from "./watched.mjs";

// Send a generic 500 without reflecting the error stack or local filesystem
// paths back to the caller. Exported so tests can verify the suppression
// contract directly (the live error path is hard to trigger deterministically
// over HTTP because each route catches its own failures).
export function sendServerError(res, err) {
    // Log locally for debugging; never echo to the caller.
    console.error("ci-runs: request handler error", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("internal server error");
}

function jsonResponse(res, body, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
}

// Reject requests whose Host header isn't a loopback address. The server only
// ever binds 127.0.0.1, but a DNS-rebinding attack points an attacker-owned
// hostname at 127.0.0.1 so a malicious web page's requests resolve to this
// server while still carrying `Host: attacker.example`. The browser won't let
// page JS forge the Host header, so requiring a loopback Host defeats the
// rebinding read of local session data (repo names, branches, PR metadata).
function isLoopbackHost(hostHeader) {
    if (!hostHeader) return false; // HTTP/1.1 requires Host; absence is suspect
    let host = hostHeader;
    const bracketed = host.match(/^\[([^\]]+)\]/); // [::1]:port
    host = bracketed ? bracketed[1] : host.split(":")[0];
    host = host.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Reject cross-origin state-changing requests (CSRF). Legitimate calls come
// from the canvas page's own same-origin fetch; a cross-site page can fire a
// no-cors POST/DELETE without being able to read the response, which is enough
// to add a (malicious) watched PR or flip notify config. Modern browsers tag
// such requests with Sec-Fetch-Site: cross-site / same-site and an attacker
// Origin, while same-origin fetches send Sec-Fetch-Site: same-origin (or none)
// and a loopback Origin.
function isCrossOriginWrite(req) {
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") return true;
    const origin = req.headers.origin;
    if (origin) {
        try {
            // Compare the full Origin host (including port) to the request Host,
            // which already passed the loopback guard. Matching only the
            // hostname would treat http://127.0.0.1:9999 as same-origin even
            // though a differing port is a different origin.
            const originHost = new URL(origin).host.toLowerCase();
            const requestHost = String(req.headers.host ?? "").toLowerCase();
            if (originHost !== requestHost) return true;
        } catch {
            return true;
        }
    }
    return false;
}

// Read a JSON body off an http request with a hard 1MB cap. Resolves to {}
// for empty bodies; rejects on malformed JSON or oversize payloads.
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1_000_000) {
                req.destroy();
                reject(new Error("request body too large"));
            }
        });
        req.on("end", () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        req.on("error", reject);
    });
}

export async function startServer({ ciRunUrl = null } = {}) {
    // The ad-hoc CI-run URLs passed in via the canvas `open` input. A panel can
    // hold more than one run: a re-open of the same panel (same instanceId
    // reuses this server) appends another run via addCiRunUrl() without
    // restarting. Order is preserved and duplicates are ignored.
    const configuredCiRunUrls = [];
    const addConfiguredUrl = (u) => {
        const t = typeof u === "string" ? u.trim() : "";
        if (t && !configuredCiRunUrls.includes(t)) {
            configuredCiRunUrls.push(t);
            return true;
        }
        return false;
    };
    const removeConfiguredUrl = (u) => {
        const t = typeof u === "string" ? u.trim() : "";
        const i = t ? configuredCiRunUrls.indexOf(t) : -1;
        if (i !== -1) {
            configuredCiRunUrls.splice(i, 1);
            return true;
        }
        return false;
    };
    addConfiguredUrl(ciRunUrl);
    const server = createServer(async (req, res) => {
        try {
            // Defeat DNS-rebinding: only serve requests addressed to a
            // loopback Host. Anything else is a cross-origin host pointed at
            // 127.0.0.1 and has no business reading local session data.
            if (!isLoopbackHost(req.headers.host)) {
                res.statusCode = 403;
                res.end("forbidden");
                return;
            }
            // CSRF guard for state-changing methods.
            if (req.method !== "GET" && req.method !== "HEAD" && isCrossOriginWrite(req)) {
                res.statusCode = 403;
                res.end("forbidden");
                return;
            }
            const url = new URL(req.url, "http://127.0.0.1");
            if (url.pathname === "/") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                // When the panel was opened to inspect run(s), mark the body as
                // inspect-mode in the served HTML so the PR tab bar is hidden
                // from first paint — otherwise the tabs flash briefly until the
                // client's /api/ci-run fetch resolves and adds the class.
                const html = configuredCiRunUrls.length > 0
                    ? PAGE_HTML.replace("<body>", '<body class="inspect-mode">')
                    : PAGE_HTML;
                res.end(html);
            } else if (url.pathname === "/api/sessions") {
                const rows = fetchCopilotSessions();
                if (rows && rows.__error) {
                    jsonResponse(res, { error: rows.__error });
                } else {
                    // Drop sessions whose PRs are closed/merged on github.com,
                    // even if the local DB hasn't synced that state yet. Then
                    // attach the per-checkout sync badge.
                    const liveFiltered = await filterSessionsByLivePrState(rows);
                    await enrichSessionsWithSyncState(liveFiltered);
                    // Strip the local filesystem `checkout_path` before it
                    // leaves the process — it's only needed server-side to
                    // derive the sync_state badge (already attached above) and
                    // would otherwise leak absolute local paths to any caller.
                    const safeRows = Array.isArray(liveFiltered)
                        ? liveFiltered.map(({ checkout_path, ...rest }) => rest)
                        : liveFiltered;
                    jsonResponse(res, { rows: safeRows });
                }
            } else if (url.pathname === "/api/prs") {
                const force = url.searchParams.get("force") === "1";
                const { data, cachedAt, error } = await fetchAuthoredPrs({ force });
                jsonResponse(res, { rows: data ?? [], cachedAt, error });
            } else if (url.pathname === "/api/prs-with-checks") {
                const force = url.searchParams.get("force") === "1";
                const { data, cachedAt, error } = await fetchPrsWithChecks({ force });
                jsonResponse(res, { rows: data ?? [], cachedAt, error });
            } else if (url.pathname === "/api/tasks") {
                const force = url.searchParams.get("force") === "1";
                const { data, cachedAt, error } = await fetchAgentTasks({ force });
                // Serialize Map as plain object for JSON
                const tasks = data ? Object.fromEntries(data) : {};
                jsonResponse(res, { tasks, cachedAt, error });
            } else if (url.pathname === "/api/azdo-timeline") {
                const org = url.searchParams.get("org") ?? "";
                const project = url.searchParams.get("project") ?? "";
                const buildId = url.searchParams.get("buildId") ?? "";
                const force = url.searchParams.get("force") === "1";
                // Validate: org names are restricted by Azure (alphanumerics,
                // dashes, underscores). Projects allow more characters and may
                // contain spaces, so we reject only path/query separators and
                // control chars. buildId must be digits.
                const orgOk = /^[A-Za-z0-9._-]{1,64}$/.test(org);
                const projectOk = project.length > 0 && project.length <= 128 && !/[\/\\?#\x00-\x1f]/.test(project);
                const buildIdOk = /^\d{1,12}$/.test(buildId);
                if (!orgOk || !projectOk || !buildIdOk) {
                    jsonResponse(res, { error: "invalid org/project/buildId" }, 400);
                } else {
                    const { data, cachedAt, error } = await fetchAzdoTimeline({ org, project, buildId, force });
                    jsonResponse(res, { data, cachedAt, error });
                }
            } else if (url.pathname === "/api/ci-run") {
                // Ad-hoc CI runs passed in via the canvas `open` input. When no
                // URL was supplied the panel falls back to its normal PR tabs.
                // DELETE removes one run from the panel (by its configured URL)
                // and returns the updated list so the client can re-render.
                if (req.method !== "GET" && req.method !== "DELETE") {
                    res.statusCode = 405;
                    res.end("method not allowed");
                    return;
                }
                if (req.method === "DELETE") {
                    removeConfiguredUrl(url.searchParams.get("url") ?? "");
                }
                if (configuredCiRunUrls.length === 0) {
                    jsonResponse(res, { configured: false, runs: [] });
                } else {
                    const force = url.searchParams.get("force") === "1";
                    const runs = await Promise.all(configuredCiRunUrls.map(async (runUrl) => {
                        const parsed = parseAzdoBuildUrl(runUrl);
                        if (!parsed) {
                            return {
                                url: runUrl,
                                error: "Not a recognized Azure DevOps pipeline run URL. Expected a dev.azure.com or *.visualstudio.com build-results URL with a buildId (e.g. https://dev.azure.com/{org}/{project}/_build/results?buildId=123).",
                                errorKind: "bad_url",
                            };
                        }
                        const { org, project, buildId } = parsed;
                        const { data, cachedAt, error, errorKind, auth } = await fetchAzdoBuild({ org, project, buildId, force });
                        return {
                            url: runUrl,
                            org,
                            project,
                            buildId,
                            build: data?.build ?? null,
                            records: data?.records ?? [],
                            auth,
                            error,
                            errorKind,
                            cachedAt,
                        };
                    }));
                    jsonResponse(res, { configured: true, runs });
                }
            } else if (url.pathname === "/api/notify-config") {
                if (req.method === "GET") {
                    jsonResponse(res, { config: notifyConfig });
                } else if (req.method === "POST") {
                    try {
                        const body = await readJsonBody(req);
                        const updated = await saveNotifyConfig(body);
                        jsonResponse(res, { config: updated });
                    } catch (err) {
                        jsonResponse(res, { error: String(err?.message ?? err) }, 400);
                    }
                } else {
                    res.statusCode = 405;
                    res.end("method not allowed");
                }
            } else if (url.pathname === "/api/repo-filter") {
                if (req.method === "GET") {
                    jsonResponse(res, { config: repoFilterConfig });
                } else if (req.method === "POST") {
                    try {
                        const body = await readJsonBody(req);
                        const updated = await saveRepoFilterConfig(body);
                        jsonResponse(res, { config: updated });
                    } catch (err) {
                        jsonResponse(res, { error: String(err?.message ?? err) }, 400);
                    }
                } else {
                    res.statusCode = 405;
                    res.end("method not allowed");
                }
            } else if (url.pathname === "/api/watched") {
                if (req.method === "GET") {
                    const force = url.searchParams.get("force") === "1";
                    const items = await loadWatchedList();
                    const { data, cachedAt, error } = await fetchWatchedPrsWithChecks({ force });
                    jsonResponse(res, { items, rows: data ?? [], cachedAt, error });
                } else if (req.method === "POST") {
                    let body;
                    try { body = await readJsonBody(req); }
                    catch (err) { return jsonResponse(res, { error: String(err?.message ?? err) }, 400); }
                    const result = await addWatchedPr(body?.url);
                    if (result.error && !result.item) {
                        jsonResponse(res, { error: result.error, items: result.items }, 400);
                    } else {
                        jsonResponse(res, { item: result.item, items: result.items, error: result.error ?? null });
                    }
                } else if (req.method === "DELETE") {
                    const key = url.searchParams.get("key") ?? "";
                    if (!key) {
                        jsonResponse(res, { error: "missing key" }, 400);
                    } else {
                        const result = await removeWatchedPr(key);
                        if (result.error) {
                            jsonResponse(res, { error: result.error }, 400);
                        } else {
                            jsonResponse(res, { removed: result.removed, items: result.items });
                        }
                    }
                } else {
                    res.statusCode = 405;
                    res.end("method not allowed");
                }
            } else {
                res.statusCode = 404;
                res.end("not found");
            }
        } catch (err) {
            // Don't reflect the stack/paths back to the caller; log locally
            // and return a generic error.
            sendServerError(res, err);
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    // setCiRunUrl replaces the panel's run list with a single run (or clears it
    // when given an empty value). addCiRunUrl appends another run to the panel
    // (deduped), returning whether it was newly added. Both let the canvas open
    // handler update the inspected runs when the same panel (instanceId) is
    // re-opened, without restarting the server.
    const setCiRunUrl = (next) => {
        configuredCiRunUrls.length = 0;
        addConfiguredUrl(next);
    };
    const addCiRunUrl = (next) => addConfiguredUrl(next);
    const removeCiRunUrl = (target) => removeConfiguredUrl(target);
    return { server, url: `http://127.0.0.1:${port}/`, setCiRunUrl, addCiRunUrl, removeCiRunUrl };
}
