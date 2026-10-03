"use strict";

/**
 * HTTP layer: security headers, static files, REST API and PDF delivery.
 *
 * Authentication model (no cookies, so classic CSRF does not apply):
 *  - Presenter: `X-Presenter-Token` header, returned once when the session is created.
 *  - Members:   PDF URLs carry the session's `accessToken` (`?t=`), which is only
 *               handed out over the socket after a successful join.
 *  - State-changing requests must also send `X-Requested-With: XMLHttpRequest`,
 *    which a cross-site HTML form cannot set.
 */

const fs = require("node:fs");
const express = require("express");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");

const {
  randomToken,
  safeEqual,
  isSessionId,
  isDeviceId,
  isStoredPdfName,
  isValidPassword,
  hashPassword,
  verifyPassword,
  sanitizeOriginalFilename,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} = require("./security");
const { toPublicState } = require("./session-store");
const { lanAddresses } = require("./network");

/** Content Security Policy: no inline scripts, no third-party origins. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** A PDF may start with a few junk bytes; the spec allows the header within the first 1 KiB. */
const PDF_HEADER_SCAN_BYTES = 1024;

/** Error carrying an HTTP status, rendered as JSON by the error handler. */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Wraps an async handler so rejections reach the Express error handler (Express 4 does not). */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function securityHeaders(_req, res, next) {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
}

/** Rejects state-changing requests that a cross-site form could forge. */
function requireXhr(req, _res, next) {
  if (req.get("x-requested-with") !== "XMLHttpRequest") {
    return next(new HttpError(403, "Missing X-Requested-With header", "CSRF"));
  }
  next();
}

/** Base URL as seen by the client (honours `trust proxy` for protocol). */
function originOf(req) {
  return `${req.protocol}://${req.get("host")}`;
}

/** @returns {Promise<boolean>} Whether the file looks like a PDF. */
async function hasPdfHeader(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(PDF_HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PDF_HEADER_SCAN_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes("%PDF-");
  } finally {
    await handle.close();
  }
}

/**
 * Registers middleware and routes on an Express app.
 *
 * @param {import("express").Express} app
 * @param {object} deps
 * @param {ReturnType<import("./config").loadConfig>} deps.config
 * @param {import("./session-store").SessionStore} deps.store
 * @param {import("./likes-store").LikesStore} deps.likes
 * @param {{ announcePdf: (session: import("./session-store").Session) => void }} deps.realtime
 * @param {import("./logger").Logger} deps.logger
 */
