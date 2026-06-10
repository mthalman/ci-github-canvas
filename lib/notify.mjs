// Failure / completion notifier.
//
// Host-side polling loop that watches every PR's CI runs and fires a
// session.send() alert when one of two independent transitions happens:
//   - "run completion": an AzDO build or GHA check-run goes from in-progress
//     to any completed state (success, failure, or other).
//   - "job failure": an individual job transitions from non-failure to failure.
// Both events can fire from the same poll cycle; they're coalesced into one
// session.send() so the chat only chimes once per poll.
//
// session.send() injects a user message into the chat, which makes the agent
// respond — and the agent's response is what plays the desktop app's
// notification chime when the turn settles.
//
// Notes:
// - "Build completion" treats in_progress as dominant (any in-progress job
//   keeps the whole build in_progress); only fires once everything is done.
// - GHA check-runs are leaf nodes (no sub-jobs we can see). Each acts as
//   both its own "build" (for run-completion) and "job" (for failures).
// - The first successful poll after extension load seeds state silently, so
//   the user doesn't get alerted about every already-completed or already-red
//   check on startup.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { NOTIFY_CONFIG_PATH } from "./constants.mjs";
import { fetchPrsWithChecks } from "./github.mjs";

// In-memory mirror of the on-disk notify config. Loaded eagerly at startup;
// HTTP POST /api/notify-config updates both this and the JSON file.
//
// The two notification modes are independent and may both be on at once:
//   notifyOnRunCompletion — fire when a build/run finishes (any conclusion).
//   notifyOnJobFailure    — fire when an individual job transitions to failure.
//
// Exported as a live `let` binding so server.mjs can read the current value
// directly. Server is read-only on this; only saveNotifyConfig() in this
// module ever reassigns it.
export let notifyConfig = { notifyOnRunCompletion: false, notifyOnJobFailure: false };

// Per-build aggregated state (used by the run-completion diff) and per-job
// state (used by the failure diff). Both maps are rebuilt every poll
// regardless of which flags are on, so toggling a flag never triggers
// retroactive alerts for already-seen items.
const lastBuildStates = new Map();
const lastJobStates = new Map();
// First-poll seeding flag: the very first successful poll after extension
// load just records current state without firing alerts (otherwise every
// already-red or already-completed check would alert on startup).
let notifyStateSeeded = false;
let notifyPollInFlight = false;

// Assigned by extension.mjs after joinSession() resolves; used by the
// host-side notifier to call session.send(). Kept at module scope so HTTP
// handlers and the background poll loop can reach the session handle without
// taking it as a parameter.
let activeSession = null;
export function setActiveSession(session) {
    activeSession = session;
}

export function sanitizeNotifyConfig(raw) {
    const out = { notifyOnRunCompletion: false, notifyOnJobFailure: false };
    if (!raw || typeof raw !== "object") return out;
    const hasNew = "notifyOnRunCompletion" in raw || "notifyOnJobFailure" in raw;
    if (hasNew) {
        if (typeof raw.notifyOnRunCompletion === "boolean") out.notifyOnRunCompletion = raw.notifyOnRunCompletion;
        if (typeof raw.notifyOnJobFailure === "boolean") out.notifyOnJobFailure = raw.notifyOnJobFailure;
    } else if (typeof raw.enabled === "boolean") {
        // Migrate the older { enabled, granularity } shape — the closest
        // semantic match is the failure-notification path. Run-completion
        // is a new behavior the old config never expressed, so it stays off.
        out.notifyOnJobFailure = raw.enabled;
    }
    return out;
}

export async function initNotifyConfig() {
    try {
        const text = await readFile(NOTIFY_CONFIG_PATH, "utf8");
        notifyConfig = sanitizeNotifyConfig(JSON.parse(text));
    } catch (err) {
        // ENOENT just means the user has never saved a config yet — silently
        // fall through to defaults. Any other error (corrupt JSON, perms) is
        // logged but doesn't block the extension from starting.
        if (err?.code !== "ENOENT") {
            console.error("ci-runs: failed to load notify config", err);
        }
    }
    return notifyConfig;
}

