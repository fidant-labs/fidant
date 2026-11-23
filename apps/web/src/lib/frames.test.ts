import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  ChecksumMismatchError,
  decodeEnd,
  decodeHeader,
  decodeInit,
  decodeMeta,
  encodeEnd,
  encodeHeader,
  encodeInit,
  encodeMeta,
  FrameReader,
  FrameWriter,
  HEADER_BYTES,
  hasForbiddenCharacters,
  MAX_CHUNK_BYTES,
  MAX_FROM_LENGTH,
  MAX_PADDABLE_SIZE,
  META_PADDED_BYTES,
  MetaTooLargeError,
  metaFits,
  paddedLength,
  ReceiveVerifier,
  RecipientKind,
  SenderKind,
} from "./frames.ts";
import { createTransferId, deriveFileKey } from "./keys.ts";
import { createLink } from "./link.ts";

const { META, CHUNK, END } = SenderKind;
const { ACCEPT, RECEIPT, DECLINE } = RecipientKind;
const sha256 = (u8: Uint8Array) => new Uint8Array(createHash("sha256").update(u8).digest());

async function setup() {
  const { secret } = createLink("https://localhost");
  const transferId = createTransferId();
  const key = await deriveFileKey(secret, transferId);
  return { secret, transferId, key };
}

function flip(frame: Uint8Array, index: number): Uint8Array {
  const out = frame.slice();
  out[index] = (out[index] as number) ^ 1;
  return out;
}

/** Encrypts a whole file as the sender would: META, zero-padded CHUNKs, END. */
async function encryptFile(key: CryptoKey, file: Uint8Array, chunkSize = MAX_CHUNK_BYTES) {
  const writer = new FrameWriter(key, "s");
  const meta = { name: "report.bin", size: file.length, type: "", chunkSize, from: "" };
  const frames = [await writer.encrypt(META, encodeMeta(meta))];
  for (let o = 0; o < paddedLength(file.length, chunkSize); o += chunkSize) {
    const body = new Uint8Array(chunkSize);
    body.set(file.subarray(o, o + chunkSize));
    frames.push(await writer.encrypt(CHUNK, body));
  }
  frames.push(await writer.encrypt(END, encodeEnd(sha256(file), file.length)));
  return frames;
}

/** Decrypts and verifies frames as the recipient would; returns the verified checksum. */
async function receiveFile(key: CryptoKey, frames: Uint8Array[]) {
  const reader = new FrameReader(key, "s");
  const verifier = new ReceiveVerifier();
  const parts: Uint8Array[] = [];
  for (const frame of frames) {
    const { kind, body } = await reader.decrypt(frame);
    if (kind === META) verifier.meta(decodeMeta(body));
    else if (kind === CHUNK) parts.push(verifier.chunk(body));
    else if (kind === END) verifier.end(body);
  }
  return { digest: verifier.finish(), data: Buffer.concat(parts) };
}

test("header encodes version, kind and a u64 seq", () => {
  const header = { version: 1, kind: CHUNK, seq: 2 ** 40 + 5 };
  const bytes = encodeHeader(header);
  assert.equal(bytes.length, HEADER_BYTES);
  assert.deepEqual([...bytes], [1, 2, 0, 0, 1, 0, 0, 0, 0, 5]);
  assert.deepEqual(decodeHeader(bytes), header);
  assert.throws(() => decodeHeader(bytes.subarray(0, 9)));
});

test("INIT carries the transferId in clear at seq 0", async () => {
  const transferId = createTransferId();
  const frame = encodeInit(transferId);
  assert.deepEqual(decodeHeader(frame), { version: 1, kind: SenderKind.INIT, seq: 0 });
  assert.deepEqual(decodeInit(frame), transferId);
  assert.throws(() => decodeInit(frame.subarray(0, frame.length - 1)));
  assert.throws(() => decodeInit(flip(frame, 1)), "other kind");
  assert.throws(() => decodeInit(flip(frame, 9)), "non-zero seq");
  assert.throws(() => decodeInit(flip(frame, 0)), "other version");

  // An encrypted reader never accepts INIT.
  const { key } = await setup();
  await assert.rejects(new FrameReader(key, "s").decrypt(frame), /not allowed/);
});

