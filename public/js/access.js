/**
 * PDF Presenter — session directory (/access).
 *
 * Lists active sessions so audience members can join one as viewers.
 * Search, sort and time filters run client-side; the list refreshes every
 * 10 seconds while the tab is visible.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { $, api, icons, applySavedTheme } from "./lib/common.js";

applySavedTheme();

const REFRESH_INTERVAL_MS = 10_000;
const TIME_WINDOWS_MS = { "1h": 3_600_000, "4h": 14_400_000, "24h": 86_400_000 };

const dom = {
  list: $("sessionList"),
  search: $("sessionSearch"),
  sort: $("sortSelect"),
  timeFilter: $("timeFilter"),
  refresh: $("refreshBtn"),
};

/** @type {{ id: string, name: string, hasPassword: boolean, hasPdf: boolean, viewerCount: number, presenterOnline: boolean, createdAt: number }[]} */
let sessions = [];

function formatTimeAgo(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function filteredSessions() {
  const query = dom.search.value.trim().toLocaleLowerCase();
  const window = TIME_WINDOWS_MS[dom.timeFilter.value];
  const now = Date.now();

  const result = sessions.filter(
    (s) => (!window || now - s.createdAt <= window) && (!query || s.name.toLocaleLowerCase().includes(query)),
  );

  const comparators = {
    newest: (a, b) => b.createdAt - a.createdAt,
    oldest: (a, b) => a.createdAt - b.createdAt,
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return result.sort(comparators[dom.sort.value] || comparators.newest);
}

/** Small element factory; text is always inserted as text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function withIcon(className, icon, text) {
  const node = el("span", className);
  node.innerHTML = icon; // static markup from `icons`
  node.append(` ${text}`);
  return node;
}

function renderSession(s) {
  const item = el("div", "session-item");

  const info = el("div", "session-info");
  info.append(el("span", "session-id", s.id));
  const name = el("span", "session-filename", s.name);
  if (s.hasPassword) {
    const lock = el("span", "session-lock");
    lock.innerHTML = icons.lock;
    lock.title = "Password required";
    name.append(" ", lock);
  }
  info.append(name);

  const meta = el("div", "session-meta");
  meta.append(
    withIcon("session-time", icons.clock, formatTimeAgo(s.createdAt)),
    el("span", "session-viewers", `${s.viewerCount} viewer${s.viewerCount === 1 ? "" : "s"}`),
    el(
      "span",
      `session-state ${s.presenterOnline ? "online" : "offline"}`,
      !s.presenterOnline ? "Presenter offline" : s.hasPdf ? "Live" : "Waiting for slides",
    ),
  );

  const actions = el("div", "action-buttons");
  const link = el("a", "btn btn-sm", s.hasPassword ? "View (password required)" : "View");
  link.href = `/viewer.html?session=${encodeURIComponent(s.id)}`;
  actions.append(link);

  item.append(info, meta, actions);
  return item;
}

function render() {
  if (!sessions.length) {
    dom.list.replaceChildren(el("div", "no-sessions", "No active sessions. Start a presentation first."));
    return;
  }
  const visible = filteredSessions();
  dom.list.replaceChildren(
    ...(visible.length ? visible.map(renderSession) : [el("div", "no-sessions", "No matching sessions.")]),
  );
}

async function fetchSessions() {
  const { ok, data } = await api("/api/sessions");
  if (!ok) {
    dom.list.replaceChildren(el("div", "no-sessions", "Could not load sessions. Is the server running?"));
    return;
  }
  sessions = data.sessions || [];
  render();
}

dom.search.addEventListener("input", render);
dom.sort.addEventListener("change", render);
dom.timeFilter.addEventListener("change", render);
dom.refresh.addEventListener("click", fetchSessions);

fetchSessions();
setInterval(() => {
  if (document.visibilityState === "visible") fetchSessions();
}, REFRESH_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") fetchSessions();
});
