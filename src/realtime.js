"use strict";

/**
 * Real-time layer (Socket.io).
 *
 * Every socket belongs to at most one session and has exactly one role, fixed
 * on join:
 *   - presenter: proves ownership with the presenter token; a new presenter
 *                connection (page reload, new tab) replaces the old one.
 *   - viewer:    read-only audience; needs a viewer token when the session has a password.
 *   - remote:    phone/tablet controller; needs the presenter's approval (remembered per device).
 *
 * Client → server events use acknowledgements: every handler answers
 * `{ ok: true, ... }` or `{ ok: false, code, message }`.
 *
 * Server → client events:
 *   session-state, slide-update, total-slides-update, pdf-loaded, presence,
 *   presenter-status, session-renamed, session-ended, cursor-move,
 *   remote-pending, remote-request-cancelled, remote-approved, remote-rejected,
 *   presenter-replaced
 */

const {
  safeEqual,
  isSessionId,
  isDeviceId,
  sanitizeDisplayName,
} = require("./security");
const { toPublicState } = require("./session-store");

const MAX_TOTAL_SLIDES = 10_000;
/** Minimum delay between two forwarded cursor events of one socket (~60 fps). */
const CURSOR_INTERVAL_MS = 15;
/** Minimum delay between two remote-access requests of one socket. */
const REMOTE_REQUEST_INTERVAL_MS = 3000;
/** Generic per-socket event budget (token bucket). */
const EVENT_BURST = 40;
const EVENT_REFILL_PER_SEC = 20;
/** How often expired sessions are swept. */
const SWEEP_INTERVAL_MS = 60 * 1000;

const ROLES = Object.freeze({ PRESENTER: "presenter", VIEWER: "viewer", REMOTE: "remote" });

/** Expected failure, reported to the client through the acknowledgement. */
class ClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Wires all socket handlers.
 *
 * @param {object} deps
 * @param {import("socket.io").Server} deps.io
 * @param {import("./session-store").SessionStore} deps.store
 * @param {import("./logger").Logger} deps.logger
 * @returns {{ announcePdf: (session: import("./session-store").Session) => void,
 *             endSession: (sessionId: string, reason: string) => void,
 *             close: () => void }}
 */
