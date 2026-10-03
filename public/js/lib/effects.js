/**
 * PDF Presenter — zoom and spotlight effects shared by the presenter and viewers.
 *
 * Zoom scales a "zoom layer" (the slide canvas plus its overlays) inside a
 * clipping stage so the focus point ends up centred, without ever showing the
 * area outside the slide. Spotlight dims everything except a circle.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/** Spotlight radius as a fraction of the slide's shorter side. */
const SPOTLIGHT_RADIUS = 0.22;

/**
 * @typedef {{ mode: "none"|"spotlight"|"zoom", x: number, y: number, zoom: number }} ViewEffect
 */

/**
 * Applies an effect.
 * @param {ViewEffect|null} effect
 * @param {{ layer: HTMLElement, spotlight: HTMLElement }} targets
 *   `layer` is scaled for zoom; `spotlight` is an overlay covering the slide.
 */
export function applyEffect(effect, { layer, spotlight }) {
  const mode = effect?.mode || "none";

  if (mode === "zoom") {
    const z = Math.min(5, Math.max(1, effect.zoom || 2));
    // Translation in % of the layer: centre the focus point, clamped to the slide edges.
    const tx = Math.min(0, Math.max(100 - z * 100, 50 - effect.x * z * 100));
    const ty = Math.min(0, Math.max(100 - z * 100, 50 - effect.y * z * 100));
    layer.style.transformOrigin = "0 0";
    layer.style.transform = `translate(${tx}%, ${ty}%) scale(${z})`;
    layer.classList.add("zoomed");
  } else {
    layer.style.transform = "";
    layer.classList.remove("zoomed");
  }

  if (mode === "spotlight") {
    const { clientWidth: w, clientHeight: h } = spotlight;
    const radius = Math.round(Math.min(w, h) * SPOTLIGHT_RADIUS);
    spotlight.style.background = `radial-gradient(circle ${radius}px at ${effect.x * 100}% ${effect.y * 100}%, transparent 0, transparent ${radius - 2}px, rgba(0, 0, 0, 0.78) ${radius + 2}px)`;
    spotlight.classList.add("active");
  } else {
    spotlight.classList.remove("active");
  }
}
