/**
 * PDF Presenter — viewer page (read-only audience).
 *
 * Joins a session (with a password when required), mirrors the presenter's
 * slide in real time with the pointer, annotations, zoom and spotlight, lets
 * the audience browse earlier slides on their own and vote in live polls, and
 * recovers automatically from network drops and mid-session PDF swaps.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import {
  $,
  api,
  request,
  icons,
  session as sessionStore,
  createToast,
  setStatus,
  normalizeSessionId,
  SESSION_ID_PATTERN,
  copyText,
  drawQr,
  applySavedTheme,
  fullscreenElement,
  enterFullscreen,
  exitFullscreen,
  onFullscreenChange,
  keepScreenAwake,
  getDeviceId,
  isTyping,
  haptic,
  setupPwa,
} from "./lib/common.js";
import { t, bindLangToggles, onLangChange } from "./lib/i18n.js";
import { openDocument, SlideRenderer } from "./lib/pdf-renderer.js";
import { AnnotationLayer } from "./lib/annotations.js";
import { applyEffect } from "./lib/effects.js";
import { renderPoll } from "./lib/poll-view.js";
import { startDhikr } from "./lib/dhikr.js";

applySavedTheme();

// ─── DOM ──────────────────────────────────────────────────────────────────────

const dom = {
  connectScreen: $("viewerConnect"),
  sessionInput: $("sessionInput"),
  connectBtn: $("connectBtn"),
  passwordRow: $("passwordRow"),
  passwordInput: $("passwordInput"),
  passwordBtn: $("passwordBtn"),
  togglePasswordBtn: $("togglePassword"),
  hint: $("vcHint"),

  viewer: $("viewerSlide"),
  sessionName: $("vsSessionName"),
  sessionBadge: $("vsSessionBadge"),
  viewerCount: $("vsViewerCount"),
  status: $("vsStatusDot"),
  shareBtn: $("vsShareBtn"),
  fullscreenBtn: $("vsFullscreenBtn"),
  wrap: $("vsCanvasWrap"),
  canvas: $("viewerCanvas"),
  ink: $("vsInk"),
  zoomLayer: $("vsZoomLayer"),
  spotlight: $("vsSpotlight"),
  cursor: $("remoteCursor"),
  downloadBtn: $("vsDownloadBtn"),
  prevBtn: $("vsPrevBtn"),
  nextBtn: $("vsNextBtn"),
  liveBtn: $("vsLiveBtn"),
  poll: $("vsPoll"),
  pollBody: $("vsPollBody"),
  pollToggle: $("vsPollToggle"),
  pollReopen: $("vsPollReopen"),
  waiting: $("vsWaiting"),
  refreshBtn: $("vsRefreshBtn"),
  loading: $("vsLoading"),
  error: $("vsError"),
  errorText: $("vsErrorText"),
  counter: $("vsCounter"),
  reconnecting: $("vsReconnecting"),
  reloadBtn: $("vsReloadBtn"),
  presenterOffline: $("vsPresenterOffline"),

  shareModal: $("shareModal"),
  shareQr: $("shareQrCanvas"),
  shareUrl: $("shareUrlDisplay"),
  shareSessionId: $("shareModalSessionId"),
  copyShareBtn: $("copyShareUrlBtn"),
};

const toast = createToast($("toast"));

// ─── State ────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);

const state = {
  sessionId: null,
  viewerToken: null,
  /** @type {import("socket.io-client").Socket | null} */
  socket: null,
  orientation: params.get("orient") === "portrait" ? "portrait" : "landscape",
  /** Slide the presenter is showing. */
  liveSlide: 1,
  /** Slide shown on this screen; differs from liveSlide while browsing. */
  currentSlide: 1,
  following: true,
  totalSlides: 0,
  pdfUrl: null,
  /** Increments per PDF load so a slow, outdated load never wins. */
  loadId: 0,
  hasDoc: false,
  /** @type {{ mode: string, x: number, y: number, zoom: number }} */
  effect: { mode: "none", x: 0.5, y: 0.5, zoom: 1 },
  cursor: { x: 0, y: 0, active: false },
  allowDownload: false,
  poll: null,
  pollHidden: false,
};

document.body.classList.add(`orient-${state.orientation}`);

const renderer = new SlideRenderer(dom.canvas, {
  boost: () => (state.effect.mode === "zoom" ? state.effect.zoom : 1),
  cacheSize: 4,
  fit(pageWidth, pageHeight) {
    const style = getComputedStyle(dom.wrap);
    const width = dom.wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = dom.wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const scale =
      state.orientation === "portrait"
        ? width / pageWidth
        : Math.min(width / pageWidth, height / pageHeight);
    return { width: pageWidth * Math.max(0.01, scale), height: pageHeight * Math.max(0.01, scale) };
  },
  onPaint({ pageNum }) {
    dom.loading.hidden = true;
    renderer.preload(pageNum + 1);
    showEffect(state.effect);
  },
});

