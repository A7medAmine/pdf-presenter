/**
 * PDF Presenter — remote control page (phone / tablet).
 *
 * Requests control of a session (the presenter approves it once per device),
 * then sends slide commands, a pointer and offers private speaker notes with
 * a teleprompter. Reconnects transparently after network drops.
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
} from "./lib/common.js";

applySavedTheme();

// ─── Constants ────────────────────────────────────────────────────────────────

const NOTES_KEY = "presenter-notes";
const NOTES_FONT_KEY = "presenter-notes-font";
const RETRY_DELAY_MS = 5000;
/** Teleprompter speed is expressed in "units"; one unit scrolls 60 px per second. */
const TP_PX_PER_UNIT_PER_SEC = 60;
const CURSOR_SEND_INTERVAL_MS = 16;

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
  headerFullscreen: $("rcHeaderFullscreen"),
  cursorToggle: $("rcCursorToggle"),
  fullscreen: $("rcFullscreen"),
  disconnect: $("rcDisconnect"),
  panel: $("tabControl"),
  slideBox: $("rcSlideBox"),
  slideNum: $("rcSlideNum"),
  totalSlides: $("rcTotalSlides"),
  prev: $("rcPrev"),
  next: $("rcNext"),
  jumpInput: $("jumpInput"),
  jumpBtn: $("jumpBtn"),

  notes: $("notesArea"),
  notesFontDown: $("notesFontDown"),
  notesFontUp: $("notesFontUp"),
  teleBtn: $("notesTeleBtn"),

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

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  sessionId: null,
  /** @type {import("socket.io-client").Socket | null} */
  socket: null,
  approved: false,
  currentSlide: 1,
  totalSlides: 0,
  retryTimer: null,
  cursorEnabled: false,
};

// ─── Connection ───────────────────────────────────────────────────────────────