test("a file round trips through INIT, META, CHUNKs and END", async () => {
  const { secret, transferId } = await setup();
  const file = randomBytes(MAX_CHUNK_BYTES * 3 + 123);
  const senderKey = await deriveFileKey(secret, transferId);
  const init = encodeInit(transferId);
  const frames = await encryptFile(senderKey, file);

  // The recipient derives the key from the INIT it received.
  const recipientKey = await deriveFileKey(secret, decodeInit(init));
  const { digest, data } = await receiveFile(recipientKey, frames);
  assert.deepEqual(data, file);
  assert.deepEqual(digest, sha256(file));
  assert.ok(!Buffer.from(frames[1] as Uint8Array).includes(file.subarray(0, 64)));
});

test("an empty file round trips as one chunk of padding", async () => {
  const { key } = await setup();
  const frames = await encryptFile(key, new Uint8Array(0));
  assert.equal(frames.length, 3);
  const { digest, data } = await receiveFile(key, frames);
  assert.equal(data.length, 0);
  assert.deepEqual(digest, sha256(new Uint8Array(0)));
});

test("every CHUNK frame has the same size whatever the file size", async () => {
  const { key } = await setup();
  const c = 1000;
  for (const size of [0, 1, c - 1, c, c + 1, 9 * c + 1]) {
    const file = randomBytes(size);
    const frames = await encryptFile(key, file, c);
    const chunks = frames.slice(1, -1);
    assert.equal(chunks.length, paddedLength(size, c) / c, `size ${size}`);
    for (const frame of chunks) assert.equal(frame.length, HEADER_BYTES + c + 16, `size ${size}`);
    const { digest, data } = await receiveFile(key, frames);
    assert.deepEqual(data, file, `size ${size}`);
    assert.deepEqual(digest, sha256(file), `size ${size}`);
  }
});

test("paddedLength: Padmé rounding, then whole chunks", () => {
  // With a chunk size of 1 it is plain Padmé (0 counts as 1).
  const padme: [number, number][] = [
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 3],
    [5, 5],
    [8, 8],
    [9, 10],
    [100, 104],
    [1000, 1024],
    [1025, 1088],
    [2 ** 20 + 1, 2 ** 20 + 2 ** 15],
    [2 ** 32 + 1, 2 ** 32 + 2 ** 26],
    [2 ** 40 - 1, 2 ** 40],
    [MAX_PADDABLE_SIZE, MAX_PADDABLE_SIZE],
  ];
  for (const [n, expected] of padme) assert.equal(paddedLength(n, 1), expected, `n ${n}`);

  assert.equal(paddedLength(0), MAX_CHUNK_BYTES);
  assert.equal(paddedLength(1), MAX_CHUNK_BYTES);
  assert.equal(paddedLength(MAX_CHUNK_BYTES), MAX_CHUNK_BYTES);
  assert.equal(paddedLength(MAX_CHUNK_BYTES + 1), 2 * MAX_CHUNK_BYTES);
  assert.equal(paddedLength(2 ** 20), 22 * MAX_CHUNK_BYTES);

  assert.throws(() => paddedLength(-1), /size/);
  assert.throws(() => paddedLength(1.5), /size/);
  assert.throws(() => paddedLength(MAX_PADDABLE_SIZE + 1), /size/);
  assert.throws(() => paddedLength(10, 0), /chunk size/);
  assert.throws(() => paddedLength(10, MAX_CHUNK_BYTES + 1), /chunk size/);
});

test("paddedLength is monotonic, at least n and a whole number of chunks", () => {
  const sizes: number[] = [];
  for (let n = 0; n < 5000; n++) sizes.push(n);
  for (let n = 1; n < 2 ** 52; n = Math.ceil(n * 1.37) + 1) sizes.push(n - 1, n, n + 1);
  sizes.push(2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 2 ** 33 + 12345, MAX_PADDABLE_SIZE);
  sizes.sort((a, b) => a - b);
  for (const chunkSize of [1, 1000, 16 * 1024 - 64, MAX_CHUNK_BYTES]) {
    let previous = 0;
    for (const n of sizes) {
      if (n > MAX_PADDABLE_SIZE) continue;
      const padded = paddedLength(n, chunkSize);
      assert.ok(Number.isSafeInteger(padded), `n ${n}`);
      assert.ok(padded >= Math.max(n, 1), `n ${n}`);
      assert.ok(padded >= previous, `n ${n} monotonic`);
      assert.equal(padded % chunkSize, 0, `n ${n} chunk ${chunkSize}`);
      // Padmé adds at most 12 %; whole chunks add less than one chunk.
      assert.ok(padded < Math.max(n, 1) * 1.12 + chunkSize, `n ${n} overhead`);
      previous = padded;
    }
  }
});

