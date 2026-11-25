import assert from "node:assert/strict";
import { test } from "node:test";
import { barePath, localizedPath, pathLanguage, SWEDISH_PATHS } from "./language.ts";

test("barePath and localizedPath map each page to its address in each language", () => {
  for (const [path, bare, sv] of [
    ["/", "/", "/sv"],
    ["/sv", "/", "/sv"],
    ["/sv/", "/", "/sv"],
    ["/about", "/about", "/sv/om"],
    ["/sv/om", "/about", "/sv/om"],
    ["/sv/om/", "/about", "/sv/om"],
    ["/how", "/how", "/sv/sa-fungerar-det"],
    ["/sv/sa-fungerar-det", "/how", "/sv/sa-fungerar-det"],
    ["/how/link", "/how/link", "/sv/sa-fungerar-det/lanken"],
    ["/sv/sa-fungerar-det/lanken", "/how/link", "/sv/sa-fungerar-det/lanken"],
    ["/how/traces", "/how/traces", "/sv/sa-fungerar-det/lamnas-kvar"],
  ] as const) {
    assert.equal(barePath(path), bare, path);
    assert.equal(localizedPath(path, "en"), bare, path);
    assert.equal(localizedPath(path, "sv"), sv, path);
  }
  assert.equal(localizedPath("/about/", "sv"), "/sv/om");
});

test("a path that is no page keeps its address in both languages", () => {
  for (const path of [
    "/sv/security",
    "/sv/how/link",
    "/sv/sa-fungerar-det/link",
    "/sakerhet",
    "/no-such-page",
    "/svenska",
    "/sv//x",
    "/r/abc",
    "/sv/r/abc",
  ]) {
    assert.equal(barePath(path), path, path);
    assert.equal(localizedPath(path, "en"), path, path);
    assert.equal(localizedPath(path, "sv"), path, path);
  }
});

test("localizedPath keeps a query and an anchor", () => {
  assert.equal(localizedPath("/how#relay", "sv"), "/sv/sa-fungerar-det#relay");
  assert.equal(localizedPath("/how/tech?x=1#y", "sv"), "/sv/sa-fungerar-det/ordlista?x=1#y");
  assert.equal(localizedPath("/sv/sa-fungerar-det#relay", "en"), "/how#relay");
  assert.equal(localizedPath("/r/abc#key", "sv"), "/r/abc#key");
});

test("every Swedish address is unique, plain ASCII and under its parent page's", () => {
  const swedish = Object.values(SWEDISH_PATHS);
  assert.equal(new Set(swedish).size, swedish.length);
  for (const [english, path] of Object.entries(SWEDISH_PATHS)) {
    assert.match(path, /^(?:\/[a-z]+(?:-[a-z]+)*)+$/, english);
    assert.equal(barePath(`/sv${path}`), english);
    const parent = english.slice(0, english.lastIndexOf("/"));
    if (parent) {
      assert.ok(path.startsWith(`${SWEDISH_PATHS[parent]}/`), english);
    }
  }
});

test("pathLanguage reads the language from the path", () => {
  for (const [path, lang] of [
    ["/", "en"],
    ["/about", "en"],
    ["/svenska", "en"],
    ["/sv", "sv"],
    ["/sv/", "sv"],
    ["/sv/om", "sv"],
    ["/sv/security", "sv"],
    ["/r/abc", undefined],
  ] as const) {
    assert.equal(pathLanguage(path), lang, path);
  }
});