function registerHttp(app, { config, store, likes, realtime, logger }) {
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(securityHeaders);

  // ── Static files ─────────────────────────────────────────────────────────
  app.use(
    express.static(config.publicDir, {
      extensions: ["html"],
      setHeaders(res, filePath) {
        // HTML must always be revalidated so deployments take effect at once;
        // assets may be cached briefly.
        res.setHeader("Cache-Control", filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600");
      },
    }),
  );

  app.use(express.json({ limit: "10kb" }));

  // ── Rate limiters ────────────────────────────────────────────────────────
  const limiterDefaults = { standardHeaders: "draft-7", legacyHeaders: false };
  const sessionCreateLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: config.sessionRateWindowMs,
    limit: config.sessionRateMax,
    message: { error: "Too many sessions created from this address, try again later" },
  });
  const uploadLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 60 * 60 * 1000,
    limit: 30,
    // Runs after presenter authentication, so the key cannot be abused by others.
    keyGenerator: (_req, res) => res.locals.session.id,
    message: { error: "Too many uploads for this session, try again later" },
  });
  const passwordLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 60 * 1000,
    limit: 5,
    keyGenerator: (req) => `${req.ip}:${req.params.sessionId}`,
    message: { error: "Too many attempts, wait a minute and try again" },
  });
  const likesLimiter = rateLimit({
    ...limiterDefaults,
    windowMs: 60 * 1000,
    limit: 20,
    message: { error: "Too many requests, slow down" },
  });

  // ── Parameter helpers ────────────────────────────────────────────────────
  /** Loads `req.params.sessionId` into `res.locals.session` or answers 404. */
  function loadSession(req, res, next) {
    const { sessionId } = req.params;
    const session = isSessionId(sessionId) ? store.get(sessionId) : undefined;
    if (!session) return next(new HttpError(404, "Session not found", "SESSION_NOT_FOUND"));
    res.locals.session = session;
    next();
  }

  /** Requires the presenter token for `res.locals.session`. */
  function requirePresenter(req, res, next) {
    if (!safeEqual(req.get("x-presenter-token"), res.locals.session.presenterToken)) {
      return next(new HttpError(403, "Invalid presenter token", "FORBIDDEN"));
    }
    store.touch(res.locals.session);
    next();
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      // Never trust the client's name on disk: random name, fixed extension.
      filename: (_req, _file, cb) => cb(null, `${randomToken(16)}.pdf`),
    }),
    defParamCharset: "utf8", // keeps non-Latin (e.g. Arabic) file names intact
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 2, parts: 3 },
    fileFilter: (_req, file, cb) => {
      const looksLikePdf =
        file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
      cb(looksLikePdf ? null : new HttpError(415, "Only PDF files are allowed", "NOT_PDF"), looksLikePdf);
    },
  });

  // ── Routes ───────────────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", sessions: store.size, uptime: Math.round(process.uptime()) });
  });

  /** Creates a session. Body: `{ name?: string, password?: string }`. */
  app.post(
    "/api/session",
    sessionCreateLimiter,
    requireXhr,
    asyncHandler(async (req, res) => {
      const { name, password } = req.body || {};
      let passwordHash = null;
      if (password !== undefined && password !== null && password !== "") {
        if (!isValidPassword(password)) {
          throw new HttpError(
            400,
            `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
            "INVALID_PASSWORD",
          );
        }
        passwordHash = await hashPassword(password);
      }

      const session = store.create({ name, passwordHash });
      logger.info(`Session ${session.id} created${passwordHash ? " (password protected)" : ""}`);

      const origin = originOf(req);
      res.status(201).json({
        sessionId: session.id,
        presenterToken: session.presenterToken,
        name: session.name,
        remoteUrl: `${origin}/remote.html?session=${session.id}`,
        viewerUrl: `${origin}/viewer.html?session=${session.id}`,
      });
    }),
  );

  /** Full session state for the presenter (used to restore after a page reload). */
  app.get("/api/session/:sessionId", loadSession, requirePresenter, (req, res) => {
    res.json(toPublicState(res.locals.session));
  });

  /** Public info a viewer needs before joining. */
  app.get("/api/session/:sessionId/requires-password", loadSession, (req, res) => {
    res.json({ requiresPassword: Boolean(res.locals.session.passwordHash), name: res.locals.session.name });
  });

  /** Exchanges the viewer password for a viewer token. Body: `{ password: string }`. */
  app.post(
    "/api/session/:sessionId/verify-password",
    requireXhr,
    passwordLimiter,
    loadSession,
    asyncHandler(async (req, res) => {
      const { session } = res.locals;
      if (!session.passwordHash) return res.json({ valid: true, viewerToken: null });

      const valid = await verifyPassword(req.body?.password, session.passwordHash);
      if (!valid) return res.status(401).json({ valid: false, error: "Invalid password" });

      res.json({ valid: true, viewerToken: store.issueViewerToken(session) });
    }),
  );

  /** Uploads (or replaces) the session's PDF. Multipart field: `pdf`. */
  app.post(
    "/api/upload/:sessionId",
    requireXhr,
    loadSession,
    requirePresenter,
    uploadLimiter,
    upload.single("pdf"),
    asyncHandler(async (req, res) => {
      const { session } = res.locals;
      const { file } = req;
      if (!file) throw new HttpError(400, "No PDF uploaded", "NO_FILE");

      const isPdf = await hasPdfHeader(file.path).catch(() => false);
      // The session may have ended while the upload was streaming.
      if (!isPdf || store.get(session.id) !== session) {
        await fs.promises.unlink(file.path).catch(() => {});
        if (!isPdf) throw new HttpError(415, "The file is not a valid PDF", "NOT_PDF");
        throw new HttpError(404, "Session not found", "SESSION_NOT_FOUND");
      }

      store.setPdf(session, {
        file: file.filename,
        originalName: sanitizeOriginalFilename(file.originalname),
        size: file.size,
      });
      logger.info(`Session ${session.id}: PDF uploaded (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

      realtime.announcePdf(session);
      res.status(201).json(toPublicState(session));
    }),
  );

  /** Lists sessions for the /access page. Contains no secrets. */
  app.get("/api/sessions", (_req, res) => {
    const sessions = [...store.all()].map((s) => ({
      id: s.id,
      name: s.name,
      hasPassword: Boolean(s.passwordHash),
      hasPdf: Boolean(s.pdf),
      viewerCount: s.viewers.size,
      presenterOnline: Boolean(s.presenterSocketId),
      createdAt: s.createdAt,
    }));
    res.json({ sessions });
  });

  /** LAN addresses of the server, so the presenter can build phone-reachable QR codes. */
  app.get("/api/session/:sessionId/network", loadSession, requirePresenter, (_req, res) => {
    res.json({ addresses: lanAddresses() });
  });

  /** Streams a session PDF to members holding the session access token. */
  app.get("/uploads/:file", (req, res, next) => {
    const { file } = req.params;
    const session = isStoredPdfName(file) ? store.findByFile(file) : undefined;
    // Same 404 for every failure so file names cannot be probed.
    if (!session || !safeEqual(req.query.t, session.accessToken)) {
      return next(new HttpError(404, "File not found", "NOT_FOUND"));
    }
    res.setHeader("Cache-Control", "private, max-age=600");
    res.sendFile(store.filePath(file), { headers: { "Content-Type": "application/pdf" } }, (err) => {
      if (err && !res.headersSent) next(new HttpError(404, "File not found", "NOT_FOUND"));
    });
  });

  /** Like counter. Query: `?deviceId=`. */
  app.get("/api/likes", (req, res) => {
    const { deviceId } = req.query;
    res.json({ count: likes.count, hasLiked: isDeviceId(deviceId) && likes.hasLiked(deviceId) });
  });

  /** Sets the like state of a device. Body: `{ deviceId: string, liked: boolean }`. */
  app.post("/api/likes", requireXhr, likesLimiter, (req, res, next) => {
    const { deviceId, liked } = req.body || {};
    if (!isDeviceId(deviceId) || typeof liked !== "boolean") {
      return next(new HttpError(400, "Expected { deviceId, liked }", "BAD_REQUEST"));
    }
    const result = likes.setLiked(deviceId, liked);
    if (!result) return next(new HttpError(503, "Like counter is full", "FULL"));
    res.json(result);
  });

  // ── Fallbacks ────────────────────────────────────────────────────────────

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found", "NOT_FOUND")));

  // Error handler: Express recognizes it by its four parameters.
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let message = status < 500 ? err.message : "Internal server error";
    let code = err.code;

    if (err instanceof multer.MulterError) {
      status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      message =
        err.code === "LIMIT_FILE_SIZE"
          ? `File too large (max ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`
          : "Invalid upload";
    } else if (err.type === "entity.parse.failed") {
      status = 400;
      message = "Malformed JSON body";
      code = "BAD_JSON";
    } else if (err.type === "entity.too.large") {
      status = 413;
      message = "Request body too large";
    }

    if (status >= 500) logger.error(`${req.method} ${req.originalUrl} failed`, err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: message, code: typeof code === "string" ? code : undefined });
  });
}

module.exports = { registerHttp, HttpError, CONTENT_SECURITY_POLICY };
