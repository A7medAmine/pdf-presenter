/**
 * PDF Presenter — presenter page.
 *
 * Responsibilities:
 *  - create or restore a session (survives page reloads via sessionStorage)
 *  - upload / swap the PDF (or a PowerPoint file, converted by the server) and
 *    render it sharply (see lib/pdf-renderer.js); recent files are kept in
 *    this browser for one-click re-use
 *  - draw on slides, show zoom / spotlight from remotes, run audience polls
 *  - navigate with keyboard, clicks, swipes and the thumbnail strip
 *  - stay in sync with remotes and viewers over Socket.io
 *  - approve, reject or block remote controllers
 *  - share remote / viewer links as QR codes
 *
 * Licensed under the Apache License, Version 2.0.
 */

import {
  $,
  api,
  request,
  icons,
  local,
  session as sessionStore,
  createToast,
  getDeviceId,
  isTyping,
  copyText,
  drawQr,
  applySavedTheme,
  bindThemeToggles,
  fullscreenElement,
  enterFullscreen,
  exitFullscreen,
  onFullscreenChange,
  keepScreenAwake,
  haptic,
  setupPwa,
  formatBytes,
} from "./lib/common.js";
import { t, bindLangToggles, onLangChange, currentLang } from "./lib/i18n.js";
import { openDocument, renderThumbnail, SlideRenderer } from "./lib/pdf-renderer.js";
import { AnnotationLayer, COLORS } from "./lib/annotations.js";
import { applyEffect } from "./lib/effects.js";
import { renderPoll } from "./lib/poll-view.js";
import { listDecks, getDeckFile, saveDeck, removeDeck } from "./lib/library.js";
import { startDhikr } from "./lib/dhikr.js";

applySavedTheme();

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "presenter-session";
const IP_KEY = "presenter-ip";
const ORIENTATION_KEY = "presenter-orientation";
const REMEMBER_KEY = "presenter-remember-decks";
const COLOR_KEY = "presenter-ink-color";
const SWIPE_THRESHOLD_PX = 50;
const THUMB_HEIGHT_PX = 44;
/** Link annotations are only followed for these protocols (never `javascript:`). */
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

// ─── DOM ──────────────────────────────────────────────────────────────────────

const dom = {
  topbar: $("topbar"),
  sessionName: $("sessionNameDisplay"),
  sessionBadge: $("sessionBadge"),
  slideCounter: $("slideCounter"),
  changePdfBtn: $("changePdfBtn"),
  themeToggle: $("themeToggle"),
  fullscreenBtn: $("fullscreenBtn"),
  showRemoteBtn: $("showRemoteBtn"),
  showViewerBtn: $("showViewerBtn"),
  endSessionBtn: $("endSessionBtn"),

  setupOverlay: $("setupOverlay"),
  setupThemeToggle: $("setupThemeToggle"),
  setupTitle: $("setupTitle"),
  setupSubtitle: $("setupSubtitle"),
  createSection: $("createSection"),
  sessionNameInput: $("sessionNameInput"),
  sessionPasswordInput: $("sessionPasswordInput"),
  togglePasswordBtn: $("toggleSessionPassword"),
  startSessionBtn: $("startSessionBtn"),
  uploadZone: $("uploadZone"),
  fileInput: $("fileInput"),
  uploadProgress: $("uploadProgress"),
  progressFill: $("progressFill"),
  progressLabel: $("progressLabel"),
  swapCancelBtn: $("swapCancelBtn"),
  likeBtn: $("likeBtn"),
  likeCount: $("likeCount"),

  slideArea: $("slideArea"),
  slideWrapper: $("slideWrapper"),
  canvas: $("slideCanvas"),
  linkLayer: $("linkLayer"),
  zoomLayer: $("zoomLayer"),
  ink: $("inkCanvas"),
  spotlight: $("spotlightLayer"),
  cursor: $("artificialCursor"),
  drawToolbar: $("drawToolbar"),
  drawTools: document.querySelectorAll(".draw-tool[data-tool]"),
  drawColors: $("drawColors"),
  drawUndo: $("drawUndo"),
  drawClear: $("drawClear"),
  pollBtn: $("pollBtn"),
  pollModal: $("pollModal"),
  pollQuestion: $("pollQuestion"),
  pollOptions: $("pollOptions"),
  pollStartBtn: $("pollStartBtn"),
  pollOverlay: $("pollOverlay"),
  pollOverlayBody: $("pollOverlayBody"),
  pollCloseBtn: $("pollCloseBtn"),
  pollHideBtn: $("pollHideBtn"),
  pollClearBtn: $("pollClearBtn"),
  allowDownloadToggle: $("allowDownloadToggle"),
  uploadHint: $("uploadHint"),
  librarySection: $("librarySection"),
  libraryList: $("libraryList"),
  rememberDecks: $("rememberDecks"),
  transition: $("transitionOverlay"),
  prevBtn: $("prevBtn"),
  nextBtn: $("nextBtn"),
  slideStrip: $("slideStrip"),

  remoteModal: $("remoteModal"),
  ipInput: $("ipInput"),
  ipSelector: $("ipSelector"),
  ipNote: $("ipNote"),
  applyIpBtn: $("applyIpBtn"),
  qrCanvas: $("qrCanvas"),
  remoteUrlDisplay: $("remoteUrlDisplay"),
  modalSessionId: $("modalSessionId"),
  remoteCount: $("connectedCount"),
  copyRemoteUrlBtn: $("copyUrlBtn"),
  toggleRemoteRequestsBtn: $("toggleRemoteRequestsBtn"),

  viewerModal: $("viewerModal"),
  orientLandscape: $("orientLandscape"),
  orientPortrait: $("orientPortrait"),
  viewerQrCanvas: $("viewerQrCanvas"),
  viewerUrlDisplay: $("viewerUrlDisplay"),
  viewerModalSessionId: $("viewerModalSessionId"),
  viewerCount: $("viewerCount"),
  copyViewerUrlBtn: $("copyViewerUrlBtn"),

  approvalDialog: $("remoteApprovalDialog"),
  approvalCount: $("approvalCount"),
  approvalDevice: $("approvalDevice"),
  approveBtn: $("approveRemoteBtn"),
  rejectBtn: $("rejectRemoteBtn"),
  blockBtn: $("blockRemoteBtn"),
  dismissApprovalBtn: $("dismissApprovalBtn"),
};

