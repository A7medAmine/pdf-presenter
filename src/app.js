"use strict";

/**
 * Application factory: assembles stores, HTTP routes and the Socket.io layer
 * into one server. Kept free of `listen()` side effects so tests can create
 * isolated instances.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const { SessionStore } = require("./session-store");
const { LikesStore } = require("./likes-store");
const { registerHttp } = require("./http");
const { registerRealtime } = require("./realtime");

/** Largest socket message accepted; the biggest legitimate payload is a session name. */
const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024;

/**
 * Rejects cross-site WebSocket handshakes: when the browser sends an Origin,
 * its host must match the Host header. Non-browser clients send no Origin.
 */
function isSameOrigin(req) {
  const { origin, host } = req.headers;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * @param {ReturnType<import("./config").loadConfig>} config
 * @param {import("./logger").Logger} logger
 */
async function createApp(config, logger) {
  await fs.promises.mkdir(config.uploadDir, { recursive: true });
  await fs.promises.mkdir(config.dataDir, { recursive: true });

  const store = new SessionStore({
    uploadDir: config.uploadDir,
    idleTtlMs: config.sessionIdleTtlMs,
    maxLifetimeMs: config.sessionMaxLifetimeMs,
    logger: logger.child("sessions"),
  });
  await store.purgeUploads();

  const likes = new LikesStore({ file: path.join(config.dataDir, "likes.json"), logger: logger.child("likes") });
  await likes.load();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: MAX_SOCKET_MESSAGE_BYTES,
    allowRequest: (req, callback) => callback(null, isSameOrigin(req)),
  });

  const realtime = registerRealtime({ io, store, logger: logger.child("ws") });
  registerHttp(app, { config, store, likes, realtime, logger: logger.child("http") });

  /** Starts listening; resolves with the bound port. */
  function listen(port = config.port, host = config.host) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(server.address().port);
      });
    });
  }

  /** Stops accepting connections, closes sockets and flushes pending writes. */
  async function close() {
    realtime.close();
    await new Promise((resolve) => io.close(() => resolve()));
    await likes.flush();
  }

  return { app, server, io, store, likes, realtime, listen, close };
}

module.exports = { createApp };
