/**
 * PDF Presenter — shared browser utilities.
 *
 * Used by every page (presenter, viewer, remote, access). Nothing here touches
 * page-specific DOM; pages pass in the elements they own.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/** Session IDs are 16 characters from an unambiguous alphabet. */
export const SESSION_ID_PATTERN = /^[A-Z0-9]{16}$/;

/** Shorthand for `document.getElementById`. */
export const $ = (id) => document.getElementById(id);

/** Inline SVG icons (static markup, safe for `innerHTML`). */
export const icons = {
  warning:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  check:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  cross:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  clock:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  lock:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
  sun: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>',
  moon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>',
  enterFullscreen:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>',
  exitFullscreen:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>',
  eye: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  swap: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>',
};

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Wraps Web Storage so private browsing / disabled storage never throws.
 * @param {"local"|"session"} kind
 */
function safeStorage(kind) {
  const backend = () => (kind === "local" ? window.localStorage : window.sessionStorage);
  return {
    get(key) {
      try {
        return backend().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        backend().setItem(key, value);
      } catch {
        /* storage unavailable or full */
      }
    },
    remove(key) {
      try {
        backend().removeItem(key);
      } catch {
        /* storage unavailable */
      }
    },
  };
}

export const local = safeStorage("local");
export const session = safeStorage("session");

// ─── Identity ─────────────────────────────────────────────────────────────────

/** Stable random ID for this browser (used for likes and remote approval). */
export function getDeviceId() {
  const key = "pdf-presenter-device-id";
  let id = local.get(key);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    if (crypto.randomUUID) {
      id = crypto.randomUUID();
    } else {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    local.set(key, id);
  }
  return id;
}

/** Uppercases and strips everything that cannot be part of a session ID. */
export function normalizeSessionId(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

// ─── Network ──────────────────────────────────────────────────────────────────

/**
 * JSON fetch helper. Always sends `X-Requested-With` (required by the server
 * for state-changing requests) and never throws on HTTP errors.
 *
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
export async function api(path, { method = "GET", body, headers = {} } = {}) {
  const init = { method, headers: { "X-Requested-With": "XMLHttpRequest", ...headers } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Network error — is the server running?" } };
  }
}

/**
 * Emits a Socket.io event and waits for the server acknowledgement.
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, [key: string]: any }>}
 */
export async function request(socket, event, payload = {}, timeoutMs = 8000) {
  try {
    return await socket.timeout(timeoutMs).emitWithAck(event, payload);
  } catch {
    return { ok: false, code: "TIMEOUT", message: "The server did not respond" };
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

/**
 * Creates a toast notifier bound to an element.
 * @param {HTMLElement} element
 * @returns {(message: string, options?: { duration?: number }) => void}
 */
export function createToast(element) {
  let timer = null;
  return (message, { duration = 3000 } = {}) => {
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => element.classList.remove("show"), duration);
  };
}

/**
 * Writes a status line made of an optional static icon and dynamic text.
 * The text is always inserted as text, never as HTML.
 */
export function setStatus(element, { icon = "", text = "", color = "" } = {}) {
  element.innerHTML = icon;
  if (icon && text) element.append(" ");
  element.append(text);
  element.style.color = color;
}

/** True when keyboard input currently targets a text field. */
export function isTyping(target = document.activeElement) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** Copies text, falling back to `execCommand` on non-secure (HTTP) origins. */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

/** Draws a QR code into a canvas using the bundled QRious library. */
export function drawQr(canvas, value, size = 200) {
  if (!canvas || !value || typeof window.QRious !== "function") return;
  // QRious draws into the canvas as a side effect of construction.
  new window.QRious({ element: canvas, value, size, background: "#ffffff", foreground: "#1a1a2e" });
}

// ─── Theme ────────────────────────────────────────────────────────────────────

const THEME_KEY = "presenter-theme";

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Applies the saved theme (dark by default). */
export function applySavedTheme() {
  document.documentElement.dataset.theme = local.get(THEME_KEY) === "light" ? "light" : "dark";
}

/**
 * Wires theme toggle buttons; their icon shows the theme you switch *from*.
 * @param {...HTMLElement} buttons
 */
export function bindThemeToggles(...buttons) {
  const present = buttons.filter(Boolean);
  const paint = () => {
    for (const button of present) button.innerHTML = currentTheme() === "dark" ? icons.sun : icons.moon;
  };
  for (const button of present) {
    button.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      local.set(THEME_KEY, next);
      paint();
    });
  }
  paint();
}

// ─── Fullscreen ───────────────────────────────────────────────────────────────

/** Current fullscreen element, including the WebKit-prefixed API (iOS Safari). */
export function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

/** Requests fullscreen on an element; resolves even when the browser refuses. */
export async function enterFullscreen(element) {
  try {
    if (element.requestFullscreen) await element.requestFullscreen();
    else element.webkitRequestFullscreen?.();
  } catch {
    /* user gesture missing or unsupported */
  }
}

export async function exitFullscreen() {
  if (!fullscreenElement()) return;
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else document.webkitExitFullscreen?.();
  } catch {
    /* already exited */
  }
}

/** Subscribes to fullscreen changes (standard and WebKit events). */
export function onFullscreenChange(listener) {
  document.addEventListener("fullscreenchange", listener);
  document.addEventListener("webkitfullscreenchange", listener);
}

// ─── Screen wake lock ─────────────────────────────────────────────────────────

/**
 * Keeps the screen awake while the page is visible (remotes and viewers).
 * Silently does nothing where the Wake Lock API is unavailable.
 */
export function keepScreenAwake() {
  if (!("wakeLock" in navigator)) return;
  let lock = null;
  const acquire = async () => {
    if (document.visibilityState !== "visible" || lock) return;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => (lock = null));
    } catch {
      lock = null;
    }
  };
  document.addEventListener("visibilitychange", acquire);
  acquire();
}
