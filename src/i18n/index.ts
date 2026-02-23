/**
 * Lightweight i18n engine for Vibecraft.
 *
 * - Nested translation objects flattened to dot-notation keys
 * - `t('feed.thinking')` lookup with `{param}` interpolation
 * - `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` for static HTML
 * - CSS custom property `--i18n-deepgram-hint` for CSS content strings
 * - Auto-detects browser language, persists choice in localStorage
 */

import en from "./en";
import zh from "./zh";

export type Locale = "en" | "zh";

type NestedDict = { [key: string]: string | NestedDict };
type FlatDict = Record<string, string>;

const STORAGE_KEY = "vibecraft-locale";

let currentLocale: Locale = "en";
let flatDict: FlatDict = {};
const changeCallbacks: Array<(locale: Locale) => void> = [];

const dictionaries: Record<Locale, NestedDict> = { en, zh };

// Flatten nested object to dot-notation keys
function flatten(obj: NestedDict, prefix = ""): FlatDict {
  const result: FlatDict = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result[fullKey] = value;
    } else {
      Object.assign(result, flatten(value, fullKey));
    }
  }
  return result;
}

/**
 * Translate a key, with optional parameter interpolation.
 * Returns the key itself if no translation found (fallback).
 *
 * Usage:
 *   t('feed.thinking')           → "Claude is thinking"
 *   t('status.sentTo', { name }) → "Sent to Frontend!"
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  let text = flatDict[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Switch locale. Updates flatDict, persists to localStorage,
 * refreshes all data-i18n DOM elements, and notifies listeners.
 */
export function setLocale(locale: Locale): void {
  flatDict = flatten(dictionaries[locale]);
  currentLocale = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  updateDOMTranslations();
  changeCallbacks.forEach((cb) => cb(locale));
}

export function onLocaleChange(cb: (locale: Locale) => void): void {
  changeCallbacks.push(cb);
}

/** Update all DOM elements tagged with data-i18n attributes. */
function updateDOMTranslations(): void {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n")!;
    el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder")!;
    (el as HTMLInputElement | HTMLTextAreaElement).placeholder = t(key);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title")!;
    (el as HTMLElement).title = t(key);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html")!;
    el.innerHTML = t(key);
  });

  // CSS custom property for content strings
  document.documentElement.style.setProperty(
    "--i18n-deepgram-hint",
    `'${t("voice.deepgramHint")}'`,
  );
}

/**
 * Initialize i18n. Call once at app startup before any t() usage.
 * Loads saved locale from localStorage, or auto-detects from browser.
 */
export function initI18n(): void {
  const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
  const detected: Locale = navigator.language.startsWith("zh") ? "zh" : "en";
  const locale = saved ?? detected;
  // Set without triggering callbacks (nothing registered yet)
  flatDict = flatten(dictionaries[locale]);
  currentLocale = locale;
  updateDOMTranslations();
}
