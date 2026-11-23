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
