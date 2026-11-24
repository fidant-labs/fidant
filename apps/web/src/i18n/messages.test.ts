import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { en } from "./en.ts";
import { pickLanguage } from "./language.ts";
import { sv } from "./sv.ts";

/** Every key path with the type of its value, like "menu.send: string". */
function shape(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") {
    return [`${path}: ${typeof value}`];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    shape(child, path ? `${path}.${key}` : key),
  );
}

test("Swedish and English have the same keys", () => {
  assert.deepEqual(shape(sv).sort(), shape(en).sort());
});

test("pickLanguage prefers the stored choice, then a Swedish browser", () => {
  assert.equal(pickLanguage("en", "sv-SE"), "en");
  assert.equal(pickLanguage("sv", "en-US"), "sv");
  assert.equal(pickLanguage(null, "sv-SE"), "sv");
  assert.equal(pickLanguage(null, "sv"), "sv");
  assert.equal(pickLanguage(null, "SV-fi"), "sv");
  assert.equal(pickLanguage(null, "en-GB"), "en");
  assert.equal(pickLanguage(null, "svx"), "en");
  assert.equal(pickLanguage("de", "de-DE"), "en");
});

test("server.logs lists every log field and what the server never logs", () => {
  assert.equal(
    en.server.logs,
    "What happened, like a link being opened, with the first 6 characters of a link ID, how many links a sender has, message sizes, why a link, connection, email or code was refused, error codes, whether each connection was direct, went through our relay or failed, and the port the server listens on. Never names, email addresses, emailed codes, keys, file data or IP addresses.",
  );
  assert.equal(
    sv.server.logs,
    "Vad som hände, till exempel att en länk öppnades, med de 6 första tecknen i ett länk-ID, hur många länkar en avsändare har, meddelandens storlek, varför en länk, en anslutning, ett mejl eller en kod nekades, felkoder, om varje anslutning gick direkt, via vårt relä eller misslyckades och porten servern lyssnar på. Aldrig namn, e-postadresser, mejlade koder, nycklar, filinnehåll eller IP-adresser.",
  );
});

test("index.html's meta description is the English tagline", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.ok(html.includes(`<meta name="description" content="${en.footer.tagline}" />`));
});

test("index.html's noscript text is the English landing page", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const noscript = html.match(/<noscript>([\s\S]*)<\/noscript>/)?.[1] ?? "";
  const { title, lede, stepsHeading, steps } = en.landing;
  for (const text of [
    title,
    lede,
    stepsHeading,
    ...steps.map(([step, detail]) => `${step}. ${detail}`),
  ]) {
    assert.ok(noscript.includes(`>${text}<`), text);
  }
  for (const [label, path] of [
    [en.footer.about, "/about"],
    [en.footer.security, "/security"],
    [en.menu.privacy, "/privacy"],
    [en.footer.terms, "/terms"],
    [en.footer.source, "https://github.com/sigill-labs/sigill"],
  ] as const) {
    assert.ok(noscript.includes(`<a href="${path}">${label}</a>`), label);
  }
});
