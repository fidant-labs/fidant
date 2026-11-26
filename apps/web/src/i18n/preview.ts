import { ORIGIN, pageUrl } from "../site-files.ts";
import { type Lang, MESSAGES } from "./language.ts";

export type PageHead = {
  lang: Lang;
  title: string;
  description: string;
  /** The link preview's title, when it differs from the tab title. */
  ogTitle?: string;
  image: "preview.png" | "preview-receive.png";
  /** A public page's English path: adds its canonical and hreflang links. */
  path?: string;
  /** The pre-paint script, and on an English page with a Swedish twin, that twin's path. */
  script?: { src: string; sv?: string | undefined };
  /** The page rendered at build time. */
  markup?: string;
};

/** A copy of the built index.html with this page's head, text and markup; link previews and crawlers read only this. */
export function pageHtml(html: string, page: PageHead): string {
  const t = MESSAGES[page.lang];
  const description = attribute(page.description);
  const tags = [
    `<meta name="description" content="${description}" />`,
    `<meta property="og:site_name" content="Fidant" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${attribute(page.ogTitle ?? page.title)}" />`,
    `<meta property="og:description" content="${description}" />`,
    // Previews can't reach a local server, so the image always names the live site.
    `<meta property="og:image" content="${ORIGIN}/${page.image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ];
  if (page.path !== undefined) {
    const url = (lang: Lang) => pageUrl(page.path ?? "/", lang);
    tags.push(
      `<meta property="og:url" content="${url(page.lang)}" />`,
      `<link rel="canonical" href="${url(page.lang)}" />`,
      `<link rel="alternate" hreflang="en" href="${url("en")}" />`,
      `<link rel="alternate" hreflang="sv" href="${url("sv")}" />`,
      `<link rel="alternate" hreflang="x-default" href="${url("en")}" />`,
    );
  }
  const english = `<meta name="description" content="${attribute(MESSAGES.en.footer.tagline)}" />`;
  let out = replaceOnce(html, `<html lang="en">`, `<html lang="${page.lang}">`);
  out = replaceOnce(out, `<title>Fidant</title>`, `<title>${attribute(page.title)}</title>`);
  out = replaceOnce(out, english, tags.join("\n    "));
  out = replaceOnce(out, `>${MESSAGES.en.noscript}<`, `>${attribute(t.noscript)}<`);
  if (page.script) {
    const sv = page.script.sv === undefined ? "" : ` data-sv="${attribute(page.script.sv)}"`;
    const charset = `<meta charset="utf-8" />`;
    out = replaceOnce(
      out,
      charset,
      `${charset}\n    <script src="${page.script.src}"${sv}></script>`,
    );
  }
  if (page.markup !== undefined) {
    out = replaceOnce(out, `<div id="app"></div>`, `<div id="app">${page.markup}</div>`);
  }
  return out;
}

function replaceOnce(html: string, from: string, to: string): string {
  const parts = html.split(from);
  if (parts.length !== 2) {
    throw new Error(`pageHtml: expected ${from} once, found it ${parts.length - 1} times`);
  }
  return parts.join(to);
}

function attribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