const ink = new AnnotationLayer(dom.ink);

// ─── Viewer token (password-protected sessions) ───────────────────────────────

const tokenKey = (sessionId) => `viewer-token-${sessionId}`;

// ─── Connection flow ──────────────────────────────────────────────────────────

/** Validates the entered ID, checks for a password and joins. */
async function connect() {
  const sessionId = normalizeSessionId(dom.sessionInput.value);
  dom.sessionInput.value = sessionId;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    setStatus(dom.hint, { icon: icons.warning, text: t("enterSessionId"), color: "var(--danger)" });
    return;
  }

  state.sessionId = sessionId;
  state.viewerToken = sessionStore.get(tokenKey(sessionId));
  setStatus(dom.hint, { text: t("checkingSession"), color: "var(--text-3)" });
  dom.connectBtn.disabled = true;

  const { ok, status, data } = await api(`/api/session/${sessionId}/requires-password`);
  dom.connectBtn.disabled = false;
  if (!ok) {
    const text = status === 404 ? t("sessionNotFound") : data.error || t("connectionFailed");
    setStatus(dom.hint, { icon: icons.warning, text, color: "var(--danger)" });
    return;
  }

  if (data.requiresPassword && !state.viewerToken) {
    askForPassword();
    return;
  }
  openSocket();
}

function askForPassword(message = t("passwordRequired")) {
  dom.passwordRow.hidden = false;
  dom.passwordInput.value = "";
  dom.passwordInput.focus();
  setStatus(dom.hint, { icon: icons.lock, text: message, color: "var(--warning)" });
}

async function verifyPassword() {
  const password = dom.passwordInput.value;
  if (!password) {
    setStatus(dom.hint, { icon: icons.warning, text: t("enterPassword"), color: "var(--danger)" });
    return;
  }

  dom.passwordBtn.disabled = true;
  setStatus(dom.hint, { text: t("verifying"), color: "var(--text-3)" });
  const { ok, data } = await api(`/api/session/${state.sessionId}/verify-password`, {
    method: "POST",
    body: { password },
  });
  dom.passwordBtn.disabled = false;

  if (!ok || !data.valid) {
    setStatus(dom.hint, { icon: icons.cross, text: data.error || t("invalidPassword"), color: "var(--danger)" });
    dom.passwordInput.select();
    return;
  }

  state.viewerToken = data.viewerToken;
  if (data.viewerToken) sessionStore.set(tokenKey(state.sessionId), data.viewerToken);
  dom.passwordRow.hidden = true;
  setStatus(dom.hint, { icon: icons.check, text: t("accessGranted"), color: "var(--success)" });
  openSocket();
}

