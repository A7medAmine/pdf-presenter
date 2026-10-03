/**
 * PDF Presenter — remote control page (phone / tablet).
 *
 * Requests control of a session (the presenter approves it once per device),
 * then shows the current and next slide, sends slide commands, and offers a
 * pointer, pen / highlighter annotations, spotlight and zoom, live polls and
 * private per-slide speaker notes with a teleprompter. Reconnects
 * transparently after network drops.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import {
  $,
  request,
  icons,
  local,
  createToast,
  setStatus,
  normalizeSessionId,
  SESSION_ID_PATTERN,
  getDeviceId,
  isTyping,
  applySavedTheme,
  fullscreenElement,
  enterFullscreen,
  exitFullscreen,
  onFullscreenChange,
  keepScreenAwake,
  haptic,
  setupPwa,
  saveBlob,
} from "./lib/common.js";
import { t, bindLangToggles, onLangChange } from "./lib/i18n.js";
import { openDocument, SlideRenderer } from "./lib/pdf-renderer.js";
import { AnnotationLayer, COLORS } from "./lib/annotations.js";
import { applyEffect } from "./lib/effects.js";
import { renderPoll } from "./lib/poll-view.js";
import { NotesStore } from "./lib/notes-store.js";

applySavedTheme();

// ─── Constants ────────────────────────────────────────────────────────────────

const NOTES_FONT_KEY = "presenter-notes-font";
const COLOR_KEY = "presenter-ink-color";
const RETRY_DELAY_MS = 5000;
/** Teleprompter speed is expressed in "units"; one unit scrolls 60 px per second. */
const TP_PX_PER_UNIT_PER_SEC = 60;
const CURSOR_SEND_INTERVAL_MS = 16;
const SWIPE_THRESHOLD_PX = 40;
/** The preview never takes more than this share of the screen height. */
const PREVIEW_MAX_VH = 0.42;

// ─── DOM ──────────────────────────────────────────────────────────────────────

const dom = {
  connectScreen: $("remoteConnect"),
  sessionInput: $("sessionInput"),
  connectBtn: $("connectBtn"),
  hint: $("rcHint"),

  pad: $("remotePad"),
  sessionName: $("rcSessionName"),
  sessionBadge: $("rcSessionBadge"),
  status: $("rcStatusDot"),
  fullscreen: $("rcFullscreen"),
  disconnect: $("rcDisconnect"),
  slideBox: $("rcSlideBox"),
  slideNum: $("rcSlideNum"),
  totalSlides: $("rcTotalSlides"),
  prev: $("rcPrev"),
  next: $("rcNext"),
  jumpInput: $("jumpInput"),
  jumpBtn: $("jumpBtn"),

  stageBox: $("rcStageBox"),
  stage: $("rcStage"),
  canvas: $("rcCanvas"),
  ink: $("rcInk"),
  touch: $("rcTouch"),
  spotlight: $("rcSpotlight"),
  zoomIndicator: $("rcZoomIndicator"),
  stageEmpty: $("rcStageEmpty"),
  nextCanvas: $("rcNextCanvas"),
  nextEnd: $("rcNextEnd"),

  tools: document.querySelectorAll(".rc-tool"),
  toolHint: $("rcToolHint"),
  inkOptions: $("rcInkOptions"),
  colors: $("rcColors"),
  undo: $("rcUndo"),
  clear: $("rcClear"),
  zoomOptions: $("rcZoomOptions"),
  zoomLevels: $("rcZoomLevels"),
  effectOff: $("rcEffectOff"),

  notesLabel: $("rcNotesLabel"),
  notes: $("notesArea"),
  notesFontDown: $("notesFontDown"),
  notesFontUp: $("notesFontUp"),
  teleBtn: $("notesTeleBtn"),
  notesExport: $("notesExport"),
  notesImport: $("notesImport"),

  pollSection: $("rcPollSection"),
  pollBadge: $("rcPollBadge"),
  pollCreate: $("rcPollCreate"),
  pollQuestion: $("rcPollQuestion"),
  pollOptions: $("rcPollOptions"),
  pollStart: $("rcPollStart"),
  pollLive: $("rcPollLive"),
  pollResults: $("rcPollResults"),
  pollClose: $("rcPollClose"),
  pollClear: $("rcPollClear"),

  tele: $("teleprompterOverlay"),
  tpClose: $("tpClose"),
  tpText: $("tpText"),
  tpWrap: $("tpTextWrap"),
  tpPlayPause: $("tpPlayPause"),
  tpSpeedValue: $("tpSpeedValue"),
  tpSpeedUp: $("tpSpeedUp"),
  tpSpeedDown: $("tpSpeedDown"),
  tpPrev: $("tpPrevSlide"),
  tpNext: $("tpNextSlide"),
  tpIndicator: $("tpSlideIndicator"),

  bigPad: $("rcFsOverlay"),
  bigCounter: $("rfsCounter"),
  bigPrev: $("rfsPrev"),
  bigNext: $("rfsNext"),
  bigExit: $("rfsExit"),
};

