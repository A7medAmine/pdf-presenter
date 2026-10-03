"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { startServer, ask, MINIMAL_PDF } = require("./helpers");

describe("HTTP API", () => {
  let ctx;
  before(async () => {
    ctx = await startServer();
  });
  after(() => ctx.close());

  test("GET /health reports ok", async () => {
    const res = await ctx.request("/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "ok");
  });

  test("responses carry a strict Content-Security-Policy", async () => {
    const res = await ctx.request("/index.html");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  test("pages are reachable without the .html extension", async () => {
    const res = await ctx.request("/access");
    assert.equal(res.status, 200);
  });

  test("session creation requires the X-Requested-With header", async () => {
    const res = await ctx.request("/api/session", { method: "POST", body: {}, xhr: false });
    assert.equal(res.status, 403);
  });

  test("session creation keeps non-Latin names", async () => {
    const session = await ctx.createSession({ name: "عرض تقديمي <b>2026</b>" });
    assert.equal(session.name, "عرض تقديمي b2026b");
    assert.match(session.sessionId, /^[A-Z0-9]{16}$/);
    assert.match(session.presenterToken, /^[a-f0-9]{64}$/);
  });

  test("session creation rejects a too-short password", async () => {
    const res = await ctx.request("/api/session", { method: "POST", body: { password: "abc" } });
    assert.equal(res.status, 400);
  });

  test("malformed JSON returns 400 instead of crashing", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: "{oops",
    });
    assert.equal(res.status, 400);
  });

  test("session state requires the presenter token", async () => {
    const session = await ctx.createSession();
    const denied = await ctx.request(`/api/session/${session.sessionId}`);
    assert.equal(denied.status, 403);
    const allowed = await ctx.request(`/api/session/${session.sessionId}`, {
      headers: { "X-Presenter-Token": session.presenterToken },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.sessionId, session.sessionId);
  });

  describe("password verification", () => {
    test("missing password body does not crash the server", async () => {
      const session = await ctx.createSession({ password: "secret" });
      const res = await ctx.request(`/api/session/${session.sessionId}/verify-password`, {
        method: "POST",
        body: {},
      });
      assert.equal(res.status, 401);
      assert.equal((await ctx.request("/health")).status, 200);
    });

    test("correct password returns a viewer token", async () => {
      const session = await ctx.createSession({ password: "secret" });
      const res = await ctx.request(`/api/session/${session.sessionId}/verify-password`, {
        method: "POST",
        body: { password: "secret" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.valid, true);
      assert.match(res.json.viewerToken, /^[a-f0-9]{48}$/);
    });

    test("attempts are rate limited", async () => {
      const session = await ctx.createSession({ password: "secret" });
      const statuses = [];
      for (let i = 0; i < 7; i++) {
        const res = await ctx.request(`/api/session/${session.sessionId}/verify-password`, {
          method: "POST",
          body: { password: "wrong" },
        });
        statuses.push(res.status);
      }
      assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
      assert.equal(statuses[6], 429);
    });
  });

  describe("uploads", () => {
    test("rejects uploads without the presenter token", async () => {
      const session = await ctx.createSession();
      const res = await ctx.uploadPdf({ ...session, presenterToken: "nope" });
      assert.equal(res.status, 403);
    });

    test("rejects files that are not PDFs and deletes them", async () => {
      const session = await ctx.createSession();
      const res = await ctx.uploadPdf(session, Buffer.from("MZ not a pdf"), "evil.pdf");
      assert.equal(res.status, 415);
      assert.deepEqual(fs.readdirSync(ctx.config.uploadDir), []);
    });

    test("stores PDFs under random names and keeps the original name for display", async () => {
      const session = await ctx.createSession();
      const res = await ctx.uploadPdf(session, MINIMAL_PDF, "محاضرة ١.pdf");
      assert.equal(res.status, 201);
      assert.equal(res.json.pdf.name, "محاضرة ١.pdf");
      assert.match(res.json.pdf.url, /^\/uploads\/[a-f0-9]{32}\.pdf\?t=[a-f0-9]{48}$/);
    });

    test("replacing a PDF deletes the previous file", async () => {
      const session = await ctx.createSession();
      const first = await ctx.uploadPdf(session);
      const second = await ctx.uploadPdf(session);
      const firstFile = first.json.pdf.url.split("/")[2].split("?")[0];
      const secondFile = second.json.pdf.url.split("/")[2].split("?")[0];
      await new Promise((r) => setTimeout(r, 50));
      const files = fs.readdirSync(ctx.config.uploadDir);
      assert.ok(!files.includes(firstFile));
      assert.ok(files.includes(secondFile));
    });

    test("rejects files over the size limit", async () => {
      const small = await startServer({ maxUploadBytes: 1024 });
      try {
        const session = await small.createSession();
        const big = Buffer.concat([MINIMAL_PDF, Buffer.alloc(4096)]);
        const res = await small.uploadPdf(session, big);
        assert.equal(res.status, 413);
      } finally {
        await small.close();
      }
    });
  });

  describe("PDF delivery", () => {
    test("requires the session access token", async () => {
      const session = await ctx.createSession();
      const { json } = await ctx.uploadPdf(session);
      const [pathname, query] = json.pdf.url.split("?");

      const withToken = await fetch(ctx.baseUrl + json.pdf.url);
      assert.equal(withToken.status, 200);
      assert.equal(withToken.headers.get("content-type"), "application/pdf");

      assert.equal((await fetch(ctx.baseUrl + pathname)).status, 404);
      assert.equal((await fetch(`${ctx.baseUrl}${pathname}?t=${"0".repeat(48)}`)).status, 404);
      assert.ok(query.startsWith("t="));
    });

    test("supports range requests (used by PDF.js)", async () => {
      const session = await ctx.createSession();
      const { json } = await ctx.uploadPdf(session);
      const res = await fetch(ctx.baseUrl + json.pdf.url, { headers: { Range: "bytes=0-3" } });
      assert.equal(res.status, 206);
      assert.equal(await res.text(), "%PDF");
    });

    test("ending a session deletes its PDF", async () => {
      const session = await ctx.createSession();
      const { json } = await ctx.uploadPdf(session);
      const presenter = await ctx.socket();
      await ask(presenter, "join-session", {
        sessionId: session.sessionId,
        role: "presenter",
        presenterToken: session.presenterToken,
      });
      await ask(presenter, "end-session");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal((await fetch(ctx.baseUrl + json.pdf.url)).status, 404);
      const file = json.pdf.url.split("/")[2].split("?")[0];
      assert.ok(!fs.readdirSync(ctx.config.uploadDir).includes(file));
    });
  });

  test("/api/sessions lists sessions without secrets", async () => {
    const session = await ctx.createSession({ name: "Listed", password: "secret" });
    const res = await ctx.request("/api/sessions");
    const entry = res.json.sessions.find((s) => s.id === session.sessionId);
    assert.equal(entry.name, "Listed");
    assert.equal(entry.hasPassword, true);
    const serialized = JSON.stringify(res.json);
    assert.ok(!serialized.includes(session.presenterToken));
    assert.ok(!serialized.includes("scrypt"));
  });

  test("/api/session/:id/network is presenter-only", async () => {
    const session = await ctx.createSession();
    const denied = await ctx.request(`/api/session/${session.sessionId}/network`);
    assert.equal(denied.status, 403);
    const allowed = await ctx.request(`/api/session/${session.sessionId}/network`, {
      headers: { "X-Presenter-Token": session.presenterToken },
    });
    assert.equal(allowed.status, 200);
    assert.ok(Array.isArray(allowed.json.addresses));
  });

  describe("likes", () => {
    const deviceId = "device-1234567890";

    test("like and unlike are idempotent", async () => {
      const like = (liked) => ctx.request("/api/likes", { method: "POST", body: { deviceId, liked } });
      assert.deepEqual((await like(true)).json, { count: 1, hasLiked: true });
      assert.deepEqual((await like(true)).json, { count: 1, hasLiked: true });
      assert.deepEqual((await like(false)).json, { count: 0, hasLiked: false });
      assert.deepEqual((await like(false)).json, { count: 0, hasLiked: false });
    });

    test("rejects malformed bodies", async () => {
      const res = await ctx.request("/api/likes", { method: "POST", body: { deviceId: "x", action: "unlike" } });
      assert.equal(res.status, 400);
    });
  });

  test("unknown API routes return JSON 404", async () => {
    const res = await ctx.request("/api/nope");
    assert.equal(res.status, 404);
    assert.equal(res.json.code, "NOT_FOUND");
  });

  test("removed library endpoints are gone", async () => {
    assert.equal((await ctx.request("/api/pdfs")).status, 404);
  });
});