function registerRealtime({ io, store, logger }) {
  // ── Helpers ──────────────────────────────────────────────────────────────

  const socketById = (id) => io.sockets.sockets.get(id);

  /** Broadcasts member counts to everyone in the session. */
  function emitPresence(session) {
    io.to(session.id).emit("presence", {
      viewerCount: session.viewers.size,
      remoteCount: session.remotes.size,
    });
  }

  /** Sends a pending-request notification to the presenter (if connected). */
  function notifyPresenterOfPending(session, socketId, pending) {
    if (!session.presenterSocketId) return;
    io.to(session.presenterSocketId).emit("remote-pending", {
      remoteSocketId: socketId,
      deviceLabel: pending.deviceId.slice(0, 6).toUpperCase(),
      pendingCount: session.pendingRemotes.size,
    });
  }

  /** Adds a socket to a session with a fixed role. */
  function attach(socket, session, role) {
    socket.data.sessionId = session.id;
    socket.data.role = role;
    socket.join(session.id);
    if (role === ROLES.VIEWER) session.viewers.add(socket.id);
    if (role === ROLES.REMOTE) session.remotes.add(socket.id);
    store.touch(session);
  }

  /** Returns the socket's session, or throws when the socket has not joined one. */
  function requireMembership(socket, roles) {
    const session = store.get(socket.data.sessionId);
    if (!session) throw new ClientError("NOT_IN_SESSION", "Join a session first");
    if (!roles.includes(socket.data.role)) {
      throw new ClientError("FORBIDDEN", `Requires role: ${roles.join(" or ")}`);
    }
    return session;
  }

  /**
   * Ends a session: notifies every member (and pending remotes), detaches all
   * sockets and deletes the PDF.
   */
  function endSession(sessionId, reason) {
    const session = store.get(sessionId);
    if (!session) return;

    const message = reason === "expired" ? "Session expired" : "The presenter ended the session";
    const payload = { reason, message };
    io.to(sessionId).emit("session-ended", payload);

    for (const socketId of session.pendingRemotes.keys()) socketById(socketId)?.emit("session-ended", payload);

    const members = io.sockets.adapter.rooms.get(sessionId);
    for (const socketId of members ? [...members] : []) {
      const member = socketById(socketId);
      if (!member) continue;
      member.leave(sessionId);
      member.data.sessionId = null;
      member.data.role = null;
    }

    store.destroy(sessionId);
    logger.info(`Session ${sessionId} ended (${reason})`);
  }

  /** Sends the new PDF to everybody but the presenter, who already has it. */
  function announcePdf(session) {
    const state = toPublicState(session);
    const target = session.presenterSocketId
      ? io.to(session.id).except(session.presenterSocketId)
      : io.to(session.id);
    target.emit("pdf-loaded", { pdf: state.pdf, currentSlide: state.currentSlide, totalSlides: state.totalSlides });
  }

  /** Token bucket: returns false when the socket exceeded its event budget. */
  function consumeBudget(socket) {
    const now = Date.now();
    const bucket = socket.data.bucket || { tokens: EVENT_BURST, last: now };
    bucket.tokens = Math.min(EVENT_BURST, bucket.tokens + ((now - bucket.last) / 1000) * EVENT_REFILL_PER_SEC);
    bucket.last = now;
    socket.data.bucket = bucket;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Registers a handler with uniform validation, rate limiting, error
   * reporting and acknowledgements.
   */
  function handle(socket, event, handler, { rateLimited = true } = {}) {
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (rateLimited && !consumeBudget(socket)) {
        return reply({ ok: false, code: "RATE_LIMITED", message: "Too many requests" });
      }
      try {
        const data = payload !== null && typeof payload === "object" ? payload : {};
        const result = await handler(data);
        reply({ ok: true, ...(result || {}) });
      } catch (err) {
        if (err instanceof ClientError) {
          logger.debug(`${event} rejected for ${socket.id}: ${err.code}`);
          reply({ ok: false, code: err.code, message: err.message });
        } else {
          logger.error(`Handler ${event} failed`, err);
          reply({ ok: false, code: "INTERNAL", message: "Internal error" });
        }
      }
    });
  }

  // ── Connection handling ──────────────────────────────────────────────────

  io.on("connection", (socket) => {
    logger.debug(`Socket ${socket.id} connected`);

    const assertNotJoined = () => {
      if (socket.data.sessionId || socket.data.pendingSessionId) {
        throw new ClientError("ALREADY_JOINED", "This connection already belongs to a session");
      }
    };

    const findSession = (sessionId) => {
      const session = isSessionId(sessionId) ? store.get(sessionId) : undefined;
      if (!session) throw new ClientError("SESSION_NOT_FOUND", "Session not found");
      return session;
    };

    /**
     * join-session — presenter or viewer joins.
     * Payload: { sessionId, role: "presenter"|"viewer", presenterToken?, viewerToken? }
     */
    handle(socket, "join-session", ({ sessionId, role, presenterToken, viewerToken }) => {
      assertNotJoined();
      const session = findSession(sessionId);

      if (role === ROLES.PRESENTER) {
        if (!safeEqual(presenterToken, session.presenterToken)) {
          throw new ClientError("FORBIDDEN", "Invalid presenter token");
        }
        const previous = session.presenterSocketId && socketById(session.presenterSocketId);
        if (previous && previous.id !== socket.id) {
          // A reload or second tab takes over; the stale connection is closed.
          previous.data.sessionId = null;
          previous.data.role = null;
          previous.emit("presenter-replaced");
          previous.disconnect(true);
        }
        session.presenterSocketId = socket.id;
        attach(socket, session, ROLES.PRESENTER);
        io.to(session.id).emit("presenter-status", { online: true });
        for (const [pendingId, pending] of session.pendingRemotes) {
          notifyPresenterOfPending(session, pendingId, pending);
        }
        logger.debug(`Presenter joined ${session.id}`);
      } else if (role === ROLES.VIEWER) {
        if (!store.canView(session, viewerToken)) {
          throw new ClientError("PASSWORD_REQUIRED", "This session requires a password");
        }
        attach(socket, session, ROLES.VIEWER);
      } else {
        // Remotes must go through remote-request-access (presenter approval).
        throw new ClientError("BAD_ROLE", "Unsupported role");
      }

      emitPresence(session);
      return { state: toPublicState(session) };
    });

    /**
     * remote-request-access — a remote asks to control the session.
     * Payload: { sessionId, deviceId }
     * Answers { status: "approved", state } or { status: "pending" }.
     */
    handle(socket, "remote-request-access", ({ sessionId, deviceId }) => {
      assertNotJoined();
      if (!isDeviceId(deviceId)) throw new ClientError("BAD_DEVICE", "Invalid device ID");

      const now = Date.now();
      if (now - (socket.data.lastRemoteRequest || 0) < REMOTE_REQUEST_INTERVAL_MS) {
        throw new ClientError("RATE_LIMITED", "Please wait before requesting again");
      }
      socket.data.lastRemoteRequest = now;

      const session = findSession(sessionId);
      if (session.blockedDevices.has(deviceId)) throw new ClientError("BLOCKED", "Access denied");

      socket.data.deviceId = deviceId;

      // Devices approved earlier in this session reconnect without asking again.
      if (session.approvedDevices.has(deviceId)) {
        attach(socket, session, ROLES.REMOTE);
        emitPresence(session);
        return { status: "approved", state: toPublicState(session) };
      }

      if (!session.presenterSocketId) throw new ClientError("PRESENTER_OFFLINE", "The presenter is not connected");
      if (!session.remoteRequestsEnabled) {
        throw new ClientError("REQUESTS_DISABLED", "The presenter is not accepting remotes right now");
      }

      // A device re-requesting from a new connection replaces its old request.
      for (const [pendingId, pending] of session.pendingRemotes) {
        if (pending.deviceId === deviceId) {
          session.pendingRemotes.delete(pendingId);
          io.to(session.presenterSocketId).emit("remote-request-cancelled", { remoteSocketId: pendingId });
        }
      }
      if (!store.hasPendingCapacity(session)) {
        throw new ClientError("TOO_MANY_PENDING", "Too many pending requests, try again later");
      }

      const pending = { deviceId, requestedAt: now };
      session.pendingRemotes.set(socket.id, pending);
      socket.data.pendingSessionId = session.id;
      notifyPresenterOfPending(session, socket.id, pending);
      return { status: "pending" };
    });

    /** Shared lookup for the presenter's accept/reject/block actions. */
    const takePending = (remoteSocketId) => {
      const session = requireMembership(socket, [ROLES.PRESENTER]);
      const pending = typeof remoteSocketId === "string" && session.pendingRemotes.get(remoteSocketId);
      if (!pending) throw new ClientError("NOT_FOUND", "Request not found");
      session.pendingRemotes.delete(remoteSocketId);
      return { session, pending, remote: socketById(remoteSocketId) };
    };

    /** Rejects a remote: tells it why and closes its connection. */
    const dismissRemote = (remote, message) => {
      if (!remote) return;
      remote.data.pendingSessionId = null;
      remote.emit("remote-rejected", { message });
      remote.disconnect(true);
    };

    /** remote-accept — Payload: { remoteSocketId } */
    handle(socket, "remote-accept", ({ remoteSocketId }) => {
      const { session, pending, remote } = takePending(remoteSocketId);
      if (!remote) throw new ClientError("GONE", "The remote disconnected");
      session.approvedDevices.add(pending.deviceId);
      remote.data.pendingSessionId = null;
      attach(remote, session, ROLES.REMOTE);
      remote.emit("remote-approved", { state: toPublicState(session) });
      emitPresence(session);
      return { pendingCount: session.pendingRemotes.size };
    });

    /** remote-reject — Payload: { remoteSocketId } */
    handle(socket, "remote-reject", ({ remoteSocketId }) => {
      const { session, remote } = takePending(remoteSocketId);
      dismissRemote(remote, "The presenter declined your request");
      return { pendingCount: session.pendingRemotes.size };
    });

    /** remote-block — rejects a request and blocks the device. Payload: { remoteSocketId } */
    handle(socket, "remote-block", ({ remoteSocketId }) => {
      const { session, pending, remote } = takePending(remoteSocketId);
      session.blockedDevices.add(pending.deviceId);
      session.approvedDevices.delete(pending.deviceId);
      dismissRemote(remote, "You have been blocked from this session");
      return { pendingCount: session.pendingRemotes.size };
    });

    /** toggle-remote-requests — Payload: { enabled: boolean } */
    handle(socket, "toggle-remote-requests", ({ enabled }) => {
      const session = requireMembership(socket, [ROLES.PRESENTER]);
      if (typeof enabled !== "boolean") throw new ClientError("BAD_INPUT", "`enabled` must be a boolean");
      session.remoteRequestsEnabled = enabled;
      return { enabled };
    });

    /**
     * slide-change — Payload: { slide: number } (absolute, 1-based) or { direction: "next"|"prev" }.
     * Broadcasts slide-update to the whole session when the slide actually changes.
     */
    handle(socket, "slide-change", ({ slide, direction }) => {
      const session = requireMembership(socket, [ROLES.PRESENTER, ROLES.REMOTE]);
      if (!session.pdf) throw new ClientError("NO_PDF", "No PDF loaded");

      const last = session.totalSlides || MAX_TOTAL_SLIDES;
      let target;
      if (Number.isInteger(slide)) target = slide;
      else if (direction === "next") target = session.currentSlide + 1;
      else if (direction === "prev") target = session.currentSlide - 1;
      else throw new ClientError("BAD_INPUT", "Expected an integer `slide` or a `direction`");

      target = Math.min(last, Math.max(1, target));
      if (target !== session.currentSlide) {
        session.currentSlide = target;
        io.to(session.id).emit("slide-update", { currentSlide: target });
      }
      store.touch(session);
      return { currentSlide: session.currentSlide };
    });

    /** set-total-slides — presenter reports the page count. Payload: { totalSlides } */
    handle(socket, "set-total-slides", ({ totalSlides }) => {
      const session = requireMembership(socket, [ROLES.PRESENTER]);
      if (!session.pdf) throw new ClientError("NO_PDF", "No PDF loaded");
      if (!Number.isInteger(totalSlides) || totalSlides < 1 || totalSlides > MAX_TOTAL_SLIDES) {
        throw new ClientError("BAD_INPUT", "Invalid slide count");
      }
      session.totalSlides = totalSlides;
      session.currentSlide = Math.min(session.currentSlide, totalSlides);
      io.to(session.id).emit("total-slides-update", { totalSlides, currentSlide: session.currentSlide });
    });

    /**
     * cursor-move — remote pointer, forwarded to the presenter and viewers.
     * Payload: { x, y, active } with x/y in [0, 1]. Fire-and-forget (volatile).
     */
    socket.on("cursor-move", (payload) => {
      if (socket.data.role !== ROLES.REMOTE || !payload || typeof payload !== "object") return;
      const session = store.get(socket.data.sessionId);
      if (!session) return;

      const now = Date.now();
      const active = Boolean(payload.active);
      // Always forward "pointer released" so the cursor never gets stuck on screen.
      if (active && now - (socket.data.lastCursor || 0) < CURSOR_INTERVAL_MS) return;
      socket.data.lastCursor = now;

      const clamp = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
      socket.volatile.to(session.id).emit("cursor-move", { x: clamp(payload.x), y: clamp(payload.y), active });
    });

    /** rename-session — Payload: { name } */
    handle(socket, "rename-session", ({ name }) => {
      const session = requireMembership(socket, [ROLES.PRESENTER]);
      const cleaned = sanitizeDisplayName(name);
      if (!cleaned) throw new ClientError("BAD_INPUT", "Invalid session name");
      session.name = cleaned;
      io.to(session.id).emit("session-renamed", { name: cleaned });
      return { name: cleaned };
    });

    /** end-session — the presenter closes the session for everyone. */
    handle(socket, "end-session", () => {
      const session = requireMembership(socket, [ROLES.PRESENTER]);
      endSession(session.id, "ended");
    });

    /** request-session-state — any member re-syncs its state. */
    handle(socket, "request-session-state", () => {
      const session = requireMembership(socket, Object.values(ROLES));
      return { state: toPublicState(session) };
    });

    socket.on("disconnect", (reason) => {
      logger.debug(`Socket ${socket.id} disconnected (${reason})`);

      const pendingSession = store.get(socket.data.pendingSessionId);
      if (pendingSession?.pendingRemotes.delete(socket.id) && pendingSession.presenterSocketId) {
        io.to(pendingSession.presenterSocketId).emit("remote-request-cancelled", { remoteSocketId: socket.id });
      }

      const session = store.get(socket.data.sessionId);
      if (!session) return;
      session.viewers.delete(socket.id);
      session.remotes.delete(socket.id);
      if (session.presenterSocketId === socket.id) {
        session.presenterSocketId = null;
        io.to(session.id).emit("presenter-status", { online: false });
      }
      store.touch(session);
      emitPresence(session);
    });
  });

  // ── Expiry sweeper ───────────────────────────────────────────────────────

  const sweeper = setInterval(() => {
    for (const id of store.expiredIds()) endSession(id, "expired");
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    announcePdf,
    endSession,
    close: () => clearInterval(sweeper),
  };
}

module.exports = { registerRealtime, ROLES };
