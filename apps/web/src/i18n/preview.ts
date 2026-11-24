import { type Lang, MESSAGES } from "./language.ts";

export type PreviewKind = "home" | "receive";

/** Link previews read only this static head, so each kind and language gets its own copy. */
export function previewPage(html: string, lang: Lang, kind: PreviewKind): string {
  const t = MESSAGES[lang];
  const [title, description, image] =
    kind === "receive"
      ? [t.preview.receiveTitle, t.preview.receiveDescription, "preview-receive.png"]
      : [t.preview.title, t.footer.tagline, "preview.png"];
  const tags = [
    `<meta name="description" content="${attribute(description)}" />`,
    `<meta property="og:site_name" content="Fidant" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${attribute(title)}" />`,
    `<meta property="og:description" content="${attribute(description)}" />`,
    // Previews can't reach a local server, so the image always names the live site.
    `<meta property="og:image" content="https://fidant.se/${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ];
  const english = `<meta name="description" content="${attribute(MESSAGES.en.footer.tagline)}" />`;
  return replaceOnce(
    replaceOnce(html, `<html lang="en">`, `<html lang="${lang}">`),
    english,
    tags.join("\n    "),
  );
}

function replaceOnce(html: string, from: string, to: string): string {
  const parts = html.split(from);
  if (parts.length !== 2) {
    throw new Error(`previewPage: expected ${from} once, found it ${parts.length - 1} times`);
  }
  return parts.join(to);
}

function attribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