test("recipient frames round trip and seq starts at 0 in each direction", async () => {
  const { key } = await setup();
  const writer = new FrameWriter(key, "r");
  const reader = new FrameReader(key, "r");
  const receipt = randomBytes(32);
  const frames = [
    await writer.encrypt(ACCEPT, new Uint8Array(0)),
    await writer.encrypt(RECEIPT, receipt),
    await writer.encrypt(DECLINE, new Uint8Array(0)),
  ];
  assert.deepEqual(
    frames.map((f) => decodeHeader(f).seq),
    [0, 1, 2],
  );
  assert.deepEqual(await reader.decrypt(frames[0] as Uint8Array), {
    kind: ACCEPT,
    body: new Uint8Array(0),
  });
  assert.deepEqual(await reader.decrypt(frames[1] as Uint8Array), {
    kind: RECEIPT,
    body: new Uint8Array(receipt),
  });
  assert.equal((await reader.decrypt(frames[2] as Uint8Array)).kind, DECLINE);
});

test("a flipped bit anywhere in a frame fails", async () => {
  const { key } = await setup();
  const frame = await new FrameWriter(key, "s").encrypt(CHUNK, randomBytes(1000));
  for (const index of [0, 1, 2, 9, HEADER_BYTES, HEADER_BYTES + 500, frame.length - 1]) {
    await assert.rejects(new FrameReader(key, "s").decrypt(flip(frame, index)), `byte ${index}`);
  }
  // The untouched frame still decrypts.
  await new FrameReader(key, "s").decrypt(frame);
});

test("reordered, replayed or dropped frames fail", async () => {
  const { key } = await setup();
  const writer = new FrameWriter(key, "s");
  const a = await writer.encrypt(CHUNK, randomBytes(10));
  const b = await writer.encrypt(CHUNK, randomBytes(10));
  const c = await writer.encrypt(CHUNK, randomBytes(10));

  await assert.rejects(new FrameReader(key, "s").decrypt(b), /seq 1, expected 0/, "reordered");

  const replay = new FrameReader(key, "s");
  await replay.decrypt(a);
  await assert.rejects(replay.decrypt(a), /seq 0, expected 1/, "replayed");

  const dropped = new FrameReader(key, "s");
  await dropped.decrypt(a);
  await assert.rejects(dropped.decrypt(c), /seq 2, expected 1/, "dropped");

  // Rewriting the header seq to the expected value breaks the tag (seq is in the AAD and IV).
  const relabelled = c.slice();
  relabelled.set(encodeHeader({ version: 1, kind: CHUNK, seq: 1 }));
  const reader = new FrameReader(key, "s");
  await reader.decrypt(a);
  await assert.rejects(reader.decrypt(relabelled), "seq rewritten");
});

test("a reader stops after any failure", async () => {
  const { key } = await setup();
  const writer = new FrameWriter(key, "s");
  const a = await writer.encrypt(CHUNK, randomBytes(10));
  const reader = new FrameReader(key, "s");
  await assert.rejects(reader.decrypt(flip(a, HEADER_BYTES)));
  await assert.rejects(reader.decrypt(a), /has failed/);
});

test("a CHUNK relabelled as END fails", async () => {
  const { key } = await setup();
  const writer = new FrameWriter(key, "s");
  // A 40-byte chunk has the same length as an END body.
  const chunk = await writer.encrypt(CHUNK, randomBytes(40));
  const relabelled = chunk.slice();
  relabelled[1] = END;
  await assert.rejects(new FrameReader(key, "s").decrypt(relabelled));
});

test("frames from the wrong key or another transferId fail", async () => {
  const { secret, key } = await setup();
  const frame = await new FrameWriter(key, "s").encrypt(META, encodeMeta(meta(10)));
  const wrongSecret = await deriveFileKey(
    createLink("https://localhost").secret,
    createTransferId(),
  );
  const otherTransfer = await deriveFileKey(secret, createTransferId());
  await assert.rejects(new FrameReader(wrongSecret, "s").decrypt(frame), "wrong secret");
  await assert.rejects(new FrameReader(otherTransfer, "s").decrypt(frame), "other transferId");
});

