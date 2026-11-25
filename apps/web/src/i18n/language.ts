// Which language the page shows: chosen in this browser, and named by the page's path (/sv for Swedish).

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

function initialLanguage(): Lang {
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

const SV_PREFIX = /^\/sv(?=\/|$)/;
const RECEIVE = /^(?:\/sv)?\/r\//;

/** The path without its /sv prefix: /sv/how is /how, /sv is /. Receive paths, with or without /sv, come back unchanged. */
export function barePath(path: string): string {
  if (RECEIVE.test(path)) {
    return path;
  }
  const bare = path.replace(SV_PREFIX, "");
  return bare === "" || bare === "/" ? "/" : bare;
}

/** The same page in `lang`. Receive links have one path for both languages. */
export function localizedPath(path: string, lang: Lang): string {
  if (RECEIVE.test(path)) {
    return path;
  }
  const bare = barePath(path);
  return lang === "sv" ? `/sv${bare === "/" ? "" : bare}` : bare;
}

/** The language a path names, or undefined for a receive link, whose language is picked as before. */
export function pathLanguage(path: string): Lang | undefined {
  if (path.startsWith("/r/")) {
    return undefined;
  }
  return SV_PREFIX.test(path) ? "sv" : "en";
}

export function startLanguage(path: string): Lang {
  return pathLanguage(path) ?? initialLanguage();
}
