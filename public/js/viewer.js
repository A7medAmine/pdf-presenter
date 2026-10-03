/**
 * PDF Presenter — viewer page (read-only audience).
 *
 * Joins a session (with a password when required), mirrors the presenter's
 * slide in real time, shows the remote pointer and recovers automatically
 * from network drops and mid-session PDF swaps.
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
} from "./lib/common.js";
import { openDocument, SlideRenderer } from "./lib/pdf-renderer.js";
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
  cursor: $("remoteCursor"),
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
  currentSlide: 1,
  totalSlides: 0,
  pdfUrl: null,
  /** Increments per PDF load so a slow, outdated load never wins. */
  loadId: 0,
  hasDoc: false,
};

document.body.classList.add(`orient-${state.orientation}`);

const renderer = new SlideRenderer(dom.canvas, {
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
  },
});

// ─── Viewer token (password-protected sessions) ───────────────────────────────

const tokenKey = (sessionId) => `viewer-token-${sessionId}`;

// ─── Connection flow ──────────────────────────────────────────────────────────

/** Validates the entered ID, checks for a password and joins. */
async function connect() {
  const sessionId = normalizeSessionId(dom.sessionInput.value);
  dom.sessionInput.value = sessionId;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    setStatus(dom.hint, { icon: icons.warning, text: "Enter the 16-character session ID", color: "var(--danger)" });
    return;
  }

  state.sessionId = sessionId;
  state.viewerToken = sessionStore.get(tokenKey(sessionId));
  setStatus(dom.hint, { text: "Checking session…", color: "var(--text-3)" });
  dom.connectBtn.disabled = true;

  const { ok, status, data } = await api(`/api/session/${sessionId}/requires-password`);
  dom.connectBtn.disabled = false;
  if (!ok) {
    const text = status === 404 ? "Session not found — check the ID" : data.error || "Connection failed";
    setStatus(dom.hint, { icon: icons.warning, text, color: "var(--danger)" });
    return;
  }

  if (data.requiresPassword && !state.viewerToken) {
    askForPassword();
    return;
  }
  openSocket();
}

function askForPassword(message = "This session requires a password") {
  dom.passwordRow.hidden = false;
  dom.passwordInput.value = "";
  dom.passwordInput.focus();
  setStatus(dom.hint, { icon: icons.lock, text: message, color: "var(--warning)" });
}