test("kinds are enforced per direction", async () => {
  const { key } = await setup();
  const s = new FrameWriter(key, "s");
  const r = new FrameWriter(key, "r");
  await assert.rejects(s.encrypt(ACCEPT, new Uint8Array(0)), /not allowed/);
  await assert.rejects(r.encrypt(CHUNK, randomBytes(1)), /not allowed/);
  // @ts-expect-error INIT is not an encrypted kind.
  await assert.rejects(s.encrypt(SenderKind.INIT, randomBytes(16)), /not allowed/);

  // A recipient frame fed to a sender-direction reader, and the reverse.
  const accept = await new FrameWriter(key, "r").encrypt(ACCEPT, new Uint8Array(0));
  await assert.rejects(new FrameReader(key, "s").decrypt(accept), /not allowed/);
  const chunk = await new FrameWriter(key, "s").encrypt(CHUNK, randomBytes(1));
  await assert.rejects(new FrameReader(key, "r").decrypt(chunk), /not allowed/);

  // A recipient frame relabelled with a sender kind still fails authentication.
  const relabelled = accept.slice();
  relabelled[1] = META;
  await assert.rejects(new FrameReader(key, "s").decrypt(relabelled));

  // Unknown kinds.
  const unknown = chunk.slice();
  unknown[1] = 99;
  await assert.rejects(new FrameReader(key, "s").decrypt(unknown), /not allowed/);
});

test("chunk bodies are limited to 48 KiB and fixed-size kinds are checked", async () => {
  const { key } = await setup();
  const s = new FrameWriter(key, "s");
  await s.encrypt(CHUNK, randomBytes(MAX_CHUNK_BYTES));
  await assert.rejects(s.encrypt(CHUNK, randomBytes(MAX_CHUNK_BYTES + 1)), /out of range/);
  await assert.rejects(s.encrypt(CHUNK, new Uint8Array(0)), /out of range/);
  await assert.rejects(s.encrypt(END, randomBytes(39)), /out of range/);
  const r = new FrameWriter(key, "r");
  await assert.rejects(r.encrypt(RECEIPT, randomBytes(31)), /out of range/);
  await assert.rejects(r.encrypt(ACCEPT, randomBytes(1)), /out of range/);

  // An oversized frame is refused before decryption.
  const big = new Uint8Array(HEADER_BYTES + MAX_CHUNK_BYTES + 17);
  big.set(encodeHeader({ version: 1, kind: CHUNK, seq: 0 }));
  await assert.rejects(new FrameReader(key, "s").decrypt(big), /length out of range/);
});

function meta(size: number) {
  return { name: "a.txt", size, type: "text/plain", chunkSize: 4, from: "Anna" };
}

test("META and END bodies encode and decode", () => {
  const m = {
    name: "Årsrapport 2026.pdf",
    size: 2 ** 40,
    type: "application/pdf",
    chunkSize: 4,
    from: "Åsa Öberg",
  };
  assert.equal(encodeMeta(m).length, META_PADDED_BYTES);
  assert.deepEqual(decodeMeta(encodeMeta(m)), m);
  assert.throws(() => encodeMeta({ ...m, name: "" }));
  assert.throws(() => encodeMeta({ ...m, size: -1 }));
  assert.throws(() => encodeMeta({ ...m, size: MAX_PADDABLE_SIZE + 1 }));
  assert.throws(() => encodeMeta({ ...m, type: "x".repeat(256) }));
  assert.throws(() => encodeMeta({ ...m, chunkSize: MAX_CHUNK_BYTES + 1 }));
  assert.deepEqual(decodeMeta(encodeMeta({ ...m, from: "" })).from, "");
  assert.deepEqual(
    decodeMeta(encodeMeta({ ...m, from: "x".repeat(MAX_FROM_LENGTH) })).from.length,
    MAX_FROM_LENGTH,
  );
  assert.throws(() => encodeMeta({ ...m, from: "x".repeat(MAX_FROM_LENGTH + 1) }));

  const hash = randomBytes(32);
  assert.deepEqual(decodeEnd(encodeEnd(hash, 12345)), {
    sha256: new Uint8Array(hash),
    size: 12345,
  });
  assert.throws(() => decodeEnd(new Uint8Array(39)));
});

