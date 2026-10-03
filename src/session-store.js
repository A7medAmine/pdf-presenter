"use strict";

/**
 * In-memory registry of presentation sessions.
 *
 * A session ties one presenter to any number of remotes (controllers) and
 * viewers (read-only audience). It owns at most one uploaded PDF on disk,
 * which is deleted when the PDF is replaced or the session ends.
 */

const fs = require("node:fs");
const path = require("node:path");
const { generateSessionId, randomToken, sanitizeDisplayName } = require("./security");

/** Upper bound of remembered viewer tokens per session (oldest are evicted). */
const MAX_VIEWER_TOKENS = 1000;
/** Upper bound of simultaneous pending remote-access requests per session. */
const MAX_PENDING_REMOTES = 10;

/**
 * @typedef {object} StoredPdf
 * @property {string} file          Random on-disk name (`<hex>.pdf`) inside the upload dir.
 * @property {string} originalName  Name the presenter uploaded, for display only.
 * @property {number} size          Size in bytes.
 */

/**
 * @typedef {object} PendingRemote
 * @property {string} deviceId
 * @property {number} requestedAt
 */

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} name
 * @property {string|null} passwordHash     scrypt hash for viewer access, `null` when public.
 * @property {string} presenterToken        Secret proving presenter ownership (uploads, rejoin).
 * @property {string} accessToken           Secret embedded in PDF URLs handed to members.
 * @property {string|null} presenterSocketId
 * @property {number} currentSlide          1-based.
 * @property {number} totalSlides           0 until the presenter reports the page count.
 * @property {StoredPdf|null} pdf
 * @property {Set<string>} viewers          Socket IDs.
 * @property {Set<string>} remotes          Socket IDs of approved remotes.
 * @property {Map<string, PendingRemote>} pendingRemotes  Keyed by socket ID.
 * @property {Set<string>} approvedDevices  Device IDs allowed to reconnect without approval.
 * @property {Set<string>} blockedDevices   Device IDs that may not request access.
 * @property {boolean} remoteRequestsEnabled
 * @property {Set<string>} viewerTokens     Tokens issued after a correct password.
 * @property {number} createdAt
 * @property {number} lastActivityAt
 */

class SessionStore {
  /**
   * @param {object} options
   * @param {string} options.uploadDir
   * @param {number} options.idleTtlMs      Idle time after which a presenter-less session expires.
   * @param {number} options.maxLifetimeMs  Absolute session lifetime.
   * @param {import("./logger").Logger} options.logger
   * @param {() => number} [options.now]    Clock, injectable for tests.
   */
  constructor({ uploadDir, idleTtlMs, maxLifetimeMs, logger, now = Date.now }) {
    this.uploadDir = uploadDir;
    this.idleTtlMs = idleTtlMs;
    this.maxLifetimeMs = maxLifetimeMs;
    this.logger = logger;
    this.now = now;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    /** @type {Map<string, string>} stored file name → session ID */
    this.fileIndex = new Map();
  }