function connect() {
  const sessionId = normalizeSessionId(dom.sessionInput.value);
  dom.sessionInput.value = sessionId;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    setStatus(dom.hint, { icon: icons.warning, text: "Enter the 16-character session ID", color: "var(--danger)" });
    return;
  }

  state.sessionId = sessionId;
  state.approved = false;
  setStatus(dom.hint, { text: "Connecting…", color: "var(--text-3)" });
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
    toast("Access granted");
    showPad(snapshot);
  });

  socket.on("remote-rejected", ({ message }) => {
    fail(message || "The presenter declined your request");
  });

  socket.on("slide-update", ({ currentSlide }) => {
    state.currentSlide = currentSlide;
    updateSlideDisplay();
    pulseSlideBox();
  });

  socket.on("total-slides-update", ({ totalSlides, currentSlide }) => {
    state.totalSlides = totalSlides;
    state.currentSlide = currentSlide;
    updateSlideDisplay();
  });

  socket.on("pdf-loaded", ({ pdf, currentSlide, totalSlides }) => {
    state.currentSlide = currentSlide;
    state.totalSlides = totalSlides;
    updateSlideDisplay();
    showSwapBanner(pdf.name);
  });

  socket.on("presenter-status", ({ online }) => {
    if (state.approved) toast(online ? "Presenter is back" : "Presenter disconnected — waiting…");
  });

  socket.on("session-renamed", ({ name }) => showSessionName(name));

  socket.on("session-ended", ({ message }) => {
    state.approved = false;
    socket.disconnect();
    toast(message || "Session ended", { duration: 4000 });
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
    setStatus(dom.hint, { icon: icons.clock, text: "Waiting for the presenter to approve…", color: "var(--warning)" });
    return;
  }

  switch (res.code) {
    case "PRESENTER_OFFLINE":
    case "RATE_LIMITED":
    case "TIMEOUT":
      setStatus(dom.hint, {
        icon: icons.clock,
        text: `${res.message || "Not available yet"} — retrying…`,
        color: "var(--warning)",
      });
      state.retryTimer = setTimeout(() => {
        if (socket.connected && socket === state.socket) requestAccess();
      }, RETRY_DELAY_MS);
      break;
    default:
      fail(res.message || "Could not connect");
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

// ─── Slide commands ───────────────────────────────────────────────────────────

async function sendSlideChange(payload) {
  if (!state.approved || !state.socket?.connected) {
    toast("Not connected");
    return;
  }
  navigator.vibrate?.(10);
  const res = await request(state.socket, "slide-change", payload);
  if (!res.ok) toast(res.code === "NO_PDF" ? "The presenter has not loaded a PDF yet" : res.message);
}

const next = () => sendSlideChange({ direction: "next" });
const prev = () => sendSlideChange({ direction: "prev" });

function jump() {
  const slide = Number(dom.jumpInput.value);
  if (!Number.isInteger(slide) || slide < 1 || (state.totalSlides && slide > state.totalSlides)) {
    toast(state.totalSlides ? `Enter a slide between 1 and ${state.totalSlides}` : "Enter a slide number");
    return;
  }
  sendSlideChange({ slide });
  dom.jumpInput.value = "";
  dom.jumpInput.blur();
}

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
}

function showConnectScreen() {
  dom.pad.hidden = true;
  dom.bigPad.hidden = true;
  closeTeleprompter();
  dom.connectScreen.hidden = false;
}

function setLive(online) {
  dom.status.className = `rc-status ${online ? "connected" : "disconnected"}`;
  dom.status.textContent = online ? "● Live" : "○ Reconnecting…";
}

function showSessionName(name) {
  dom.sessionName.textContent = name || "Untitled Session";
  dom.sessionName.hidden = false;
}

function updateSlideDisplay() {
  const total = state.totalSlides || "?";
  dom.slideNum.textContent = String(state.currentSlide);
  dom.totalSlides.textContent = String(total);
  dom.bigCounter.textContent = `${state.currentSlide} / ${total}`;
  dom.tpIndicator.textContent = `${state.currentSlide} / ${total}`;
  dom.jumpInput.max = String(state.totalSlides || 9999);
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
  text.append("New PDF: ");
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

// ─── Speaker notes ────────────────────────────────────────────────────────────

let notesFontSize = Number(local.get(NOTES_FONT_KEY)) || 16;

function applyNotesFont() {
  notesFontSize = Math.min(32, Math.max(10, notesFontSize));
  dom.notes.style.fontSize = `${notesFontSize}px`;
  local.set(NOTES_FONT_KEY, String(notesFontSize));
}

// ─── Teleprompter ─────────────────────────────────────────────────────────────

const tp = { running: false, speed: 1.5, position: 0, lastTime: 0, raf: 0 };

function openTeleprompter() {
  const text = dom.notes.value.trim();
  if (!text) {
    toast("Add some notes first");
    return;
  }
  // Paragraphs are built as DOM nodes, so notes can never inject HTML.
  const paragraphs = text.split(/\n{2,}/).map((block) => {
    const p = document.createElement("p");
    block.split("\n").forEach((line, i) => {
      if (i) p.append(document.createElement("br"));
      p.append(line);
    });
    return p;
  });
  dom.tpText.replaceChildren(...paragraphs);
  dom.tpWrap.scrollTop = 0;
  tp.position = 0;
  dom.tele.hidden = false;
  enterFullscreen(dom.tele);
  setTeleprompterRunning(true);
}

function closeTeleprompter() {
  setTeleprompterRunning(false);
  dom.tele.hidden = true;
  if (fullscreenElement() === dom.tele) exitFullscreen();
}

function setTeleprompterRunning(running) {
  tp.running = running;
  dom.tpPlayPause.textContent = running ? "⏸ Pause" : "▶ Play";
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

// ─── Pointer (remote cursor) ──────────────────────────────────────────────────

let lastCursorSend = 0;
let pendingCursor = null;
let cursorTimer = null;

function sendCursor(x, y, active) {
  if (state.approved && state.socket?.connected) state.socket.emit("cursor-move", { x, y, active });
}

/** Throttles pointer moves to ~60 per second, always delivering the latest position. */
function queueCursor(x, y) {
  pendingCursor = { x, y };
  const wait = CURSOR_SEND_INTERVAL_MS - (Date.now() - lastCursorSend);
  if (wait <= 0) {
    flushCursor();
  } else if (!cursorTimer) {
    cursorTimer = setTimeout(flushCursor, wait);
  }
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

/** Maps a pointer position on the control panel to slide coordinates in [0, 1]. */
function panelPosition(event) {
  const rect = dom.panel.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

const isControl = (target) => Boolean(target.closest("button, input, textarea, select, label"));

dom.panel.addEventListener("pointerdown", (e) => {
  if (!state.cursorEnabled || isControl(e.target)) return;
  dom.panel.setPointerCapture(e.pointerId);
  const { x, y } = panelPosition(e);
  queueCursor(x, y);
});
dom.panel.addEventListener("pointermove", (e) => {
  if (!state.cursorEnabled || !dom.panel.hasPointerCapture(e.pointerId)) return;
  const { x, y } = panelPosition(e);
  queueCursor(x, y);
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  dom.panel.addEventListener(type, () => {
    if (state.cursorEnabled) releaseCursor();
  });
}

function toggleCursor() {
  state.cursorEnabled = !state.cursorEnabled;
  dom.cursorToggle.classList.toggle("active", state.cursorEnabled);
  dom.cursorToggle.setAttribute("aria-pressed", String(state.cursorEnabled));
  // While the pointer is on, touches on the pad must not scroll the page.
  dom.panel.classList.toggle("pointer-mode", state.cursorEnabled);
  if (!state.cursorEnabled) releaseCursor();
  toast(state.cursorEnabled ? "Pointer on — drag on the pad" : "Pointer off");
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

// ─── Event wiring ─────────────────────────────────────────────────────────────

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
dom.cursorToggle.addEventListener("click", toggleCursor);
dom.fullscreen.addEventListener("click", openBigPad);
dom.headerFullscreen.addEventListener("click", openBigPad);
dom.bigPrev.addEventListener("click", prev);
dom.bigNext.addEventListener("click", next);
dom.bigExit.addEventListener("click", closeBigPad);

dom.notes.value = local.get(NOTES_KEY) || "";
dom.notes.addEventListener("input", () => local.set(NOTES_KEY, dom.notes.value));
dom.notesFontDown.addEventListener("click", () => {
  notesFontSize -= 2;
  applyNotesFont();
});
dom.notesFontUp.addEventListener("click", () => {
  notesFontSize += 2;
  applyNotesFont();
});
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

const initialId = normalizeSessionId(new URLSearchParams(window.location.search).get("session"));
if (SESSION_ID_PATTERN.test(initialId)) {
  dom.sessionInput.value = initialId;
  connect();
} else {
  dom.sessionInput.focus();
}