export async function saveNotifyConfig(next) {
    notifyConfig = sanitizeNotifyConfig(next);
    try {
        // Best-effort mkdir for the parent — ~/.copilot generally already
        // exists because the desktop app creates it, but covering the case
        // where the user wipes it costs little.
        await mkdir(join(homedir(), ".copilot"), { recursive: true });
        await writeFile(NOTIFY_CONFIG_PATH, JSON.stringify(notifyConfig, null, 2), "utf8");
    } catch (err) {
        console.error("ci-runs: failed to persist notify config", err);
    }
    return notifyConfig;
}

// Classify one check-run into the four states the UI/notifier care about.
// Mirrors the inline logic inside summarizeAzdoRuns/summarizeGhaRuns; kept
// as a separate helper because the notifier needs to derive per-build and
// per-job state independently from the pre-summarized snapshot.
export function classifyRun(r) {
    if (r.status !== "COMPLETED") return "in_progress";
    if (r.conclusion === "SUCCESS" || r.conclusion === "NEUTRAL" || r.conclusion === "SKIPPED") return "success";
    if (r.conclusion === "FAILURE" || r.conclusion === "TIMED_OUT" || r.conclusion === "STARTUP_FAILURE" || r.conclusion === "ACTION_REQUIRED") return "failure";
    return "other";
}

// Walk a fetchPrsWithChecks() snapshot and build the per-build and per-job
// state maps in one pass. Each value carries enough metadata for the alert
// formatter to produce a readable line without re-walking the snapshot.
// Also returns a per-PR registry (`prInfo`) keyed by PR URL so the formatter
// can list every build for a PR (e.g. to compute remaining pending runs)
// without re-walking the snapshot itself.
export function collectNotifyStates(prs) {
    const buildStates = new Map();
    const jobStates = new Map();
    const prInfo = new Map();
    for (const pr of prs ?? []) {
        const prLabel = `${pr.repository?.nameWithOwner ?? "unknown"}#${pr.number}`;
        const prUrl = pr.url;
        const prTitle = typeof pr.title === "string" ? pr.title : "";
        if (!prInfo.has(prUrl)) {
            prInfo.set(prUrl, { prLabel, prUrl, prTitle, buildKeys: new Set() });
        }
        const info = prInfo.get(prUrl);

        for (const b of pr.azdo?.builds ?? []) {
            const buildLabel = b.buildId ? `AzDO build #${b.buildId}` : "AzDO build";
            const buildKey = `${prUrl}|azdo|${b.buildId ?? b.summaryUrl}`;
            // Build-level overall for run-completion: in_progress wins so the
            // build only counts as "done" once every job has settled. Once
            // settled, failure wins over success so the message reflects
            // whether the build passed overall.
            let nFail = 0, nProg = 0, nOk = 0;
            for (const r of b.runs) {
                const s = classifyRun(r);
                if (s === "failure") nFail++;
                else if (s === "in_progress") nProg++;
                else if (s === "success") nOk++;
            }
            const buildOverall =
                nProg > 0 ? "in_progress" :
                nFail > 0 ? "failure" :
                nOk > 0 ? "success" : "other";
            buildStates.set(buildKey, {
                state: buildOverall,
                meta: { prLabel, prUrl, label: buildLabel, url: b.summaryUrl },
            });
            info.buildKeys.add(buildKey);
            for (const r of b.runs) {
                const jobKey = `${prUrl}|azdo|${b.buildId ?? b.summaryUrl}|${r.name}`;
                jobStates.set(jobKey, {
                    state: classifyRun(r),
                    meta: { prLabel, prUrl, label: `${buildLabel} · ${r.name}`, url: r.detailsUrl || b.summaryUrl },
                });
            }
        }

        for (const r of pr.gha?.runs ?? []) {
            // No parent-build aggregation for GHA — each check-run stands
            // alone, so we register the same entry under both maps.
            // Include the workflow run id in the key so a re-run on the same
            // commit (same job name, possibly same conclusion) registers as
            // a distinct entry, the way AzDO uses buildId. Without this, a
            // re-run that lands in the same success/failure state as the
            // prior run is treated as "no change" and silently swallowed.
            const runIdMatch = typeof r.detailsUrl === "string"
                ? r.detailsUrl.match(/\/actions\/runs\/(\d+)\b/)
                : null;
            const runId = runIdMatch ? runIdMatch[1] : "norun";
            const ghaKey = `${prUrl}|gha|${runId}|${r.name}`;
            const entry = {
                state: classifyRun(r),
                meta: { prLabel, prUrl, label: `GHA · ${r.name}`, url: r.detailsUrl },
            };
            buildStates.set(ghaKey, entry);
            jobStates.set(ghaKey, entry);
            info.buildKeys.add(ghaKey);
        }
    }
    return { buildStates, jobStates, prInfo };
}

