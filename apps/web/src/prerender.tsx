// Renders the public pages at build time (see vite.config.ts), with no browser around.

import { renderToString } from "preact-render-to-string";
import { App, pageDescription, pageTitle } from "./App.tsx";
import { STEPS } from "./how/steps.tsx";
import { I18nProvider } from "./i18n/I18n.tsx";
import { type Lang, MESSAGES } from "./i18n/language.ts";

/** Every public page, by its English path. */
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

export function renderPage(
  path: string,
  lang: Lang,
): { markup: string; title: string; description: string } {
  const t = MESSAGES[lang];
  const markup = renderToString(
    <I18nProvider initial={lang}>
      <App secure theme="system" prerender={path} />
    </I18nProvider>,
  );
  if (markup.includes(' style="')) {
    throw new Error(`renderPage: ${path} renders a style attribute, which the CSP blocks`);
  }
  return { markup, title: pageTitle(t, path), description: pageDescription(t, path) };
}
