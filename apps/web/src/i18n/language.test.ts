import assert from "node:assert/strict";
import { test } from "node:test";
import { barePath, localizedPath, pathLanguage } from "./language.ts";

test("barePath and localizedPath swap the /sv prefix", () => {
  for (const [path, bare, sv] of [
    ["/", "/", "/sv"],
    ["/sv", "/", "/sv"],
    ["/sv/", "/", "/sv"],
    ["/about", "/about", "/sv/about"],
    ["/sv/how/link", "/how/link", "/sv/how/link"],
    ["/svenska", "/svenska", "/sv/svenska"],
  ] as const) {
    assert.equal(barePath(path), bare, path);
    assert.equal(localizedPath(path, "en"), bare, path);
    assert.equal(localizedPath(path, "sv"), sv, path);
  }
});

test("receive paths keep no prefix", () => {
  for (const lang of ["en", "sv"] as const) {
    assert.equal(localizedPath("/r/abc", lang), "/r/abc");
  }
});

test("pathLanguage reads the language from the path", () => {
  for (const [path, lang] of [
    ["/", "en"],
    ["/about", "en"],
    ["/svenska", "en"],
    ["/sv", "sv"],
    ["/sv/", "sv"],
    ["/sv/how/link", "sv"],
    ["/r/abc", undefined],
  ] as const) {
    assert.equal(pathLanguage(path), lang, path);
  }
});
