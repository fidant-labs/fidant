import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
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
  MAX_CHUNK_BYTES,
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

/** Encrypts a whole file as the sender would: META, CHUNKs, END. */
async function encryptFile(key: CryptoKey, file: Uint8Array, chunkSize = MAX_CHUNK_BYTES) {
  const writer = new FrameWriter(key, "s");
  const meta = { name: "report.bin", size: file.length, type: "", chunkSize };
  const frames = [await writer.encrypt(META, encodeMeta(meta))];
  for (let o = 0; o < file.length; o += chunkSize) {
    frames.push(await writer.encrypt(CHUNK, file.subarray(o, o + chunkSize)));
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
    else if (kind === CHUNK) {
      verifier.chunk(body);
      parts.push(body);
    } else if (kind === END) verifier.end(body);
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

test("an empty file round trips", async () => {
  const { key } = await setup();
  const { digest } = await receiveFile(key, await encryptFile(key, new Uint8Array(0)));
  assert.deepEqual(digest, sha256(new Uint8Array(0)));
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
  return { name: "a.txt", size, type: "text/plain", chunkSize: 4 };
}

test("META and END bodies encode and decode", () => {
  const m = { name: "Årsrapport 2026.pdf", size: 2 ** 40, type: "application/pdf", chunkSize: 4 };
  assert.deepEqual(decodeMeta(encodeMeta(m)), m);
  assert.throws(() => encodeMeta({ ...m, name: "" }));
  assert.throws(() => encodeMeta({ ...m, name: "x".repeat(1025) }));
  assert.throws(() => encodeMeta({ ...m, size: -1 }));
  assert.throws(() => encodeMeta({ ...m, chunkSize: MAX_CHUNK_BYTES + 1 }));
  const enc = new TextEncoder();
  assert.throws(() => decodeMeta(enc.encode(JSON.stringify({ ...m, extra: 1 }))));
  assert.throws(() => decodeMeta(enc.encode("not json")));

  const hash = randomBytes(32);
  assert.deepEqual(decodeEnd(encodeEnd(hash, 12345)), {
    sha256: new Uint8Array(hash),
    size: 12345,
  });
  assert.throws(() => decodeEnd(new Uint8Array(39)));
});

test("verifier: a complete transfer finishes with the checksum", () => {
  const file = randomBytes(10);
  const v = new ReceiveVerifier();
  v.meta(meta(10));
  v.chunk(file.subarray(0, 4));
  v.chunk(file.subarray(4));
  assert.equal(v.bytesReceived, 10);
  assert.deepEqual(v.end(encodeEnd(sha256(file), 10)), sha256(file));
  assert.deepEqual(v.finish(), sha256(file));
});

test("verifier: truncation makes finish() throw", () => {
  const file = randomBytes(10);

  const missingEnd = new ReceiveVerifier();
  missingEnd.meta(meta(10));
  missingEnd.chunk(file);
  assert.throws(() => missingEnd.finish(), /incomplete/);

  const fewerBytes = new ReceiveVerifier();
  fewerBytes.meta(meta(10));
  fewerBytes.chunk(file.subarray(0, 6));
  assert.throws(() => fewerBytes.end(encodeEnd(sha256(file), 10)), /bytes received/);
  assert.throws(() => fewerBytes.finish());

  const endSizeLies = new ReceiveVerifier();
  endSizeLies.meta(meta(10));
  endSizeLies.chunk(file.subarray(0, 6));
  assert.throws(() => endSizeLies.end(encodeEnd(sha256(file.subarray(0, 6)), 6)), /META size/);
  assert.throws(() => endSizeLies.finish());

  const wrongHash = new ReceiveVerifier();
  wrongHash.meta(meta(10));
  wrongHash.chunk(file);
  assert.throws(() => wrongHash.end(encodeEnd(randomBytes(32), 10)), /checksum/);
  assert.throws(() => wrongHash.finish());

  const nothing = new ReceiveVerifier();
  assert.throws(() => nothing.finish());
});

test("verifier: rejects out-of-order kinds and excess bytes", () => {
  const file = randomBytes(10);

  const endFirst = new ReceiveVerifier();
  assert.throws(() => endFirst.end(encodeEnd(sha256(file), 10)), /END before META/);

  const chunkFirst = new ReceiveVerifier();
  assert.throws(() => chunkFirst.chunk(file), /CHUNK before META/);

  const tooMany = new ReceiveVerifier();
  tooMany.meta(meta(10));
  tooMany.chunk(file);
  assert.throws(() => tooMany.chunk(randomBytes(1)), /more bytes/);
  assert.throws(() => tooMany.end(encodeEnd(sha256(file), 10)), /has failed/);

  const chunkAfterEnd = new ReceiveVerifier();
  chunkAfterEnd.meta(meta(10));
  chunkAfterEnd.chunk(file);
  chunkAfterEnd.end(encodeEnd(sha256(file), 10));
  assert.throws(() => chunkAfterEnd.chunk(new Uint8Array(0)), /CHUNK after END/);
  assert.throws(() => chunkAfterEnd.finish(), "failed verifier does not finish");

  const metaTwice = new ReceiveVerifier();
  metaTwice.meta(meta(10));
  assert.throws(() => metaTwice.meta(meta(10)), /twice/);
});

test("dropping the END frame in transit is detected as truncation", async () => {
  const { key } = await setup();
  const file = randomBytes(MAX_CHUNK_BYTES + 1);
  const frames = await encryptFile(key, file);
  await assert.rejects(receiveFile(key, frames.slice(0, -1)), /incomplete/);
  await assert.rejects(receiveFile(key, frames.slice(0, -2)), /incomplete/);
});