async function verifyPassword() {
  const password = dom.passwordInput.value;
  if (!password) {
    setStatus(dom.hint, { icon: icons.warning, text: "Enter the password", color: "var(--danger)" });
    return;
  }

  dom.passwordBtn.disabled = true;
  setStatus(dom.hint, { text: "Verifying…", color: "var(--text-3)" });
  const { ok, data } = await api(`/api/session/${state.sessionId}/verify-password`, {
    method: "POST",
    body: { password },
  });
  dom.passwordBtn.disabled = false;

  if (!ok || !data.valid) {
    setStatus(dom.hint, { icon: icons.cross, text: data.error || "Invalid password", color: "var(--danger)" });
    dom.passwordInput.select();
    return;
  }

  state.viewerToken = data.viewerToken;
  if (data.viewerToken) sessionStore.set(tokenKey(state.sessionId), data.viewerToken);
  dom.passwordRow.hidden = true;
  setStatus(dom.hint, { icon: icons.check, text: "Access granted", color: "var(--success)" });
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
      askForPassword("Password required");
    } else if (res.code === "SESSION_NOT_FOUND") {
      setStatus(dom.hint, { icon: icons.warning, text: "This session has ended", color: "var(--danger)" });
    } else {
      setStatus(dom.hint, { icon: icons.warning, text: res.message || "Could not join", color: "var(--danger)" });
    }
  });

  socket.on("disconnect", (reason) => {
    setLive(false);
    if (reason !== "io client disconnect") dom.reconnecting.hidden = dom.viewer.hidden;
  });

  socket.on("slide-update", ({ currentSlide }) => {
    if (currentSlide === state.currentSlide) return;
    state.currentSlide = currentSlide;
    updateCounter();
    flashSlideChange();
    if (state.hasDoc) renderer.show(currentSlide);
  });

  socket.on("total-slides-update", ({ totalSlides, currentSlide }) => {
    state.totalSlides = totalSlides;
    if (currentSlide !== state.currentSlide) {
      state.currentSlide = currentSlide;
      if (state.hasDoc) renderer.show(currentSlide);
    }
    updateCounter();
  });

  socket.on("pdf-loaded", ({ pdf, currentSlide, totalSlides }) => {
    state.currentSlide = currentSlide;
    state.totalSlides = totalSlides;
    showSwapBanner(pdf.name);
    loadPdf(pdf.url);
  });

  socket.on("presence", ({ viewerCount }) => updateViewerCount(viewerCount));
  socket.on("presenter-status", ({ online }) => {
    dom.presenterOffline.hidden = online;
  });
  socket.on("session-renamed", ({ name }) => showSessionName(name));
  socket.on("cursor-move", moveCursor);

  socket.on("session-ended", ({ message }) => {
    socket.disconnect();
    toast(message || "Session ended", { duration: 4000 });
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
  state.currentSlide = snapshot.currentSlide;
  state.totalSlides = snapshot.totalSlides;
  updateCounter();

  if (!snapshot.pdf) {
    state.pdfUrl = null;
    dom.waiting.hidden = false;
    dom.loading.hidden = true;
    return;
  }
  dom.waiting.hidden = true;
  if (snapshot.pdf.url !== state.pdfUrl || !state.hasDoc) loadPdf(snapshot.pdf.url);
  else renderer.show(state.currentSlide);
}

async function loadPdf(url) {
  const loadId = ++state.loadId;
  state.pdfUrl = url;
  state.hasDoc = false;
  dom.waiting.hidden = true;
  dom.error.hidden = true;
  dom.loading.hidden = false;

  try {
    const doc = await openDocument(url);
    if (loadId !== state.loadId) {
      doc.destroy();
      return;
    }
    renderer.setDocument(doc);
    state.hasDoc = true;
    state.totalSlides = doc.numPages;
    updateCounter();
    await renderer.show(state.currentSlide);
  } catch (err) {
    if (loadId !== state.loadId) return;
    console.error("[viewer] PDF load failed", err);
    dom.loading.hidden = true;
    dom.error.hidden = false;
    dom.errorText.textContent = `Could not load the PDF: ${err.message || "unknown error"}`;
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
  dom.status.textContent = online ? "● Live" : "○ Offline";
}

function showSessionName(name) {
  dom.sessionName.textContent = name || "Untitled Session";
  dom.sessionName.hidden = false;
}

function updateViewerCount(count = 0) {
  dom.viewerCount.textContent = `${count} viewer${count === 1 ? "" : "s"}`;
}

function updateCounter() {
  dom.counter.textContent = `${state.currentSlide} / ${state.totalSlides || "—"}`;
}

function moveCursor({ x, y, active }) {
  dom.cursor.classList.toggle("active", Boolean(active));
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
  text.append("Presenter switched to: ");
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
  dom.togglePasswordBtn.title = show ? "Hide password" : "Show password";
});

dom.fullscreenBtn.addEventListener("click", toggleFullscreen);
dom.refreshBtn.addEventListener("click", () => window.location.reload());
dom.reloadBtn.addEventListener("click", () => window.location.reload());
dom.shareBtn.addEventListener("click", openShareModal);
dom.shareModal.addEventListener("click", (e) => {
  if (e.target === dom.shareModal || e.target.closest(".modal-close")) dom.shareModal.hidden = true;
});
dom.copyShareBtn.addEventListener("click", async () => {
  toast((await copyText(shareLink())) ? "Link copied" : "Copy failed — select the link manually");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") dom.shareModal.hidden = true;
});
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
