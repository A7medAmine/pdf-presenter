/**
 * PDF Presenter — presenter page.
 *
 * Responsibilities:
 *  - create or restore a session (survives page reloads via sessionStorage)
 *  - upload / swap the PDF and render it sharply (see lib/pdf-renderer.js)
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
} from "./lib/common.js";
import { openDocument, renderThumbnail, SlideRenderer } from "./lib/pdf-renderer.js";
import { startDhikr } from "./lib/dhikr.js";

applySavedTheme();

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "presenter-session";
const IP_KEY = "presenter-ip";
const ORIENTATION_KEY = "presenter-orientation";
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
  cursor: $("artificialCursor"),
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
};

const renderer = new SlideRenderer(dom.canvas, {
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
    renderer.preload(pageNum + 1);
    renderer.preload(pageNum - 1);
  },
});

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

  const copy = {
    create: ["PDF Presenter", "Upload a PDF and start presenting. Control slides from any device."],
    upload: ["Upload your slides", "Session ready! Upload a PDF to start presenting."],
    swap: ["Switch PDF", "Upload a new PDF. Everyone stays connected and jumps to the new file."],
    replaced: ["Opened in another tab", "This session is now controlled from another tab or window. Reload to take it back."],
  }[mode];
  if (copy) {
    dom.setupTitle.textContent = copy[0];
    dom.setupSubtitle.textContent = copy[1];
  }
  if (mode === "create") dom.sessionNameInput.focus();
  if (mode === "upload" || mode === "swap") dom.uploadZone.focus();
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

async function startSession() {
  const name = dom.sessionNameInput.value.trim() || null;
  const password = dom.sessionPasswordInput.value;
  if (password && password.length < 4) {
    toast("Password must be at least 4 characters");
    dom.sessionPasswordInput.focus();
    return;
  }

  dom.startSessionBtn.disabled = true;
  const { ok, data } = await api("/api/session", { method: "POST", body: { name, password: password || null } });
  dom.startSessionBtn.disabled = false;
  if (!ok) {
    toast(data.error || "Could not create the session");
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
  toast("Session restored");
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

  connectSocket();

  if (serverState?.pdf) {
    loadPdf(serverState.pdf, serverState.currentSlide);
  } else {
    setSetupMode("upload");
  }
}

function showSessionName(name) {
  dom.sessionName.textContent = name || "Untitled Session";
  dom.sessionName.hidden = false;
}

async function endSession() {
  if (!confirm("End this session? All viewers and remotes will be disconnected.")) return;
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
  const name = prompt("Session name:", dom.sessionName.textContent);
  if (name === null || !name.trim()) return;
  const res = await request(state.socket, "rename-session", { name });
  if (!res.ok) toast(res.message || "Could not rename the session");
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
        toast("This session no longer exists — starting over");
        setTimeout(() => leaveSession("/"), 2000);
      } else {
        toast(res.message || "Could not join the session");
      }
      return;
    }

    state.joined = true;
    updatePresence(res.state);
    syncTotalSlides();
    // After a reconnect the server is the source of truth for the position.
    if (state.doc && res.state.currentSlide !== state.currentSlide) showSlide(res.state.currentSlide);
  });

  socket.on("disconnect", (reason) => {
    state.joined = false;
    if (reason !== "io client disconnect" && reason !== "io server disconnect") {
      toast("Connection lost — reconnecting…");
    }
  });

  socket.on("slide-update", ({ currentSlide }) => {
    if (currentSlide !== state.currentSlide) showSlide(currentSlide, { animate: true });
  });

  socket.on("presence", updatePresence);
  socket.on("session-renamed", ({ name }) => showSessionName(name));
  socket.on("cursor-move", moveCursor);

  socket.on("remote-pending", ({ remoteSocketId, deviceLabel }) => {
    if (state.pendingRemotes.some((p) => p.remoteSocketId === remoteSocketId)) return;
    state.pendingRemotes.push({ remoteSocketId, deviceLabel });
    notificationSound.currentTime = 0;
    notificationSound.play().catch(() => {}); // autoplay may be blocked until first interaction
    renderApprovalDialog();
  });

  socket.on("remote-request-cancelled", ({ remoteSocketId }) => dropPending(remoteSocketId));

  socket.on("session-ended", ({ message }) => {
    toast(message || "Session ended");
    setTimeout(() => leaveSession("/"), 2000);
  });

  socket.on("presenter-replaced", () => {
    state.joined = false;
    setSetupMode("replaced");
  });
}

function updatePresence({ viewerCount = 0, remoteCount = 0 } = {}) {
  dom.viewerCount.textContent = `${viewerCount} viewer${viewerCount === 1 ? "" : "s"} connected`;
  dom.remoteCount.textContent = `${remoteCount} remote${remoteCount === 1 ? "" : "s"} connected`;
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
  dom.approvalCount.textContent = `${count} remote${count === 1 ? "" : "s"} waiting`;
  dom.approvalDevice.textContent = `Device ${head.deviceLabel}`;
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
  if (!res.ok) toast(res.message || "Request no longer available");
  else if (event === "remote-accept") toast(`Remote ${head.deviceLabel} connected`);
  else if (event === "remote-block") toast(`Device ${head.deviceLabel} blocked`);
}

async function toggleRemoteRequests() {
  if (!state.joined) return;
  const res = await request(state.socket, "toggle-remote-requests", { enabled: !state.remoteRequestsEnabled });
  if (!res.ok) return toast(res.message || "Could not change the setting");
  state.remoteRequestsEnabled = res.enabled;
  dom.toggleRemoteRequestsBtn.querySelector("span").textContent = res.enabled
    ? "Disable remote requests"
    : "Enable remote requests";
  dom.toggleRemoteRequestsBtn.classList.toggle("btn-danger", res.enabled);
  dom.toggleRemoteRequestsBtn.classList.toggle("btn-success", !res.enabled);
  toast(res.enabled ? "Remote requests enabled" : "Remote requests disabled");
}

// ─── Upload ───────────────────────────────────────────────────────────────────

const isPdfFile = (file) => file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));

function handleFile(file) {
  if (!isPdfFile(file)) {
    toast("Please choose a PDF file");
    return;
  }
  uploadFile(file);
}

/** Uploads with XMLHttpRequest because fetch() cannot report upload progress. */
function uploadFile(file) {
  const { sessionId, presenterToken } = state.session;
  const form = new FormData();
  form.append("pdf", file);

  dom.uploadProgress.hidden = false;
  dom.progressFill.style.width = "0%";
  dom.progressLabel.textContent = "Uploading…";
  dom.uploadZone.classList.add("busy");

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload/${sessionId}`);
  xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
  xhr.setRequestHeader("X-Presenter-Token", presenterToken);
  xhr.responseType = "json";

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 90);
    dom.progressFill.style.width = `${pct}%`;
    dom.progressLabel.textContent = `Uploading… ${pct}%`;
  };

  const fail = (message) => {
    dom.uploadZone.classList.remove("busy");
    dom.uploadProgress.hidden = true;
    dom.fileInput.value = "";
    toast(message);
  };

  xhr.onload = async () => {
    const body = xhr.response || {};
    if (xhr.status !== 201) return fail(`Upload failed: ${body.error || `HTTP ${xhr.status}`}`);
    dom.progressFill.style.width = "100%";
    dom.progressLabel.textContent = "Opening PDF…";
    await loadPdf(body.pdf, 1);
    dom.uploadZone.classList.remove("busy");
  };
  xhr.onerror = () => fail("Network error during upload");
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
    toast(`${pdf.name} — ${doc.numPages} slide${doc.numPages === 1 ? "" : "s"}`);
  } catch (err) {
    console.error("[presenter] PDF load failed", err);
    toast(`Could not open the PDF: ${err.message}`);
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
    thumb.title = `Slide ${page}`;
    thumb.setAttribute("aria-label", `Go to slide ${page}`);
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
      link.title = "Go to linked slide";
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
}

const anyModalOpen = () => !dom.remoteModal.hidden || !dom.viewerModal.hidden;

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
    dom.ipNote.textContent = "Several networks detected — pick the one your phone uses, then Apply";
  } else {
    dom.ipNote.textContent = "Detected LAN address — click Apply to use it in the QR code";
  }
  dom.ipNote.style.color = "var(--text-3)";
}

function applyIp() {
  const ip = dom.ipInput.value.trim();
  if (ip && !/^[A-Za-z0-9.-]{1,253}$|^\[?[0-9a-fA-F:]+\]?$/.test(ip)) {
    dom.ipNote.textContent = "That does not look like an IP address or host name";
    dom.ipNote.style.color = "var(--danger)";
    return;
  }
  if (ip) local.set(IP_KEY, ip);
  else local.remove(IP_KEY);
  refreshShareCodes();
  dom.ipNote.textContent = ip ? `QR code now points to ${ip}` : "Using the address in your browser bar";
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
  toast((await copyText(url)) ? "Link copied" : "Copy failed — select the link manually");
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
  dom.togglePasswordBtn.title = show ? "Hide password" : "Show password";
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
for (const modal of [dom.remoteModal, dom.viewerModal]) {
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
    return;
  }
  if (isTyping(e.target) || anyModalOpen() || !dom.setupOverlay.classList.contains("hide")) return;
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
  }
});

let touchStartX = null;
dom.slideArea.addEventListener(
  "touchstart",
  (e) => {
    touchStartX = e.touches.length === 1 ? e.touches[0].clientX : null;
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
setOrientation(state.orientation);
if (!(await restoreSession())) setSetupMode("create");