/** A META body with this JSON text, padded the way encodeMeta pads. */
function rawMeta(json: string, length = META_PADDED_BYTES): Uint8Array {
  const text = new TextEncoder().encode(json);
  const body = new Uint8Array(length);
  new DataView(body.buffer).setUint16(0, text.length);
  body.set(text, 2);
  return body;
}

test("META is always the same size, so it does not reveal the name length", async () => {
  const { key } = await setup();
  const writer = new FrameWriter(key, "s");
  const short = { name: "a", size: 1, type: "", chunkSize: MAX_CHUNK_BYTES, from: "" };
  const long = {
    name: `${"å".repeat(300)}.pdf`,
    size: 2 ** 40,
    type: "application/pdf",
    chunkSize: 4,
    from: "å".repeat(MAX_FROM_LENGTH),
  };
  const a = await writer.encrypt(META, encodeMeta(short));
  const b = await writer.encrypt(META, encodeMeta(long));
  assert.equal(a.length, b.length);
  assert.equal(a.length, HEADER_BYTES + META_PADDED_BYTES + 16);

  // A META body of any other length is refused before decryption, and by decodeMeta.
  await assert.rejects(writer.encrypt(META, encodeMeta(short).subarray(1)), /out of range/);
  assert.throws(() => decodeMeta(encodeMeta(short).subarray(1)), /wrong length/);
});

test("META that does not fit throws MetaTooLargeError, and metaFits says so", () => {
  const fits = { name: "x".repeat(900), type: "application/pdf", size: 2 ** 40 };
  assert.equal(metaFits(fits), true);
  assert.deepEqual(
    decodeMeta(encodeMeta({ ...fits, chunkSize: MAX_CHUNK_BYTES, from: "" })).name,
    fits.name,
  );
  const tooLong = { ...fits, name: "x".repeat(1000) };
  assert.equal(metaFits(tooLong), false);
  assert.throws(() => encodeMeta({ ...tooLong, chunkSize: 4, from: "" }), MetaTooLargeError);
  // Escaped and multi-byte characters count by their encoded length.
  assert.equal(metaFits({ ...fits, name: "\u0001".repeat(170) }), false);
  assert.equal(metaFits({ ...fits, name: "å".repeat(400) }), true);
  assert.equal(metaFits({ ...fits, name: "å".repeat(500) }), false);
  assert.equal(metaFits({ ...fits, name: "" }), false);
  // The sender name shares the same 1024 bytes.
  assert.equal(metaFits({ ...fits, name: "x".repeat(800) }, "x".repeat(MAX_FROM_LENGTH)), true);
  assert.equal(metaFits({ ...fits, name: "x".repeat(900) }, "x".repeat(MAX_FROM_LENGTH)), false);
  assert.equal(metaFits(fits, "x".repeat(MAX_FROM_LENGTH + 1)), false);
});

test("decodeMeta rejects malformed padding and JSON", () => {
  const json = JSON.stringify(meta(10));
  assert.deepEqual(decodeMeta(rawMeta(json)), meta(10));

  const tampered = rawMeta(json);
  tampered[META_PADDED_BYTES - 1] = 1;
  assert.throws(() => decodeMeta(tampered), /padding/);
  const space = rawMeta(json);
  space[2 + json.length] = 0x20;
  assert.throws(() => decodeMeta(space), /padding/);

  // A length prefix that covers less or more than the JSON.
  const shorter = rawMeta(json);
  new DataView(shorter.buffer).setUint16(0, json.length - 1);
  assert.throws(() => decodeMeta(shorter));
  const longer = rawMeta(json);
  new DataView(longer.buffer).setUint16(0, json.length + 1);
  assert.throws(() => decodeMeta(longer));
  const huge = rawMeta(json);
  new DataView(huge.buffer).setUint16(0, META_PADDED_BYTES - 1);
  assert.throws(() => decodeMeta(huge), /length out of range/);

  assert.throws(() => decodeMeta(rawMeta(JSON.stringify({ ...meta(10), extra: 1 }))));
  const { from: _, ...noFrom } = meta(10);
  assert.throws(() => decodeMeta(rawMeta(JSON.stringify(noFrom))));
  assert.throws(() => decodeMeta(rawMeta(JSON.stringify({ ...meta(10), from: 1 }))));
  assert.throws(() => decodeMeta(rawMeta("not json")));
  assert.throws(() => decodeMeta(rawMeta("")));
});

