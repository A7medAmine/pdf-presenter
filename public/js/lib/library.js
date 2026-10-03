/**
 * PDF Presenter — presentation library stored in this browser (IndexedDB).
 *
 * The server deletes every file when a session ends, so presenters keep their
 * recent decks locally and re-upload them with one click. Nothing here ever
 * leaves the browser on its own.
 *
 * Licensed under the Apache License, Version 2.0.
 */

const DB_NAME = "pdf-presenter";
const STORE = "decks";
const MAX_DECKS = 12;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;

/**
 * @typedef {{ id: string, name: string, type: string, size: number, addedAt: number, usedAt: number }} DeckInfo
 */

let dbPromise = null;

function openDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB unavailable"));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** Runs `fn(store)` in a transaction and resolves with the request result. */
async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Same file (name + size + modification time) is stored once. */
const deckId = (file) => `${file.name}|${file.size}|${file.lastModified || 0}`;

/** @returns {Promise<DeckInfo[]>} Decks, most recently used first (without file data). */
export async function listDecks() {
  try {
    const all = await withStore("readonly", (store) => store.getAll());
    return (all || [])
      .map(({ id, name, type, size, addedAt, usedAt }) => ({ id, name, type, size, addedAt, usedAt }))
      .sort((a, b) => b.usedAt - a.usedAt);
  } catch {
    return [];
  }
}

/** @returns {Promise<File|null>} */
export async function getDeckFile(id) {
  try {
    const deck = await withStore("readonly", (store) => store.get(id));
    if (!deck) return null;
    await withStore("readwrite", (store) => store.put({ ...deck, usedAt: Date.now() }));
    return new File([deck.blob], deck.name, { type: deck.type });
  } catch {
    return null;
  }
}

/** Saves a file, evicting the least recently used decks beyond the limits. */
export async function saveDeck(file) {
  if (file.size > MAX_TOTAL_BYTES) return false;
  try {
    const now = Date.now();
    const id = deckId(file);
    await withStore("readwrite", (store) =>
      store.put({ id, name: file.name, type: file.type, size: file.size, addedAt: now, usedAt: now, blob: file }),
    );
    const decks = await listDecks();
    let total = 0;
    const evict = [];
    decks.forEach((deck, index) => {
      total += deck.size;
      if (deck.id !== id && (index >= MAX_DECKS || total > MAX_TOTAL_BYTES)) evict.push(deck.id);
    });
    for (const old of evict) await removeDeck(old);
    return true;
  } catch {
    return false;
  }
}

export async function removeDeck(id) {
  try {
    await withStore("readwrite", (store) => store.delete(id));
  } catch {
    /* already gone */
  }
}
