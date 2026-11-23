import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  base32Token,
  canaryFile,
  canaryKey,
  defaultChunkSize,
  formatSeed,
  pickCanarySize,
  runSeed,
  SeededRandom,
  sizeIsCheckable,
} from "./canary.ts";

const seed = createHash("sha256").update("canary test").digest();

test("is SHA-256 in counter mode over the seed", () => {
  const block = (counter: number) => {
    const counterBytes = Buffer.alloc(8);
    counterBytes.writeBigUInt64BE(BigInt(counter));
    return createHash("sha256").update(seed).update(counterBytes).digest();
  };
  const expected = Buffer.concat([block(0), block(1), block(2)]);
  assert.deepEqual(new SeededRandom(seed).bytes(96), expected);
});

test("gives the same stream for the same seed, however it is read", () => {
  const whole = new SeededRandom(seed).bytes(100);
  const random = new SeededRandom(seed);
  const parts = Buffer.concat([
    random.bytes(7),
    random.bytes(0),
    random.bytes(40),
    random.bytes(53),
  ]);
  assert.deepEqual(parts, whole);
  assert.notDeepEqual(SeededRandom.fromLabel("other").bytes(100), whole);
});

test("forks independent streams by label", () => {
  const random = new SeededRandom(seed);
  const a = random.fork("a").bytes(32);
  assert.deepEqual(new SeededRandom(seed).fork("a").bytes(32), a);
  assert.notDeepEqual(random.fork("b").bytes(32), a);
  assert.notDeepEqual(new SeededRandom(seed).bytes(32), a);
});

test("draws uniform integers below a bound", () => {
  const random = new SeededRandom(seed);
  const counts = new Map<number, number>();
  for (let i = 0; i < 3000; i++) {
    const value = random.int(3);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  assert.deepEqual([...counts.keys()].sort(), [0, 1, 2]);
  for (const count of counts.values()) {
    assert.ok(count > 900 && count < 1100, String(count));
  }
  assert.equal(random.int(1), 0);
  assert.throws(() => random.int(0));
});

test("reads the seed from SIGILL_E2E_SEED or makes a random one", () => {
  const hex = formatSeed(seed);
  assert.deepEqual(runSeed(hex), seed);
  assert.deepEqual(runSeed(hex.toUpperCase()), seed);
  assert.equal(runSeed(undefined).length, 32);
  assert.equal(runSeed("").length, 32);
  assert.notDeepEqual(runSeed(undefined), runSeed(undefined));
  assert.throws(() => runSeed("abc"), /SIGILL_E2E_SEED/);
  assert.throws(() => runSeed(`${hex.slice(2)}zz`), /SIGILL_E2E_SEED/);
});

test("makes lowercase base32 tokens", () => {
  const token = base32Token(new SeededRandom(seed));
  assert.match(token, /^[a-z2-7]{16}$/);
  assert.match(base32Token(new SeededRandom(seed), 5), /^[a-z2-7]{5}$/);
});

test("picks sizes with six digits that are off every chunk boundary", () => {
  const random = new SeededRandom(seed);
  for (let i = 0; i < 200; i++) {
    const size = pickCanarySize(random, { max: 300_000 });
    assert.ok(size >= 100_000 && size <= 300_000, String(size));
    assert.notEqual(size % defaultChunkSize, 0);
  }
  // A range with a single boundary in it can still be satisfied.
  const tight = pickCanarySize(random, { min: 3 * 49_152, max: 3 * 49_152 + 1 });
  assert.equal(tight, 3 * 49_152 + 1);
  assert.throws(() => pickCanarySize(random, { min: 99_999 }));
});

test("says when the size check applies", () => {
  assert.equal(sizeIsCheckable(0), false);
  assert.equal(sizeIsCheckable(defaultChunkSize), false);
  assert.equal(sizeIsCheckable(99_999), false);
  assert.equal(sizeIsCheckable(4 * defaultChunkSize), false);
  assert.equal(sizeIsCheckable(123_457), true);
  assert.equal(sizeIsCheckable(100_000, 1000), false);
});

test("makes a canary file with random bytes, name and type", () => {
  const file = canaryFile(new SeededRandom(seed).fork("file"));
  assert.equal(file.bytes.length, file.size);
  assert.ok(sizeIsCheckable(file.size));
  assert.match(file.name, /^sigill-[a-z2-7]{16}-räksmörgås\.[a-z]{3}$/);
  assert.equal(file.name, file.name.normalize("NFC"));
  assert.ok(file.name.includes(file.token));
  assert.equal(file.mime, `application/x-sigill-${file.mimeToken}`);
  assert.notEqual(file.token, file.mimeToken);
  assert.deepEqual(canaryFile(new SeededRandom(seed).fork("file")), file);
});

test("makes canary files of exact sizes", () => {
  const random = new SeededRandom(seed);
  assert.equal(canaryFile(random, { size: 0 }).bytes.length, 0);
  assert.equal(canaryFile(random, { size: defaultChunkSize }).bytes.length, defaultChunkSize);
  assert.match(canaryFile(random, { ext: "txt" }).name, /\.txt$/);
});

test("makes keys shaped like a fragment secret", () => {
  const key = canaryKey(new SeededRandom(seed));
  assert.equal(key.bytes.length, 32);
  assert.match(key.text, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Buffer.from(key.text, "base64url"), key.bytes);
});