const toast = createToast($("toast"));

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icons[el.dataset.icon] || "";

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  sessionId: null,
  /** @type {import("socket.io-client").Socket | null} */
  socket: null,
  approved: false,
  currentSlide: 1,
  totalSlides: 0,
  retryTimer: null,
  /** @type {"none"|"pointer"|"pen"|"highlighter"|"spotlight"|"zoom"} */
  tool: "none",
  color: COLORS.includes(local.get(COLOR_KEY)) ? local.get(COLOR_KEY) : COLORS[0],
  zoom: 2,
  /** @type {{ mode: string, x: number, y: number, zoom: number }} */
  effect: { mode: "none", x: 0.5, y: 0.5, zoom: 1 },
  pdfUrl: null,
  /** @type {import("pdfjs-dist").PDFDocumentProxy | null} */
  doc: null,
  loadId: 0,
  /** @type {NotesStore | null} */
  notes: null,
  /** @type {object | null} */
  poll: null,
};

const renderer = new SlideRenderer(dom.canvas, {
  cacheSize: 3,
  fit(pageWidth, pageHeight) {
    const maxWidth = dom.stageBox.clientWidth;
    const maxHeight = window.innerHeight * PREVIEW_MAX_VH;
    const scale = Math.max(0.01, Math.min(maxWidth / pageWidth, maxHeight / pageHeight));
    return { width: pageWidth * scale, height: pageHeight * scale };
  },
  onPaint({ pageNum }) {
    renderer.preload(pageNum + 1);
  },
});

const ink = new AnnotationLayer(dom.ink);

// ─── Connection ───────────────────────────────────────────────────────────────

function connect() {
  const sessionId = normalizeSessionId(dom.sessionInput.value);
  dom.sessionInput.value = sessionId;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    setStatus(dom.hint, { icon: icons.warning, text: t("enterSessionId"), color: "var(--danger)" });
    return;
  }

  state.sessionId = sessionId;
  state.approved = false;
  setStatus(dom.hint, { text: t("connecting"), color: "var(--text-3)" });
  state.socket?.disconnect();

  const socket = window.io({ transports: ["websocket", "polling"], reconnectionDelayMax: 5000 });
  state.socket = socket;

  // Every (re)connection is a new server-side socket, so access is requested
  // each time; devices approved earlier are let in without asking again.
  socket.on("connect", requestAccess);

  socket.on("disconnect", (reason) => {
    setLive(false);
    if (reason === "io server disconnect" && !state.approved) socket.disconnect();
  });

  socket.on("remote-approved", ({ state: snapshot }) => {
    toast(t("accessGranted"));
    haptic([20, 40, 20]);
    showPad(snapshot);
  });

  socket.on("remote-rejected", ({ message }) => {
    fail(message || t("requestDeclined"));
  });

  socket.on("slide-update", ({ currentSlide }) => {
    setSlide(currentSlide);
    pulseSlideBox();
  });

  socket.on("total-slides-update", ({ totalSlides, currentSlide }) => {
    state.totalSlides = totalSlides;
    setSlide(currentSlide);
  });

  socket.on("pdf-loaded", ({ pdf, currentSlide, totalSlides }) => {
    state.currentSlide = currentSlide;
    state.totalSlides = totalSlides;
    updateSlideDisplay();
    showSwapBanner(pdf.name);
    loadPdf(pdf);
  });

  socket.on("draw-stroke", (chunk) => ink.applyChunk(chunk));
  socket.on("draw-undo", ({ slide, id }) => ink.removeStroke(slide, id));
  socket.on("draw-clear", ({ slide }) => ink.clear(slide));
  socket.on("view-effect", (effect) => showEffect(effect));
  socket.on("poll-update", ({ poll }) => showPoll(poll));

  socket.on("presenter-status", ({ online }) => {
    if (state.approved) toast(online ? t("presenterBack") : t("presenterGone"));
  });

  socket.on("session-renamed", ({ name }) => showSessionName(name));

  socket.on("session-ended", ({ message }) => {
    state.approved = false;
    socket.disconnect();
    toast(message || t("sessionEnded"), { duration: 4000 });
    setTimeout(() => {
      window.location.href = "/access.html";
    }, 3000);
  });
}

