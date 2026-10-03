#!/usr/bin/env node
"use strict";

/**
 * PDF Presenter — entry point.
 *
 * Loads configuration, starts the HTTP + WebSocket server and handles
 * graceful shutdown. All application logic lives in `src/`.
 *
 * Licensed under the Apache License, Version 2.0.
 */

const path = require("node:path");
const { loadConfig, loadDotEnv, ROOT_DIR } = require("./src/config");
const { createLogger } = require("./src/logger");
const { createApp } = require("./src/app");
const { lanAddresses } = require("./src/network");

/** Grace period for open connections before a forced exit. */
const SHUTDOWN_TIMEOUT_MS = 5000;

async function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection", reason));

  const application = await createApp(config, logger);
  const port = await application.listen();

  logger.info(`PDF Presenter running at http://localhost:${port}`);
  for (const { address } of lanAddresses()) logger.info(`  on your network: http://${address}:${port}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down…`);
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    await application.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start PDF Presenter:", err);
  process.exit(1);
});
