import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  base32Token,
  canaryFile,
  canaryKey,
  defaultChunkSize,
  formatSeed,
  pickCanarySize,
  runSeed,
  SeededRandom,
  sampledRanges,
  sizeIsCheckable,
  writeLargeCanary,
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

test("reads the seed from FIDANT_E2E_SEED or makes a random one", () => {
  const hex = formatSeed(seed);
  assert.deepEqual(runSeed(hex), seed);
  assert.deepEqual(runSeed(hex.toUpperCase()), seed);
  assert.equal(runSeed(undefined).length, 32);
  assert.equal(runSeed("").length, 32);
  assert.notDeepEqual(runSeed(undefined), runSeed(undefined));
  assert.throws(() => runSeed("abc"), /FIDANT_E2E_SEED/);
  assert.throws(() => runSeed(`${hex.slice(2)}zz`), /FIDANT_E2E_SEED/);
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
  assert.match(file.name, /^fidant-[a-z2-7]{16}-räksmörgås\.[a-z]{3}$/);
  assert.equal(file.name, file.name.normalize("NFC"));
  assert.ok(file.name.includes(file.token));
  assert.equal(file.mime, `application/x-fidant-${file.mimeToken}`);
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

const MiB = 1024 * 1024;
const ranges = (size: number) =>
  sampledRanges(size).map(({ offset, length }) => [offset / MiB, length / MiB]);

test("samples the first and last MiB of a large file and a MiB at every 64 MiB", () => {
  const size = 200 * MiB + 123;
  assert.deepEqual(ranges(size), [
    [0, 1],
    [64, 1],
    [128, 1],
    [192, 1],
    [(size - MiB) / MiB, 1],
  ]);
  assert.deepEqual(ranges(128 * MiB), [
    [0, 1],
    [64, 1],
    [127, 1],
  ]);
});

test("joins a sample at 64 MiB with the last MiB when they overlap or touch", () => {
  assert.deepEqual(ranges(129.5 * MiB), [
    [0, 1],
    [64, 1],
    [128, 1.5],
  ]);
  assert.deepEqual(ranges(130 * MiB), [
    [0, 1],
    [64, 1],
    [128, 2],
  ]);
  assert.deepEqual(ranges(64 * MiB + 1), [
    [0, 1],
    [(63 * MiB + 1) / MiB, 1],
  ]);
});

test("samples all of a file of up to 2 MiB", () => {
  assert.deepEqual(ranges(1.5 * MiB), [[0, 1.5]]);
  assert.deepEqual(ranges(2 * MiB), [[0, 2]]);
  assert.deepEqual(sampledRanges(1000), [{ offset: 0, length: 1000 }]);
  assert.deepEqual(sampledRanges(0), []);
});

test("samples 76 MiB of a 5 GB file", () => {
  const samples = sampledRanges(5e9);
  assert.equal(samples.length, 76);
  assert.equal(
    samples.reduce((sum, { length }) => sum + length, 0),
    76 * MiB,
  );
});

const dir = await mkdtemp(join(tmpdir(), "canary-test-"));
after(() => rm(dir, { recursive: true, force: true }));

test("writes the bytes canaryFile makes and keeps the sampled ones", async () => {
  const size = 3 * MiB + 5;
  const rule = { piece: 300_000, every: 1_000_000 };
  const large = await writeLargeCanary(new SeededRandom(seed).fork("large"), dir, { size, rule });
  const { bytes, ...head } = canaryFile(new SeededRandom(seed).fork("large"), { size });
  assert.deepEqual(await readFile(large.path), bytes);
  assert.equal(large.path, join(dir, head.name));
  assert.deepEqual(large.sha256, createHash("sha256").update(bytes).digest());
  for (const key of Object.keys(head) as (keyof typeof head)[]) {
    assert.equal(large[key], head[key], key);
  }
  assert.deepEqual(
    large.samples.map(({ offset, bytes }) => ({ offset, length: bytes.length })),
    sampledRanges(size, rule),
  );
  for (const sample of large.samples) {
    assert.deepEqual(
      sample.bytes,
      bytes.subarray(sample.offset, sample.offset + sample.bytes.length),
    );
  }
  const picked = await writeLargeCanary(new SeededRandom(seed), dir, { max: 200_000 });
  assert.deepEqual(
    await readFile(picked.path),
    canaryFile(new SeededRandom(seed), { max: 200_000 }).bytes,
  );
});
