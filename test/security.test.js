"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const security = require("../src/security");
const { LikesStore } = require("../src/likes-store");
const { loadConfig, loadDotEnv } = require("../src/config");
const { createLogger } = require("../src/logger");

describe("security helpers", () => {
  test("session IDs are 16 unambiguous characters and unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, security.generateSessionId));
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.match(id, /^[A-HJ-NP-Z2-9]{16}$/);
  });

  test("password hashing round-trips and rejects bad input", async () => {
    const hash = await security.hashPassword("correct horse");
    assert.equal(await security.verifyPassword("correct horse", hash), true);
    assert.equal(await security.verifyPassword("wrong", hash), false);
    assert.equal(await security.verifyPassword(undefined, hash), false);
    assert.equal(await security.verifyPassword({}, hash), false);
    assert.equal(await security.verifyPassword("x", "garbage"), false);
  });

  test("safeEqual handles non-strings and length mismatches", () => {
    assert.equal(security.safeEqual("abc", "abc"), true);
    assert.equal(security.safeEqual("abc", "abcd"), false);
    assert.equal(security.safeEqual(undefined, "abc"), false);
    assert.equal(security.safeEqual(["abc"], "abc"), false);
  });

  test("display names keep every script and drop markup characters", () => {
    assert.equal(security.sanitizeDisplayName("  Q&A — Week 1 "), "Q&A Week 1");
    assert.equal(security.sanitizeDisplayName("الدرس الأول"), "الدرس الأول");
    assert.equal(security.sanitizeDisplayName("<img src=x onerror=alert(1)>"), "img srcx onerroralert(1)");
    assert.equal(security.sanitizeDisplayName("   "), null);
    assert.equal(security.sanitizeDisplayName(42), null);
    assert.equal(Array.from(security.sanitizeDisplayName("a".repeat(100))).length, 60);
  });

  test("original filenames are reduced to a clean base name", () => {
    assert.equal(security.sanitizeOriginalFilename("C:\\x\\..\\slides\u0000.pdf"), "slides.pdf");
    assert.equal(security.sanitizeOriginalFilename(""), "Presentation.pdf");
  });
});

describe("LikesStore", () => {
  test("persists atomically and derives the count from devices", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "likes-"));
    const file = path.join(dir, "likes.json");
    fs.writeFileSync(file, JSON.stringify({ count: 999, likedDevices: ["a", "b"] }));

    const store = new LikesStore({ file, logger: createLogger("silent") });
    await store.load();
    assert.equal(store.count, 2);
    store.setLiked("c", true);
    store.setLiked("a", false);
    await store.flush();

    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved, { count: 2, likedDevices: ["b", "c"] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a corrupt file starts from zero", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "likes-"));
    const file = path.join(dir, "likes.json");
    fs.writeFileSync(file, "{not json");
    const store = new LikesStore({ file, logger: createLogger("silent") });
    await store.load();
    assert.equal(store.count, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("config", () => {
  test("reads and clamps environment values", () => {
    const config = loadConfig({ PORT: "8080", SESSION_TTL: "2", MAX_FILE_SIZE: "abc", TRUST_PROXY: "1" });
    assert.equal(config.port, 8080);
    assert.equal(config.sessionIdleTtlMs, 2 * 60 * 60 * 1000);
    assert.equal(config.maxUploadBytes, 100 * 1024 * 1024);
    assert.equal(config.trustProxy, 1);
    assert.ok(Object.isFrozen(config));
  });

  test(".env files never override real environment variables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "# comment\nPORT=1234\nHOST='127.0.0.1'\n");
    const env = { PORT: "5000" };
    loadDotEnv(file, env);
    assert.equal(env.PORT, "5000");
    assert.equal(env.HOST, "127.0.0.1");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