  /**
   * Creates a session with fresh secrets.
   * @param {{ name?: string|null, passwordHash?: string|null }} options
   * @returns {Session}
   */
  create({ name = null, passwordHash = null } = {}) {
    let id;
    do id = generateSessionId();
    while (this.sessions.has(id));

    const now = this.now();
    /** @type {Session} */
    const session = {
      id,
      name: sanitizeDisplayName(name) || `Session ${id.slice(0, 4)}`,
      passwordHash,
      presenterToken: randomToken(32),
      accessToken: randomToken(24),
      presenterSocketId: null,
      currentSlide: 1,
      totalSlides: 0,
      pdf: null,
      viewers: new Set(),
      remotes: new Set(),
      pendingRemotes: new Map(),
      approvedDevices: new Set(),
      blockedDevices: new Set(),
      remoteRequestsEnabled: true,
      viewerTokens: new Set(),
      createdAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** @returns {Session|undefined} */
  get(id) {
    return typeof id === "string" ? this.sessions.get(id) : undefined;
  }

  /** @returns {IterableIterator<Session>} */
  all() {
    return this.sessions.values();
  }

  get size() {
    return this.sessions.size;
  }

  /** Marks a session as active, postponing its idle expiry. */
  touch(session) {
    session.lastActivityAt = this.now();
  }

  /** @returns {Session|undefined} The session owning a stored PDF file. */
  findByFile(file) {
    const id = this.fileIndex.get(file);
    return id ? this.sessions.get(id) : undefined;
  }

  /** Absolute path of a stored PDF. */
  filePath(file) {
    return path.join(this.uploadDir, file);
  }

  /**
   * Attaches a freshly uploaded PDF, deleting the previous one and resetting
   * the slide position.
   * @param {Session} session
   * @param {StoredPdf} pdf
   */
  setPdf(session, pdf) {
    this.#releasePdf(session);
    session.pdf = pdf;
    session.currentSlide = 1;
    session.totalSlides = 0;
    this.fileIndex.set(pdf.file, session.id);
    this.touch(session);
  }

  /** Issues a viewer token for a password-protected session. */
  issueViewerToken(session) {
    const token = randomToken(24);
    session.viewerTokens.add(token);
    if (session.viewerTokens.size > MAX_VIEWER_TOKENS) {
      const oldest = session.viewerTokens.values().next().value;
      session.viewerTokens.delete(oldest);
    }
    return token;
  }

  /** @returns {boolean} Whether a viewer is allowed to join. */
  canView(session, viewerToken) {
    if (!session.passwordHash) return true;
    return typeof viewerToken === "string" && session.viewerTokens.has(viewerToken);
  }

  /** @returns {boolean} Whether another pending remote request fits. */
  hasPendingCapacity(session) {
    return session.pendingRemotes.size < MAX_PENDING_REMOTES;
  }

  /**
   * Removes a session and deletes its PDF.
   * @returns {Session|undefined} The removed session.
   */
  destroy(id) {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.#releasePdf(session);
    this.sessions.delete(id);
    return session;
  }

  /**
   * @returns {string[]} IDs of sessions that should be removed: idle with no
   * presenter connected, or older than the absolute lifetime.
   */
  expiredIds() {
    const now = this.now();
    const ids = [];
    for (const session of this.sessions.values()) {
      const idle = now - session.lastActivityAt > this.idleTtlMs && !session.presenterSocketId;
      const tooOld = now - session.createdAt > this.maxLifetimeMs;
      if (idle || tooOld) ids.push(session.id);
    }
    return ids;
  }

  /**
   * Deletes every stored PDF. Sessions live in memory, so files left over
   * from a previous run can never be reached again.
   */
  async purgeUploads() {
    let entries = [];
    try {
      entries = await fs.promises.readdir(this.uploadDir);
    } catch (err) {
      if (err.code !== "ENOENT") this.logger.warn("Could not read upload dir", err);
      return;
    }
    const removals = entries
      .filter((name) => name.toLowerCase().endsWith(".pdf"))
      .map((name) => this.#unlink(name));
    await Promise.all(removals);
    if (removals.length) this.logger.info(`Removed ${removals.length} orphaned upload(s)`);
  }

  #releasePdf(session) {
    if (!session.pdf) return;
    this.fileIndex.delete(session.pdf.file);
    this.#unlink(session.pdf.file);
    session.pdf = null;
  }

  #unlink(file) {
    return fs.promises.unlink(this.filePath(file)).catch((err) => {
      if (err.code !== "ENOENT") this.logger.warn(`Could not delete ${file}`, err);
    });
  }
}

/**
 * Snapshot of a session that is safe to send to its members.
 * @param {Session} session
 */
function toPublicState(session) {
  return {
    sessionId: session.id,
    name: session.name,
    currentSlide: session.currentSlide,
    totalSlides: session.totalSlides,
    pdf: session.pdf
      ? {
          url: `/uploads/${session.pdf.file}?t=${session.accessToken}`,
          name: session.pdf.originalName,
        }
      : null,
    viewerCount: session.viewers.size,
    remoteCount: session.remotes.size,
    presenterOnline: Boolean(session.presenterSocketId),
  };
}

module.exports = { SessionStore, toPublicState, MAX_PENDING_REMOTES };
