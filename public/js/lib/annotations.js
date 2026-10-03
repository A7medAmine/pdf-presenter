/**
 * PDF Presenter — slide annotations (pen and highlighter).
 *
 * `AnnotationLayer` owns a transparent canvas laid over a slide. It draws the
 * strokes of the slide being shown (coordinates normalized to 0–1, so every
 * screen draws them at its own resolution), merges strokes streamed from
 * other devices, and can capture local pointer input, streaming each stroke
 * in small chunks while it is being drawn.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/** Palette offered by the drawing tools. */
export const COLORS = ["#ef4444", "#f0a500", "#22c55e", "#3b82f6", "#111111", "#ffffff"];

/** Stroke width as a fraction of the slide width. */
export const TOOL_WIDTH = { pen: 0.004, highlighter: 0.022 };
const HIGHLIGHTER_ALPHA = 0.38;
/** Local strokes are sent at most this often while drawing. */
const CHUNK_INTERVAL_MS = 40;
const MAX_POINTS_PER_CHUNK = 150;

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export class AnnotationLayer {
  /**
   * @param {HTMLCanvasElement} canvas Overlay canvas, positioned over the slide with CSS (`inset: 0`).
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.slide = 0;
    /** @type {{ id: string, tool: string, color: string, width: number, points: number[] }[]} */
    this.strokes = [];
    this.frame = 0;
    /** @type {{ tool: string, color: string, onChunk: (chunk: object) => void } | null} */
    this.input = null;
    this.active = null;
    this.#bindPointer();
    new ResizeObserver(() => this.redraw()).observe(canvas);
  }

  /** Shows the strokes of another slide. */
  setSlide(slide, strokes = []) {
    this.slide = slide;
    this.strokes = strokes.map((s) => ({ ...s, points: [...s.points] }));
    this.active = null;
    this.redraw();
  }

  /** Merges a chunk received from the server (ignored when it belongs to another slide). */
  applyChunk(chunk) {
    if (chunk.slide !== this.slide) return;
    const stroke = this.strokes.find((s) => s.id === chunk.id);
    if (stroke) stroke.points.push(...chunk.points);
    else this.strokes.push({ id: chunk.id, tool: chunk.tool, color: chunk.color, width: chunk.width, points: [...chunk.points] });
    this.redraw();
  }

  removeStroke(slide, id) {
    if (slide !== this.slide) return;
    this.strokes = this.strokes.filter((s) => s.id !== id);
    this.redraw();
  }

  clear(slide) {
    if (slide !== this.slide) return;
    this.strokes = [];
    this.redraw();
  }

  /**
   * Enables drawing with the pointer, or disables it with `null`.
   * @param {{ tool: "pen"|"highlighter", color: string, onChunk: (chunk: object) => void } | null} options
   */
  setInput(options) {
    this.input = options;
    this.canvas.classList.toggle("drawing", Boolean(options));
    if (!options) this.#finishStroke();
  }

  /** Coalesces redraws into one per animation frame. */
  redraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.#paint();
    });
  }

  #paint() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    for (const stroke of this.strokes) drawStroke(ctx, stroke, width, height);
  }

  #bindPointer() {
    const position = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      return [
        Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
      ];
    };

    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.input || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      const { tool, color } = this.input;
      const stroke = { id: randomId(), tool, color, width: TOOL_WIDTH[tool], points: position(e) };
      this.strokes.push(stroke);
      this.active = { stroke, sent: 0, styleSent: false, timer: 0 };
      this.redraw();
      this.#scheduleFlush();
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.active) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const event of events) this.active.stroke.points.push(...position(event));
      this.redraw();
      this.#scheduleFlush();
    });

    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      this.canvas.addEventListener(type, () => this.#finishStroke());
    }
    // A click that ends a stroke must not also advance the slide.
    this.canvas.addEventListener("click", (e) => {
      if (this.input) e.stopPropagation();
    });
  }

  #scheduleFlush() {
    if (this.active && !this.active.timer) this.active.timer = setTimeout(() => this.#flush(), CHUNK_INTERVAL_MS);
  }

  /** Sends the points drawn since the last chunk. */
  #flush() {
    const active = this.active;
    if (!active) return;
    active.timer = 0;
    const { stroke } = active;
    while (active.sent < stroke.points.length) {
      const points = stroke.points.slice(active.sent, active.sent + MAX_POINTS_PER_CHUNK * 2);
      active.sent += points.length;
      const chunk = { slide: this.slide, id: stroke.id, points };
      if (!active.styleSent) Object.assign(chunk, { tool: stroke.tool, color: stroke.color, width: stroke.width });
      active.styleSent = true;
      this.input?.onChunk(chunk);
    }
  }

  #finishStroke() {
    if (!this.active) return;
    clearTimeout(this.active.timer);
    this.#flush();
    this.active = null;
  }
}

/** Draws one stroke with smooth curves through the midpoints. */
function drawStroke(ctx, stroke, width, height) {
  const p = stroke.points;
  if (p.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = Math.max(1, stroke.width * width);
  if (stroke.tool === "highlighter") ctx.globalAlpha = HIGHLIGHTER_ALPHA;

  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0] * width, p[1] * height, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(p[0] * width, p[1] * height);
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = ((p[i] + p[i + 2]) / 2) * width;
      const my = ((p[i + 1] + p[i + 3]) / 2) * height;
      ctx.quadraticCurveTo(p[i] * width, p[i + 1] * height, mx, my);
    }
    ctx.lineTo(p[p.length - 2] * width, p[p.length - 1] * height);
    ctx.stroke();
  }
  ctx.restore();
}
