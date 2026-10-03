"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startServer, ask, next, delay } = require("./helpers");

describe("Realtime (Socket.io)", () => {
  let ctx;
  before(async () => {
    ctx = await startServer();
  });
  after(() => ctx.close());

  /** Creates a session with an uploaded PDF and a connected presenter. */
  async function setup({ password } = {}) {
    const session = await ctx.createSession(password ? { password } : {});
    await ctx.uploadPdf(session);
    const presenter = await ctx.socket();
    const joined = await ask(presenter, "join-session", {
      sessionId: session.sessionId,
      role: "presenter",
      presenterToken: session.presenterToken,
    });
    assert.equal(joined.ok, true);
    await ask(presenter, "set-total-slides", { totalSlides: 10 });
    return { session, presenter };
  }

  /** Connects a remote and has the presenter approve it. */
  async function approvedRemote(session, presenter, deviceId = "remote-device-0001") {
    const remote = await ctx.socket();
    const pendingEvent = next(presenter, "remote-pending");
    const request = await ask(remote, "remote-request-access", { sessionId: session.sessionId, deviceId });
    assert.equal(request.status, "pending");
    const { remoteSocketId } = await pendingEvent;
    const approvedEvent = next(remote, "remote-approved");
    assert.equal((await ask(presenter, "remote-accept", { remoteSocketId })).ok, true);
    await approvedEvent;
    return remote;
  }

  test("joining an unknown session fails instead of creating it", async () => {
    const client = await ctx.socket();
    const res = await ask(client, "join-session", { sessionId: "ZZZZZZZZZZZZZZZZ", role: "viewer" });
    assert.equal(res.code, "SESSION_NOT_FOUND");
    assert.equal(ctx.store.get("ZZZZZZZZZZZZZZZZ"), undefined);
  });

  test("presenter join requires the presenter token", async () => {
    const session = await ctx.createSession();
    const client = await ctx.socket();
    const res = await ask(client, "join-session", { sessionId: session.sessionId, role: "presenter" });
    assert.equal(res.code, "FORBIDDEN");
  });

  test("a reloaded presenter takes over the session", async () => {
    const { session, presenter } = await setup();
    const replaced = next(presenter, "presenter-replaced");
    const reloaded = await ctx.socket();
    const res = await ask(reloaded, "join-session", {
      sessionId: session.sessionId,
      role: "presenter",
      presenterToken: session.presenterToken,
    });
    assert.equal(res.ok, true);
    await replaced;
    const change = await ask(reloaded, "slide-change", { slide: 4 });
    assert.equal(change.currentSlide, 4);
  });

  test("presenter disconnect clears the presenter slot", async () => {
    const { session, presenter } = await setup();
    presenter.disconnect();
    await delay(50);
    assert.equal(ctx.store.get(session.sessionId).presenterSocketId, null);
  });

  test("viewers receive the state, slide updates and a working PDF URL", async () => {
    const { session, presenter } = await setup();
    const viewer = await ctx.socket();
    const joined = await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });
    assert.equal(joined.ok, true);
    assert.equal(joined.state.totalSlides, 10);
    assert.equal((await fetch(ctx.baseUrl + joined.state.pdf.url)).status, 200);

    const update = next(viewer, "slide-update");
    await ask(presenter, "slide-change", { direction: "next" });
    assert.deepEqual(await update, { currentSlide: 2 });
  });

  test("viewers cannot change slides", async () => {
    const { session } = await setup();
    const viewer = await ctx.socket();
    await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });
    const res = await ask(viewer, "slide-change", { slide: 5 });
    assert.equal(res.code, "FORBIDDEN");
  });

  test("password-protected sessions require a viewer token", async () => {
    const { session } = await setup({ password: "secret" });
    const viewer = await ctx.socket();
    const denied = await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });
    assert.equal(denied.code, "PASSWORD_REQUIRED");

    const { json } = await ctx.request(`/api/session/${session.sessionId}/verify-password`, {
      method: "POST",
      body: { password: "secret" },
    });
    const allowed = await ask(viewer, "join-session", {
      sessionId: session.sessionId,
      role: "viewer",
      viewerToken: json.viewerToken,
    });
    assert.equal(allowed.ok, true);
  });

  test("slide input is validated and clamped", async () => {
    const { presenter } = await setup();
    assert.equal((await ask(presenter, "slide-change", { slide: Number.NaN })).code, "BAD_INPUT");
    assert.equal((await ask(presenter, "slide-change", { slide: "3" })).code, "BAD_INPUT");
    assert.equal((await ask(presenter, "slide-change", { slide: 999 })).currentSlide, 10);
    assert.equal((await ask(presenter, "slide-change", { slide: -5 })).currentSlide, 1);
    assert.equal((await ask(presenter, "set-total-slides", { totalSlides: 0 })).code, "BAD_INPUT");
  });

  describe("remote approval", () => {
    test("a pending remote cannot join or control before approval", async () => {
      const { session, presenter } = await setup();
      const remote = await ctx.socket();
      const pending = next(presenter, "remote-pending");
      await ask(remote, "remote-request-access", { sessionId: session.sessionId, deviceId: "sneaky-device-01" });
      await pending;

      const bypass = await ask(remote, "join-session", { sessionId: session.sessionId, role: "remote" });
      assert.equal(bypass.code, "ALREADY_JOINED");
      const control = await ask(remote, "slide-change", { slide: 3 });
      assert.equal(control.code, "NOT_IN_SESSION");
    });

    test("an approved remote can control slides and reconnect without approval", async () => {
      const { session, presenter } = await setup();
      const remote = await approvedRemote(session, presenter, "phone-device-0001");
      assert.equal((await ask(remote, "slide-change", { direction: "next" })).currentSlide, 2);

      remote.disconnect();
      const again = await ctx.socket();
      const res = await ask(again, "remote-request-access", {
        sessionId: session.sessionId,
        deviceId: "phone-device-0001",
      });
      assert.equal(res.status, "approved");
    });

    test("rejected remotes are disconnected", async () => {
      const { session, presenter } = await setup();
      const remote = await ctx.socket();
      const pending = next(presenter, "remote-pending");
      await ask(remote, "remote-request-access", { sessionId: session.sessionId, deviceId: "unwanted-device1" });
      const { remoteSocketId } = await pending;
      const rejected = next(remote, "remote-rejected");
      const disconnected = next(remote, "disconnect");
      await ask(presenter, "remote-reject", { remoteSocketId });
      await rejected;
      await disconnected;
    });

    test("blocked devices cannot request again", async () => {
      const { session, presenter } = await setup();
      const remote = await ctx.socket();
      const pending = next(presenter, "remote-pending");
      await ask(remote, "remote-request-access", { sessionId: session.sessionId, deviceId: "blocked-device-1" });
      const { remoteSocketId } = await pending;
      await ask(presenter, "remote-block", { remoteSocketId });

      const retry = await ctx.socket();
      const res = await ask(retry, "remote-request-access", {
        sessionId: session.sessionId,
        deviceId: "blocked-device-1",
      });
      assert.equal(res.code, "BLOCKED");
    });

    test("a pending request disappears when the remote disconnects", async () => {
      const { session, presenter } = await setup();
      const remote = await ctx.socket();
      const pending = next(presenter, "remote-pending");
      await ask(remote, "remote-request-access", { sessionId: session.sessionId, deviceId: "leaving-device-1" });
      const { remoteSocketId } = await pending;
      const cancelled = next(presenter, "remote-request-cancelled");
      remote.disconnect();
      assert.deepEqual(await cancelled, { remoteSocketId });
      assert.equal(ctx.store.get(session.sessionId).pendingRemotes.size, 0);
    });

    test("a viewer cannot switch to the remote role", async () => {
      const { session } = await setup();
      const viewer = await ctx.socket();
      await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });
      const res = await ask(viewer, "remote-request-access", {
        sessionId: session.sessionId,
        deviceId: "viewer-device-001",
      });
      assert.equal(res.code, "ALREADY_JOINED");
    });

    test("remote cursor events reach viewers with clamped coordinates", async () => {
      const { session, presenter } = await setup();
      const remote = await approvedRemote(session, presenter, "cursor-device-01");
      const viewer = await ctx.socket();
      await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });
      const moved = next(viewer, "cursor-move");
      remote.emit("cursor-move", { x: 5, y: -1, active: true });
      assert.deepEqual(await moved, { x: 1, y: 0, active: true });
    });
  });

  test("presence counts follow joins and leaves", async () => {
    const { session, presenter } = await setup();
    const viewer = await ctx.socket();
    const joinedPresence = next(presenter, "presence");
    await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });
    assert.equal((await joinedPresence).viewerCount, 1);
    const leftPresence = next(presenter, "presence");
    viewer.disconnect();
    assert.equal((await leftPresence).viewerCount, 0);
  });

  test("uploading a new PDF notifies members but not the presenter", async () => {
    const { session, presenter } = await setup();
    const viewer = await ctx.socket();
    await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });

    let presenterNotified = false;
    presenter.on("pdf-loaded", () => (presenterNotified = true));
    const loaded = next(viewer, "pdf-loaded");
    await ctx.uploadPdf(session);
    const payload = await loaded;
    assert.equal(payload.currentSlide, 1);
    assert.match(payload.pdf.url, /^\/uploads\//);
    await delay(50);
    assert.equal(presenterNotified, false);
  });

  test("renaming sanitizes and broadcasts the name", async () => {
    const { session, presenter } = await setup();
    const viewer = await ctx.socket();
    await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });
    const renamed = next(viewer, "session-renamed");
    await ask(presenter, "rename-session", { name: "  درس   <script>  " });
    assert.deepEqual(await renamed, { name: "درس script" });
  });

  test("ending the session notifies members and removes it", async () => {
    const { session, presenter } = await setup();
    const viewer = await ctx.socket();
    await ask(viewer, "join-session", { sessionId: session.sessionId, role: "viewer" });
    const ended = next(viewer, "session-ended");
    await ask(presenter, "end-session");
    assert.equal((await ended).reason, "ended");
    assert.equal(ctx.store.get(session.sessionId), undefined);
  });

  test("expired sessions are swept", async () => {
    const { session, presenter } = await setup();
    presenter.disconnect();
    await delay(50);
    ctx.store.get(session.sessionId).lastActivityAt = 0;
    assert.deepEqual(ctx.store.expiredIds(), [session.sessionId]);
    ctx.realtime.endSession(session.sessionId, "expired");
    assert.equal(ctx.store.get(session.sessionId), undefined);
  });

  test("garbage payloads never crash the server", async () => {
    const client = await ctx.socket();
    for (const payload of [null, 42, "x", [], { sessionId: { $gt: "" } }]) {
      const res = await ask(client, "join-session", payload);
      assert.equal(res.ok, false);
    }
    client.emit("cursor-move", null);
    client.emit("slide-change");
    assert.equal((await ctx.request("/health")).status, 200);
  });

  test("cross-origin WebSocket handshakes are refused", async () => {
    const { io: connect } = require("socket.io-client");
    const client = connect(ctx.baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Origin: "https://evil.example" },
    });
    const outcome = await new Promise((resolve) => {
      client.once("connect", () => resolve("connected"));
      client.once("connect_error", () => resolve("refused"));
    });
    client.close();
    assert.equal(outcome, "refused");
  });
});
