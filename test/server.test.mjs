// Integration tests for lib/server.mjs: start the local HTTP server and hit
// its endpoints with the global fetch API. We exercise the input-validation
// and routing layer end-to-end (not the gh/AzDO calls, which would need
// network); the DB-backed and gh-backed endpoints would surface errors that
// we treat as acceptable for routing validation.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import { startServer, sendServerError } from "../lib/server.mjs";

let server;
let baseUrl;
let port;

before(async () => {
    const entry = await startServer();
    server = entry.server;
    baseUrl = entry.url.replace(/\/$/, "");
    port = Number(new URL(entry.url).port);
});

// Low-level request helper so we can set headers (Host, Origin, Sec-Fetch-*)
// that the fetch API treats as forbidden / unsettable.
function rawRequest({ method = "GET", path = "/", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve({ status: res.statusCode, body: data }));
        });
        req.on("error", reject);
        if (body != null) req.write(body);
        req.end();
    });
}

after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
});

test("GET / returns HTML page", async () => {
    const r = await fetch(`${baseUrl}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const body = await r.text();
    assert.match(body, /<!doctype html>/i);
    assert.match(body, /CI Runs/);
    // No run configured on the shared server: the body must not be stamped
    // inspect-mode, so the PR tabs render normally.
    assert.doesNotMatch(body, /<body class="inspect-mode">/);
});

test("GET / stamps <body class=\"inspect-mode\"> when a run is configured", async () => {
    // The server pre-marks the page in inspect mode so the PR tab bar/panels are
    // hidden from first paint — no flash before the client's /api/ci-run fetch.
    const entry = await startServer({ ciRunUrl: "https://dev.azure.com/org/proj/_build/results?buildId=1" });
    try {
        const url = entry.url.replace(/\/$/, "");
        const body = await fetch(`${url}/`).then((r) => r.text());
        assert.match(body, /<body class="inspect-mode">/);
    } finally {
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
});

test("GET unknown path returns 404", async () => {
    const r = await fetch(`${baseUrl}/no/such/route`);
    assert.equal(r.status, 404);
});

test("GET /api/notify-config returns the in-memory config", async () => {
    const r = await fetch(`${baseUrl}/api/notify-config`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(typeof body.config, "object");
    assert.equal(typeof body.config.notifyOnRunCompletion, "boolean");
    assert.equal(typeof body.config.notifyOnJobFailure, "boolean");
});

test("DELETE /api/notify-config → 405", async () => {
    const r = await fetch(`${baseUrl}/api/notify-config`, { method: "DELETE" });
    assert.equal(r.status, 405);
});

test("GET /api/repo-filter returns the in-memory config", async () => {
    const r = await fetch(`${baseUrl}/api/repo-filter`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(typeof body.config, "object");
    assert.ok(Array.isArray(body.config.patterns));
});

test("DELETE /api/repo-filter → 405", async () => {
    const r = await fetch(`${baseUrl}/api/repo-filter`, { method: "DELETE" });
    assert.equal(r.status, 405);
});

test("GET /api/azdo-timeline rejects missing params with 400", async () => {
    const r = await fetch(`${baseUrl}/api/azdo-timeline`);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /invalid org\/project\/buildId/);
});

test("GET /api/azdo-timeline rejects bad org with 400", async () => {
    const r = await fetch(`${baseUrl}/api/azdo-timeline?org=bad%2Forg&project=Foo&buildId=1`);
    assert.equal(r.status, 400);
});

test("GET /api/azdo-timeline rejects non-numeric buildId with 400", async () => {
    const r = await fetch(`${baseUrl}/api/azdo-timeline?org=org&project=Foo&buildId=abc`);
    assert.equal(r.status, 400);
});

test("GET /api/azdo-timeline rejects project with path separator with 400", async () => {
    const r = await fetch(`${baseUrl}/api/azdo-timeline?org=org&project=Foo%2FBar&buildId=1`);
    assert.equal(r.status, 400);
});

test("GET /api/azdo-timeline accepts well-formed params (network attempt allowed to fail)", async () => {
    // We don't assert success on the inner fetch — the request goes to the
    // real dev.azure.com which may or may not respond in CI. We only assert
    // that the routing layer accepts the input and returns a JSON envelope.
    const r = await fetch(`${baseUrl}/api/azdo-timeline?org=dnceng-public&project=public&buildId=99999999`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok("data" in body || "error" in body);
});

// --- /api/watched ----------------------------------------------------------

test("GET /api/watched returns an items array (may be non-empty if user has watched PRs)", async () => {
    const r = await fetch(`${baseUrl}/api/watched`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.items));
    assert.ok(Array.isArray(body.rows));
});

test("POST /api/watched rejects malformed URLs with 400", async () => {
    const r = await fetch(`${baseUrl}/api/watched`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "not a url" }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error ?? "", /valid GitHub PR URL/i);
});

test("POST /api/watched rejects empty body with 400", async () => {
    const r = await fetch(`${baseUrl}/api/watched`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
    assert.equal(r.status, 400);
});

test("DELETE /api/watched without key returns 400", async () => {
    const r = await fetch(`${baseUrl}/api/watched`, { method: "DELETE" });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error ?? "", /key/i);
});

test("DELETE /api/watched with unknown key returns 200 removed=false", async () => {
    const r = await fetch(`${baseUrl}/api/watched?key=zz%2Fzz%23999999`, { method: "DELETE" });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.removed, false);
    assert.ok(Array.isArray(body.items));
});

test("PUT /api/watched → 405", async () => {
    const r = await fetch(`${baseUrl}/api/watched`, { method: "PUT" });
    assert.equal(r.status, 405);
});

// --- /api/ci-run -----------------------------------------------------------

test("GET /api/ci-run returns configured:false when no ciRunUrl was supplied", async () => {
    const r = await fetch(`${baseUrl}/api/ci-run`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.configured, false);
});

test("GET /api/ci-run with a configured but malformed URL returns a bad_url error", async () => {
    const entry = await startServer({ ciRunUrl: "not a pipeline url" });
    try {
        const url = entry.url.replace(/\/$/, "");
        const r = await fetch(`${url}/api/ci-run`);
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.configured, true);
        assert.equal(body.runs.length, 1);
        assert.equal(body.runs[0].errorKind, "bad_url");
        assert.match(body.runs[0].error ?? "", /Azure DevOps pipeline run URL/i);
    } finally {
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
});

test("setCiRunUrl swaps the configured run for the same panel", async () => {
    const entry = await startServer();
    try {
        const url = entry.url.replace(/\/$/, "");
        let body = await fetch(`${url}/api/ci-run`).then((r) => r.json());
        assert.equal(body.configured, false);
        // Swap in a (malformed) URL: proves the setter mutates server state
        // without reaching the network (a valid URL would hit dev.azure.com).
        entry.setCiRunUrl("https://example.com/not/azdo");
        body = await fetch(`${url}/api/ci-run`).then((r) => r.json());
        assert.equal(body.configured, true);
        assert.equal(body.runs.length, 1);
        assert.equal(body.runs[0].errorKind, "bad_url");
        // Swapping back to empty hides the run again.
        entry.setCiRunUrl("");
        body = await fetch(`${url}/api/ci-run`).then((r) => r.json());
        assert.equal(body.configured, false);
    } finally {
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
});

test("addCiRunUrl appends runs to the same panel and dedupes", async () => {
    // Use malformed URLs so the panel resolves them offline (bad_url) without
    // reaching dev.azure.com; we're only verifying the run-list bookkeeping.
    const entry = await startServer({ ciRunUrl: "https://example.com/run/a" });
    try {
        const url = entry.url.replace(/\/$/, "");
        let body = await fetch(`${url}/api/ci-run`).then((r) => r.json());
        assert.equal(body.configured, true);
        assert.equal(body.runs.length, 1);
        assert.equal(body.runs[0].url, "https://example.com/run/a");
        // Add a second, distinct run: the panel now holds both, in order.
        entry.addCiRunUrl("https://example.com/run/b");
        body = await fetch(`${url}/api/ci-run`).then((r) => r.json());
        assert.equal(body.runs.length, 2);
        assert.deepEqual(body.runs.map((x) => x.url), [
            "https://example.com/run/a",
            "https://example.com/run/b",
        ]);
        // Adding a duplicate (or blank) is a no-op.
        entry.addCiRunUrl("https://example.com/run/b");
        entry.addCiRunUrl("   ");
        body = await fetch(`${url}/api/ci-run`).then((r) => r.json());
        assert.equal(body.runs.length, 2);
    } finally {
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
});

test("ciRunCount reflects the panel's configured run count", async () => {
    const entry = await startServer({ ciRunUrl: "https://example.com/run/a" });
    try {
        assert.equal(entry.ciRunCount(), 1);
        entry.addCiRunUrl("https://example.com/run/b");
        assert.equal(entry.ciRunCount(), 2);
        entry.removeCiRunUrl("https://example.com/run/a");
        assert.equal(entry.ciRunCount(), 1);
        // A panel opened without a run starts empty.
        const empty = await startServer();
        assert.equal(empty.ciRunCount(), 0);
        await new Promise((resolve) => empty.server.close(() => resolve()));
    } finally {
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
});

// --- security hardening ----------------------------------------------------

test("DELETE /api/ci-run removes one run and returns the updated list", async () => {
    // Malformed URLs resolve offline (bad_url) so this stays network-free.
    const entry = await startServer({ ciRunUrl: "https://example.com/run/a" });
    try {
        const url = entry.url.replace(/\/$/, "");
        entry.addCiRunUrl("https://example.com/run/b");
        let body = await fetch(`${url}/api/ci-run`).then((r) => r.json());
        assert.equal(body.runs.length, 2);
        // Remove the first run via the HTTP DELETE the panel's ✕ button uses.
        const del = await fetch(`${url}/api/ci-run?url=${encodeURIComponent("https://example.com/run/a")}`, { method: "DELETE" });
        assert.equal(del.status, 200);
        body = await del.json();
        assert.equal(body.configured, true);
        assert.deepEqual(body.runs.map((x) => x.url), ["https://example.com/run/b"]);
        // Removing the last run flips the panel back to configured:false.
        const del2 = await fetch(`${url}/api/ci-run?url=${encodeURIComponent("https://example.com/run/b")}`, { method: "DELETE" });
        body = await del2.json();
        assert.equal(body.configured, false);
        assert.equal(body.runs.length, 0);
        // Deleting an unknown URL is a harmless no-op.
        const del3 = await fetch(`${url}/api/ci-run?url=${encodeURIComponent("https://example.com/nope")}`, { method: "DELETE" });
        assert.equal(del3.status, 200);
    } finally {
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
});

test("removeCiRunUrl drops a run from the panel state", async () => {
    const entry = await startServer({ ciRunUrl: "https://example.com/run/a" });
    try {
        const url = entry.url.replace(/\/$/, "");
        entry.addCiRunUrl("https://example.com/run/b");
        assert.equal(entry.removeCiRunUrl("https://example.com/run/a"), true);
        const body = await fetch(`${url}/api/ci-run`).then((r) => r.json());
        assert.deepEqual(body.runs.map((x) => x.url), ["https://example.com/run/b"]);
        // Removing a URL that isn't present returns false.
        assert.equal(entry.removeCiRunUrl("https://example.com/missing"), false);
    } finally {
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
});

test("rejects non-loopback Host header with 403 (DNS-rebinding guard)", async () => {
    const r = await rawRequest({ path: "/api/notify-config", headers: { Host: "attacker.example" } });
    assert.equal(r.status, 403);
});

test("allows loopback Host header", async () => {
    const r = await rawRequest({ path: "/api/notify-config", headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(r.status, 200);
});

test("allows localhost Host header", async () => {
    const r = await rawRequest({ path: "/api/notify-config", headers: { Host: `localhost:${port}` } });
    assert.equal(r.status, 200);
});

test("rejects cross-site write via Sec-Fetch-Site with 403 (CSRF guard)", async () => {
    const r = await rawRequest({
        method: "POST",
        path: "/api/notify-config",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
        body: "{}",
    });
    assert.equal(r.status, 403);
});

test("rejects cross-origin write via Origin header with 403 (CSRF guard)", async () => {
    const r = await rawRequest({
        method: "POST",
        path: "/api/watched",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", Origin: "https://attacker.example" },
        body: JSON.stringify({ url: "https://github.com/o/r/pull/1" }),
    });
    assert.equal(r.status, 403);
});

test("rejects cross-port Origin write with 403 (CSRF guard)", async () => {
    // Same loopback hostname but a different port is still a different origin
    // and must be blocked for state-changing requests.
    const r = await rawRequest({
        method: "POST",
        path: "/api/watched",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port + 1}` },
        body: JSON.stringify({ url: "https://github.com/o/r/pull/1" }),
    });
    assert.equal(r.status, 403);
});

