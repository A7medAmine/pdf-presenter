/**
 * PDF Presenter — PDF.js rendering helpers shared by the presenter and viewer.
 *
 * `SlideRenderer` renders pages into off-screen canvases at device-pixel
 * resolution (sharp on phones and Retina screens), caches them (LRU), and
 * always ends up showing the *latest* requested page: fast clicks never get
 * dropped and never leave the screen on a stale slide.
 *
 * Licensed under the Apache License, Version 2.0.
 */

const pdfjsLib = window.pdfjsLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";

/** Largest backing-store size per canvas; keeps memory bounded on huge screens. */
const MAX_CANVAS_PIXELS = 16_777_216; // 4096 × 4096

/**
 * Opens a PDF document.
 * @param {string} url
 * @returns {Promise<import("pdfjs-dist").PDFDocumentProxy>}
 */
export function openDocument(url) {
  return pdfjsLib.getDocument({
    url,
    cMapUrl: "/vendor/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/vendor/standard_fonts/",
    isEvalSupported: false, // required by the Content-Security-Policy (no unsafe-eval)
  }).promise;
}

/** Device pixel ratio, capped so the backing store stays within MAX_CANVAS_PIXELS. */
function pixelRatioFor(cssWidth, cssHeight) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const maxRatio = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssWidth * cssHeight));
  return Math.min(dpr, maxRatio);
}

/**
 * Starts rendering a page into a new off-screen canvas.
 * @returns {{ promise: Promise<HTMLCanvasElement>, cancel: () => void }}
 */
function renderOffscreen(page, cssWidth, cssHeight) {
  const base = page.getViewport({ scale: 1 });
  const ratio = pixelRatioFor(cssWidth, cssHeight);
  // Backing store matches the CSS box exactly (no 1px stretch from rounding).
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  const viewport = page.getViewport({ scale: canvas.width / base.width });
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvasContext: context, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE });
  return { promise: task.promise.then(() => canvas), cancel: () => task.cancel() };
}

/**
 * Renders a small thumbnail of a page into the given canvas.
 * @param {import("pdfjs-dist").PDFDocumentProxy} doc
 */
export async function renderThumbnail(doc, pageNum, canvas, cssHeight) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const cssWidth = (base.width / base.height) * cssHeight;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: (cssHeight / base.height) * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
}

/**
 * @typedef {object} PaintInfo
 * @property {number} pageNum
 * @property {import("pdfjs-dist").PDFPageProxy} page
 * @property {number} cssWidth
 * @property {number} cssHeight
 */

export class SlideRenderer {
  /**
   * @param {HTMLCanvasElement} canvas Visible canvas.
   * @param {object} options
   * @param {(pageWidth: number, pageHeight: number) => { width: number, height: number }} options.fit
   *   Returns the CSS size the page should occupy, given its size at scale 1.
   * @param {(info: PaintInfo) => void} [options.onPaint] Called after a page is shown.
   * @param {number} [options.cacheSize] Rendered pages kept in memory.
   */
  constructor(canvas, { fit, onPaint = () => {}, cacheSize = 4 }) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.fit = fit;
    this.onPaint = onPaint;
    this.cacheSize = cacheSize;
    /** @type {import("pdfjs-dist").PDFDocumentProxy|null} */
    this.doc = null;
    /** @type {Map<string, HTMLCanvasElement>} insertion order = LRU order */
    this.cache = new Map();
    /** @type {Map<string, { promise: Promise<HTMLCanvasElement>, cancel: () => void }>} */
    this.inflight = new Map();
    /** Bumped on every document swap; stale async work compares against it and bails out. */
    this.generation = 0;
    this.target = 0;
    this.shownKey = "";
    this.running = false;
    /** @type {Promise<void>} */
    this.loop = Promise.resolve();
  }

  /**
   * Swaps the document. In-flight renders are cancelled and the previous
   * document is destroyed to free worker memory. A render pass still waiting
   * on the old document (e.g. paused in a background tab) can no longer block
   * the new one.
   */
  setDocument(doc) {
    this.generation++;
    for (const job of this.inflight.values()) job.cancel();
    this.inflight.clear();
    this.cache.clear();
    if (this.doc && this.doc !== doc) this.doc.destroy().catch(() => {});
    this.doc = doc;
    this.shownKey = "";
    this.running = false;
  }

  get pageCount() {
    return this.doc ? this.doc.numPages : 0;
  }

  /**
   * Shows a page. Concurrent calls coalesce: the promise resolves once the
   * most recently requested page is on screen.
   * @returns {Promise<void>}
   */
  show(pageNum) {
    if (!this.doc) return Promise.resolve();
    this.target = Math.min(Math.max(1, pageNum), this.doc.numPages);
    if (!this.running) this.loop = this.#drain();
    return this.loop;
  }

  /** Re-renders the current page (after a resize or fullscreen change). */
  refresh() {
    this.cache.clear();
    this.shownKey = "";
    return this.target ? this.show(this.target) : Promise.resolve();
  }

  /** Renders a page into the cache in the background. */
  preload(pageNum) {
    if (!this.doc || pageNum < 1 || pageNum > this.doc.numPages) return;
    const run = () => this.#rendered(pageNum).catch(() => {});
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 500 });
    else setTimeout(run, 50);
  }

  async #drain() {
    const generation = this.generation;
    this.running = true;
    try {
      while (this.doc && generation === this.generation) {
        const pageNum = this.target;
        const result = await this.#rendered(pageNum);
        if (generation !== this.generation) return; // document swapped: a new pass owns the canvas
        if (pageNum !== this.target) continue; // a newer page was requested meanwhile
        this.#paint(result);
        return;
      }
    } catch (err) {
      if (generation === this.generation && err?.name !== "RenderingCancelledException") {
        console.error("[pdf] render failed", err);
      }
    } finally {
      // Runs synchronously on return, so a show() issued right after always starts a new pass.
      if (generation === this.generation) this.running = false;
    }
  }

  /** Returns the cached rendering of a page at the current fit size, rendering it if needed. */
  async #rendered(pageNum) {
    const doc = this.doc;
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const { width, height } = this.fit(base.width, base.height);
    const cssWidth = Math.max(1, Math.floor(width));
    const cssHeight = Math.max(1, Math.floor(height));
    const key = `${pageNum}:${cssWidth}x${cssHeight}@${window.devicePixelRatio || 1}`;

    let canvas = this.cache.get(key);
    if (canvas) {
      this.cache.delete(key); // refresh LRU position
    } else {
      let job = this.inflight.get(key);
      if (!job) {
        job = renderOffscreen(page, cssWidth, cssHeight);
        const done = () => {
          if (this.inflight.get(key) === job) this.inflight.delete(key);
        };
        job.promise.then(done, done);
        this.inflight.set(key, job);
      }
      canvas = await job.promise;
      if (doc !== this.doc) return { key, canvas, page, pageNum, cssWidth, cssHeight };
    }
    this.cache.set(key, canvas);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return { key, canvas, page, pageNum, cssWidth, cssHeight };
  }

  #paint({ key, canvas, page, pageNum, cssWidth, cssHeight }) {
    if (key !== this.shownKey) {
      this.canvas.width = canvas.width;
      this.canvas.height = canvas.height;
      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      this.context.drawImage(canvas, 0, 0);
      this.shownKey = key;
    }
    this.onPaint({ pageNum, page, cssWidth, cssHeight });
  }
}
