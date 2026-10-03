"use strict";

/**
 * Persistent "like this app" counter.
 *
 * State lives in memory and is written to disk asynchronously (debounced,
 * atomic tmp-file + rename), so request handlers never block on file I/O and
 * concurrent requests cannot corrupt the file. The count is always derived
 * from the set of devices, so it can never drift.
 */

const fs = require("node:fs");
const path = require("node:path");

const SAVE_DEBOUNCE_MS = 500;
/** Hard cap to keep memory and file size bounded even under abuse. */
const MAX_DEVICES = 100_000;

class LikesStore {
  /**
   * @param {object} options
   * @param {string} options.file  JSON file path.
   * @param {import("./logger").Logger} options.logger
   */
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger;
    /** @type {Set<string>} */
    this.devices = new Set();
    this.saveTimer = null;
    this.pendingSave = Promise.resolve();
  }

  /** Loads the persisted state; a missing or corrupt file starts from zero. */
  async load() {
    try {
      const raw = await fs.promises.readFile(this.file, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.likedDevices)) {
        this.devices = new Set(data.likedDevices.filter((id) => typeof id === "string"));
      }
    } catch (err) {
      if (err.code !== "ENOENT") this.logger.warn("Likes file unreadable, starting empty", err);
    }
  }

  get count() {
    return this.devices.size;
  }

  hasLiked(deviceId) {
    return this.devices.has(deviceId);
  }

  /**
   * Sets the like state of a device. Idempotent: liking twice counts once and
   * unliking a device that never liked changes nothing.
   *
   * @returns {{ count: number, hasLiked: boolean } | null} `null` when the cap is reached.
   */
  setLiked(deviceId, liked) {
    const before = this.devices.has(deviceId);
    if (liked && !before) {
      if (this.devices.size >= MAX_DEVICES) return null;
      this.devices.add(deviceId);
    } else if (!liked && before) {
      this.devices.delete(deviceId);
    }
    if (before !== liked) this.#scheduleSave();
    return { count: this.count, hasLiked: liked };
  }

  /** Writes pending changes immediately (used on shutdown). */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.pendingSave = this.pendingSave.then(() => this.#write());
    }
    await this.pendingSave;
  }

  #scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.pendingSave = this.pendingSave.then(() => this.#write());
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  async #write() {
    const data = JSON.stringify({ count: this.count, likedDevices: [...this.devices] });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      this.logger.error("Failed to persist likes", err);
    }
  }
}

module.exports = { LikesStore };
