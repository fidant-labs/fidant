import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveContentKey } from "./keys.ts";
import { chunkCount, paddedLength } from "./padding.ts";
import {
  decodeStreamHeader,
  encodeStreamHeader,
  FRAME_HEADER_BYTES,
  padChunks,
  type StreamHeader,
  StreamReader,
  StreamWriter,
} from "./stream.ts";

const sequence = (length: number, start: number) =>
  Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);

const F = sequence(32, 0x00);
const S = sequence(32, 0x20);
const TRANSFER_ID = sequence(16, 0xa0);
const key = await deriveContentKey(F, S, TRANSFER_ID);

function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index] = (copy[index] as number) ^ 1;
  return copy;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Encrypts `size` bytes of test data and returns the header and every frame. */
async function seal(size: number, chunkSize: number) {
  const data = sequence(size, 7);
  const header: StreamHeader = {
    transferId: TRANSFER_ID,
    chunkSize,
    paddedLength: paddedLength(size, chunkSize),
  };
  const writer = new StreamWriter(key, header);
  const frames: Uint8Array[] = [];
  // Feed odd-sized pieces so padChunks has to rejoin them.
  const pieces = [];
  for (let i = 0; i < data.length; i += 37) {
    pieces.push(data.subarray(i, i + 37));
  }
  for await (const chunk of padChunks(pieces, chunkSize, header.paddedLength)) {
    frames.push(await writer.encrypt(chunk));
  }
  assert.ok(writer.done);
  return { data, header, frames };
}

/** A sealed multi-chunk stream: 1000 bytes at 64-byte chunks. */
async function multi() {
  const sealed = await seal(1000, 64);
  assert.ok(sealed.frames.length >= 4);
  return sealed;
}

async function readAll(reader: StreamReader, frames: Uint8Array[]): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  for (const frame of frames) {
    out.push(await reader.decrypt(frame));
  }
  reader.finish();
  return concat(out);
}

async function assertFailsForGood(reader: StreamReader, frames: Uint8Array[]): Promise<void> {
  await assert.rejects(readAll(reader, frames));
  // Every later call throws, even with a valid frame.
  await assert.rejects(reader.decrypt(frames[0] as Uint8Array), /has failed/);
  assert.throws(() => reader.finish(), /has failed/);
}

for (const [size, chunkSize] of [
  [0, 64],
  [1, 64],
  [64, 64],
  [1000, 64],
  [5000, 1024],
  [100, 1024],
]) {
  test(`round trip: ${size} B at ${chunkSize} B chunks`, async () => {
    const { data, header, frames } = await seal(size as number, chunkSize as number);
    assert.equal(frames.length, chunkCount(header.paddedLength, header.chunkSize));
    const plain = await readAll(new StreamReader(key, header), frames);
    assert.equal(plain.length, header.paddedLength);
    assert.deepEqual(plain.subarray(0, data.length), data);
    assert.ok(plain.subarray(data.length).every((b) => b === 0));
  });
}

test("stream header round trips and rejects malformed input", () => {
  const header = { transferId: TRANSFER_ID, chunkSize: 1024, paddedLength: 8192 };
  const bytes = encodeStreamHeader(header);
  assert.deepEqual(decodeStreamHeader(bytes), {
    ...header,
    transferId: new Uint8Array(TRANSFER_ID),
  });
  assert.throws(() => decodeStreamHeader(bytes.subarray(1)));
  assert.throws(() => decodeStreamHeader(flipBit(bytes, 0)), /version/);
  assert.throws(() => encodeStreamHeader({ ...header, paddedLength: 8000 }));
  assert.throws(() => encodeStreamHeader({ ...header, paddedLength: 0 }));
  assert.throws(() => encodeStreamHeader({ ...header, transferId: new Uint8Array(15) }));
});

test("writer rejects wrong-sized chunks and chunks after the final one", async () => {
  const writer = new StreamWriter(key, {
    transferId: TRANSFER_ID,
    chunkSize: 64,
    paddedLength: 64,
  });
  await assert.rejects(writer.encrypt(new Uint8Array(63)));
  await writer.encrypt(new Uint8Array(64));
  await assert.rejects(writer.encrypt(new Uint8Array(64)), /finished/);
});

