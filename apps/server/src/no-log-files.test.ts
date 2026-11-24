import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The box keeps log lines only in the journal, so the server must not write files.
// The certificate is written by openssl (execFileSync), not by these calls.
test("the server writes no log files", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(
      source,
      /\b(writeFile|appendFile|createWriteStream|open|writeSync)\w*\s*\(/,
      file,
    );
  }
});
