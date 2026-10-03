/**
 * PDF Presenter — speaker notes per presentation and per slide.
 *
 * Notes live in this browser's localStorage, keyed by the PDF's fingerprint
 * (stable across uploads of the same file), with the file name as a fallback
 * for re-exported decks. They can be exported to and imported from a file.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { local } from "./common.js";

const PREFIX = "presenter-notes:";
const LEGACY_KEY = "presenter-notes";
const NAME_INDEX_KEY = "presenter-notes-names";
const FORMAT = "pdf-presenter-notes";

/** @typedef {{ name: string, slides: Record<string, string>, updatedAt: number }} DeckNotes */

function readJson(key, fallback) {
  try {
    return JSON.parse(local.get(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

export class NotesStore {
  /**
   * @param {string} fingerprint PDF fingerprint (pdf.js `doc.fingerprints[0]`).
   * @param {string} name        File name, used as a fallback key.
   */
  constructor(fingerprint, name) {
    this.key = PREFIX + fingerprint;
    this.name = name;
    /** @type {DeckNotes} */
    this.data = readJson(this.key, null) || this.#fromName() || { name, slides: {}, updatedAt: 0 };
    this.#migrateLegacy();
  }

  get(slide) {
    return this.data.slides[slide] || "";
  }

  set(slide, text) {
    if (text) this.data.slides[slide] = text;
    else delete this.data.slides[slide];
    this.#save();
  }

  /** @returns {[number, string][]} Slides with notes, in order. */
  entries() {
    return Object.entries(this.data.slides)
      .map(([slide, text]) => [Number(slide), text])
      .filter(([slide, text]) => Number.isInteger(slide) && text.trim())
      .sort((a, b) => a[0] - b[0]);
  }

  /** @returns {Blob} JSON export of the notes. */
  export() {
    const body = { format: FORMAT, version: 1, deck: this.name, slides: this.data.slides };
    return new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
  }

  /**
   * Imports notes from a file: our JSON export, or plain text where slides are
   * separated by lines containing only `---`.
   * @returns {number} Number of slides imported.
   */
  import(text) {
    const slides = {};
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      if (parsed?.format !== FORMAT || typeof parsed.slides !== "object") throw new Error("Unknown notes file");
      for (const [slide, note] of Object.entries(parsed.slides)) {
        if (/^\d{1,5}$/.test(slide) && typeof note === "string") slides[slide] = note.slice(0, 20_000);
      }
    } else {
      trimmed.split(/^\s*---\s*$/m).forEach((block, i) => {
        if (block.trim()) slides[i + 1] = block.trim().slice(0, 20_000);
      });
    }
    this.data.slides = { ...this.data.slides, ...slides };
    this.#save();
    return Object.keys(slides).length;
  }

  #save() {
    this.data.updatedAt = Date.now();
    this.data.name = this.name;
    local.set(this.key, JSON.stringify(this.data));
    const index = readJson(NAME_INDEX_KEY, {});
    index[this.name] = this.key;
    local.set(NAME_INDEX_KEY, JSON.stringify(index));
  }

  /** Same deck re-exported (new fingerprint, same file name). */
  #fromName() {
    const key = readJson(NAME_INDEX_KEY, {})[this.name];
    return key ? readJson(key, null) : null;
  }

  /** Notes from older versions were one text for everything: they become slide 1's notes. */
  #migrateLegacy() {
    const legacy = local.get(LEGACY_KEY);
    if (!legacy) return;
    if (!Object.keys(this.data.slides).length) this.set(1, legacy);
    local.remove(LEGACY_KEY);
  }
}