test("padChunks rejects a source longer than paddedLength", async () => {
  const run = async () => {
    for await (const _ of padChunks([new Uint8Array(129)], 64, 128)) {
      // drain
    }
  };
  await assert.rejects(run(), /longer/);
});

test("dropped final chunk is reported as incomplete at finish", async () => {
  const { header, frames } = await multi();
  const reader = new StreamReader(key, header);
  for (const frame of frames.slice(0, -1)) {
    await reader.decrypt(frame);
  }
  assert.throws(() => reader.finish(), /incomplete/);
  await assert.rejects(reader.decrypt(frames.at(-1) as Uint8Array), /has failed/);
});

test("dropped middle chunk fails", async () => {
  const { header, frames } = await multi();
  await assertFailsForGood(new StreamReader(key, header), [
    ...frames.slice(0, 1),
    ...frames.slice(2),
  ]);
});

test("reordered chunks fail", async () => {
  const { header, frames } = await multi();
  const swapped = [frames[1], frames[0], ...frames.slice(2)] as Uint8Array[];
  await assertFailsForGood(new StreamReader(key, header), swapped);
});

test("extra chunk after the final one fails", async () => {
  const { header, frames } = await multi();
  const reader = new StreamReader(key, header);
  for (const frame of frames) {
    await reader.decrypt(frame);
  }
  await assert.rejects(reader.decrypt(frames.at(-1) as Uint8Array), /after CHUNK_FINAL/);
  assert.throws(() => reader.finish(), /has failed/);
});

test("CHUNK_FINAL too early fails", async () => {
  // The final frame of a shorter stream under the same key and header fields
  // except paddedLength: its seq and kind say "final" too early.
  const long = await multi();
  const short = await seal(100, 64);
  assert.ok(short.frames.length < long.frames.length);
  const early = [
    ...long.frames.slice(0, short.frames.length - 1),
    short.frames.at(-1),
  ] as Uint8Array[];
  await assertFailsForGood(new StreamReader(key, long.header), early);

  // A CHUNK relabelled as CHUNK_FINAL passes the structural checks only if the
  // count matches, and then its tag fails because the kind is in the AAD.
  const relabelled = new Uint8Array(long.frames[0] as Uint8Array);
  relabelled[1] = 4;
  await assertFailsForGood(new StreamReader(key, { ...long.header, paddedLength: 64 }), [
    relabelled,
  ]);
});

test("bit flip in ciphertext fails", async () => {
  const { header, frames } = await multi();
  const tampered = [...frames];
  tampered[1] = flipBit(frames[1] as Uint8Array, FRAME_HEADER_BYTES + 5);
  await assertFailsForGood(new StreamReader(key, header), tampered);
  const tag = [...frames];
  tag[2] = flipBit(frames[2] as Uint8Array, (frames[2] as Uint8Array).length - 1);
  await assertFailsForGood(new StreamReader(key, header), tag);
});

test("bit flip in the frame header fails", async () => {
  const { header, frames } = await multi();
  for (const index of [0, 1, FRAME_HEADER_BYTES - 1]) {
    const tampered = [...frames];
    tampered[1] = flipBit(frames[1] as Uint8Array, index);
    await assertFailsForGood(new StreamReader(key, header), tampered);
  }
});

test("wrong key fails", async () => {
  const { header, frames } = await multi();
  const otherKey = await deriveContentKey(F, flipBit(S, 0), TRANSFER_ID);
  await assertFailsForGood(new StreamReader(otherKey, header), frames);
});

test("a different stream header fails", async () => {
  const { header, frames } = await multi();
  for (const changed of [
    { ...header, transferId: flipBit(TRANSFER_ID, 0) },
    { ...header, paddedLength: header.paddedLength + header.chunkSize },
    { ...header, paddedLength: header.paddedLength - header.chunkSize },
    { ...header, chunkSize: 32, paddedLength: header.paddedLength },
  ]) {
    await assertFailsForGood(new StreamReader(key, changed), frames);
  }
});
