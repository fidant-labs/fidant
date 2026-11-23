import assert from "node:assert/strict";
import { test } from "node:test";
import { paddedLength as webPaddedLength } from "../../../apps/web/src/lib/frames.ts";
import { chunkCount, MAX_PADDABLE_SIZE, overhead, paddedLength } from "./padding.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const CHUNK_SIZES = [48 * KiB, 256 * KiB, MiB, 4 * MiB];

// Small sizes, both sides of each power of two, and a few odd ones.
const SIZES = [
  0,
  1,
  2,
  3,
  1000,
  12345,
  48 * KiB - 1,
  48 * KiB,
  48 * KiB + 1,
  ...Array.from({ length: 50 }, (_, i) => [
    2 ** (i + 2) - 1,
    2 ** (i + 2),
    2 ** (i + 2) + 1,
  ]).flat(),
  987654321,
  5 * GiB,
  5 * GiB + 12345,
  MAX_PADDABLE_SIZE,
];

/** Padmé with chunk rounding in BigInt, as an exact reference. */
function referencePaddedLength(size: number, chunkSize: number): bigint {
  const length = BigInt(Math.max(size, 1));
  let padded = length;
  if (length >= 2n) {
    const e = BigInt(length.toString(2).length - 1);
    const s = BigInt(e.toString(2).length);
    const step = 1n << (e - s);
    padded = ((length + step - 1n) / step) * step;
  }
  const chunk = BigInt(chunkSize);
  return ((padded + chunk - 1n) / chunk) * chunk;
}

test("matches apps/web paddedLength at 48 KiB", () => {
  for (const size of SIZES) {
    assert.equal(paddedLength(size, 48 * KiB), webPaddedLength(size, 48 * KiB), `size ${size}`);
  }
});

test("matches an exact BigInt reference at every chunk size", () => {
  for (const chunkSize of CHUNK_SIZES) {
    for (const size of SIZES) {
      assert.equal(
        BigInt(paddedLength(size, chunkSize)),
        referencePaddedLength(size, chunkSize),
        `size ${size}, chunk ${chunkSize}`,
      );
    }
  }
});

test("pads sizes past 2^32 without precision loss", () => {
  // 5 GiB + 1: E = 32, S = 6, so Padmé rounds up to a multiple of 2^26.
  assert.equal(paddedLength(5 * GiB + 1, 48 * KiB), 5 * GiB + 2 ** 26);
  assert.equal(paddedLength(5 * GiB + 1, 4 * MiB), 5 * GiB + 2 ** 26);
  assert.ok(Number.isSafeInteger(paddedLength(MAX_PADDABLE_SIZE, 4 * MiB)));
});

test("an empty file pads to one chunk, like a 1-byte file", () => {
  for (const chunkSize of CHUNK_SIZES) {
    assert.equal(paddedLength(0, chunkSize), chunkSize);
    assert.equal(paddedLength(1, chunkSize), chunkSize);
    assert.equal(chunkCount(paddedLength(0, chunkSize), chunkSize), 1);
  }
});

test("is monotonic and never shorter than the file", () => {
  for (const chunkSize of CHUNK_SIZES) {
    let previous = 0;
    for (let size = 0; size < 200_000; size += 7) {
      const padded = paddedLength(size, chunkSize);
      assert.ok(padded >= previous, `size ${size}`);
      assert.ok(padded >= size, `size ${size}`);
      previous = padded;
    }
    const sorted = SIZES.toSorted((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        paddedLength(sorted[i] as number, chunkSize) >=
          paddedLength(sorted[i - 1] as number, chunkSize),
      );
    }
  }
});

test("overhead stays within Padmé's 12 % plus one chunk", () => {
  for (const chunkSize of CHUNK_SIZES) {
    for (const size of SIZES) {
      const { padded, bytes, ratio } = overhead(size, chunkSize);
      assert.equal(padded, paddedLength(size, chunkSize));
      assert.equal(bytes, padded - size);
      assert.equal(ratio, bytes / Math.max(size, 1));
      assert.ok(bytes < 0.12 * Math.max(size, 1) + chunkSize, `size ${size}, chunk ${chunkSize}`);
    }
  }
});

test("chunkCount divides a padded length into whole chunks", () => {
  assert.equal(chunkCount(paddedLength(5 * GiB + 1, MiB), MiB), 5 * 1024 + 64);
  assert.equal(chunkCount(4 * MiB, MiB), 4);
  assert.throws(() => chunkCount(0, MiB), /positive multiple/);
  assert.throws(() => chunkCount(MiB + 1, MiB), /positive multiple/);
  assert.throws(() => chunkCount(1.5 * MiB, MiB), /positive multiple/);
  assert.throws(() => chunkCount(MiB, 0), /chunk size/);
});

test("rejects invalid sizes and chunk sizes", () => {
  for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PADDABLE_SIZE + 1]) {
    assert.throws(() => paddedLength(size, MiB), /size out of range/, `size ${size}`);
    assert.throws(() => overhead(size, MiB), /size out of range/, `size ${size}`);
  }
  for (const chunkSize of [0, -1, 1.5, Number.NaN, 64 * MiB + 1]) {
    assert.throws(() => paddedLength(1, chunkSize), /chunk size out of range/, `${chunkSize}`);
  }
});
