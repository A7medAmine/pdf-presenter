/**
 * PDF Presenter — internationalization (English / Arabic).
 *
 * Static markup is translated through attributes:
 *   data-i18n="key"              → textContent
 *   data-i18n-placeholder="key"  → placeholder
 *   data-i18n-title="key"        → title
 *   data-i18n-aria="key"         → aria-label
 * Scripts call `t(key, vars)`. Plural entries are objects keyed by
 * Intl.PluralRules categories (Arabic uses zero/one/two/few/many/other).
 *
 * Arabic switches the document to `dir="rtl"`. Slide stages and navigation
 * rows keep `dir="ltr"` in the markup so "next" stays on the right, matching
 * keyboards and presentation clickers.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { STRINGS } from "./strings.js";

const LANG_KEY = "presenter-lang";
const SUPPORTED = ["en", "ar"];

function readSaved() {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

function detect() {
  const saved = readSaved();
  if (SUPPORTED.includes(saved)) return saved;
  const preferred = (navigator.languages || [navigator.language || "en"]).map((l) => String(l).slice(0, 2));
  return preferred.find((l) => SUPPORTED.includes(l)) || "en";
}

let lang = detect();
let plurals = new Intl.PluralRules(lang);
const listeners = new Set();

export const currentLang = () => lang;

/**
 * Translates a key. `{name}` placeholders are replaced by `vars.name`; a
 * numeric `vars.count` selects the plural form.
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 */
export function t(key, vars = {}) {
  let entry = STRINGS[lang]?.[key] ?? STRINGS.en[key];
  if (entry === undefined) return key;
  if (typeof entry === "object") {
    const category = typeof vars.count === "number" ? plurals.select(vars.count) : "other";
    entry = entry[category] ?? entry.other;
  }
  return entry.replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? `{${name}}` : String(vars[name])));
}

/** Translates every annotated element under `root`. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  if (root === document) {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    const titleKey = document.documentElement.dataset.titleKey;
    if (titleKey) document.title = t(titleKey);
  }
}

/** Switches the language and re-translates the page. */
export function setLang(next) {
  if (!SUPPORTED.includes(next) || next === lang) return;
  lang = next;
  plurals = new Intl.PluralRules(lang);
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  applyI18n();
  for (const listener of listeners) listener(lang);
}

/** Runs `listener(lang)` after every language change (for script-rendered text). */
export function onLangChange(listener) {
  listeners.add(listener);
}

/**
 * Wires language toggle buttons; each shows the language you switch *to*.
 * @param {...HTMLElement} buttons
 */
export function bindLangToggles(...buttons) {
  const present = buttons.filter(Boolean);
  const paint = () => {
    for (const button of present) {
      button.textContent = lang === "ar" ? "EN" : "ع";
      button.title = t("switchLanguage");
      button.setAttribute("aria-label", t("switchLanguage"));
    }
  };
  for (const button of present) button.addEventListener("click", () => setLang(lang === "ar" ? "en" : "ar"));
  onLangChange(paint);
  paint();
}

/** Formats a number for the current language (Western digits, as in the slides). */
export const formatNumber = (n) => new Intl.NumberFormat(lang === "ar" ? "ar-u-nu-latn" : "en").format(n);

applyI18n();