/** Opens the socket; it reconnects forever with backoff and re-joins on every connect. */
function openSocket() {
  state.socket?.disconnect();
  const socket = window.io({
    transports: ["websocket", "polling"],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  state.socket = socket;

  socket.on("connect", async () => {
    const res = await request(socket, "join-session", {
      sessionId: state.sessionId,
      role: "viewer",
      viewerToken: state.viewerToken,
      deviceId: getDeviceId(),
    });
    if (res.ok) {
      dom.reconnecting.hidden = true;
      setLive(true);
      applyState(res.state);
      return;
    }

    socket.disconnect();
    showConnectScreen();
    if (res.code === "PASSWORD_REQUIRED") {
      sessionStore.remove(tokenKey(state.sessionId));
      state.viewerToken = null;
      askForPassword(t("passwordRequired"));
    } else if (res.code === "SESSION_NOT_FOUND") {
      setStatus(dom.hint, { icon: icons.warning, text: t("sessionHasEnded"), color: "var(--danger)" });
    } else {
      setStatus(dom.hint, { icon: icons.warning, text: res.message || t("couldNotJoin"), color: "var(--danger)" });
    }
  });

  socket.on("disconnect", (reason) => {
    setLive(false);
    if (reason !== "io client disconnect") dom.reconnecting.hidden = dom.viewer.hidden;
  });

  socket.on("slide-update", ({ currentSlide }) => {
    if (currentSlide === state.liveSlide) return;
    state.liveSlide = currentSlide;
    if (state.following) {
      flashSlideChange();
      showSlide(currentSlide);
    } else {
      updateCounter();
    }
  });

  socket.on("total-slides-update", ({ totalSlides, currentSlide }) => {
    state.totalSlides = totalSlides;
    state.liveSlide = currentSlide;
    if (state.following && currentSlide !== state.currentSlide) showSlide(currentSlide);
    else updateCounter();
  });

  socket.on("pdf-loaded", ({ pdf, currentSlide, totalSlides }) => {
    state.liveSlide = currentSlide;
    state.currentSlide = currentSlide;
    state.following = true;
    state.totalSlides = totalSlides;
    state.effect = { mode: "none", x: 0.5, y: 0.5, zoom: 1 };
    showSwapBanner(pdf.name);
    loadPdf(pdf.url);
  });

  socket.on("draw-stroke", (chunk) => ink.applyChunk(chunk));
  socket.on("draw-undo", ({ slide, id }) => ink.removeStroke(slide, id));
  socket.on("draw-clear", ({ slide }) => ink.clear(slide));
  socket.on("view-effect", (effect) => {
    const rerender = (effect.mode === "zoom" ? effect.zoom : 1) !== (state.effect.mode === "zoom" ? state.effect.zoom : 1);
    state.effect = effect;
    showEffect(effect);
    if (rerender && state.hasDoc) renderer.show(state.currentSlide); // sharper pixels for the new zoom level
  });
  socket.on("poll-update", ({ poll }) => showPoll(poll));
  socket.on("download-update", ({ enabled }) => {
    state.allowDownload = enabled;
    updateDownload();
    if (enabled) toast(t("downloadEnabled"));
  });

  socket.on("presence", ({ viewerCount }) => updateViewerCount(viewerCount));
  socket.on("presenter-status", ({ online }) => {
    dom.presenterOffline.hidden = online;
  });
  socket.on("session-renamed", ({ name }) => showSessionName(name));
  socket.on("cursor-move", moveCursor);

  socket.on("session-ended", ({ message }) => {
    socket.disconnect();
    toast(message || t("sessionEnded"), { duration: 4000 });
    setTimeout(() => {
      window.location.href = "/access.html";
    }, 3000);
  });
}

/** Applies a full session snapshot (initial join and every reconnect). */
function applyState(snapshot) {
  showViewer();
  showSessionName(snapshot.name);
  updateViewerCount(snapshot.viewerCount);
  dom.presenterOffline.hidden = snapshot.presenterOnline;
  state.liveSlide = snapshot.currentSlide;
  if (state.following || snapshot.pdf?.url !== state.pdfUrl) {
    state.following = true;
    state.currentSlide = snapshot.currentSlide;
  }
  state.totalSlides = snapshot.totalSlides;
  state.effect = snapshot.effect || state.effect;
  state.allowDownload = Boolean(snapshot.allowDownload);
  updateCounter();
  showPoll(snapshot.poll);

  if (!snapshot.pdf) {
    state.pdfUrl = null;
    dom.waiting.hidden = false;
    dom.loading.hidden = true;
    return;
  }
  dom.waiting.hidden = true;
  if (snapshot.pdf.url !== state.pdfUrl || !state.hasDoc) loadPdf(snapshot.pdf.url);
  else showSlide(state.currentSlide);
}

/** Shows a slide on this screen with its annotations. */
function showSlide(slide) {
  state.currentSlide = slide;
  updateCounter();
  if (!state.hasDoc) return;
  renderer.show(slide);
  fetchAnnotations();
  showEffect(state.effect);
}

async function fetchAnnotations() {
  const slide = state.currentSlide;
  ink.setSlide(slide, []);
  if (!state.socket?.connected) return;
  const res = await request(state.socket, "get-annotations", { slide });
  if (res.ok && slide === state.currentSlide) ink.setSlide(slide, res.strokes);
}

// ─── Free browsing ────────────────────────────────────────────────────────────

/** Moves this screen only; reaching the live slide resumes following. */
function browse(delta) {
  if (!state.hasDoc) return;
  const target = Math.min(Math.max(1, state.currentSlide + delta), state.totalSlides || 1);
  if (target === state.currentSlide) return;
  haptic(8);
  state.following = target === state.liveSlide;
  showSlide(target);
}

function backToLive() {
  state.following = true;
  haptic(12);
  flashSlideChange();
  showSlide(state.liveSlide);
}

// ─── Effects, pointer, polls, download ───────────────────────────────────────

/** Zoom, spotlight and the pointer only make sense on the live slide. */
function showEffect(effect) {
  const onLive = state.currentSlide === state.liveSlide;
  applyEffect(onLive ? effect : null, { layer: dom.zoomLayer, spotlight: dom.spotlight });
  dom.cursor.classList.toggle("active", onLive && state.cursor.active);
}

function showPoll(poll) {
  const previousId = state.poll?.id;
  state.poll = poll || null;
  if (!poll) {
    dom.poll.hidden = true;
    dom.pollReopen.hidden = true;
    return;
  }
  if (poll.id !== previousId) {
    state.pollHidden = false;
    if (poll.open) haptic([15, 40, 15]);
  }
  const myVote = Number(sessionStore.get(`poll-vote-${poll.id}`));
  const voted = Number.isInteger(myVote) && sessionStore.get(`poll-vote-${poll.id}`) !== null;
  renderPoll(dom.pollBody, poll, {
    myVote: voted ? myVote : null,
    onVote: vote,
    showResults: voted || !poll.open,
  });
  dom.poll.hidden = state.pollHidden;
  dom.pollReopen.hidden = !state.pollHidden;
}

async function vote(option) {
  const poll = state.poll;
  if (!poll || !state.socket?.connected) return;
  haptic(15);
  const res = await request(state.socket, "poll-vote", { pollId: poll.id, option });
  if (!res.ok) {
    toast(res.message || t("voteFailed"));
    return;
  }
  sessionStore.set(`poll-vote-${poll.id}`, String(option));
  toast(t("voteRecorded"));
  showPoll(state.poll);
}

function updateDownload() {
  dom.downloadBtn.hidden = !(state.allowDownload && state.pdfUrl);
  if (state.pdfUrl) dom.downloadBtn.href = `${state.pdfUrl}&download=1`;
}

async function loadPdf(url) {
  const loadId = ++state.loadId;
  state.pdfUrl = url;
  state.hasDoc = false;
  dom.waiting.hidden = true;
  dom.error.hidden = true;
  dom.loading.hidden = false;
  updateDownload();

  try {
    const doc = await openDocument(url);
    if (loadId !== state.loadId) {
      doc.destroy();
      return;
    }
    renderer.setDocument(doc);
    state.hasDoc = true;
    state.totalSlides = doc.numPages;
    showSlide(state.currentSlide);
  } catch (err) {
    if (loadId !== state.loadId) return;
    console.error("[viewer] PDF load failed", err);
    dom.loading.hidden = true;
    dom.error.hidden = false;
    dom.errorText.textContent = t("pdfLoadFailed", { reason: err.message || "?" });
  }
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function showConnectScreen() {
  dom.viewer.hidden = true;
  dom.reconnecting.hidden = true;
  dom.connectScreen.hidden = false;
}

function showViewer() {
  if (!dom.viewer.hidden) return;
  dom.connectScreen.hidden = true;
  dom.viewer.hidden = false;
  dom.sessionBadge.textContent = state.sessionId;
  keepScreenAwake();
}

function setLive(online) {
  dom.status.className = `vs-status ${online ? "connected" : "disconnected"}`;
  dom.status.textContent = online ? `● ${t("live")}` : `○ ${t("offline")}`;
}

function showSessionName(name) {
  dom.sessionName.textContent = name || t("untitledSession");
  dom.sessionName.hidden = false;
}

let viewerCount = 0;
function updateViewerCount(count = viewerCount) {
  viewerCount = count;
  dom.viewerCount.textContent = t("viewerCount", { count });
}

function updateCounter() {
  dom.counter.textContent = `${state.currentSlide} / ${state.totalSlides || "—"}`;
  dom.prevBtn.disabled = !state.hasDoc || state.currentSlide <= 1;
  dom.nextBtn.disabled = !state.hasDoc || state.currentSlide >= state.totalSlides;
  const browsing = state.currentSlide !== state.liveSlide;
  dom.liveBtn.hidden = !browsing;
  dom.liveBtn.textContent = t("backToLive", { n: state.liveSlide });
  dom.viewer.classList.toggle("browsing", browsing);
}

function moveCursor({ x, y, active }) {
  state.cursor = { x, y, active: Boolean(active) };
  dom.cursor.classList.toggle("active", Boolean(active) && state.currentSlide === state.liveSlide);
  if (!active) return;
  dom.cursor.style.left = `${x * 100}%`;
  dom.cursor.style.top = `${y * 100}%`;
}

function flashSlideChange() {
  dom.wrap.classList.remove("vs-flash");
  void dom.wrap.offsetWidth; // restart the CSS animation
  dom.wrap.classList.add("vs-flash");
}

function showSwapBanner(filename) {
  document.getElementById("pdfSwapBanner")?.remove();
  const banner = document.createElement("div");
  banner.id = "pdfSwapBanner";
  banner.className = "pdf-swap-banner";
  banner.setAttribute("role", "status");
  banner.innerHTML = icons.swap;
  const text = document.createElement("span");
  text.append(`${t("presenterSwitched")} `);
  const strong = document.createElement("strong");
  strong.textContent = filename;
  text.append(strong);
  banner.append(text);
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add("show"));
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 400);
  }, 4000);
}