test("META refuses control and direction characters in the name, type and sender name", () => {
  const forbidden = [
    0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x9f, 0x200e, 0x200f, 0x202a, 0x202d, 0x202e, 0x2066,
    0x2069,
  ];
  for (const code of forbidden) {
    const c = String.fromCodePoint(code);
    const label = `U+${code.toString(16).padStart(4, "0")}`;
    assert.equal(hasForbiddenCharacters(`a${c}b.pdf`), true, label);
    const badName = { ...meta(10), name: `invoice${c}fdp.exe` };
    const badType = { ...meta(10), type: `text/plain${c}` };
    const badFrom = { ...meta(10), from: `Your bank${c}` };
    assert.throws(() => encodeMeta(badName), /invalid/, label);
    assert.throws(() => encodeMeta(badType), /invalid/, label);
    assert.throws(() => encodeMeta(badFrom), /invalid/, label);
    assert.equal(metaFits(badName), false, label);
    assert.equal(metaFits(meta(10), badFrom.from), false, label);
    // A sender that skips the check is still refused by the recipient.
    assert.throws(() => decodeMeta(rawMeta(JSON.stringify(badName))), /invalid/, label);
    assert.throws(() => decodeMeta(rawMeta(JSON.stringify(badType))), /invalid/, label);
    assert.throws(() => decodeMeta(rawMeta(JSON.stringify(badFrom))), /invalid/, label);
  }
  // Ordinary non-ASCII names, joiners and emoji are fine.
  for (const name of ["Årsrapport 2026.pdf", "日本語.txt", "a\u200db.png", "🙂.bin", "a b.txt"]) {
    assert.equal(hasForbiddenCharacters(name), false, name);
    assert.deepEqual(decodeMeta(encodeMeta({ ...meta(10), name })).name, name);
  }
});

// meta(10) has chunkSize 4: paddedLength(10, 4) = 12, so three chunks, the
// last one with two bytes of file and two of padding.
function chunksOf(file: Uint8Array, chunkSize = 4, padded = 12): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < padded; o += chunkSize) {
    const body = new Uint8Array(chunkSize);
    body.set(file.subarray(o, o + chunkSize));
    out.push(body);
  }
  return out;
}

test("verifier: a complete transfer finishes with the checksum", () => {
  const file = randomBytes(10);
  const v = new ReceiveVerifier();
  v.meta(meta(10));
  const data = chunksOf(file).map((c) => v.chunk(c));
  assert.deepEqual(
    data.map((d) => d.length),
    [4, 4, 2],
  );
  assert.deepEqual(Buffer.concat(data), file);
  assert.equal(v.bytesReceived, 10);
  assert.deepEqual(v.end(encodeEnd(sha256(file), 10)), sha256(file));
  assert.deepEqual(v.finish(), sha256(file));
});

test("verifier: padding chunks carry no file bytes and must be zeros", () => {
  // paddedLength(9, 1) = 10: one byte of padding after nine bytes of file.
  const file = randomBytes(9);
  const v = new ReceiveVerifier();
  v.meta({ size: 9, chunkSize: 1 });
  for (let i = 0; i < 9; i++) v.chunk(file.subarray(i, i + 1));
  assert.equal(v.chunk(new Uint8Array(1)).length, 0);
  assert.equal(v.bytesReceived, 9);
  assert.deepEqual(v.end(encodeEnd(sha256(file), 9)), sha256(file));

  const dirty = new ReceiveVerifier();
  dirty.meta(meta(10));
  const chunks = chunksOf(randomBytes(10));
  dirty.chunk(chunks[0] as Uint8Array);
  dirty.chunk(chunks[1] as Uint8Array);
  const last = (chunks[2] as Uint8Array).slice();
  last[3] = 7;
  assert.throws(() => dirty.chunk(last), /padding/);
  assert.throws(() => dirty.finish());
});