// Run-completion diff: fire whenever a build/job lands in a completed state
// we haven't already reported for it. That covers both the classic
// in_progress → completed transition AND the unseen → completed case (e.g. a
// GHA check-run that GitHub registers late and is already done by the time we
// first see it — without this we'd silently miss it). Same-state repeats
// (prev=success, next=success) are skipped so we don't re-alert every poll,
// and the seed-poll guard in runNotifyPoll() still prevents an alert flood
// on the very first poll after extension load.
export function diffNewCompletions(prevMap, nextMap) {
    const out = [];
    for (const [key, next] of nextMap) {
        if (next.state === "in_progress") continue;
        const prev = prevMap.get(key);
        if (prev && prev.state === next.state) continue;
        out.push({ key, ...next });
    }
    return out;
}

// Failure diff: fire on any non-failure → failure transition, INCLUDING the
// unseen → failure case (a brand-new job that started already broken). For
// failures we want to err on the side of telling the user — missing a real
// failure is worse than the rare spurious alert.
export function diffNewFailures(prevMap, nextMap) {
    const out = [];
    for (const [key, next] of nextMap) {
        if (next.state !== "failure") continue;
        const prev = prevMap.get(key);
        if (prev?.state === "failure") continue;
        out.push({ key, ...next });
    }
    return out;
}