async function requestAccess() {
  clearTimeout(state.retryTimer);
  const socket = state.socket;
  const res = await request(socket, "remote-request-access", {
    sessionId: state.sessionId,
    deviceId: getDeviceId(),
  });
  if (socket !== state.socket) return; // user reconnected meanwhile

  if (res.ok && res.status === "approved") {
    showPad(res.state);
    return;
  }
  if (res.ok && res.status === "pending") {
    setStatus(dom.hint, { icon: icons.clock, text: t("waitingApproval"), color: "var(--warning)" });
    return;
  }

  switch (res.code) {
    case "PRESENTER_OFFLINE":
    case "RATE_LIMITED":
    case "TIMEOUT":
      setStatus(dom.hint, {
        icon: icons.clock,
        text: t("retrying", { reason: res.message || t("notAvailableYet") }),
        color: "var(--warning)",
      });
      state.retryTimer = setTimeout(() => {
        if (socket.connected && socket === state.socket) requestAccess();
      }, RETRY_DELAY_MS);
      break;
    default:
      fail(res.message || t("couldNotConnect"));
  }
}

/** Shows an error on the connect screen and closes the connection. */
function fail(message) {
  clearTimeout(state.retryTimer);
  state.approved = false;
  state.socket?.disconnect();
  showConnectScreen();
  setStatus(dom.hint, { icon: icons.cross, text: message, color: "var(--danger)" });
}

function disconnect() {
  clearTimeout(state.retryTimer);
  state.approved = false;
  state.socket?.disconnect();
  state.socket = null;
  showConnectScreen();
  setStatus(dom.hint, { text: "" });
}

const connected = () => state.approved && state.socket?.connected;

// ─── Slide commands ───────────────────────────────────────────────────────────

async function sendSlideChange(payload) {
  if (!connected()) {
    toast(t("notConnected"));
    return;
  }
  haptic(10);
  const res = await request(state.socket, "slide-change", payload);
  if (!res.ok) toast(res.code === "NO_PDF" ? t("noPdfYet") : res.message);
}

const next = () => sendSlideChange({ direction: "next" });
const prev = () => sendSlideChange({ direction: "prev" });

function jump() {
  const slide = Number(dom.jumpInput.value);
  if (!Number.isInteger(slide) || slide < 1 || (state.totalSlides && slide > state.totalSlides)) {
    toast(state.totalSlides ? t("slideRange", { max: state.totalSlides }) : t("enterSlideNumber"));
    return;
  }
  sendSlideChange({ slide });
  dom.jumpInput.value = "";
  dom.jumpInput.blur();
}

// ─── Slides & previews ────────────────────────────────────────────────────────

/** Applies a new current slide everywhere on the remote. */
function setSlide(slide) {
  const changed = slide !== state.currentSlide;
  state.currentSlide = slide;
  updateSlideDisplay();
  if (!state.doc) return;
  renderer.show(slide);
  renderNextPreview();
  if (changed) {
    loadNotesForSlide();
    fetchAnnotations();
    if (!dom.tele.hidden) scrollTeleprompterToSlide(true);
  }
}

/** Loads the session PDF for the previews. */
async function loadPdf(pdf) {
  if (!pdf) {
    state.pdfUrl = null;
    dom.stageEmpty.hidden = false;
    dom.stage.hidden = true;
    return;
  }
  if (pdf.url === state.pdfUrl && state.doc) return;
  const loadId = ++state.loadId;
  state.pdfUrl = pdf.url;
  try {
    const doc = await openDocument(pdf.url);
    if (loadId !== state.loadId) {
      doc.destroy();
      return;
    }
    renderer.setDocument(doc);
    state.doc = doc;
    state.totalSlides = doc.numPages;
    dom.stageEmpty.hidden = true;
    dom.stage.hidden = false;
    state.notes = new NotesStore(doc.fingerprints?.[0] || pdf.name, pdf.name);
    updateSlideDisplay();
    await renderer.show(state.currentSlide);
    renderNextPreview();
    loadNotesForSlide();
    fetchAnnotations();
  } catch (err) {
    if (loadId !== state.loadId) return;
    console.error("[remote] PDF load failed", err);
    toast(t("previewFailed"));
  }
}

