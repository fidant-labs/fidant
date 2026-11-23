import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkHandoffFragment,
  HANDOFF_FRAGMENT_CHARS,
  inspectLocation,
  makeHandoffFragment,
  makeHandoffLink,
} from "./handoff-check.ts";

// Dummy F = 00..1f. The check is the first 6 bytes of SHA-256(F), computed
// with node:crypto createHash("sha256").
const F = Uint8Array.from({ length: 32 }, (_, i) => i);
const FRAGMENT = "k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8.Yw3NKWbE";

/** Replaces the character at index with another base64url character. */
function swapChar(text: string, index: number): string {
  const replacement = text[index] === "A" ? "B" : "A";
  return text.slice(0, index) + replacement + text.slice(index + 1);
}

test("makeHandoffFragment gives k=, F, a dot and the 8-character check", async () => {
  const fragment = await makeHandoffFragment(F);
  assert.equal(fragment, FRAGMENT);
  assert.equal(fragment.length, HANDOFF_FRAGMENT_CHARS);
  assert.equal(HANDOFF_FRAGMENT_CHARS, 54);
});

test("makeHandoffLink adds the page path and probe query", async () => {
  assert.equal(
    await makeHandoffLink("https://192.0.2.1:8451", F),
    `https://192.0.2.1:8451/handoff.html?probe=1#${FRAGMENT}`,
  );
});

test("an intact fragment passes, with or without the leading #", async () => {
  for (const hash of [FRAGMENT, `#${FRAGMENT}`]) {
    const result = await checkHandoffFragment(hash);
    assert.equal(result.verdict, "intact");
    assert.equal(result.percentDecoded, false);
    assert.deepEqual(result.parts, { prefix: true, length: true, charset: true, check: true });
  }
});

test("a fragment one character short is truncated", async () => {
  const result = await checkHandoffFragment(`#${FRAGMENT.slice(0, -1)}`);
  assert.equal(result.verdict, "truncated");
  assert.equal(result.receivedLength, HANDOFF_FRAGMENT_CHARS - 1);
  assert.equal(result.parts.length, false);
});

test("a fragment cut inside F is truncated", async () => {
  const result = await checkHandoffFragment(`#${FRAGMENT.slice(0, 20)}`);
  assert.equal(result.verdict, "truncated");
});

test("a changed character in F or in the check is altered", async () => {
  // Index 10 is inside F, index 50 inside the check.
  for (const index of [10, 50]) {
    const result = await checkHandoffFragment(`#${swapChar(FRAGMENT, index)}`);
    assert.equal(result.verdict, "altered", `index ${index}`);
    assert.equal(result.parts.check, false);
  }
});

test("a character outside base64url is altered", async () => {
  const result = await checkHandoffFragment(`#${FRAGMENT.slice(0, 10)}+${FRAGMENT.slice(11)}`);
  assert.equal(result.verdict, "altered");
  assert.equal(result.parts.length, true);
  assert.equal(result.parts.charset, false);
});

test("a changed separator is altered", async () => {
  const result = await checkHandoffFragment(`#${FRAGMENT.replace(".", "_")}`);
  assert.equal(result.verdict, "altered");
});

test("a percent-encoded fragment is accepted after one decode", async () => {
  // Clients have been seen to encode `=` and `.`; base64url characters never need it.
  const encoded = FRAGMENT.replace("=", "%3D").replace(".", "%2E");
  const result = await checkHandoffFragment(`#${encoded}`);
  assert.equal(result.verdict, "intact");
  assert.equal(result.percentDecoded, true);
  assert.equal(result.receivedLength, HANDOFF_FRAGMENT_CHARS + 4);
});

test("a broken percent-encoding is altered", async () => {
  const result = await checkHandoffFragment(`#${FRAGMENT}%E0%A4%A`);
  assert.equal(result.verdict, "altered");
});

test("no fragment, an empty one, or one without k= is missing", async () => {
  for (const hash of ["", "#", "#other=1"]) {
    assert.equal((await checkHandoffFragment(hash)).verdict, "missing", hash);
  }
});

test("characters added before k= are altered", async () => {
  assert.equal((await checkHandoffFragment(`#x${FRAGMENT}`)).verdict, "altered");
});

test("characters after the check are trailing, with F still verified", async () => {
  for (const extra of [")", ".", "%29", "&utm_source=chat"]) {
    const result = await checkHandoffFragment(`#${FRAGMENT}${extra}`);
    assert.equal(result.verdict, "trailing", extra);
    assert.equal(result.parts.check, true);
    assert.ok(result.extraLength > 0);
  }
});

test("inspectLocation sees an unchanged landing URL", () => {
  assert.deepEqual(inspectLocation({ pathname: "/handoff.html", search: "?probe=1" }), {
    pathChanged: false,
    queryChanged: false,
    fragmentInQuery: false,
  });
});

test("inspectLocation sees a rewritten path and query", () => {
  const report = inspectLocation({ pathname: "/handoff", search: "?probe=1&utm_source=x" });
  assert.equal(report.pathChanged, true);
  assert.equal(report.queryChanged, true);
  assert.equal(report.fragmentInQuery, false);
});

test("inspectLocation finds the fragment moved into the query", () => {
  for (const search of [
    `?probe=1&${FRAGMENT}`,
    `?probe=1%23${encodeURIComponent(FRAGMENT)}`,
    `?url=${encodeURIComponent(`https://example.test/handoff.html?probe=1#${FRAGMENT}`)}`,
  ]) {
    const report = inspectLocation({ pathname: "/handoff.html", search });
    assert.equal(report.fragmentInQuery, true, search);
    assert.equal(report.queryChanged, true);
  }
});

test("inspectLocation copes with a query that is not valid percent-encoding", () => {
  const report = inspectLocation({ pathname: "/handoff.html", search: `?%E0&${FRAGMENT}` });
  assert.equal(report.fragmentInQuery, true);
});