// Build both the user-facing alert (what shows up in the chat timeline) and
// the model-facing prompt (which also carries the acknowledgement instruction
// so the agent responds, triggering the desktop notification chime).
//
// Events are grouped by PR so the reader sees one section per affected PR
// with its title, a list of what just happened, and either the list of runs
// that are still pending OR a "CI complete" marker when the completing event
// was the PR's last in-flight run. PR labels render as markdown links to the
// PR URL so the user can click straight through to the PR rather than
// landing on the build.
//
// Dedupe: a GHA check-run that just failed will normally appear in both
// `completions` (as a build whose overall state is failure) and `failures`
// (as the single job that flipped to failure), because for GHA the build
// key and the job key are identical. We drop the duplicate from `failures`
// so it isn't listed twice in the same PR section.
export function formatAlertMessage(completions, failures, buildStates, prInfo) {
    const completionKeys = new Set(completions.map((c) => c.key));
    const dedupedFailures = failures.filter((f) => !completionKeys.has(f.key));

    const eventsByPr = new Map();
    const ensure = (prUrl) => {
        if (!eventsByPr.has(prUrl)) eventsByPr.set(prUrl, { completions: [], failures: [] });
        return eventsByPr.get(prUrl);
    };
    for (const c of completions) ensure(c.meta.prUrl).completions.push(c);
    for (const f of dedupedFailures) ensure(f.meta.prUrl).failures.push(f);

    const verbForCompletion = (state) =>
        state === "success" ? "✅ passed" :
        state === "failure" ? "❌ failed" :
        state === "other"   ? "⚠️ completed (mixed result)" :
                              "completed";

    const sections = [];
    let prsNowComplete = 0;
    for (const [prUrl, ev] of eventsByPr) {
        const info = prInfo.get(prUrl);
        const fallbackLabel = (ev.completions[0] ?? ev.failures[0])?.meta.prLabel ?? "PR";
        const prLabel = info?.prLabel ?? fallbackLabel;
        const prTitle = info?.prTitle ? ` — _${info.prTitle}_` : "";

        const pending = [];
        if (info) {
            for (const key of info.buildKeys) {
                const b = buildStates.get(key);
                if (b?.state === "in_progress") pending.push(b);
            }
        }
        const allComplete = pending.length === 0;
        if (allComplete) prsNowComplete++;

        const lines = [`### [${prLabel}](${prUrl})${prTitle}`];

        for (const c of ev.completions) {
            lines.push(`- ${verbForCompletion(c.state)} — ${c.meta.label} · [details](${c.meta.url})`);
        }
        for (const f of ev.failures) {
            lines.push(`- ❌ job failed — ${f.meta.label} · [details](${f.meta.url})`);
        }

        lines.push("");
        if (allComplete) {
            lines.push(`**All CI runs for this PR are complete.**`);
        } else {
            const pendingNoun = pending.length === 1 ? "run" : "runs";
            lines.push(`⏳ **${pending.length} ${pendingNoun} still pending:**`);
            for (const p of pending) {
                lines.push(`- ${p.meta.label}${p.meta.url ? ` · [details](${p.meta.url})` : ""}`);
            }
        }
        sections.push(lines.join("\n"));
    }

    const totalEvents = completions.length + dedupedFailures.length;
    const eventWord = totalEvents === 1 ? "event" : "events";
    const prCount = eventsByPr.size;
    const headerParts = [`CI update: ${totalEvents} ${eventWord}`];
    if (prCount > 1) headerParts.push(`across ${prCount} PRs`);
    if (prsNowComplete > 0) {
        if (prsNowComplete === prCount) {
            headerParts.push(prCount === 1 ? "(PR CI complete)" : `(all ${prCount} PRs complete)`);
        } else {
            headerParts.push(`(${prsNowComplete} of ${prCount} PRs now complete)`);
        }
    }
    const header = `${headerParts.join(" ")}.`;

    const display = [header, "", sections.join("\n\n")].join("\n");
    const prompt = [
        display,
        "",
        "Reply with one short acknowledgement (no investigation, no tools).",
    ].join("\n");
    return { prompt, displayPrompt: display };
}

export async function runNotifyPoll() {
    if (notifyPollInFlight) return;
    notifyPollInFlight = true;
    try {
        // Force a fresh fetch — the cache TTL would otherwise let us miss
        // transitions that happened in the last 90s.
        const { data, error } = await fetchPrsWithChecks({ force: true });
        if (error || !data) {
            if (error) console.error("ci-runs: notify poll fetch failed", error);
            return;
        }
        const { buildStates, jobStates, prInfo } = collectNotifyStates(data);
        // Snapshot the previous maps before we overwrite, so the diff sees
        // the right "before" picture.
        const prevBuilds = new Map(lastBuildStates);
        const prevJobs = new Map(lastJobStates);
        lastBuildStates.clear();
        for (const [k, v] of buildStates) lastBuildStates.set(k, v);
        lastJobStates.clear();
        for (const [k, v] of jobStates) lastJobStates.set(k, v);

        if (!notifyStateSeeded) {
            notifyStateSeeded = true;
            return;
        }
        if (!activeSession) return;
        if (!notifyConfig.notifyOnRunCompletion && !notifyConfig.notifyOnJobFailure) return;

        const completions = notifyConfig.notifyOnRunCompletion
            ? diffNewCompletions(prevBuilds, buildStates) : [];
        const failures = notifyConfig.notifyOnJobFailure
            ? diffNewFailures(prevJobs, jobStates) : [];
        if (completions.length === 0 && failures.length === 0) return;
        try {
            // `prompt` carries the acknowledgement directive the model needs;
            // `displayPrompt` is what the user sees in the timeline, omitting
            // that directive so it reads as a clean CI status update.
            await activeSession.send(formatAlertMessage(completions, failures, buildStates, prInfo));
        } catch (err) {
            console.error("ci-runs: failed to send notify alert", err);
        }
    } catch (err) {
        console.error("ci-runs: notify poll errored", err);
    } finally {
        notifyPollInFlight = false;
    }
}