let nextRenderId = 0;

/** Renders the next slide into the small preview. */
async function renderNextPreview() {
  const renderId = ++nextRenderId;
  const target = state.currentSlide + 1;
  const atEnd = !state.doc || target > state.doc.numPages;
  dom.nextEnd.hidden = !atEnd || !state.doc;
  dom.nextCanvas.hidden = atEnd;
  if (atEnd) return;
  try {
    const page = await state.doc.getPage(target);
    if (renderId !== nextRenderId) return;
    const base = page.getViewport({ scale: 1 });
    const box = dom.nextCanvas.parentElement;
    const scale = Math.min(box.clientWidth / base.width, (box.clientHeight || 1e9) / base.height);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: scale * ratio });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    if (renderId !== nextRenderId) return;
    dom.nextCanvas.width = canvas.width;
    dom.nextCanvas.height = canvas.height;
    dom.nextCanvas.style.width = `${base.width * scale}px`;
    dom.nextCanvas.style.height = `${base.height * scale}px`;
    dom.nextCanvas.getContext("2d").drawImage(canvas, 0, 0);
  } catch {
    /* preview is best effort */
  }
}

async function fetchAnnotations() {
  const slide = state.currentSlide;
  ink.setSlide(slide, []);
  if (!connected() || !state.doc) return;
  const res = await request(state.socket, "get-annotations", { slide });
  if (res.ok && slide === state.currentSlide) ink.setSlide(slide, res.strokes);
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOL_HINTS = {
  none: "hintNavigate",
  pointer: "hintPointer",
  pen: "hintPen",
  highlighter: "hintPen",
  spotlight: "hintSpotlight",
  zoom: "hintZoom",
};

function selectTool(tool) {
  if (tool === state.tool) return;
  const previous = state.tool;
  state.tool = tool;
  haptic(8);
  for (const button of dom.tools) {
    const active = button.dataset.tool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  }
  dom.inkOptions.hidden = tool !== "pen" && tool !== "highlighter";
  dom.zoomOptions.hidden = tool !== "zoom";
  dom.toolHint.textContent = t(TOOL_HINTS[tool]);
  dom.stage.dataset.tool = tool;

  if (previous === "pointer") releaseCursor();
  // Leaving spotlight turns it off; a zoom stays until "Reset view" or the next slide.
  if (previous === "spotlight" && state.effect.mode === "spotlight") sendEffect({ mode: "none" });

  ink.setInput(
    tool === "pen" || tool === "highlighter"
      ? { tool, color: state.color, onChunk: (chunk) => connected() && state.socket.emit("draw-stroke", chunk) }
      : null,
  );
}

function buildColorSwatches() {
  dom.colors.replaceChildren(
    ...COLORS.map((color) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "color-swatch";
      swatch.style.background = color;
      swatch.dataset.color = color;
      swatch.setAttribute("aria-label", color);
      swatch.classList.toggle("active", color === state.color);
      return swatch;
    }),
  );
}

function selectColor(color) {
  state.color = color;
  local.set(COLOR_KEY, color);
  for (const swatch of dom.colors.children) swatch.classList.toggle("active", swatch.dataset.color === color);
  if (state.tool === "pen" || state.tool === "highlighter") selectToolForce(state.tool);
}

/** Re-applies the current drawing tool (after a colour change). */
function selectToolForce(tool) {
  state.tool = "";
  selectTool(tool);
}

async function undoStroke() {
  if (!connected()) return;
  haptic(8);
  const res = await request(state.socket, "draw-undo", { slide: state.currentSlide });
  if (res.ok && res.id) ink.removeStroke(state.currentSlide, res.id);
}

async function clearSlide() {
  if (!connected()) return;
  haptic([10, 30, 10]);
  const res = await request(state.socket, "draw-clear", { slide: state.currentSlide });
  if (res.ok) ink.clear(state.currentSlide);
}

