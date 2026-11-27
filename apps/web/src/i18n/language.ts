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

/** Each public page's Swedish address after /sv, by its English path. The Swedish front page is /sv. */
export const SWEDISH_PATHS: Readonly<Record<string, string>> = {
  "/send": "/skicka",
  "/send/file": "/skicka/fil",
  "/send/secret": "/skicka/hemlighet",
  "/how": "/sa-fungerar-det",
  "/how/file": "/sa-fungerar-det/filen",
  "/how/encryption": "/sa-fungerar-det/kryptering",
  "/how/link": "/sa-fungerar-det/lanken",
  "/how/connect": "/sa-fungerar-det/anslutning",
  "/how/direct": "/sa-fungerar-det/direkt",
  "/how/relay": "/sa-fungerar-det/relaet",
  "/how/transfer": "/sa-fungerar-det/overforing",
  "/how/verification": "/sa-fungerar-det/kontroll",
  "/how/masking": "/sa-fungerar-det/maskering",
  "/how/traces": "/sa-fungerar-det/lamnas-kvar",
  "/how/protection": "/sa-fungerar-det/skydd",
  "/how/tech": "/sa-fungerar-det/ordlista",
  "/about": "/om",
  "/privacy": "/integritet",
  "/security": "/sakerhet",
  "/terms": "/villkor",
};

const ENGLISH_PATHS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SWEDISH_PATHS).map(([english, swedish]) => [swedish, english]),
);

const withoutSlash = (path: string) => (/[^/]\/$/.test(path) ? path.slice(0, -1) : path);

/** The English path of a page: /sv/sakerhet is /security, /sv is /. Any other path comes back unchanged. */
export function barePath(path: string): string {
  if (!SV_PREFIX.test(path)) {
    return path;
  }
  const swedish = withoutSlash(path.slice(3) || "/");
  return swedish === "/" ? "/" : (ENGLISH_PATHS[swedish] ?? path);
}

/** The same page in `lang`, keeping any query and anchor. A path that is no page, such as a receive link, comes back unchanged. */
export function localizedPath(path: string, lang: Lang): string {
  const cut = path.search(/[?#]/);
  const suffix = cut < 0 ? "" : path.slice(cut);
  const english = withoutSlash(barePath(cut < 0 ? path : path.slice(0, cut)));
  if (english === "/") {
    return (lang === "sv" ? "/sv" : "/") + suffix;
  }
  const swedish = SWEDISH_PATHS[english];
  if (swedish === undefined) {
    return path;
  }
  return (lang === "sv" ? `/sv${swedish}` : english) + suffix;
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
