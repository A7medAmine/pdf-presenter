"use strict";

/**
 * Test helpers: spin up an isolated server instance on a random port with
 * temporary upload/data directories, plus small HTTP and socket utilities.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { io: connect } = require("socket.io-client");

const { loadConfig } = require("../src/config");
const { createLogger } = require("../src/logger");
const { createApp } = require("../src/app");

/** Smallest well-formed PDF with one page. */
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
);

/**
 * Starts a server. Call `ctx.close()` when done.
 * @param {object} [overrides] Config overrides.
 */
async function startServer(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-presenter-test-"));
  const config = loadConfig(
    { NODE_ENV: "test" },
    { uploadDir: path.join(tmp, "uploads"), dataDir: path.join(tmp, "data"), ...overrides },
  );
  const application = await createApp(config, createLogger("silent"));
  const port = await application.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets = [];

  return {
    ...application,
    config,
    baseUrl,
    tmp,

    /** fetch() relative to the server, with JSON + XHR headers by default. */
    async request(urlPath, { method = "GET", body, headers = {}, xhr = true } = {}) {
      const init = { method, headers: { ...headers } };
      if (xhr) init.headers["X-Requested-With"] = "XMLHttpRequest";
      if (body !== undefined && !(body instanceof FormData)) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      } else if (body) {
        init.body = body;
      }
      const res = await fetch(baseUrl + urlPath, init);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
      return { status: res.status, headers: res.headers, json, text };
    },

    /** Creates a session through the API. */
    async createSession(body = {}) {
      const res = await this.request("/api/session", { method: "POST", body });
      if (res.status !== 201) throw new Error(`createSession failed: ${res.status} ${res.text}`);
      return res.json;
    },

    /** Uploads a PDF as the presenter. */
    async uploadPdf(session, buffer = MINIMAL_PDF, filename = "slides.pdf") {
      const form = new FormData();
      form.append("pdf", new Blob([buffer], { type: "application/pdf" }), filename);
      return this.request(`/api/upload/${session.sessionId}`, {
        method: "POST",
        body: form,
        headers: { "X-Presenter-Token": session.presenterToken },
      });
    },

    /** Opens a connected socket.io client. */
    async socket() {
      const client = connect(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
      sockets.push(client);
      await new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("connect_error", reject);
      });
      return client;
    },

    async close() {
      for (const client of sockets) client.disconnect();
      await application.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Emits an event and resolves with the acknowledgement. */
function ask(client, event, payload = {}) {
  return client.timeout(2000).emitWithAck(event, payload);
}

/** Resolves with the next payload of `event`. */
function next(client, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolves after `ms` milliseconds. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { startServer, ask, next, delay, MINIMAL_PDF };