/** Sends a zoom / spotlight change and mirrors it on the preview. */
function sendEffect(effect) {
  const full = { x: 0.5, y: 0.5, zoom: state.zoom, ...effect };
  if (connected()) state.socket.emit("view-effect", full);
  showEffect(full.mode === "none" ? { mode: "none", x: 0.5, y: 0.5, zoom: 1 } : full);
}

/** Mirrors the shared effect on the preview: a spotlight as-is, a zoom as a frame. */
function showEffect(effect) {
  state.effect = effect;
  applyEffect(effect.mode === "spotlight" ? effect : null, { layer: dom.canvas, spotlight: dom.spotlight });
  const zoomed = effect.mode === "zoom";
  dom.zoomIndicator.hidden = !zoomed;
  if (!zoomed) return;
  const z = effect.zoom;
  const left = -Math.min(0, Math.max(100 - z * 100, 50 - effect.x * z * 100)) / z;
  const top = -Math.min(0, Math.max(100 - z * 100, 50 - effect.y * z * 100)) / z;
  Object.assign(dom.zoomIndicator.style, {
    left: `${left}%`,
    top: `${top}%`,
    width: `${100 / z}%`,
    height: `${100 / z}%`,
  });
}

function setZoomLevel(zoom) {
  state.zoom = zoom;
  for (const button of dom.zoomLevels.children) button.classList.toggle("active", Number(button.dataset.zoom) === zoom);
  if (state.effect.mode === "zoom") sendEffect({ mode: "zoom", x: state.effect.x, y: state.effect.y });
}

// ─── Pointer, spotlight, zoom and swipe on the preview ───────────────────────

let lastCursorSend = 0;
let pendingCursor = null;
let cursorTimer = null;

function sendCursor(x, y, active) {
  if (connected()) state.socket.emit("cursor-move", { x, y, active });
}

/** Throttles pointer moves to ~60 per second, always delivering the latest position. */
function queueCursor(x, y) {
  pendingCursor = { x, y };
  const wait = CURSOR_SEND_INTERVAL_MS - (Date.now() - lastCursorSend);
  if (wait <= 0) flushCursor();
  else if (!cursorTimer) cursorTimer = setTimeout(flushCursor, wait);
}

function flushCursor() {
  clearTimeout(cursorTimer);
  cursorTimer = null;
  if (!pendingCursor) return;
  sendCursor(pendingCursor.x, pendingCursor.y, true);
  lastCursorSend = Date.now();
  pendingCursor = null;
}

function releaseCursor() {
  clearTimeout(cursorTimer);
  cursorTimer = null;
  pendingCursor = null;
  sendCursor(0, 0, false);
}