const toast = createToast($("toast"));
const notificationSound = new Audio("/sounds/notification.mp3");
notificationSound.preload = "auto";

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  /** @type {{ sessionId: string, presenterToken: string, remoteUrl: string, viewerUrl: string } | null} */
  session: null,
  /** @type {import("socket.io-client").Socket | null} */
  socket: null,
  joined: false,
  /** @type {import("pdfjs-dist").PDFDocumentProxy | null} */
  doc: null,
  currentSlide: 1,
  totalSlides: 0,
  remoteRequestsEnabled: true,
  /** Pending remote requests, oldest first. */
  pendingRemotes: /** @type {{ remoteSocketId: string, deviceLabel: string }[]} */ ([]),
  orientation: local.get(ORIENTATION_KEY) === "portrait" ? "portrait" : "landscape",
  /** Increments on every paint so stale async link-layer work can be dropped. */
  paintId: 0,
  /** Accepted upload extensions (PowerPoint only when the server can convert). */
  formats: [".pdf"],
  /** @type {null|"pen"|"highlighter"} */
  tool: null,
  color: COLORS.includes(local.get(COLOR_KEY)) ? local.get(COLOR_KEY) : COLORS[0],
  effect: { mode: "none", x: 0.5, y: 0.5, zoom: 1 },
  poll: null,
  pollHidden: false,
  presence: { viewerCount: 0, remoteCount: 0 },
};

const renderer = new SlideRenderer(dom.canvas, {
  boost: () => (state.effect.mode === "zoom" ? state.effect.zoom : 1),
  cacheSize: 5,
  fit(pageWidth, pageHeight) {
    const fullscreen = Boolean(fullscreenElement());
    const maxWidth = dom.slideArea.clientWidth - (fullscreen ? 0 : 60);
    const maxHeight = dom.slideArea.clientHeight - (fullscreen ? 0 : 40);
    const scale = Math.max(0.01, Math.min(maxWidth / pageWidth, maxHeight / pageHeight));
    return { width: pageWidth * scale, height: pageHeight * scale };
  },
  onPaint({ pageNum, page }) {
    renderLinkLayer(page);
    applyEffect(state.effect, { layer: dom.zoomLayer, spotlight: dom.spotlight });
    renderer.preload(pageNum + 1);
    renderer.preload(pageNum - 1);
  },
});

const ink = new AnnotationLayer(dom.ink);

// ─── Session persistence ──────────────────────────────────────────────────────

function saveSession() {
  if (state.session) sessionStore.set(STORAGE_KEY, JSON.stringify(state.session));
}

function loadSavedSession() {
  try {
    const saved = JSON.parse(sessionStore.get(STORAGE_KEY) || "null");
    return saved && saved.sessionId && saved.presenterToken ? saved : null;
  } catch {
    return null;
  }
}

function forgetSession() {
  sessionStore.remove(STORAGE_KEY);
}

// ─── Setup overlay ────────────────────────────────────────────────────────────

/**
 * Switches the setup overlay between its modes.
 * @param {"create"|"upload"|"swap"|"replaced"|"hidden"} mode
 */
function setSetupMode(mode) {
  dom.setupOverlay.dataset.mode = mode;
  dom.setupOverlay.classList.toggle("hide", mode === "hidden");
  dom.setupOverlay.setAttribute("aria-hidden", String(mode === "hidden"));
  dom.createSection.hidden = mode !== "create";
  dom.uploadZone.hidden = mode !== "upload" && mode !== "swap";
  dom.swapCancelBtn.hidden = mode !== "swap";
  if (mode !== "upload" && mode !== "swap") dom.uploadProgress.hidden = true;

  dom.librarySection.hidden = mode !== "upload" && mode !== "swap";
  if (!dom.librarySection.hidden) renderLibrary();
  paintSetupCopy();
  if (mode === "create") dom.sessionNameInput.focus();
  if (mode === "upload" || mode === "swap") dom.uploadZone.focus();
}

/** Title and subtitle of the setup card, in the current language. */
function paintSetupCopy() {
  const mode = dom.setupOverlay.dataset.mode;
  const keys = {
    create: ["appName", "setupCreateSub"],
    upload: ["setupUploadTitle", "setupUploadSub"],
    swap: ["setupSwapTitle", "setupSwapSub"],
    replaced: ["setupReplacedTitle", "setupReplacedSub"],
  }[mode];
  if (keys) {
    dom.setupTitle.textContent = t(keys[0]);
    dom.setupSubtitle.textContent = t(keys[1]);
  }
  const office = state.formats.length > 1;
  dom.uploadHint.textContent = t(office ? "uploadHintOffice" : "uploadHintPdf");
  dom.fileInput.accept = office
    ? `application/pdf,${state.formats.join(",")}`
    : "application/pdf,.pdf";
}

