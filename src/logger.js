"use strict";

/**
 * Tiny leveled logger.
 *
 * Production keeps `info` and above so operators can still see errors,
 * development defaults to `debug`, and tests use `silent`.
 */

const { LOG_LEVELS } = require("./config");

/**
 * @typedef {object} Logger
 * @property {(msg: string, meta?: unknown) => void} error
 * @property {(msg: string, meta?: unknown) => void} warn
 * @property {(msg: string, meta?: unknown) => void} info
 * @property {(msg: string, meta?: unknown) => void} debug
 * @property {(scope: string) => Logger} child
 */

/**
 * @param {string} level One of `silent | error | warn | info | debug`.
 * @param {string} [scope] Prefix shown on every line (e.g. `http`, `ws`).
 * @returns {Logger}
 */
function createLogger(level = "info", scope = "") {
  const threshold = LOG_LEVELS.indexOf(level);

  const write = (name, msg, meta) => {
    if (LOG_LEVELS.indexOf(name) > threshold) return;
    const prefix = `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)}${scope ? ` [${scope}]` : ""}`;
    const stream = name === "error" || name === "warn" ? console.error : console.log;
    if (meta === undefined) stream(`${prefix} ${msg}`);
    else stream(`${prefix} ${msg}`, meta instanceof Error ? meta.stack || meta.message : meta);
  };

  return {
    error: (msg, meta) => write("error", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    debug: (msg, meta) => write("debug", msg, meta),
    child: (childScope) => createLogger(level, scope ? `${scope}:${childScope}` : childScope),
  };
}

module.exports = { createLogger };
