// Renders the public pages at build time (see vite.config.ts), with no browser around.

import { renderToString } from "preact-render-to-string";
import { App, pageTitle, routeOf } from "./App.tsx";
import { STEPS } from "./how/steps.tsx";
import type { Messages } from "./i18n/en.ts";
import { I18nProvider } from "./i18n/I18n.tsx";
import { type Lang, MESSAGES } from "./i18n/language.ts";

/** Every public page, without the /sv prefix. */
export const PAGES: readonly string[] = [
  "/",
  "/send",
  "/secret",
  "/how",
  ...STEPS.map((step) => `/how/${step.slug}`),
  "/about",
  "/privacy",
  "/security",
  "/terms",
];

/** Any path no page has: it renders the not-found page. */
export const NOT_FOUND = "/404";

function description(t: Messages, path: string): string {
  const step = STEPS.find(({ slug }) => path === `/how/${slug}`);
  if (step) {
    return t.how.sections[step.id].body[0] ?? t.how.lede;
  }
  const route = routeOf(path);
  switch (route) {
    case "landing":
    case "send":
    case "secret":
    case "how":
    case "about":
    case "privacy":
    case "security":
    case "terms":
      return t[route].lede;
    default:
      return t.notFound.body;
  }
}

export function renderPage(
  path: string,
  lang: Lang,
): { markup: string; title: string; description: string } {
  const t = MESSAGES[lang];
  const markup = renderToString(
    <I18nProvider initial={lang}>
      <App start={{ path, hash: "" }} secure theme="system" prerender />
    </I18nProvider>,
  );
  return { markup, title: pageTitle(t, path), description: description(t, path) };
}
