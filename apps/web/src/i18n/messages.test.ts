import assert from "node:assert/strict";
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
    "What happened, like a link being opened, with the first 6 characters of a link ID, how many links a sender has, message sizes, why a link or connection was refused, error codes, whether each connection was direct, went through our relay or failed, and the port the server listens on. Never names, keys, file data or IP addresses.",
  );
  assert.equal(
    sv.server.logs,
    "Vad som hände, till exempel att en länk öppnades, med de 6 första tecknen i ett länk-ID, hur många länkar en avsändare har, meddelandens storlek, varför en länk eller anslutning nekades, felkoder, om varje anslutning gick direkt, via vårt relä eller misslyckades och porten servern lyssnar på. Aldrig namn, nycklar, filinnehåll eller IP-adresser.",
  );
});