function stagePosition(event) {
  const rect = dom.touch.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

let swipeStart = null;

function handleStagePointer(event, phase) {
  const { x, y } = stagePosition(event);
  switch (state.tool) {
    case "pointer":
      if (phase === "end") releaseCursor();
      else queueCursor(x, y);
      break;
    case "spotlight":
      if (phase !== "end") sendEffect({ mode: "spotlight", x, y });
      break;
    case "zoom":
      if (phase !== "end") sendEffect({ mode: "zoom", x, y });
      break;
    case "none":
      if (phase === "start") swipeStart = event.clientX;
      if (phase === "end" && swipeStart !== null) {
        const dx = event.clientX - swipeStart;
        swipeStart = null;
        if (Math.abs(dx) > SWIPE_THRESHOLD_PX) (dx < 0 ? next : prev)();
      }
      break;
  }
}

dom.touch.addEventListener("pointerdown", (e) => {
  dom.touch.setPointerCapture(e.pointerId);
  if (state.tool !== "none") haptic(5);
  handleStagePointer(e, "start");
});
dom.touch.addEventListener("pointermove", (e) => {
  if (dom.touch.hasPointerCapture(e.pointerId)) handleStagePointer(e, "move");
});
dom.touch.addEventListener("pointerup", (e) => handleStagePointer(e, "end"));
dom.touch.addEventListener("pointercancel", (e) => handleStagePointer(e, "end"));

// ─── UI ───────────────────────────────────────────────────────────────────────

function showPad(snapshot) {
  state.approved = true;
  state.currentSlide = snapshot.currentSlide;
  state.totalSlides = snapshot.totalSlides;
  dom.connectScreen.hidden = true;
  dom.pad.hidden = false;
  dom.sessionBadge.textContent = state.sessionId;
  showSessionName(snapshot.name);
  setLive(true);
  updateSlideDisplay();
  keepScreenAwake();
  showEffect(snapshot.effect || state.effect);
  showPoll(snapshot.poll);
  if (state.doc && snapshot.pdf?.url === state.pdfUrl) {
    // Reconnected to the same deck: refresh what may have changed meanwhile.
    setSlide(state.currentSlide);
    loadNotesForSlide();
    fetchAnnotations();
  } else {
    loadPdf(snapshot.pdf);
  }
}

function showConnectScreen() {
  dom.pad.hidden = true;
  dom.bigPad.hidden = true;
  closeTeleprompter();
  dom.connectScreen.hidden = false;
}

function setLive(online) {
  dom.status.className = `rc-status ${online ? "connected" : "disconnected"}`;
  dom.status.textContent = online ? `● ${t("live")}` : `○ ${t("reconnecting")}`;
}

function showSessionName(name) {
  dom.sessionName.textContent = name || t("untitledSession");
  dom.sessionName.hidden = false;
}

function updateSlideDisplay() {
  const total = state.totalSlides || "?";
  dom.slideNum.textContent = String(state.currentSlide);
  dom.totalSlides.textContent = String(total);
  dom.bigCounter.textContent = `${state.currentSlide} / ${total}`;
  dom.tpIndicator.textContent = `${state.currentSlide} / ${total}`;
  dom.jumpInput.max = String(state.totalSlides || 9999);
  dom.notesLabel.textContent = t("notesForSlide", { n: state.currentSlide });
}

function pulseSlideBox() {
  dom.slideBox.classList.remove("pulse");
  void dom.slideBox.offsetWidth; // restart the CSS animation
  dom.slideBox.classList.add("pulse");
}

function showSwapBanner(filename) {
  document.getElementById("rcPdfSwapBanner")?.remove();
  const banner = document.createElement("div");
  banner.id = "rcPdfSwapBanner";
  banner.className = "rc-pdf-swap-banner";
  banner.setAttribute("role", "status");
  banner.innerHTML = icons.swap;
  const text = document.createElement("span");
  text.append(`${t("newPdf")} `);
  const strong = document.createElement("strong");
  strong.textContent = filename;
  text.append(strong);
  banner.append(text);
  dom.pad.querySelector(".rc-header").insertAdjacentElement("afterend", banner);
  requestAnimationFrame(() => banner.classList.add("show"));
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 400);
  }, 4000);
}

// ─── Polls ────────────────────────────────────────────────────────────────────

function showPoll(poll) {
  state.poll = poll || null;
  dom.pollCreate.hidden = Boolean(poll);
  dom.pollLive.hidden = !poll;
  dom.pollBadge.hidden = !poll?.open;
  dom.pollClose.hidden = !poll?.open;
  if (poll) renderPoll(dom.pollResults, poll);
}

async function startPoll() {
  if (!connected()) return toast(t("notConnected"));
  const question = dom.pollQuestion.value.trim();
  const options = dom.pollOptions.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!question) return toast(t("pollNeedsQuestion"));
  if (options.length < 2 || options.length > 6) return toast(t("pollNeedsOptions"));
  const res = await request(state.socket, "poll-start", { question, options });
  if (!res.ok) return toast(res.message);
  haptic(15);
  dom.pollQuestion.value = "";
  dom.pollOptions.value = "";
  showPoll(res.poll);
}

async function pollCommand(event) {
  if (!connected()) return;
  const res = await request(state.socket, event);
  if (!res.ok) toast(res.message);
}

// ─── Speaker notes ────────────────────────────────────────────────────────────

let notesFontSize = Number(local.get(NOTES_FONT_KEY)) || 16;

function applyNotesFont() {
  notesFontSize = Math.min(32, Math.max(10, notesFontSize));
  dom.notes.style.fontSize = `${notesFontSize}px`;
  local.set(NOTES_FONT_KEY, String(notesFontSize));
}

function loadNotesForSlide() {
  dom.notes.disabled = !state.notes;
  dom.notes.value = state.notes ? state.notes.get(state.currentSlide) : "";
}

