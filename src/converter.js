"use strict";

/**
 * Office → PDF conversion (PowerPoint, OpenDocument and Keynote-free formats).
 *
 * Uses LibreOffice in headless mode when it is installed. Every conversion
 * runs in its own temporary profile directory so several can run in parallel,
 * is killed after a timeout, and at most `maxConcurrent` run at once (the rest
 * wait in a queue). When LibreOffice is missing, `available` is false and the
 * HTTP layer only accepts PDFs.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

/** File extensions accepted for conversion, mapped to the magic bytes they start with. */
const OFFICE_FORMATS = Object.freeze({
  ".pptx": "zip",
  ".ppsx": "zip",
  ".odp": "zip",
  ".ppt": "ole",
  ".pps": "ole",
});

const MAGIC = {
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  ole: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
};

/** Lowercase extension of a file name, or "" when it is not a supported office format. */
function officeExtension(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  return Object.hasOwn(OFFICE_FORMATS, ext) ? ext : "";
}

/** @returns {Promise<boolean>} Whether the file starts with the magic bytes of its format. */
async function hasOfficeSignature(filePath, ext) {
  const magic = MAGIC[OFFICE_FORMATS[ext]];
  if (!magic) return false;
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(magic.length);
    const { bytesRead } = await handle.read(buffer, 0, magic.length, 0);
    return bytesRead === magic.length && buffer.equals(magic);
  } finally {
    await handle.close();
  }
}

/** Finds the LibreOffice binary: explicit path, then PATH, then the usual install locations. */
function findSoffice(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const lookup = process.platform === "win32" ? "where" : "which";
  for (const name of ["soffice", "libreoffice"]) {
    try {
      const found = execFileSync(lookup, [name], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .split(/\r?\n/)[0]
        .trim();
      if (found) return found;
    } catch {
      /* not on PATH */
    }
  }
  const candidates = [
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/opt/libreoffice/program/soffice",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

class OfficeConverter {
  /**
   * @param {object} options
   * @param {string|null} options.binary  LibreOffice executable, or null when unavailable.
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxConcurrent]
   * @param {number} [options.maxQueue]  Waiting conversions beyond this are refused (busy).
   * @param {import("./logger").Logger} options.logger
   */
  constructor({ binary, timeoutMs = 120_000, maxConcurrent = 2, maxQueue = 8, logger }) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.logger = logger;
    this.running = 0;
    /** @type {(() => void)[]} */
    this.queue = [];
  }

  get available() {
    return Boolean(this.binary);
  }

  /** Extensions the server accepts besides `.pdf`. */
  get formats() {
    return this.available ? Object.keys(OFFICE_FORMATS) : [];
  }

  /** True when a new conversion would have to be refused. */
  get busy() {
    return this.running >= this.maxConcurrent && this.queue.length >= this.maxQueue;
  }

  /**
   * Converts an office file to PDF.
   * @param {string} input  Absolute path of the source file.
   * @param {string} output Absolute path the PDF must be written to.
   */
  async convert(input, output) {
    if (!this.available) throw new Error("Office conversion is not available");
    if (this.busy) throw Object.assign(new Error("Too many conversions in progress"), { code: "BUSY" });
    await this.#acquire();
    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pdf-presenter-convert-"));
    try {
      const profile = pathToFileURL(path.join(workDir, "profile")).href;
      await this.#run([
        `-env:UserInstallation=${profile}`,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--convert-to",
        "pdf",
        "--outdir",
        workDir,
        input,
      ]);
      const produced = path.join(workDir, `${path.parse(input).name}.pdf`);
      await fs.promises.copyFile(produced, output);
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
      this.#release();
    }
  }

  #run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 4000) stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Conversion timed out"));
      }, this.timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
      });
    });
  }

  #acquire() {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  #release() {
    const nextJob = this.queue.shift();
    if (nextJob) nextJob();
    else this.running--;
  }
}

/**
 * Creates the converter from configuration.
 * @param {{ officeConversion: "auto"|"off", sofficePath: string|null, conversionTimeoutMs: number }} config
 * @param {import("./logger").Logger} logger
 */
function createConverter(config, logger) {
  const binary = config.officeConversion === "off" ? null : findSoffice(config.sofficePath);
  if (binary) logger.info(`PowerPoint conversion enabled (${binary})`);
  else if (config.officeConversion !== "off") logger.info("LibreOffice not found: only PDF uploads are accepted");
  return new OfficeConverter({ binary, timeoutMs: config.conversionTimeoutMs, logger });
}

module.exports = { OfficeConverter, createConverter, officeExtension, hasOfficeSignature, OFFICE_FORMATS };
