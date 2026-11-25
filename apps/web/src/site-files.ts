// The files the build writes for search engines and AI assistants, from the same page list as the prerender.
// The client imports ORIGIN and pageUrl from here too, so it must not import node: modules.

import { type Lang, localizedPath } from "./i18n/language.ts";

export const ORIGIN = "https://fidant.se";

/** The canonical address of a page in `lang`: no trailing slash except the root. */
export function pageUrl(path: string, lang: Lang): string {
  return ORIGIN + localizedPath(path, lang);
}

export function sitemap(urls: readonly string[]): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...urls.map((url) => `  <url><loc>${url}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

type LlmsSection = {
  heading: string;
  pages: ReadonlyArray<{ title: string; description: string; url: string }>;
};

/** The llms.txt format (https://llmstxt.org): a title, a summary, then sections of links. */
export function llmsTxt(tagline: string, sections: readonly LlmsSection[]): string {
  return [
    "# Fidant",
    `> ${tagline}`,
    ...sections.map(({ heading, pages }) =>
      [
        `## ${heading}`,
        pages
          .map(({ title, description, url }) => `- [${title}](${url}): ${description}`)
          .join("\n"),
      ].join("\n\n"),
    ),
  ]
    .join("\n\n")
    .concat("\n");
}
