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
const path = require("node:path");
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
const { officeExtension, hasOfficeSignature } = require("./converter");
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

/** Download name of a session PDF: the uploaded name, with a `.pdf` extension. */
function downloadName(originalName) {
  const base = String(originalName || "Presentation").replace(/\.[^.]+$/, "") || "Presentation";
  return `${base}.pdf`;
}

/** `attachment` header with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Registers middleware and routes on an Express app.
 *
 * @param {import("express").Express} app
 * @param {object} deps
 * @param {ReturnType<import("./config").loadConfig>} deps.config
 * @param {import("./session-store").SessionStore} deps.store
 * @param {import("./likes-store").LikesStore} deps.likes
 * @param {import("./converter").OfficeConverter} deps.converter
 * @param {{ announcePdf: (session: import("./session-store").Session) => void }} deps.realtime
 * @param {import("./logger").Logger} deps.logger
 */
function registerHttp(app, { config, store, likes, converter, realtime, logger }) {
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(securityHeaders);

  // ── Static files ─────────────────────────────────────────────────────────
  app.use(
    express.static(config.publicDir, {
      extensions: ["html"],
      setHeaders(res, filePath) {
        // App code (HTML, scripts, styles, service worker) is always revalidated
        // (cheap with ETags) so deployments take effect at once; vendor
        // libraries, fonts and images may be cached briefly.
        const isVendor = filePath.includes(`${path.sep}vendor${path.sep}`);
        const revalidate = !isVendor && /\.(html|js|css|webmanifest)$/.test(filePath);
        res.setHeader("Cache-Control", revalidate ? "no-cache" : "public, max-age=3600");
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
      filename: (_req, file, cb) => cb(null, `${randomToken(16)}${officeExtension(file.originalname) || ".pdf"}`),
    }),
    defParamCharset: "utf8", // keeps non-Latin (e.g. Arabic) file names intact
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 2, parts: 3 },
    fileFilter: (_req, file, cb) => {
      const name = file.originalname.toLowerCase();
      const accepted =
        name.endsWith(".pdf") ||
        (converter.available && officeExtension(name) !== "") ||
        (file.mimetype === "application/pdf" && !officeExtension(name));
      const message = converter.available
        ? "Only PDF and PowerPoint files are allowed"
        : "Only PDF files are allowed on this server";
      cb(accepted ? null : new HttpError(415, message, "NOT_PDF"), accepted);
    },
  });

  // ── Routes ───────────────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", sessions: store.size, uptime: Math.round(process.uptime()) });
  });

  /** What this server can do, so the presenter page can adapt its upload hints. */
  app.get("/api/capabilities", (_req, res) => {
    res.json({
      formats: [".pdf", ...converter.formats],
      officeConversion: converter.available,
      maxUploadBytes: config.maxUploadBytes,
    });
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

  /**
   * Turns an uploaded file into a stored PDF: checks its signature and, for
   * PowerPoint files, converts it. The source file is always removed.
   * @returns {Promise<{ file: string, converted: boolean }>} Stored PDF name.
   */
  async function storeUpload(file) {
    const ext = officeExtension(file.originalname);
    if (!ext) {
      const isPdf = await hasPdfHeader(file.path).catch(() => false);
      if (!isPdf) throw new HttpError(415, "The file is not a valid PDF", "NOT_PDF");
      return { file: file.filename, converted: false };
    }

    const valid = await hasOfficeSignature(file.path, ext).catch(() => false);
    if (!valid) throw new HttpError(415, "The file is not a valid PowerPoint presentation", "NOT_OFFICE");
    const pdfName = `${randomToken(16)}.pdf`;
    const pdfPath = store.filePath(pdfName);
    const started = Date.now();
    try {
      await converter.convert(file.path, pdfPath);
    } catch (err) {
      await fs.promises.unlink(pdfPath).catch(() => {});
      if (err.code === "BUSY") throw new HttpError(503, "The server is busy converting other files, try again shortly", "BUSY");
      logger.warn(`Conversion failed: ${err.message}`);
      throw new HttpError(422, "Could not convert this presentation to PDF", "CONVERSION_FAILED");
    } finally {
      await fs.promises.unlink(file.path).catch(() => {});
    }
    if (!(await hasPdfHeader(pdfPath).catch(() => false))) {
      await fs.promises.unlink(pdfPath).catch(() => {});
      throw new HttpError(422, "Could not convert this presentation to PDF", "CONVERSION_FAILED");
    }
    logger.info(`Converted ${ext} to PDF in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return { file: pdfName, converted: true };
  }

  /** Uploads (or replaces) the session's PDF. Multipart field: `pdf` (PDF or PowerPoint). */
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

      let stored;
      try {
        stored = await storeUpload(file);
      } catch (err) {
        await fs.promises.unlink(file.path).catch(() => {});
        throw err;
      }
      // The session may have ended while the upload was streaming or converting.
      if (store.get(session.id) !== session) {
        await fs.promises.unlink(store.filePath(stored.file)).catch(() => {});
        throw new HttpError(404, "Session not found", "SESSION_NOT_FOUND");
      }

      store.setPdf(session, {
        file: stored.file,
        originalName: sanitizeOriginalFilename(file.originalname),
        size: file.size,
        converted: stored.converted,
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
    const headers = { "Content-Type": "application/pdf" };
    if (req.query.download === "1") {
      if (!session.allowDownload) return next(new HttpError(403, "Downloads are disabled", "FORBIDDEN"));
      headers["Content-Disposition"] = contentDisposition(downloadName(session.pdf.originalName));
    }
    res.setHeader("Cache-Control", "private, max-age=600");
    res.sendFile(store.filePath(file), { headers }, (err) => {
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