test("verifier: truncation makes finish() throw", () => {
  const file = randomBytes(10);
  const chunks = chunksOf(file);

  const missingEnd = new ReceiveVerifier();
  missingEnd.meta(meta(10));
  for (const c of chunks) missingEnd.chunk(c);
  assert.throws(() => missingEnd.finish(), /incomplete/);

  const fewerChunks = new ReceiveVerifier();
  fewerChunks.meta(meta(10));
  fewerChunks.chunk(chunks[0] as Uint8Array);
  fewerChunks.chunk(chunks[1] as Uint8Array);
  assert.throws(() => fewerChunks.end(encodeEnd(sha256(file), 10)), /all chunks/);
  assert.throws(() => fewerChunks.finish());

  const endSizeLies = new ReceiveVerifier();
  endSizeLies.meta(meta(10));
  for (const c of chunks) endSizeLies.chunk(c);
  assert.throws(() => endSizeLies.end(encodeEnd(sha256(file.subarray(0, 6)), 6)), /META size/);
  assert.throws(() => endSizeLies.finish());

  const wrongHash = new ReceiveVerifier();
  wrongHash.meta(meta(10));
  for (const c of chunks) wrongHash.chunk(c);
  assert.throws(
    () => wrongHash.end(encodeEnd(randomBytes(32), 10)),
    (error: unknown) =>
      error instanceof ChecksumMismatchError &&
      Buffer.from(error.actual).equals(Buffer.from(sha256(file))),
    "a mismatch says what the recipient computed",
  );
  assert.throws(() => wrongHash.finish());

  const nothing = new ReceiveVerifier();
  assert.throws(() => nothing.finish());
});

test("verifier: rejects out-of-order kinds, short chunks and excess chunks", () => {
  const file = randomBytes(10);
  const chunks = chunksOf(file);

  const endFirst = new ReceiveVerifier();
  assert.throws(() => endFirst.end(encodeEnd(sha256(file), 10)), /END before META/);

  const chunkFirst = new ReceiveVerifier();
  assert.throws(() => chunkFirst.chunk(chunks[0] as Uint8Array), /CHUNK before META/);

  const short = new ReceiveVerifier();
  short.meta(meta(10));
  short.chunk(chunks[0] as Uint8Array);
  assert.throws(() => short.chunk(file.subarray(4, 7)), /chunk size/);
  assert.throws(() => short.chunk(chunks[1] as Uint8Array), /has failed/);

  const unpadded = new ReceiveVerifier();
  unpadded.meta(meta(10));
  unpadded.chunk(chunks[0] as Uint8Array);
  unpadded.chunk(chunks[1] as Uint8Array);
  assert.throws(() => unpadded.chunk(file.subarray(8)), /chunk size/);

  const tooLong = new ReceiveVerifier();
  tooLong.meta(meta(10));
  tooLong.chunk(chunks[0] as Uint8Array);
  assert.throws(() => tooLong.chunk(new Uint8Array(5)), /chunk size/);

  const tooMany = new ReceiveVerifier();
  tooMany.meta(meta(10));
  for (const c of chunks) tooMany.chunk(c);
  assert.throws(() => tooMany.chunk(new Uint8Array(4)), /more chunks/);
  assert.throws(() => tooMany.end(encodeEnd(sha256(file), 10)), /has failed/);

  const chunkAfterEnd = new ReceiveVerifier();
  chunkAfterEnd.meta(meta(10));
  for (const c of chunks) chunkAfterEnd.chunk(c);
  chunkAfterEnd.end(encodeEnd(sha256(file), 10));
  assert.throws(() => chunkAfterEnd.chunk(new Uint8Array(4)), /CHUNK after END/);
  assert.throws(() => chunkAfterEnd.finish(), "failed verifier does not finish");

  const metaTwice = new ReceiveVerifier();
  metaTwice.meta(meta(10));
  assert.throws(() => metaTwice.meta(meta(10)), /twice/);

  const badChunkSize = new ReceiveVerifier();
  assert.throws(() => badChunkSize.meta({ size: 10, chunkSize: 0 }), /chunk size/);
});

test("dropping the END frame in transit is detected as truncation", async () => {
  const { key } = await setup();
  const file = randomBytes(MAX_CHUNK_BYTES + 1);
  const frames = await encryptFile(key, file);
  await assert.rejects(receiveFile(key, frames.slice(0, -1)), /incomplete/);
  await assert.rejects(receiveFile(key, frames.slice(0, -2)), /incomplete/);
});