// ─── Fullscreen & resize ──────────────────────────────────────────────────────

function toggleFullscreen() {
  if (fullscreenElement()) exitFullscreen();
  else enterFullscreen(dom.viewer);
}

onFullscreenChange(() => {
  const active = Boolean(fullscreenElement());
  dom.viewer.classList.toggle("fs-mode", active);
  dom.fullscreenBtn.innerHTML = active ? icons.exitFullscreen : icons.enterFullscreen;
});

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.hasDoc) renderer.refresh();
  }, 120);
}).observe(dom.wrap);

// ─── Share ────────────────────────────────────────────────────────────────────

function shareLink() {
  const url = new URL("/viewer.html", window.location.origin);
  url.searchParams.set("session", state.sessionId);
  url.searchParams.set("orient", state.orientation);
  return url.toString();
}

function openShareModal() {
  const link = shareLink();
  dom.shareSessionId.textContent = state.sessionId;
  dom.shareUrl.textContent = link;
  dom.shareModal.hidden = false;
  drawQr(dom.shareQr, link);
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

dom.connectBtn.addEventListener("click", connect);
dom.sessionInput.addEventListener("input", () => {
  dom.sessionInput.value = normalizeSessionId(dom.sessionInput.value);
});
dom.sessionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect();
});
dom.passwordBtn.addEventListener("click", verifyPassword);
dom.passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") verifyPassword();
});
dom.togglePasswordBtn.addEventListener("click", () => {
  const show = dom.passwordInput.type === "password";
  dom.passwordInput.type = show ? "text" : "password";
  dom.togglePasswordBtn.innerHTML = show ? icons.eyeOff : icons.eye;
  dom.togglePasswordBtn.title = show ? t("hidePassword") : t("showPassword");
});

