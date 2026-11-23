import assert from "node:assert/strict";
import { test } from "node:test";
import { SeededBytes, seededChunks } from "./generator.ts";

function concat(chunks: Iterable<Uint8Array>): Uint8Array {
  const parts = [...chunks];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test("the stream for a seed is fixed", () => {
  // Pinned so the runner's Node-side verification and the browser agree forever.
  const out = new Uint8Array(16);
  new SeededBytes(1).fill(out);
  assert.equal(Buffer.from(out).toString("hex"), "bcf42285f0df31b5e2819712b2a328b6");
});

test("the same seed gives the same bytes, another seed different ones", () => {
  const a = concat(seededChunks(42, 100_000, 4096));
  const b = concat(seededChunks(42, 100_000, 4096));
  const c = concat(seededChunks(43, 100_000, 4096));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("chunk boundaries do not change the bytes", () => {
  // Spans several internal 64 KiB blocks and ends mid-word.
  const total = 200_003;
  const reference = concat(seededChunks(9, total, total));
  for (const chunkSize of [1, 3, 7, 4096, 65_537, 300_000]) {
    assert.deepEqual(
      concat(seededChunks(9, total, chunkSize)),
      reference,
      `chunkSize ${chunkSize}`,
    );
  }
  // Uneven fill() calls on one instance give the same stream too.
  const source = new SeededBytes(9);
  const pieces = [5, 65_531, 1, 2, 134_464].map((length) => {
    const piece = new Uint8Array(length);
    source.fill(piece);
    return piece;
  });
  assert.deepEqual(concat(pieces), reference);
});

test("yields exactly totalBytes with a short last chunk", () => {
  const lengths = [...seededChunks(1, 10_000, 4096)].map((chunk) => chunk.length);
  assert.deepEqual(lengths, [4096, 4096, 1808]);
  assert.deepEqual([...seededChunks(1, 0, 4096)], []);
});

test("rejects bad arguments", () => {
  assert.throws(() => new SeededBytes(-1));
  assert.throws(() => new SeededBytes(2 ** 32));
  assert.throws(() => [...seededChunks(1, 10, 0)]);
  assert.throws(() => [...seededChunks(1, -1, 10)]);
});