test("allows same-origin write (loopback Origin) past the CSRF guard", async () => {
    // Bad body so it 400s inside the handler — the point is it is NOT 403'd.
    const r = await rawRequest({
        method: "POST",
        path: "/api/watched",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" },
        body: JSON.stringify({ url: "not a url" }),
    });
    assert.equal(r.status, 400);
});

test("500 handler does not leak a stack trace", async () => {
    // Drive the real error responder with an error that carries a stack and a
    // local filesystem path, and assert neither is reflected to the caller.
    const err = new Error("boom at C:\\repos\\secret\\path.mjs");
    const chunks = [];
    const headers = {};
    const fakeRes = {
        statusCode: 200,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        end(body) { if (body != null) chunks.push(String(body)); },
    };
    const origConsoleError = console.error;
    console.error = () => {}; // suppress the intentional local error log
    try {
        sendServerError(fakeRes, err);
    } finally {
        console.error = origConsoleError;
    }
    const body = chunks.join("");
    assert.equal(fakeRes.statusCode, 500);
    assert.equal(body, "internal server error");
    assert.doesNotMatch(body, /<pre>/);
    assert.doesNotMatch(body, /at Server\.|at Object\./);
    assert.doesNotMatch(body, /C:\\repos/);
    assert.doesNotMatch(body, /boom/);
});
