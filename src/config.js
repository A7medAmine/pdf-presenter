"use strict";

/**
 * Runtime configuration.
 *
 * Every setting comes from an environment variable (optionally declared in a
 * `.env` file at the project root) and falls back to a safe default. The
 * resulting object is frozen so no module can mutate it at runtime.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");

const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"];

/**
 * Minimal `.env` loader: `KEY=value` lines, `#` comments, optional quotes.
 * Variables already present in the environment always win.
 *
 * @param {string} file Absolute path of the `.env` file.
 * @param {NodeJS.ProcessEnv} env Environment object to populate.
 */
function loadDotEnv(file, env = process.env) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * Reads a numeric variable and clamps it into `[min, max]`.
 * Invalid values fall back to the default instead of crashing the server.
 */
function readNumber(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Express `trust proxy` accepts booleans, hop counts or address lists.
 * See https://expressjs.com/en/guide/behind-proxies.html
 */
function readTrustProxy(raw) {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : raw;
}

/**
 * Builds the configuration object.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment to read from (defaults to `process.env`).
 * @param {object} [overrides] Values that replace the computed ones (used by tests).
 */
function loadConfig(env = process.env, overrides = {}) {
  const nodeEnv = env.NODE_ENV || "development";
  const isProduction = nodeEnv === "production";
  const requestedLevel = (env.LOG_LEVEL || "").toLowerCase();
  const logLevel = LOG_LEVELS.includes(requestedLevel)
    ? requestedLevel
    : isProduction
      ? "info"
      : "debug";

  const config = {
    nodeEnv,
    isProduction,
    logLevel,
    host: env.HOST || "0.0.0.0",
    port: readNumber(env, "PORT", 3000, { min: 0, max: 65535 }),
    trustProxy: readTrustProxy(env.TRUST_PROXY),

    /** A session without a connected presenter is removed after this much inactivity. */
    sessionIdleTtlMs: readNumber(env, "SESSION_TTL", 4, { min: 0.05, max: 72 }) * 60 * 60 * 1000,
    /** Hard upper bound on a session's life, even while the presenter stays connected. */
    sessionMaxLifetimeMs: 24 * 60 * 60 * 1000,

    maxUploadBytes: readNumber(env, "MAX_FILE_SIZE", 100, { min: 1, max: 2048 }) * 1024 * 1024,

    /** Session creation limit per client IP. */
    sessionRateWindowMs: readNumber(env, "RATE_LIMIT_WINDOW", 60, { min: 1, max: 24 * 60 }) * 60 * 1000,
    sessionRateMax: readNumber(env, "RATE_LIMIT_MAX", 20, { min: 1, max: 10000 }),

    /** PowerPoint → PDF conversion through LibreOffice: "auto" (when installed) or "off". */
    officeConversion: (env.OFFICE_CONVERSION || "auto").toLowerCase() === "off" ? "off" : "auto",
    sofficePath: env.SOFFICE_PATH || null,
    conversionTimeoutMs: readNumber(env, "CONVERSION_TIMEOUT", 120, { min: 10, max: 900 }) * 1000,

    rootDir: ROOT_DIR,
    publicDir: path.join(ROOT_DIR, "public"),
    uploadDir: path.resolve(ROOT_DIR, env.UPLOAD_DIR || "uploads"),
    dataDir: path.resolve(ROOT_DIR, env.DATA_DIR || "data"),
  };

  return Object.freeze({ ...config, ...overrides });
}

module.exports = { loadConfig, loadDotEnv, ROOT_DIR, LOG_LEVELS };
