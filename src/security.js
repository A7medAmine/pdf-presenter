"use strict";

/**
 * Security primitives: identifiers, secrets, password hashing and input sanitizers.
 * Everything here is pure (no I/O besides the CPU-bound scrypt call).
 */

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);

/** Unambiguous alphabet (no 0/O, 1/I) so IDs are easy to read aloud and type. */
const SESSION_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_ID_LENGTH = 16; // 16 × 5 bits = 80 bits of entropy
const SESSION_ID_PATTERN = /^[A-Z0-9]{16}$/;

/** Device IDs are generated client-side (UUID or hex). */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Hex secrets produced by {@link randomToken}. */
const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/;

/** Name of every stored PDF: 32 random hex chars + `.pdf`. */
const STORED_PDF_PATTERN = /^[a-f0-9]{32}\.pdf$/;

const PASSWORD_MIN_LENGTH = 4;
const PASSWORD_MAX_LENGTH = 128;

const SCRYPT_KEY_LENGTH = 32;

/** @returns {string} Cryptographically random hex string of `bytes * 2` characters. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** @returns {string} A new 16-character session ID. 256 % 32 === 0, so the mapping is unbiased. */
function generateSessionId() {
  const bytes = crypto.randomBytes(SESSION_ID_LENGTH);
  let id = "";
  for (const byte of bytes) id += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length];
  return id;
}

/** Constant-time string comparison that also tolerates non-string input. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function isValidPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH
  );
}

/**
 * Hashes a password with scrypt and a random salt.
 * @returns {Promise<string>} `scrypt$<salt hex>$<hash hex>`
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Verifies a password against a hash created by {@link hashPassword}.
 * Never throws: malformed input simply returns `false`.
 */
async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Normalizes a user-supplied display name (session names).
 * Keeps letters and marks from every script (Arabic included), digits and a
 * small set of punctuation. Output is always rendered with `textContent`, so
 * this is about tidiness and abuse prevention, not HTML escaping.
 *
 * @returns {string|null} The cleaned name, or `null` when nothing usable remains.
 */
function sanitizeDisplayName(value, maxLength = 60) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}\s\-_.,'()&#!?:]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const limited = Array.from(cleaned).slice(0, maxLength).join("").trim();
  return limited.length > 0 ? limited : null;
}

/**
 * Normalizes free text such as poll questions: removes control and format
 * characters, collapses whitespace and limits the length. Output is always
 * rendered with `textContent`.
 *
 * @returns {string|null} The cleaned text, or `null` when nothing usable remains.
 */
function sanitizeText(value, maxLength = 200) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const limited = Array.from(cleaned).slice(0, maxLength).join("").trim();
  return limited.length > 0 ? limited : null;
}

/** Cleans an uploaded file's original name for display purposes only. */
function sanitizeOriginalFilename(value) {
  if (typeof value !== "string") return "Presentation.pdf";
  const base = value.split(/[\\/]/).pop() || "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  const limited = Array.from(cleaned).slice(0, 120).join("");
  return limited || "Presentation.pdf";
}

const isSessionId = (value) => typeof value === "string" && SESSION_ID_PATTERN.test(value);
const isDeviceId = (value) => typeof value === "string" && DEVICE_ID_PATTERN.test(value);
const isToken = (value) => typeof value === "string" && TOKEN_PATTERN.test(value);
const isStoredPdfName = (value) => typeof value === "string" && STORED_PDF_PATTERN.test(value);

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  SESSION_ID_PATTERN,
  randomToken,
  generateSessionId,
  safeEqual,
  isValidPassword,
  hashPassword,
  verifyPassword,
  sanitizeDisplayName,
  sanitizeOriginalFilename,
  sanitizeText,
  isSessionId,
  isDeviceId,
  isToken,
  isStoredPdfName,
};