function exportNotes() {
  if (!state.notes) return toast(t("notesNeedPdf"));
  const base = state.notes.name.replace(/\.[^.]+$/, "") || "notes";
  saveBlob(state.notes.export(), `${base}.notes.json`);
}

async function importNotes(file) {
  if (!file) return;
  if (!state.notes) return toast(t("notesNeedPdf"));
  try {
    const count = state.notes.import(await file.text());
    loadNotesForSlide();
    toast(t("notesImported", { count }));
  } catch {
    toast(t("notesImportFailed"));
  } finally {
    dom.notesImport.value = "";
  }
}

// ─── Teleprompter ─────────────────────────────────────────────────────────────

const tp = { running: false, speed: 1.5, position: 0, lastTime: 0, raf: 0 };

function openTeleprompter() {
  const entries = state.notes ? state.notes.entries() : [];
  if (!entries.length) {
    toast(t("addNotesFirst"));
    return;
  }
  // Paragraphs are built as DOM nodes, so notes can never inject HTML.
  const sections = entries.map(([slide, text]) => {
    const section = document.createElement("section");
    section.dataset.slide = String(slide);
    const heading = document.createElement("h4");
    heading.className = "tp-slide-heading";
    heading.textContent = t("slideN", { n: slide });
    section.append(heading);
    for (const block of text.trim().split(/\n{2,}/)) {
      const p = document.createElement("p");
      block.split("\n").forEach((line, i) => {
        if (i) p.append(document.createElement("br"));
        p.append(line);
      });
      section.append(p);
    }
    return section;
  });
  dom.tpText.replaceChildren(...sections);
  dom.tele.hidden = false;
  enterFullscreen(dom.tele);
  scrollTeleprompterToSlide(false);
  setTeleprompterRunning(true);
}

/** Scrolls to the notes of the current slide (or the closest earlier one). */
function scrollTeleprompterToSlide(smooth) {
  const sections = [...dom.tpText.querySelectorAll("section")];
  const target = sections.filter((s) => Number(s.dataset.slide) <= state.currentSlide).pop() || sections[0];
  for (const s of sections) s.classList.toggle("current", s === target);
  if (!target) return;
  const top = target.offsetTop - 16;
  dom.tpWrap.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  tp.position = top;
}

function closeTeleprompter() {
  setTeleprompterRunning(false);
  dom.tele.hidden = true;
  if (fullscreenElement() === dom.tele) exitFullscreen();
}

function setTeleprompterRunning(running) {
  tp.running = running;
  dom.tpPlayPause.textContent = running ? `⏸ ${t("pause")}` : `▶ ${t("play")}`;
  cancelAnimationFrame(tp.raf);
  if (!running) return;
  tp.position = dom.tpWrap.scrollTop;
  tp.lastTime = performance.now();
  tp.raf = requestAnimationFrame(stepTeleprompter);
}

/** Time-based scrolling: same speed on 60 Hz and 120 Hz screens, and slow speeds still move. */
function stepTeleprompter(now) {
  if (!tp.running) return;
  const elapsed = (now - tp.lastTime) / 1000;
  tp.lastTime = now;
  // A smooth jump to another slide's notes may be in progress: follow it.
  if (Math.abs(dom.tpWrap.scrollTop - tp.position) > 2) tp.position = dom.tpWrap.scrollTop;
  tp.position += tp.speed * TP_PX_PER_UNIT_PER_SEC * elapsed;
  dom.tpWrap.scrollTop = tp.position;
  if (dom.tpWrap.scrollTop + dom.tpWrap.clientHeight >= dom.tpWrap.scrollHeight - 1) {
    setTeleprompterRunning(false);
    return;
  }
  tp.raf = requestAnimationFrame(stepTeleprompter);
}

function changeSpeed(delta) {
  tp.speed = Math.round(Math.min(8, Math.max(0.1, tp.speed + delta)) * 10) / 10;
  dom.tpSpeedValue.textContent = tp.speed.toFixed(1);
}

// ─── Big-button fullscreen pad ────────────────────────────────────────────────

function openBigPad() {
  dom.bigPad.hidden = false;
  enterFullscreen(dom.bigPad);
}

function closeBigPad() {
  dom.bigPad.hidden = true;
  if (fullscreenElement() === dom.bigPad) exitFullscreen();
}

