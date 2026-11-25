import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pageHtml } from "./preview.ts";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("the receive copy carries its link preview in its language, with no canonical or script", () => {
  const receiveSv = pageHtml(html, {
    lang: "sv",
    title: "Ta emot – Fidant",
    description: "Öppna länken",
    ogTitle: "Skickat till dig med Fidant",
    image: "preview-receive.png",
  });
  assert.ok(receiveSv.includes(`<html lang="sv">`));
  assert.ok(
    receiveSv.includes(`<meta property="og:title" content="Skickat till dig med Fidant" />`),
  );
  assert.ok(
    receiveSv.includes(
      `<meta property="og:image" content="https://fidant.se/preview-receive.png" />`,
    ),
  );
  assert.ok(receiveSv.includes(`<meta name="twitter:card" content="summary_large_image" />`));
  assert.equal(receiveSv.match(/<meta name="description"/g)?.length, 1);
  assert.ok(receiveSv.includes(`<title>Ta emot – Fidant</title>`));
  assert.ok(receiveSv.includes(">Krypteringen sker i din webbläsare,"));
  assert.ok(!receiveSv.includes("canonical"));
  assert.ok(!receiveSv.includes("<script src"));
  assert.ok(receiveSv.includes(`<div id="app"></div>`));
});

test("a public page gets its canonical, hreflang links, script and markup", () => {
  const page = pageHtml(html, {
    lang: "sv",
    title: "Om Fidant – Fidant",
    description: `Ett "citat" & <mer>`,
    image: "preview.png",
    path: "/about",
    script: { src: "/assets/prepaint-x.js" },
    markup: "<main>Om</main>",
  });
  assert.ok(page.includes(`<link rel="canonical" href="https://fidant.se/sv/om" />`));
  assert.ok(page.includes(`<meta property="og:url" content="https://fidant.se/sv/om" />`));
  assert.ok(page.includes(`<link rel="alternate" hreflang="en" href="https://fidant.se/about" />`));
  assert.ok(page.includes(`<link rel="alternate" hreflang="sv" href="https://fidant.se/sv/om" />`));
  assert.ok(
    page.includes(`<link rel="alternate" hreflang="x-default" href="https://fidant.se/about" />`),
  );
  assert.ok(page.includes(`content="Ett &quot;citat&quot; &amp; &lt;mer>"`));
  assert.ok(page.includes(`<script src="/assets/prepaint-x.js"></script>`));
  assert.ok(page.includes(`<div id="app"><main>Om</main></div>`));

  const home = pageHtml(html, {
    lang: "en",
    title: "Fidant",
    description: "d",
    image: "preview.png",
    path: "/",
    script: { src: "/assets/prepaint-x.js", sv: "/sv" },
  });
  assert.ok(home.includes(`<link rel="canonical" href="https://fidant.se/" />`));
  assert.ok(home.includes(`<link rel="alternate" hreflang="sv" href="https://fidant.se/sv" />`));
  assert.ok(home.includes(`<script src="/assets/prepaint-x.js" data-sv="/sv"></script>`));
});

test("pageHtml refuses a page whose anchors moved", () => {
  assert.throws(
    () => pageHtml("<html>", { lang: "en", title: "", description: "", image: "preview.png" }),
    /expected <html lang="en"> once/,
  );
});
