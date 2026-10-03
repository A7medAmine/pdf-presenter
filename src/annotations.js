"use strict";

/**
 * Slide annotations (pen and highlighter strokes).
 *
 * Strokes are drawn on a remote or the presenter and streamed in chunks: the
 * first chunk of a stroke carries its style, later chunks with the same ID
 * append points. Coordinates are normalized to the slide (0–1), so every
 * screen draws them at its own resolution. Strokes are kept per slide so
 * late joiners and slide changes can fetch them; hard caps keep memory bounded.
 */

const TOOLS = new Set(["pen", "highlighter"]);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const STROKE_ID_PATTERN = /^[A-Za-z0-9_-]{4,40}$/;

/** Largest number of points (x/y pairs) accepted in one chunk. */
const MAX_POINTS_PER_CHUNK = 200;
/** Largest number of points a single stroke may accumulate. */
const MAX_POINTS_PER_STROKE = 4000;
/** Strokes kept per slide; the oldest are dropped first. */
const MAX_STROKES_PER_SLIDE = 300;
/** Points kept per session across all slides. */
const MAX_POINTS_PER_SESSION = 200_000;

/**
 * @typedef {object} Stroke
 * @property {string} id
 * @property {"pen"|"highlighter"} tool
 * @property {string} color
 * @property {number} width   Line width as a fraction of the slide width.
 * @property {number[]} points Flat [x0, y0, x1, y1, …] list in [0, 1].
 */

/** @returns {number} The value clamped to [0, 1] and rounded to 4 decimals. */
function unit(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

/**
 * Validates a flat point list.
 * @returns {number[]|null} Normalized points, or null when invalid.
 */
function cleanPoints(points) {
  if (!Array.isArray(points) || points.length === 0 || points.length % 2 !== 0) return null;
  if (points.length > MAX_POINTS_PER_CHUNK * 2) return null;
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    if (typeof points[i] !== "number" || !Number.isFinite(points[i])) return null;
    out[i] = unit(points[i]);
  }
  return out;
}

class AnnotationBoard {
  constructor() {
    /** @type {Map<number, Stroke[]>} */
    this.slides = new Map();
    this.pointCount = 0;
  }

  /** @returns {Stroke[]} Strokes of a slide (empty when none). */
  get(slide) {
    return this.slides.get(slide) || [];
  }

  /**
   * Applies a stroke chunk.
   * @param {{ slide: number, id: string, tool?: string, color?: string, width?: number, points: number[] }} chunk
   * @returns {object|null} The sanitized chunk to broadcast, or null when rejected.
   */
  apply(chunk) {
    const { slide, id } = chunk;
    if (!Number.isInteger(slide) || slide < 1 || typeof id !== "string" || !STROKE_ID_PATTERN.test(id)) return null;
    const points = cleanPoints(chunk.points);
    if (!points) return null;

    const strokes = this.slides.get(slide) || [];
    let stroke = strokes.find((s) => s.id === id);
    if (stroke) {
      if (stroke.points.length + points.length > MAX_POINTS_PER_STROKE * 2) return null;
      stroke.points.push(...points);
    } else {
      if (!TOOLS.has(chunk.tool) || typeof chunk.color !== "string" || !COLOR_PATTERN.test(chunk.color)) return null;
      const width = Number(chunk.width);
      if (!Number.isFinite(width)) return null;
      stroke = {
        id,
        tool: chunk.tool,
        color: chunk.color.toLowerCase(),
        width: Math.min(0.05, Math.max(0.001, width)),
        points,
      };
      strokes.push(stroke);
      this.slides.set(slide, strokes);
      while (strokes.length > MAX_STROKES_PER_SLIDE) this.pointCount -= strokes.shift().points.length / 2;
    }
    this.pointCount += points.length / 2;
    this.#enforceSessionCap(slide);
    return { slide, id, tool: stroke.tool, color: stroke.color, width: stroke.width, points };
  }

  /** Removes the most recent stroke of a slide. @returns {string|null} Its ID. */
  undo(slide) {
    const strokes = this.slides.get(slide);
    const last = strokes?.pop();
    if (!last) return null;
    this.pointCount -= last.points.length / 2;
    if (!strokes.length) this.slides.delete(slide);
    return last.id;
  }

  /** Removes every stroke of a slide. */
  clear(slide) {
    for (const stroke of this.get(slide)) this.pointCount -= stroke.points.length / 2;
    this.slides.delete(slide);
  }

  /** Removes everything (used when the PDF changes). */
  reset() {
    this.slides.clear();
    this.pointCount = 0;
  }

  /** Drops whole slides (other than the active one) until the session fits its point budget. */
  #enforceSessionCap(activeSlide) {
    for (const [slide, strokes] of this.slides) {
      if (this.pointCount <= MAX_POINTS_PER_SESSION) return;
      if (slide === activeSlide) continue;
      for (const stroke of strokes) this.pointCount -= stroke.points.length / 2;
      this.slides.delete(slide);
    }
    const active = this.slides.get(activeSlide) || [];
    while (this.pointCount > MAX_POINTS_PER_SESSION && active.length > 1) {
      this.pointCount -= active.shift().points.length / 2;
    }
  }
}

module.exports = { AnnotationBoard, MAX_POINTS_PER_CHUNK, MAX_STROKES_PER_SLIDE };
