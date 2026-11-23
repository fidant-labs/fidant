// Which language the page shows. The choice stays in this browser and is never sent anywhere.

import { en, type Messages } from "./en.ts";
import { sv } from "./sv.ts";

export type Lang = "sv" | "en";

export const MESSAGES: Record<Lang, Messages> = { sv, en };

/** Each language's own name, so people find theirs whatever language is showing. */
export const LANGUAGE_NAMES: Record<Lang, string> = { sv: "Svenska", en: "English" };

const STORAGE_KEY = "lang";

/** A stored choice wins; otherwise Swedish for a Swedish browser, English for the rest. */
export function pickLanguage(stored: string | null, browser: string): Lang {
  if (stored === "sv" || stored === "en") {
    return stored;
  }
  return /^sv\b/i.test(browser) ? "sv" : "en";
}

export function initialLanguage(): Lang {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, site data off): fall back to the browser language.
  }
  return pickLanguage(stored, navigator.language);
}

export function rememberLanguage(lang: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not remembered, but the switch still applies to this page.
  }
}
