import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Log lines go only to the journal. openssl, not these calls, writes the certificate.
const allowedWrites: Record<string, number> = { "relays.ts": 1 };

test("the server writes no log files, only the relay master in relays.ts", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), "utf8");
    const writes = source.match(
      /\b(writeFile|appendFile|createWriteStream|open|writeSync)\w*\s*\(/g,
    );
    assert.equal(writes?.length ?? 0, allowedWrites[file] ?? 0, file);
  }
});
