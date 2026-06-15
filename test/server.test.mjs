// Integration tests for lib/server.mjs: start the local HTTP server and hit
// its endpoints with the global fetch API. We exercise the input-validation
// and routing layer end-to-end (not the gh/AzDO calls, which would need
// network); the DB-backed and gh-backed endpoints would surface errors that
// we treat as acceptable for routing validation.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "../lib/server.mjs";

let server;
let baseUrl;

before(async () => {
    const entry = await startServer();
    server = entry.server;
    baseUrl = entry.url.replace(/\/$/, "");
});

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
