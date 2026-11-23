import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seededChunks } from "../bench/generator.ts";
import { expectedSha256, verifyDownload } from "./verify.ts";

const SIZE = 300_000;

function seeded(seed: number, size: number): Buffer {
  return Buffer.concat([...seededChunks(seed, size, 4096)]);
}

test("the expected digest is SHA-256 of the seeded stream", () => {
  const direct = createHash("sha256").update(seeded(5, SIZE)).digest("hex");
  assert.equal(expectedSha256(5, SIZE), direct);
});

test("verifies a correct download and catches a wrong one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "split-key-verify-"));
  try {
    const path = join(dir, "out.bin");
    await writeFile(path, seeded(5, SIZE));
    const good = await verifyDownload(path, 5, SIZE);
    assert.equal(good.sizeMatches, true);
    assert.equal(good.sha256Matches, true);

    const flipped = seeded(5, SIZE);
    flipped[SIZE - 1] = (flipped[SIZE - 1] ?? 0) ^ 1;
    await writeFile(path, flipped);
    assert.equal((await verifyDownload(path, 5, SIZE)).sha256Matches, false);

    await writeFile(path, seeded(5, SIZE - 1));
    const short = await verifyDownload(path, 5, SIZE);
    assert.equal(short.sizeMatches, false);
    assert.equal(short.size, SIZE - 1);
    assert.equal(short.sha256Matches, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