onFullscreenChange(() => {
  if (fullscreenElement()) return;
  // Leaving fullscreen (e.g. with the system back gesture) closes the overlays.
  dom.bigPad.hidden = true;
  if (!dom.tele.hidden) closeTeleprompter();
});

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.doc) return;
    renderer.refresh();
    renderNextPreview();
    showEffect(state.effect);
  }, 150);
}).observe(dom.stageBox);

// ─── Event wiring ─────────────────────────────────────────────────────────────

bindLangToggles($("rcLang"), $("rcLangConnect"));
onLangChange(() => {
  updateSlideDisplay();
  setLive(connected());
  dom.toolHint.textContent = t(TOOL_HINTS[state.tool]);
  setTeleprompterRunning(tp.running);
  if (state.poll) showPoll(state.poll);
});
setupPwa($("rcInstall"));

dom.connectBtn.addEventListener("click", connect);
dom.sessionInput.addEventListener("input", () => {
  dom.sessionInput.value = normalizeSessionId(dom.sessionInput.value);
});
dom.sessionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect();
});

dom.prev.addEventListener("click", prev);
dom.next.addEventListener("click", next);
dom.jumpBtn.addEventListener("click", jump);
dom.jumpInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") jump();
});
dom.disconnect.addEventListener("click", disconnect);
dom.fullscreen.addEventListener("click", openBigPad);
dom.bigPrev.addEventListener("click", prev);
dom.bigNext.addEventListener("click", next);
dom.bigExit.addEventListener("click", closeBigPad);

for (const button of dom.tools) button.addEventListener("click", () => selectTool(button.dataset.tool));
dom.colors.addEventListener("click", (e) => {
  const swatch = e.target.closest(".color-swatch");
  if (swatch) selectColor(swatch.dataset.color);
});
dom.undo.addEventListener("click", undoStroke);
dom.clear.addEventListener("click", clearSlide);
dom.zoomLevels.addEventListener("click", (e) => {
  const button = e.target.closest("[data-zoom]");
  if (button) setZoomLevel(Number(button.dataset.zoom));
});
dom.effectOff.addEventListener("click", () => sendEffect({ mode: "none" }));

dom.pollStart.addEventListener("click", startPoll);
dom.pollClose.addEventListener("click", () => pollCommand("poll-close"));
dom.pollClear.addEventListener("click", () => pollCommand("poll-clear"));

dom.notes.addEventListener("input", () => state.notes?.set(state.currentSlide, dom.notes.value));
dom.notesFontDown.addEventListener("click", () => {
  notesFontSize -= 2;
  applyNotesFont();
});
dom.notesFontUp.addEventListener("click", () => {
  notesFontSize += 2;
  applyNotesFont();
});
dom.notesExport.addEventListener("click", exportNotes);
dom.notesImport.addEventListener("change", () => importNotes(dom.notesImport.files[0]));
applyNotesFont();

dom.teleBtn.addEventListener("click", openTeleprompter);
dom.tpClose.addEventListener("click", closeTeleprompter);
dom.tpPlayPause.addEventListener("click", () => setTeleprompterRunning(!tp.running));
dom.tpWrap.addEventListener("click", () => setTeleprompterRunning(!tp.running));
dom.tpSpeedUp.addEventListener("click", () => changeSpeed(0.1));
dom.tpSpeedDown.addEventListener("click", () => changeSpeed(-0.1));
dom.tpPrev.addEventListener("click", prev);
dom.tpNext.addEventListener("click", next);
changeSpeed(0);

// Bluetooth presentation clickers send arrow or Page Up/Down keys.
document.addEventListener("keydown", (e) => {
  if (!state.approved || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) {
    e.preventDefault();
    next();
  } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) {
    e.preventDefault();
    prev();
  } else if (e.key === "Escape") {
    closeBigPad();
    closeTeleprompter();
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

buildColorSwatches();
dom.toolHint.textContent = t(TOOL_HINTS.none);
dom.stage.dataset.tool = "none";
dom.stage.hidden = true;

const initialId = normalizeSessionId(new URLSearchParams(window.location.search).get("session"));
if (SESSION_ID_PATTERN.test(initialId)) {
  dom.sessionInput.value = initialId;
  connect();
} else {
  dom.sessionInput.focus();
}