/** Asks the server which file types it accepts. */
async function loadCapabilities() {
  const { ok, data } = await api("/api/capabilities");
  if (ok && Array.isArray(data.formats)) state.formats = data.formats;
  paintSetupCopy();
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

async function startSession() {
  const name = dom.sessionNameInput.value.trim() || null;
  const password = dom.sessionPasswordInput.value;
  if (password && password.length < 4) {
    toast(t("passwordTooShort"));
    dom.sessionPasswordInput.focus();
    return;
  }

  dom.startSessionBtn.disabled = true;
  const { ok, data } = await api("/api/session", { method: "POST", body: { name, password: password || null } });
  dom.startSessionBtn.disabled = false;
  if (!ok) {
    toast(data.error || t("createFailed"));
    return;
  }

  state.session = {
    sessionId: data.sessionId,
    presenterToken: data.presenterToken,
    remoteUrl: data.remoteUrl,
    viewerUrl: data.viewerUrl,
  };
  saveSession();
  enterSession(data.name, null);
}

/** Tries to resume the session stored in this tab. */
async function restoreSession() {
  const saved = loadSavedSession();
  if (!saved) return false;

  const { ok, status, data } = await api(`/api/session/${saved.sessionId}`, {
    headers: { "X-Presenter-Token": saved.presenterToken },
  });
  if (!ok) {
    if (status !== 0) forgetSession(); // keep it when the server is merely unreachable
    return false;
  }

  state.session = saved;
  enterSession(data.name, data);
  toast(t("sessionRestored"));
  return true;
}

/**
 * Shows the session UI, connects the socket and loads the PDF if there is one.
 * @param {string} name
 * @param {object|null} serverState Public session state, when restoring.
 */
function enterSession(name, serverState) {
  const { sessionId } = state.session;
  showSessionName(name);
  dom.sessionBadge.textContent = sessionId;
  dom.modalSessionId.textContent = sessionId;
  dom.viewerModalSessionId.textContent = sessionId;
  dom.endSessionBtn.hidden = false;
  dom.showRemoteBtn.disabled = false;
  dom.showViewerBtn.disabled = false;
  dom.pollBtn.disabled = false;
  keepScreenAwake();

  connectSocket();

  if (serverState?.pdf) {
    loadPdf(serverState.pdf, serverState.currentSlide);
  } else {
    setSetupMode("upload");
  }
}

function showSessionName(name) {
  dom.sessionName.textContent = name || t("untitledSession");
  dom.sessionName.hidden = false;
}

async function endSession() {
  if (!confirm(t("confirmEnd"))) return;
  if (state.socket?.connected) await request(state.socket, "end-session");
  leaveSession("/");
}

/** Forgets the session locally and navigates away. */
function leaveSession(location) {
  forgetSession();
  state.socket?.disconnect();
  window.location.href = location;
}

async function renameSession() {
  if (!state.joined) return;
  const name = prompt(t("sessionNamePrompt"), dom.sessionName.textContent);
  if (name === null || !name.trim()) return;
  const res = await request(state.socket, "rename-session", { name });
  if (!res.ok) toast(res.message || t("renameFailed"));
}

// ─── Socket ───────────────────────────────────────────────────────────────────

function connectSocket() {
  const socket = window.io({ transports: ["websocket", "polling"] });
  state.socket = socket;

  socket.on("connect", async () => {
    const res = await request(socket, "join-session", {
      sessionId: state.session.sessionId,
      role: "presenter",
      presenterToken: state.session.presenterToken,
    });
    if (!res.ok) {
      state.joined = false;
      if (res.code === "SESSION_NOT_FOUND" || res.code === "FORBIDDEN") {
        toast(t("sessionGone"));
        setTimeout(() => leaveSession("/"), 2000);
      } else {
        toast(res.message || t("couldNotJoin"));
      }
      return;
    }

    state.joined = true;
    updatePresence(res.state);
    syncTotalSlides();
    state.effect = res.state.effect || state.effect;
    showPoll(res.state.poll);
    dom.allowDownloadToggle.checked = Boolean(res.state.allowDownload);
    fetchAnnotations();
    // After a reconnect the server is the source of truth for the position.
    if (state.doc && res.state.currentSlide !== state.currentSlide) showSlide(res.state.currentSlide);
  });

  socket.on("disconnect", (reason) => {
    state.joined = false;
    if (reason !== "io client disconnect" && reason !== "io server disconnect") {
      toast(t("connectionLost"));
    }
  });

  socket.on("slide-update", ({ currentSlide }) => {
    if (currentSlide !== state.currentSlide) showSlide(currentSlide, { animate: true });
  });

  socket.on("presence", updatePresence);
  socket.on("session-renamed", ({ name }) => showSessionName(name));
  socket.on("cursor-move", moveCursor);
  socket.on("draw-stroke", (chunk) => ink.applyChunk(chunk));
  socket.on("draw-undo", ({ slide, id }) => ink.removeStroke(slide, id));
  socket.on("draw-clear", ({ slide }) => ink.clear(slide));
  socket.on("view-effect", (effect) => {
    const rerender = (effect.mode === "zoom" ? effect.zoom : 1) !== (state.effect.mode === "zoom" ? state.effect.zoom : 1);
    state.effect = effect;
    applyEffect(effect, { layer: dom.zoomLayer, spotlight: dom.spotlight });
    if (rerender && state.doc) renderer.show(state.currentSlide); // sharper pixels for the new zoom level
  });
  socket.on("poll-update", ({ poll }) => showPoll(poll));

  socket.on("remote-pending", ({ remoteSocketId, deviceLabel }) => {
    if (state.pendingRemotes.some((p) => p.remoteSocketId === remoteSocketId)) return;
    state.pendingRemotes.push({ remoteSocketId, deviceLabel });
    notificationSound.currentTime = 0;
    notificationSound.play().catch(() => {}); // autoplay may be blocked until first interaction
    haptic([30, 60, 30]); // tablets used as the presenter screen
    renderApprovalDialog();
  });

  socket.on("remote-request-cancelled", ({ remoteSocketId }) => dropPending(remoteSocketId));

  socket.on("session-ended", ({ message }) => {
    toast(message || t("sessionEnded"));
    setTimeout(() => leaveSession("/"), 2000);
  });

  socket.on("presenter-replaced", () => {
    state.joined = false;
    setSetupMode("replaced");
  });
}

function updatePresence({ viewerCount = 0, remoteCount = 0 } = state.presence) {
  state.presence = { viewerCount, remoteCount };
  dom.viewerCount.textContent = t("viewersConnectedCount", { count: viewerCount });
  dom.remoteCount.textContent = t("remotesConnectedCount", { count: remoteCount });
}

/** Reports the page count once both the socket and the document are ready. */
function syncTotalSlides() {
  if (state.joined && state.doc) {
    request(state.socket, "set-total-slides", { totalSlides: state.doc.numPages });
  }
}

function moveCursor({ x, y, active }) {
  dom.cursor.classList.toggle("active", Boolean(active));
  if (!active) return;
  dom.cursor.style.left = `${x * 100}%`;
  dom.cursor.style.top = `${y * 100}%`;
}

// ─── Remote approval ──────────────────────────────────────────────────────────

function renderApprovalDialog() {
  const head = state.pendingRemotes[0];
  dom.approvalDialog.hidden = !head;
  if (!head) return;
  const count = state.pendingRemotes.length;
  dom.approvalCount.textContent = t("remotesWaiting", { count });
  dom.approvalDevice.textContent = t("deviceLabel", { id: head.deviceLabel });
}

function dropPending(remoteSocketId) {
  state.pendingRemotes = state.pendingRemotes.filter((p) => p.remoteSocketId !== remoteSocketId);
  renderApprovalDialog();
}

/** @param {"remote-accept"|"remote-reject"|"remote-block"} event */
async function answerPending(event) {
  const head = state.pendingRemotes[0];
  if (!head || !state.joined) return;
  dropPending(head.remoteSocketId);
  const res = await request(state.socket, event, { remoteSocketId: head.remoteSocketId });
  if (!res.ok) toast(res.message || t("requestGone"));
  else if (event === "remote-accept") toast(t("remoteConnected", { id: head.deviceLabel }));
  else if (event === "remote-block") toast(t("deviceBlocked", { id: head.deviceLabel }));
}

async function toggleRemoteRequests() {
  if (!state.joined) return;
  const res = await request(state.socket, "toggle-remote-requests", { enabled: !state.remoteRequestsEnabled });
  if (!res.ok) return toast(res.message || t("settingFailed"));
  state.remoteRequestsEnabled = res.enabled;
  paintRemoteRequestsButton();
  toast(res.enabled ? t("remoteRequestsOn") : t("remoteRequestsOff"));
}

function paintRemoteRequestsButton() {
  const label = dom.toggleRemoteRequestsBtn.querySelector("span");
  label.dataset.i18n = state.remoteRequestsEnabled ? "disableRemoteRequests" : "enableRemoteRequests";
  label.textContent = t(label.dataset.i18n);
  dom.toggleRemoteRequestsBtn.classList.toggle("btn-danger", state.remoteRequestsEnabled);
  dom.toggleRemoteRequestsBtn.classList.toggle("btn-success", !state.remoteRequestsEnabled);
}

// ─── Upload ───────────────────────────────────────────────────────────────────

const extensionOf = (name) => (name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
const isOfficeFile = (file) => extensionOf(file.name) !== ".pdf" && state.formats.includes(extensionOf(file.name));

function isAccepted(file) {
  if (!file) return false;
  const ext = extensionOf(file.name);
  return state.formats.includes(ext) || (file.type === "application/pdf" && !ext);
}

function handleFile(file) {
  if (!isAccepted(file)) {
    toast(t(state.formats.length > 1 ? "chooseOfficeFile" : "choosePdfFile"));
    return;
  }
  uploadFile(file);
}

/** Uploads with XMLHttpRequest because fetch() cannot report upload progress. */
function uploadFile(file) {
  const { sessionId, presenterToken } = state.session;
  const form = new FormData();
  form.append("pdf", file);

  const office = isOfficeFile(file);
  dom.uploadProgress.hidden = false;
  dom.progressFill.style.width = "0%";
  dom.progressLabel.textContent = t("uploading");
  dom.uploadZone.classList.add("busy");

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload/${sessionId}`);
  xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
  xhr.setRequestHeader("X-Presenter-Token", presenterToken);
  xhr.responseType = "json";

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * (office ? 60 : 90));
    dom.progressFill.style.width = `${pct}%`;
    dom.progressLabel.textContent = t("uploadingPct", { pct });
  };
  // PowerPoint files are converted after the upload, which can take a while.
  xhr.upload.onload = () => {
    if (!office) return;
    dom.progressFill.style.width = "75%";
    dom.progressFill.classList.add("indeterminate");
    dom.progressLabel.textContent = t("converting");
  };

  const fail = (message) => {
    dom.progressFill.classList.remove("indeterminate");
    dom.uploadZone.classList.remove("busy");
    dom.uploadProgress.hidden = true;
    dom.fileInput.value = "";
    toast(message);
  };

  xhr.onload = async () => {
    const body = xhr.response || {};
    if (xhr.status !== 201) return fail(t("uploadFailed", { reason: body.error || `HTTP ${xhr.status}` }));
    dom.progressFill.classList.remove("indeterminate");
    dom.progressFill.style.width = "100%";
    dom.progressLabel.textContent = t("openingPdf");
    if (dom.rememberDecks.checked) saveDeck(file);
    await loadPdf(body.pdf, 1);
    dom.uploadZone.classList.remove("busy");
  };
  xhr.onerror = () => fail(t("uploadNetworkError"));
  xhr.send(form);
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

/**
 * Opens a PDF and shows the given slide.
 * @param {{ url: string, name: string }} pdf
 * @param {number} slide
 */
async function loadPdf(pdf, slide) {
  try {
    const doc = await openDocument(pdf.url);
    renderer.setDocument(doc);
    state.doc = doc;
    state.totalSlides = doc.numPages;
    state.currentSlide = Math.min(Math.max(1, slide), doc.numPages);

    setSetupMode("hidden");
    dom.uploadProgress.hidden = true;
    dom.fileInput.value = "";
    dom.changePdfBtn.hidden = false;

    await renderer.show(state.currentSlide);
    updateCounter();
    buildThumbnailStrip(doc);
    syncTotalSlides();
    dom.drawToolbar.hidden = false;
    state.effect = { mode: "none", x: 0.5, y: 0.5, zoom: 1 };
    fetchAnnotations();
    toast(`${pdf.name} — ${t("slideCount", { count: doc.numPages })}`);
  } catch (err) {
    console.error("[presenter] PDF load failed", err);
    toast(t("pdfOpenFailed", { reason: err.message }));
    dom.uploadProgress.hidden = true;
    setSetupMode(state.doc ? "hidden" : "upload");
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

/** Changes slide locally and tells the server. */
function goToSlide(slide) {
  if (!state.doc) return;
  const target = Math.min(Math.max(1, slide), state.totalSlides);
  if (target === state.currentSlide) return;
  showSlide(target, { animate: true });
  if (state.joined) request(state.socket, "slide-change", { slide: target });
}

/** Shows a slide without notifying the server (used for remote-driven changes). */
function showSlide(slide, { animate = false } = {}) {
  state.currentSlide = Math.min(Math.max(1, slide), state.totalSlides || slide);
  if (animate) {
    dom.transition.classList.add("flash");
    setTimeout(() => dom.transition.classList.remove("flash"), 180);
  }
  updateCounter();
  renderer.show(state.currentSlide);
  fetchAnnotations();
}

const nextSlide = () => goToSlide(state.currentSlide + 1);
const prevSlide = () => goToSlide(state.currentSlide - 1);

function updateCounter() {
  dom.slideCounter.textContent = state.totalSlides ? `${state.currentSlide} / ${state.totalSlides}` : "— / —";
  dom.prevBtn.disabled = state.currentSlide <= 1;
  dom.nextBtn.disabled = state.currentSlide >= state.totalSlides;
  highlightThumbnail();
}

// ─── Thumbnails ───────────────────────────────────────────────────────────────

let thumbObserver = null;

/** Builds the strip; thumbnails render lazily when scrolled into view. */
function buildThumbnailStrip(doc) {
  thumbObserver?.disconnect();
  dom.slideStrip.replaceChildren();

  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        const canvas = entry.target.querySelector("canvas");
        renderThumbnail(doc, Number(entry.target.dataset.page), canvas, THUMB_HEIGHT_PX).catch(() => {});
      }
    },
    { root: dom.slideStrip, rootMargin: "0px 300px" },
  );

  const fragment = document.createDocumentFragment();
  for (let page = 1; page <= doc.numPages; page++) {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "strip-thumb";
    thumb.dataset.page = String(page);
    thumb.title = t("slideN", { n: page });
    thumb.setAttribute("aria-label", t("goToSlide", { n: page }));
    thumb.appendChild(document.createElement("canvas"));
    fragment.appendChild(thumb);
    thumbObserver.observe(thumb);
  }
  dom.slideStrip.appendChild(fragment);
  highlightThumbnail();
}

function highlightThumbnail() {
  const previous = dom.slideStrip.querySelector(".strip-thumb.active");
  const current = dom.slideStrip.querySelector(`.strip-thumb[data-page="${state.currentSlide}"]`);
  if (previous === current) return;
  previous?.classList.remove("active");
  if (!current) return;
  current.classList.add("active");
  current.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
}

// ─── PDF links ────────────────────────────────────────────────────────────────

/** Overlays clickable areas for the page's link annotations. */
async function renderLinkLayer(page) {
  const paintId = ++state.paintId;
  let annotations = [];
  try {
    annotations = await page.getAnnotations({ intent: "display" });
  } catch {
    /* annotations are optional */
  }
  if (paintId !== state.paintId) return;

  const base = page.getViewport({ scale: 1 });
  const links = [];
  for (const annotation of annotations) {
    if (annotation.subtype !== "Link") continue;
    const [x1, y1, x2, y2] = base.convertToViewportRectangle(annotation.rect);
    const link = document.createElement("a");
    link.className = "pdf-link";
    link.style.left = `${(Math.min(x1, x2) / base.width) * 100}%`;
    link.style.top = `${(Math.min(y1, y2) / base.height) * 100}%`;
    link.style.width = `${(Math.abs(x2 - x1) / base.width) * 100}%`;
    link.style.height = `${(Math.abs(y2 - y1) / base.height) * 100}%`;

    if (annotation.url) {
      let url;
      try {
        url = new URL(annotation.url);
      } catch {
        continue;
      }
      if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) continue;
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = url.href;
    } else if (annotation.dest) {
      link.href = "#";
      link.title = t("goToLinkedSlide");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        followInternalLink(annotation.dest);
      });
    } else {
      continue;
    }
    link.addEventListener("click", (e) => e.stopPropagation());
    links.push(link);
  }
  dom.linkLayer.replaceChildren(...links);
}

/** Navigates to the page targeted by an internal PDF link. */
async function followInternalLink(dest) {
  try {
    const explicit = typeof dest === "string" ? await state.doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return;
    const pageIndex = await state.doc.getPageIndex(explicit[0]);
    goToSlide(pageIndex + 1);
  } catch {
    /* broken destination */
  }
}

// ─── Share modals ─────────────────────────────────────────────────────────────

/** Builds a share URL, replacing the host with the configured LAN IP if any. */
function shareUrl(kind) {
  const base = kind === "viewer" ? state.session?.viewerUrl : state.session?.remoteUrl;
  if (!base) return "";
  const url = new URL(base);
  const ip = local.get(IP_KEY);
  if (ip) url.hostname = ip;
  if (kind === "viewer") url.searchParams.set("orient", state.orientation);
  return url.toString();
}

function refreshShareCodes() {
  const remoteUrl = shareUrl("remote");
  dom.remoteUrlDisplay.textContent = remoteUrl || "—";
  if (!dom.remoteModal.hidden) drawQr(dom.qrCanvas, remoteUrl);

  const viewerUrl = shareUrl("viewer");
  dom.viewerUrlDisplay.textContent = viewerUrl || "—";
  if (!dom.viewerModal.hidden) drawQr(dom.viewerQrCanvas, viewerUrl);
}

function openModal(modal) {
  modal.hidden = false;
  refreshShareCodes();
  modal.querySelector(".modal-close")?.focus();
}

function closeModals() {
  dom.remoteModal.hidden = true;
  dom.viewerModal.hidden = true;
  dom.pollModal.hidden = true;
}

const anyModalOpen = () => !dom.remoteModal.hidden || !dom.viewerModal.hidden || !dom.pollModal.hidden;

async function openRemoteModal() {
  const savedIp = local.get(IP_KEY);
  dom.ipInput.value = savedIp || "";
  openModal(dom.remoteModal);
  if (savedIp || !state.session) return;

  // Suggest the machine's LAN address so phones can reach the server.
  const { ok, data } = await api(`/api/session/${state.session.sessionId}/network`, {
    headers: { "X-Presenter-Token": state.session.presenterToken },
  });
  if (!ok || !data.addresses?.length) return;
  dom.ipInput.value = data.addresses[0].address;
  if (data.addresses.length > 1) {
    dom.ipSelector.replaceChildren(
      ...data.addresses.map(({ address, interface: name }) => new Option(`${address} (${name})`, address)),
    );
    dom.ipSelector.hidden = false;
    dom.ipNote.textContent = t("ipSeveral");
  } else {
    dom.ipNote.textContent = t("ipDetected");
  }
  dom.ipNote.style.color = "var(--text-3)";
}

function applyIp() {
  const ip = dom.ipInput.value.trim();
  if (ip && !/^[A-Za-z0-9.-]{1,253}$|^\[?[0-9a-fA-F:]+\]?$/.test(ip)) {
    dom.ipNote.textContent = t("ipInvalid");
    dom.ipNote.style.color = "var(--danger)";
    return;
  }
  if (ip) local.set(IP_KEY, ip);
  else local.remove(IP_KEY);
  refreshShareCodes();
  dom.ipNote.textContent = ip ? t("ipApplied", { ip }) : t("ipBrowserBar");
  dom.ipNote.style.color = ip ? "var(--success)" : "var(--text-3)";
}

function setOrientation(orientation) {
  state.orientation = orientation;
  local.set(ORIENTATION_KEY, orientation);
  dom.orientLandscape.classList.toggle("active", orientation === "landscape");
  dom.orientPortrait.classList.toggle("active", orientation === "portrait");
  dom.orientLandscape.setAttribute("aria-pressed", String(orientation === "landscape"));
  dom.orientPortrait.setAttribute("aria-pressed", String(orientation === "portrait"));
  refreshShareCodes();
}

async function copyShareUrl(kind) {
  const url = shareUrl(kind);
  if (!url) return;
  toast((await copyText(url)) ? t("linkCopied") : t("copyFailed"));
}

// ─── Fullscreen & resizing ────────────────────────────────────────────────────

function toggleFullscreen() {
  if (fullscreenElement()) exitFullscreen();
  else enterFullscreen(document.documentElement);
}

onFullscreenChange(() => {
  const active = Boolean(fullscreenElement());
  dom.fullscreenBtn.innerHTML = active ? icons.exitFullscreen : icons.enterFullscreen;
  dom.topbar.classList.toggle("hidden", active);
  dom.slideStrip.classList.toggle("fs-hidden", active);
  dom.slideWrapper.classList.toggle("fs-mode", active);
});

// ─── Drawing ──────────────────────────────────────────────────────────────────

async function fetchAnnotations() {
  const slide = state.currentSlide;
  ink.setSlide(slide, []);
  if (!state.joined || !state.doc) return;
  const res = await request(state.socket, "get-annotations", { slide });
  if (res.ok && slide === state.currentSlide) ink.setSlide(slide, res.strokes);
}

/** Selects a drawing tool; selecting the active one again turns drawing off. */
function setTool(tool) {
  state.tool = tool === state.tool ? null : tool;
  for (const button of dom.drawTools) button.classList.toggle("active", button.dataset.tool === state.tool);
  dom.slideWrapper.classList.toggle("drawing", Boolean(state.tool));
  ink.setInput(
    state.tool
      ? { tool: state.tool, color: state.color, onChunk: (chunk) => state.joined && state.socket.emit("draw-stroke", chunk) }
      : null,
  );
}

function buildDrawToolbar() {
  for (const button of dom.drawTools) button.innerHTML = icons[button.dataset.tool];
  dom.drawUndo.innerHTML = icons.undo;
  dom.drawClear.innerHTML = icons.trash;
  dom.drawColors.replaceChildren(
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

function setColor(color) {
  state.color = color;
  local.set(COLOR_KEY, color);
  for (const swatch of dom.drawColors.children) swatch.classList.toggle("active", swatch.dataset.color === color);
  if (state.tool) {
    const tool = state.tool;
    state.tool = null;
    setTool(tool);
  } else {
    setTool("pen");
  }
}

async function undoStroke() {
  if (!state.joined || !state.doc) return;
  const res = await request(state.socket, "draw-undo", { slide: state.currentSlide });
  if (res.ok && res.id) ink.removeStroke(state.currentSlide, res.id);
}

async function clearSlide() {
  if (!state.joined || !state.doc) return;
  const res = await request(state.socket, "draw-clear", { slide: state.currentSlide });
  if (res.ok) ink.clear(state.currentSlide);
}

// ─── Polls ────────────────────────────────────────────────────────────────────

function showPoll(poll) {
  if (poll?.id !== state.poll?.id) state.pollHidden = false;
  state.poll = poll || null;
  dom.pollOverlay.hidden = !poll || state.pollHidden;
  dom.pollBtn.classList.toggle("active", Boolean(poll));
  if (!poll) return;
  renderPoll(dom.pollOverlayBody, poll);
  dom.pollCloseBtn.hidden = !poll.open;
}

function openPollModal() {
  if (state.poll) {
    // A poll is running: the button brings its results back on screen.
    state.pollHidden = false;
    showPoll(state.poll);
    return;
  }
  dom.pollModal.hidden = false;
  dom.pollQuestion.focus();
}

async function startPoll() {
  const question = dom.pollQuestion.value.trim();
  const options = dom.pollOptions.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!question) return toast(t("pollNeedsQuestion"));
  if (options.length < 2 || options.length > 6) return toast(t("pollNeedsOptions"));
  if (!state.joined) return toast(t("notConnected"));
  const res = await request(state.socket, "poll-start", { question, options });
  if (!res.ok) return toast(res.message);
  dom.pollQuestion.value = "";
  dom.pollOptions.value = "";
  closeModals();
  showPoll(res.poll);
}

async function pollCommand(event) {
  if (!state.joined) return;
  const res = await request(state.socket, event);
  if (!res.ok) toast(res.message);
}

// ─── Downloads ────────────────────────────────────────────────────────────────

async function setDownload(enabled) {
  if (!state.joined) {
    dom.allowDownloadToggle.checked = !enabled;
    return toast(t("notConnected"));
  }
  const res = await request(state.socket, "set-download", { enabled });
  if (!res.ok) {
    dom.allowDownloadToggle.checked = !enabled;
    return toast(res.message);
  }
  toast(enabled ? t("downloadOn") : t("downloadOff"));
}

// ─── Library (recent files in this browser) ──────────────────────────────────

async function renderLibrary() {
  const decks = await listDecks();
  const usable = decks.filter((deck) => state.formats.includes(extensionOf(deck.name)) || deck.type === "application/pdf");
  dom.librarySection.hidden = !usable.length || (dom.setupOverlay.dataset.mode !== "upload" && dom.setupOverlay.dataset.mode !== "swap");
  const dateFormat = new Intl.DateTimeFormat(currentLang() === "ar" ? "ar-u-nu-latn" : "en", { dateStyle: "medium" });
  dom.libraryList.replaceChildren(
    ...usable.map((deck) => {
      const item = document.createElement("li");
      item.className = "library-item";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "library-open";
      open.dataset.id = deck.id;
      const name = document.createElement("span");
      name.className = "library-name";
      name.textContent = deck.name;
      name.dir = "auto";
      const meta = document.createElement("span");
      meta.className = "library-meta";
      meta.textContent = `${formatBytes(deck.size)} · ${dateFormat.format(deck.usedAt)}`;
      open.append(name, meta);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "library-remove";
      remove.dataset.remove = deck.id;
      remove.innerHTML = icons.cross;
      remove.title = t("removeFromLibrary");
      remove.setAttribute("aria-label", t("removeFromLibrary"));
      item.append(open, remove);
      return item;
    }),
  );
}

async function openFromLibrary(id) {
  const file = await getDeckFile(id);
  if (!file) {
    toast(t("libraryMissing"));
    await removeDeck(id);
    renderLibrary();
    return;
  }
  handleFile(file);
}

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.doc) renderer.refresh();
  }, 120);
}).observe(dom.slideArea);

// ─── Likes ────────────────────────────────────────────────────────────────────

let hasLiked = false;

function paintLikes({ count, hasLiked: liked }) {
  hasLiked = Boolean(liked);
  dom.likeCount.textContent = String(count);
  dom.likeBtn.classList.toggle("liked", hasLiked);
  dom.likeBtn.setAttribute("aria-pressed", String(hasLiked));
}

async function loadLikes() {
  const { ok, data } = await api(`/api/likes?deviceId=${encodeURIComponent(getDeviceId())}`);
  if (ok) paintLikes(data);
}

async function toggleLike() {
  dom.likeBtn.disabled = true;
  const { ok, data } = await api("/api/likes", {
    method: "POST",
    body: { deviceId: getDeviceId(), liked: !hasLiked },
  });
  dom.likeBtn.disabled = false;
  if (ok) paintLikes(data);
  else toast(data.error || "Could not save your like");
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

bindThemeToggles(dom.themeToggle, dom.setupThemeToggle);
bindLangToggles($("langToggle"), $("setupLangToggle"));
onLangChange(() => {
  paintSetupCopy();
  updatePresence();
  renderApprovalDialog();
  paintRemoteRequestsButton();
  if (state.poll) showPoll(state.poll);
  if (state.session) showSessionName(dom.sessionName.textContent);
  if (!dom.librarySection.hidden) renderLibrary();
});
setupPwa($("installBtn"));
buildDrawToolbar();

dom.rememberDecks.checked = local.get(REMEMBER_KEY) !== "0";
dom.rememberDecks.addEventListener("change", () => local.set(REMEMBER_KEY, dom.rememberDecks.checked ? "1" : "0"));
dom.libraryList.addEventListener("click", async (e) => {
  const remove = e.target.closest("[data-remove]");
  if (remove) {
    await removeDeck(remove.dataset.remove);
    renderLibrary();
    return;
  }
  const open = e.target.closest(".library-open");
  if (open && !dom.uploadZone.classList.contains("busy")) openFromLibrary(open.dataset.id);
});

for (const button of dom.drawTools) button.addEventListener("click", () => setTool(button.dataset.tool));
dom.drawColors.addEventListener("click", (e) => {
  const swatch = e.target.closest(".color-swatch");
  if (swatch) setColor(swatch.dataset.color);
});
dom.drawUndo.addEventListener("click", undoStroke);
dom.drawClear.addEventListener("click", clearSlide);

dom.pollBtn.addEventListener("click", openPollModal);
dom.pollStartBtn.addEventListener("click", startPoll);
dom.pollCloseBtn.addEventListener("click", () => pollCommand("poll-close"));
dom.pollClearBtn.addEventListener("click", () => pollCommand("poll-clear"));
dom.pollHideBtn.addEventListener("click", () => {
  state.pollHidden = true;
  showPoll(state.poll);
});
dom.allowDownloadToggle.addEventListener("change", () => setDownload(dom.allowDownloadToggle.checked));

dom.startSessionBtn.addEventListener("click", startSession);
for (const input of [dom.sessionNameInput, dom.sessionPasswordInput]) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startSession();
  });
}
dom.togglePasswordBtn.addEventListener("click", () => {
  const show = dom.sessionPasswordInput.type === "password";
  dom.sessionPasswordInput.type = show ? "text" : "password";
  dom.togglePasswordBtn.innerHTML = show ? icons.eyeOff : icons.eye;
  dom.togglePasswordBtn.title = show ? t("hidePassword") : t("showPassword");
});

// Upload zone: click, keyboard, drag & drop.
dom.uploadZone.addEventListener("click", (e) => {
  if (e.target.closest("label") || e.target === dom.fileInput) return;
  dom.fileInput.click();
});
dom.uploadZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    dom.fileInput.click();
  }
});
dom.uploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dom.uploadZone.classList.add("drag-over");
});
dom.uploadZone.addEventListener("dragleave", () => dom.uploadZone.classList.remove("drag-over"));
dom.uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dom.uploadZone.classList.remove("drag-over");
  handleFile(e.dataTransfer.files[0]);
});
dom.fileInput.addEventListener("change", () => handleFile(dom.fileInput.files[0]));
dom.swapCancelBtn.addEventListener("click", () => setSetupMode("hidden"));
dom.changePdfBtn.addEventListener("click", () => setSetupMode("swap"));

dom.likeBtn.addEventListener("click", toggleLike);

// Top bar.
dom.fullscreenBtn.addEventListener("click", toggleFullscreen);
dom.endSessionBtn.addEventListener("click", endSession);
dom.sessionName.addEventListener("click", renameSession);
dom.showRemoteBtn.addEventListener("click", openRemoteModal);
dom.showViewerBtn.addEventListener("click", () => {
  setOrientation(state.orientation);
  openModal(dom.viewerModal);
});

// Modals.
for (const modal of [dom.remoteModal, dom.viewerModal, dom.pollModal]) {
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest(".modal-close")) closeModals();
  });
}
dom.applyIpBtn.addEventListener("click", applyIp);
dom.ipInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyIp();
});
dom.ipSelector.addEventListener("change", () => {
  dom.ipInput.value = dom.ipSelector.value;
});
dom.copyRemoteUrlBtn.addEventListener("click", () => copyShareUrl("remote"));
dom.copyViewerUrlBtn.addEventListener("click", () => copyShareUrl("viewer"));
dom.toggleRemoteRequestsBtn.addEventListener("click", toggleRemoteRequests);
dom.orientLandscape.addEventListener("click", () => setOrientation("landscape"));
dom.orientPortrait.addEventListener("click", () => setOrientation("portrait"));

// Approval dialog.
dom.approveBtn.addEventListener("click", () => answerPending("remote-accept"));
dom.rejectBtn.addEventListener("click", () => answerPending("remote-reject"));
dom.blockBtn.addEventListener("click", () => answerPending("remote-block"));
dom.dismissApprovalBtn.addEventListener("click", () => {
  dom.approvalDialog.hidden = true;
});

// Slide navigation.
dom.prevBtn.addEventListener("click", prevSlide);
dom.nextBtn.addEventListener("click", nextSlide);
dom.canvas.addEventListener("click", nextSlide);
dom.slideStrip.addEventListener("click", (e) => {
  const thumb = e.target.closest(".strip-thumb");
  if (thumb) goToSlide(Number(thumb.dataset.page));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (anyModalOpen()) closeModals();
    else if (dom.setupOverlay.dataset.mode === "swap") setSetupMode("hidden");
    else if (state.tool) setTool(state.tool);
    return;
  }
  if (isTyping(e.target) || anyModalOpen() || !dom.setupOverlay.classList.contains("hide")) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoStroke();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
      e.preventDefault();
      nextSlide();
      break;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      e.preventDefault();
      prevSlide();
      break;
    case "Home":
      e.preventDefault();
      goToSlide(1);
      break;
    case "End":
      e.preventDefault();
      goToSlide(state.totalSlides);
      break;
    case "f":
    case "F":
      toggleFullscreen();
      break;
    case "p":
    case "P":
      setTool("pen");
      break;
    case "h":
    case "H":
      setTool("highlighter");
      break;
  }
});

let touchStartX = null;
dom.slideArea.addEventListener(
  "touchstart",
  (e) => {
    touchStartX = e.touches.length === 1 && !state.tool ? e.touches[0].clientX : null;
  },
  { passive: true },
);
dom.slideArea.addEventListener(
  "touchend",
  (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX) (dx < 0 ? nextSlide : prevSlide)();
  },
  { passive: true },
);

// ─── Boot ─────────────────────────────────────────────────────────────────────

startDhikr({ isSuppressed: () => Boolean(fullscreenElement()) });
loadLikes();
loadCapabilities();
setOrientation(state.orientation);
if (!(await restoreSession())) setSetupMode("create");
