import assert from "node:assert/strict";
import { test } from "node:test";
import { llmsTxt, pageUrl, sitemap } from "./site-files.ts";

test("sitemap lists each URL", () => {
  assert.equal(
    sitemap(["https://fidant.se/", "https://fidant.se/sv"]),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://fidant.se/</loc></url>
  <url><loc>https://fidant.se/sv</loc></url>
</urlset>
`,
  );
});

test("llmsTxt lists each page with its link and description", () => {
  assert.equal(
    llmsTxt("Files encrypted.", [
      {
        heading: "English",
        pages: [{ title: "About", description: "Who.", url: "https://fidant.se/about" }],
      },
      {
        heading: "Svenska",
        pages: [{ title: "Om", description: "Vem.", url: "https://fidant.se/sv/om" }],
      },
    ]),
    `# Fidant

> Files encrypted.

## English

- [About](https://fidant.se/about): Who.

## Svenska

- [Om](https://fidant.se/sv/om): Vem.
`,
  );
});

test("pageUrl names the page in its language", () => {
  assert.equal(pageUrl("/", "en"), "https://fidant.se/");
  assert.equal(pageUrl("/", "sv"), "https://fidant.se/sv");
  assert.equal(pageUrl("/about", "sv"), "https://fidant.se/sv/om");
});
