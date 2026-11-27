import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// 0029: no tracked file carries the earlier name or an old issue key. The name is split so
// this file doesn't match its own search.
const earlier = ["si", "gill"].join("");

test("no tracked file carries the earlier name or an old issue key", () => {
  const pattern = `(?i:${earlier})|(?i:sig-\\d)`;
  let found = "";
  try {
    found = execFileSync("git", ["grep", "-n", "-I", "-P", pattern], {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
    });
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status !== 1) {
      throw error;
    }
  }
  assert.equal(found, "");
});
