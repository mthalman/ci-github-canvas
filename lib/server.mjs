// Local HTTP server that backs the canvas iframe. Each panel instance gets
// its own ephemeral 127.0.0.1 server; the canvas open handler in
// extension.mjs starts one per instanceId and closes it on onClose.

import { createServer } from "node:http";

import { fetchAzdoTimeline } from "./azdo.mjs";
import { enrichSessionsWithSyncState } from "./git-sync.mjs";
import { fetchAgentTasks, fetchAuthoredPrs, fetchPrsWithChecks } from "./github.mjs";
import { notifyConfig, saveNotifyConfig } from "./notify.mjs";
import { PAGE_HTML } from "./page.mjs";
import { fetchCopilotSessions, filterSessionsByLivePrState } from "./sessions.mjs";

function jsonResponse(res, body, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
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

export async function startServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://127.0.0.1");
            if (url.pathname === "/") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(PAGE_HTML);
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
                    jsonResponse(res, { rows: liveFiltered });
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
            } else {
                res.statusCode = 404;
                res.end("not found");
            }
        } catch (err) {
            res.statusCode = 500;
            res.end(`<pre>${err.stack}</pre>`);
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return { server, url: `http://127.0.0.1:${port}/` };
}
