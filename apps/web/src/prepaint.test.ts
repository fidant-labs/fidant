import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { pickLanguage } from "./i18n/language.ts";

const source = readFileSync(new URL("prepaint.js", import.meta.url), "utf8");

function run(options: {
  stored?: Record<string, string>;
  blocked?: boolean;
  browser?: string;
  sv?: string;
  search?: string;
  hash?: string;
}) {
  const html: { hidden: boolean; dataset: Record<string, string> } = { hidden: false, dataset: {} };
  const replaced: { url: string; hidden: boolean }[] = [];
  const storage = {
    getItem(key: string) {
      if (options.blocked) {
        throw new Error("blocked");
      }
      return options.stored?.[key] ?? null;
    },
  };
  runInNewContext(source, {
    document: {
      documentElement: html,
      currentScript: { dataset: options.sv === undefined ? {} : { sv: options.sv } },
    },
    localStorage: storage,
    navigator: { language: options.browser ?? "en-US" },
    location: {
      search: options.search ?? "",
      hash: options.hash ?? "",
      replace(url: string) {
        replaced.push({ url, hidden: html.hidden });
      },
    },
  });
  return { html, replaced };
}

test("follows pickLanguage for every stored and browser language", () => {
  for (const stored of [undefined, "sv", "en", "xx"]) {
    for (const browser of ["sv-SE", "sv", "en-US", "svx"]) {
      const { replaced } = run({
        stored: stored === undefined ? {} : { lang: stored },
        browser,
        sv: "/sv/about",
      });
      const swedish = pickLanguage(stored ?? null, browser) === "sv";
      assert.deepEqual(
        replaced.map((r) => r.url),
        swedish ? ["/sv/about"] : [],
        `${stored} ${browser}`,
      );
    }
  }
});

test("keeps query and fragment and hides the page first", () => {
  const { replaced } = run({ browser: "sv-SE", sv: "/sv/how", search: "?a=1", hash: "#relay" });
  assert.deepEqual(replaced, [{ url: "/sv/how?a=1#relay", hidden: true }]);
});

test("never redirects without data-sv", () => {
  const { html, replaced } = run({ stored: { lang: "sv" }, browser: "sv-SE" });
  assert.deepEqual(replaced, []);
  assert.equal(html.hidden, false);
});

test("applies a stored theme", () => {
  assert.equal(run({ stored: { theme: "dark" } }).html.dataset.theme, "dark");
  assert.equal(run({ stored: { theme: "light" } }).html.dataset.theme, "light");
  assert.equal(run({ stored: { theme: "neon" } }).html.dataset.theme, undefined);
});

test("survives blocked storage and falls back to the browser language", () => {
  const { html, replaced } = run({ blocked: true, browser: "sv-SE", sv: "/sv" });
  assert.equal(html.dataset.theme, undefined);
  assert.deepEqual(
    replaced.map((r) => r.url),
    ["/sv"],
  );
});
