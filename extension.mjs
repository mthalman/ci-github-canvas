// Extension: ci-runs (v0.3)
//
// User-scoped canvas: side-panel dashboard with two tabs.
//   1. "Copilot" tab  - workspaces currently open in the desktop app, with
//                       their PR or issue origin. Source: ~/.copilot/data.db.
//   2. "All PRs" tab  - every open PR the user authored across all of GitHub.
//                       Source: `gh search prs --author=@me --state=open`.
// Cross-link: PRs that appear in both tabs get a "session" badge in tab 2.
//
// CI status: shows both Azure Pipelines and GitHub Actions workflow runs.
//
// Runtime: Node 24+ (uses node:sqlite, no npm deps).
//
// This file is the thin SDK-wiring shell. All testable logic lives under
// ./lib so it can be exercised without bootstrapping a live Copilot SDK
// session. Cross-module mutable state (notifyConfig, activeSession) flows
// through explicit exports — see lib/notify.mjs for the contract.

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

import { HOST_POLL_INTERVAL_MS } from "./lib/constants.mjs";
import { fetchPrsWithChecks } from "./lib/github.mjs";
import { initNotifyConfig, runNotifyPoll, setActiveSession } from "./lib/notify.mjs";
import { initRepoFilterConfig } from "./lib/repo-filter.mjs";
import { initSettings } from "./lib/settings.mjs";
import { startServer } from "./lib/server.mjs";
import { fetchCopilotSessions, filterSessionsByLivePrState } from "./lib/sessions.mjs";

// One HTTP server per canvas panel instance. The canvas open handler starts
// (and lazily reuses) a server keyed by ctx.instanceId; onClose tears it
// down. Lives in this entry file because it's tied to the canvas lifecycle.
const servers = new Map();

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "ci-runs",
            displayName: "CI Runs",
            description:
                "Side-panel dashboard with two tabs: (1) Copilot sessions currently open in the desktop app with their PR/issue origin; (2) all open pull requests the user authored across GitHub. Cross-links the two so the user can see which of their PRs already have a Copilot session.",
            inputSchema: {
                type: "object",
                properties: {
                    ciRunUrl: {
                        type: "string",
                        description:
                            "Optional URL of an Azure DevOps pipeline run to inspect directly, e.g. https://dev.azure.com/{org}/{project}/_build/results?buildId=123. Use this to view a branch's CI run before a PR exists. Re-opening the same canvas panel with another run URL adds it to the panel alongside the existing run(s). Public pipelines are read anonymously; private pipelines authenticate via the Azure CLI (the user must have `az` installed and be signed in with `az login`).",
                    },
                },
            },
            actions: [
                {
                    name: "refresh",
                    description: "Re-read the local session store and re-fetch the user's open PRs from GitHub.",
                    handler: async () => {
                        const rawSessions = fetchCopilotSessions();
                        const sessions = (rawSessions && rawSessions.__error)
                            ? rawSessions
                            : await filterSessionsByLivePrState(rawSessions);
                        const checks = await fetchPrsWithChecks({ force: true });
                        return {
                            ok: !checks.error && !(sessions && sessions.__error),
                            sessionCount: Array.isArray(sessions) ? sessions.length : 0,
                            prCount: checks.data?.length ?? 0,
                            azdoBuilds: (checks.data ?? []).reduce((n, p) => n + (p.azdo?.builds?.length ?? 0), 0),
                            ghaRuns: (checks.data ?? []).reduce((n, p) => n + (p.gha?.runs?.length ?? 0), 0),
                            errors: [sessions?.__error, checks.error].filter(Boolean),
                        };
                    },
                },
            ],
            open: async (ctx) => {
                const ciRunUrl = typeof ctx.input?.ciRunUrl === "string" ? ctx.input.ciRunUrl.trim() : "";
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer({ ciRunUrl });
                    servers.set(ctx.instanceId, entry);
                } else {
                    // Re-open of an existing panel: add this run to the panel
                    // (deduped) rather than replacing what's already shown.
                    entry.addCiRunUrl?.(ciRunUrl);
                }
                const rawRows = fetchCopilotSessions();
                const rows = (rawRows && rawRows.__error)
                    ? rawRows
                    : await filterSessionsByLivePrState(rawRows);
                const sessionCount = Array.isArray(rows) ? rows.length : 0;
                // Inspect mode is determined by whether the panel holds any runs
                // (set on this open or a previous one), not just the current
                // call's input — so re-opening/focusing an inspect panel without
                // a ciRunUrl keeps the "Inspecting" status instead of flipping
                // back to the session count.
                const runCount = entry.ciRunCount?.() ?? 0;
                const status = runCount > 0
                    ? `Inspecting ${runCount} Azure DevOps CI run${runCount === 1 ? "" : "s"}`
                    : `${sessionCount} active session${sessionCount === 1 ? "" : "s"}`;
                return { title: "CI Runs", url: entry.url, status };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

// Hand the session handle to the notifier so runNotifyPoll() can fire
// session.send() alerts from its background timer. Must happen before
// initNotifyConfig / runNotifyPoll so the first poll has the handle.
setActiveSession(session);

await session.log("ci-runs extension ready (v0.3)");

// Load the unified settings document (notify + repo-filter sections, with
// one-time migration from the pre-consolidation standalone files) before any
// domain module reads its section or any fetch runs.
await initSettings();

// Load the repo filter config (include/exclude globs) before any fetch so
// the first session/PR query already respects it. Empty lists = no filtering.
await initRepoFilterConfig();

// Host-side failure-notifier loop. Runs regardless of whether the canvas
// panel is open, so the user gets alerts even with the side panel closed.
// The first call seeds state silently; subsequent calls fire session.send()
// when a build (or job) transitions from non-failure to failure.
await initNotifyConfig();
runNotifyPoll().catch((err) => console.error("ci-runs: initial notify poll failed", err));
setInterval(() => {
    runNotifyPoll().catch((err) => console.error("ci-runs: notify poll failed", err));
}, HOST_POLL_INTERVAL_MS);
