import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { previewPage } from "./preview.ts";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("each page copy carries its own link preview in its own language", () => {
  const receiveSv = previewPage(html, "sv", "receive");
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

  const homeEn = previewPage(html, "en", "home");
  assert.ok(homeEn.includes(`<html lang="en">`));
  assert.ok(
    homeEn.includes(`<meta property="og:title" content="Private file transfer with Fidant" />`),
  );
  assert.ok(
    homeEn.includes(
      `<meta property="og:description" content="Files encrypted in your browser, readable only by the recipient unless you ask us to email the link." />`,
    ),
  );
  assert.ok(
    homeEn.includes(`<meta property="og:image" content="https://fidant.se/preview.png" />`),
  );

  const receiveEn = previewPage(html, "en", "receive");
  assert.ok(receiveEn.includes(`content="Open the link to receive it. It's encrypted`));
});

test("previewPage refuses a page whose anchors moved", () => {
  assert.throws(() => previewPage("<html>", "en", "home"), /expected <html lang="en"> once/);
});