dom.fullscreenBtn.addEventListener("click", toggleFullscreen);
dom.refreshBtn.addEventListener("click", () => window.location.reload());
dom.reloadBtn.addEventListener("click", () => window.location.reload());
dom.shareBtn.addEventListener("click", openShareModal);
dom.shareModal.addEventListener("click", (e) => {
  if (e.target === dom.shareModal || e.target.closest(".modal-close")) dom.shareModal.hidden = true;
});
dom.copyShareBtn.addEventListener("click", async () => {
  toast((await copyText(shareLink())) ? t("linkCopied") : t("copyFailed"));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") dom.shareModal.hidden = true;
  if (dom.viewer.hidden || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "ArrowLeft" || e.key === "PageUp") browse(-1);
  else if (e.key === "ArrowRight" || e.key === "PageDown") browse(1);
  else if (e.key === "l" || e.key === "L" || e.key === "End") backToLive();
});

dom.prevBtn.addEventListener("click", () => browse(-1));
dom.nextBtn.addEventListener("click", () => browse(1));
dom.liveBtn.addEventListener("click", backToLive);
dom.pollToggle.addEventListener("click", () => {
  state.pollHidden = true;
  showPoll(state.poll);
});
dom.pollReopen.addEventListener("click", () => {
  state.pollHidden = false;
  showPoll(state.poll);
});

let swipeX = null;
dom.wrap.addEventListener(
  "touchstart",
  (e) => {
    swipeX = e.touches.length === 1 ? e.touches[0].clientX : null;
  },
  { passive: true },
);
dom.wrap.addEventListener(
  "touchend",
  (e) => {
    if (swipeX === null || state.orientation === "portrait") return;
    const dx = e.changedTouches[0].clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) > 50) browse(dx < 0 ? 1 : -1);
  },
  { passive: true },
);

bindLangToggles($("vsLang"), $("vcLang"));
onLangChange(() => {
  updateCounter();
  updateViewerCount();
  setLive(Boolean(state.socket?.connected));
  if (state.poll) showPoll(state.poll);
});
setupPwa();
document.addEventListener("visibilitychange", () => {
  // Some mobile browsers drop canvas contents while in the background.
  if (document.visibilityState === "visible" && state.hasDoc) renderer.refresh();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

startDhikr({ isSuppressed: () => Boolean(fullscreenElement()) });

const initialId = normalizeSessionId(params.get("session"));
if (SESSION_ID_PATTERN.test(initialId)) {
  dom.sessionInput.value = initialId;
  connect();
} else {
  dom.sessionInput.focus();
}
