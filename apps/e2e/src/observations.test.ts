import assert from "node:assert/strict";
import { test } from "node:test";
import { assertActorName, stripFragment, testDirName, testSlug } from "./observations.ts";

test("strips the fragment from a URL", () => {
  assert.equal(
    stripFragment("https://localhost:51234/r/abc123#k=c2VjcmV0LWtleQ"),
    "https://localhost:51234/r/abc123",
  );
  assert.equal(stripFragment("https://localhost:51234/?q=1#"), "https://localhost:51234/?q=1");
  assert.equal(stripFragment("https://localhost:51234/#a#b"), "https://localhost:51234/");
});

test("keeps a URL without a fragment as it is", () => {
  assert.equal(stripFragment("https://localhost:51234/a?b=c"), "https://localhost:51234/a?b=c");
  assert.equal(stripFragment(""), "");
});

test("builds a readable slug with a hash suffix", () => {
  const slug = testSlug(["chromium", "smoke.spec.ts", "Smoke", "opens the app in two contexts"]);
  assert.match(slug, /^chromium-smoke-smoke-opens-the-app-in-two-contexts-[0-9a-f]{8}$/);
});

test("gives similar titles different slugs", () => {
  const a = testSlug(["chromium", "a.spec.ts", "sends a/b"]);
  const b = testSlug(["chromium", "a.spec.ts", "sends a b"]);
  assert.notEqual(a, b);
  assert.equal(a.replace(/-[0-9a-f]{8}$/, ""), b.replace(/-[0-9a-f]{8}$/, ""));
  assert.notEqual(testSlug(["x", "y z"]), testSlug(["x y", "z"]));
});

test("is stable for the same title path", () => {
  const path = ["chromium", "smoke.spec.ts", "räksmörgås"];
  assert.equal(testSlug(path), testSlug([...path]));
  assert.match(testSlug(path), /^chromium-smoke-raksmorgas-[0-9a-f]{8}$/);
});

test("keeps slugs short and safe as a directory name", () => {
  const slug = testSlug(["chromium", "x".repeat(300), "../../etc/passwd"]);
  assert.ok(slug.length <= 89, slug);
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.match(testSlug(["***"]), /^[0-9a-f]{8}$/);
});

test("accepts simple actor names only", () => {
  assertActorName("sender");
  assertActorName("recipient-2");
  assert.throws(() => assertActorName(""));
  assert.throws(() => assertActorName("Sender"));
  assert.throws(() => assertActorName("../x"));
  assert.throws(() => assertActorName("2nd"));
});

test("names a test's directory after its project and title path", () => {
  const first = { project: { name: "chromium" }, titlePath: ["a.spec.ts", "sends"] };
  const name = testDirName({ ...first, retry: 0, repeatEachIndex: 0 });
  assert.equal(name, testSlug(["chromium", "a.spec.ts", "sends"]));
  assert.match(name, /^chromium-a-sends-[0-9a-f]{8}$/);
});

test("gives retries and repeats a directory of their own", () => {
  const first = { project: { name: "chromium" }, titlePath: ["a.spec.ts", "sends"] };
  const names = [
    testDirName({ ...first, retry: 0, repeatEachIndex: 0 }),
    testDirName({ ...first, retry: 1, repeatEachIndex: 0 }),
    testDirName({ ...first, retry: 0, repeatEachIndex: 1 }),
    testDirName({ ...first, retry: 1, repeatEachIndex: 1 }),
  ];
  assert.equal(new Set(names).size, names.length);
  assert.match(names[1] ?? "", /^chromium-a-sends-retry-1-[0-9a-f]{8}$/);
  assert.match(names[2] ?? "", /^chromium-a-sends-repeat-1-[0-9a-f]{8}$/);
  assert.match(names[3] ?? "", /^chromium-a-sends-repeat-1-retry-1-[0-9a-f]{8}$/);
});
