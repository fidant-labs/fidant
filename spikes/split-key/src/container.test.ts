import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  COMMITMENT_BYTES,
  commit,
  createSalt,
  decodeMetaBody,
  encodeMetaBody,
  MAX_META_TEXT_BYTES,
  META_BODY_BYTES,
  type Meta,
  openMeta,
  openSealed,
  PlaintextCheck,
  SALT_BYTES,
  sealMeta,
  sealSealed,
} from "./container.ts";
import { createTransferId, deriveContentKey, deriveMetaKey, generateHalves } from "./keys.ts";
import { paddedLength } from "./padding.ts";
import { padChunks, type StreamHeader, StreamReader, StreamWriter } from "./stream.ts";

const sequence = (length: number, start: number) =>
  Uint8Array.from({ length }, (_, i) => (start * 31 + i * 7) & 0xff);

function pieces(data: Uint8Array, size: number): Uint8Array[] {
  const out = [];
  for (let i = 0; i < data.length; i += size) {
    out.push(data.subarray(i, i + size));
  }
  return out;
}

function flipBit(bytes: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
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

/** The sender's side: hash pass, then META, SEALED and the chunks. */
async function send(data: Uint8Array, chunkSize: number, name = "rapport.pdf") {
  const { fragmentHalf, serverHalf } = generateHalves();
  const transferId = createTransferId();
  const salt = createSalt();
  const { commitment, size } = await commit(salt, pieces(data, 37));
  assert.equal(size, data.length);
  const header: StreamHeader = {
    transferId,
    chunkSize,
    paddedLength: paddedLength(size, chunkSize),
  };
  const metaKey = await deriveMetaKey(fragmentHalf, transferId);
  const contentKey = await deriveContentKey(fragmentHalf, serverHalf, transferId);
  const meta = await sealMeta(metaKey, header, {
    name,
    commitment,
    from: "Anna",
    chunkSize,
    paddedLength: header.paddedLength,
  });
  const sealed = await sealSealed(contentKey, header, { salt, size, type: "application/pdf" });
  const writer = new StreamWriter(contentKey, header);
  const chunks: Uint8Array[] = [];
  for await (const chunk of padChunks(pieces(data, 53), chunkSize, header.paddedLength)) {
    chunks.push(await writer.encrypt(chunk));
  }
  return { fragmentHalf, serverHalf, transferId, salt, commitment, header, meta, sealed, chunks };
}

type Sent = Awaited<ReturnType<typeof send>>;

/** The recipient's side. Returns the file bytes after every check passed. */
async function receive(sent: Sent, overrides: Partial<Sent> = {}) {
  const s = { ...sent, ...overrides };
  const meta = await openMeta(s.fragmentHalf, s.transferId, s.header, s.meta);
  const contentKey = await deriveContentKey(s.fragmentHalf, s.serverHalf, s.transferId);
  const sealed = await openSealed(contentKey, s.header, s.sealed);
  const reader = new StreamReader(contentKey, s.header);
  const check = new PlaintextCheck(sealed, meta.commitment);
  const out: Uint8Array[] = [];
  for (const frame of s.chunks) {
    out.push(check.update(await reader.decrypt(frame)).slice());
  }
  reader.finish();
  check.finish();
  return { meta, sealed, data: concat(out) };
}

test("round trip at small chunk sizes", async () => {
  for (const chunkSize of [1, 16, 64, 100]) {
    for (const size of [0, 1, 63, 64, 65, 1000]) {
      const data = sequence(size, chunkSize);
      const sent = await send(data, chunkSize);
      const got = await receive(sent);
      assert.deepEqual(got.data, data);
      assert.equal(got.meta.name, "rapport.pdf");
      assert.equal(got.meta.from, "Anna");
      assert.equal(got.meta.chunkSize, chunkSize);
      assert.deepEqual(got.meta.commitment, sent.commitment);
      assert.equal(got.sealed.size, size);
      assert.equal(got.sealed.type, "application/pdf");
      assert.deepEqual(got.sealed.salt, sent.salt);
    }
  }
});

test("META and SEALED have fixed sizes whatever the name", async () => {
  const a = await send(sequence(10, 1), 16, "a");
  const b = await send(sequence(10, 1), 16, "ett mycket längre filnamn.docx");
  assert.equal(a.meta.length, b.meta.length);
  assert.equal(a.sealed.length, b.sealed.length);
  assert.equal(a.meta.length, 10 + META_BODY_BYTES + 16);
});

test("META opens with F alone; SEALED and chunks need S", async () => {
  const sent = await send(sequence(200, 3), 64);
  const meta = await openMeta(sent.fragmentHalf, sent.transferId, sent.header, sent.meta);
  assert.equal(meta.name, "rapport.pdf");

  const metaKey = await deriveMetaKey(sent.fragmentHalf, sent.transferId);
  await assert.rejects(openSealed(metaKey, sent.header, sent.sealed));
  await assert.rejects(
    new StreamReader(metaKey, sent.header).decrypt(sent.chunks[0] as Uint8Array),
  );

  const wrongS = flipBit(sent.serverHalf, 0);
  const wrongKey = await deriveContentKey(sent.fragmentHalf, wrongS, sent.transferId);
  await assert.rejects(openSealed(wrongKey, sent.header, sent.sealed));
  await assert.rejects(receive(sent, { serverHalf: wrongS }));
});

test("META does not open with a wrong F or under the content key", async () => {
  const sent = await send(sequence(10, 3), 16);
  await assert.rejects(
    openMeta(flipBit(sent.fragmentHalf, 5), sent.transferId, sent.header, sent.meta),
  );
  // SEALED is not META: kind check before any decryption.
  await assert.rejects(openMeta(sent.fragmentHalf, sent.transferId, sent.header, sent.sealed));
});

test("C equals node:crypto SHA-256(salt || plaintext)", async () => {
  const salt = createSalt();
  assert.equal(salt.length, SALT_BYTES);
  for (const size of [0, 1, 55, 56, 64, 1000, 70_000]) {
    const data = sequence(size, size);
    const expected = createHash("sha256").update(salt).update(data).digest();
    const sync = await commit(salt, pieces(data, 13));
    const asyncSource = (async function* () {
      yield* pieces(data, 4096);
    })();
    const fromAsync = await commit(salt, asyncSource);
    assert.deepEqual(Buffer.from(sync.commitment), expected);
    assert.deepEqual(Buffer.from(fromAsync.commitment), expected);
    assert.equal(sync.size, size);
  }
});

const baseMeta: Meta = {
  name: "x",
  commitment: new Uint8Array(COMMITMENT_BYTES).fill(9),
  from: "",
  chunkSize: 48 * 1024,
  paddedLength: 96 * 1024,
};

test("META body round trip with unicode names", () => {
  for (const name of ["räkning å ö.pdf", "日本語のファイル.txt", "emoji 🎉👩‍👩‍👧.zip"]) {
    const meta = { ...baseMeta, name, from: "Örjan Ångström" };
    const body = encodeMetaBody(meta);
    assert.equal(body.length, META_BODY_BYTES);
    assert.deepEqual(decodeMetaBody(body), meta);
  }
});

test("META body enforces the size limit and refuses bad names", () => {
  const fits = { ...baseMeta, name: "n".repeat(MAX_META_TEXT_BYTES - 4), from: "abcd" };
  assert.deepEqual(decodeMetaBody(encodeMetaBody(fits)), fits);
  assert.throws(() => encodeMetaBody({ ...fits, from: "abcde" }), /do not fit/);
  // Three UTF-8 bytes per character count, not UTF-16 code units.
  assert.throws(() => encodeMetaBody({ ...baseMeta, name: "語".repeat(330) }), /do not fit/);
  assert.throws(() => encodeMetaBody({ ...baseMeta, name: "" }), /empty/);
  assert.throws(() => encodeMetaBody({ ...baseMeta, name: "a‮fdp.exe" }), /forbidden/);
  assert.throws(() => encodeMetaBody({ ...baseMeta, paddedLength: 1000 }));
});

test("META body refuses non-zero padding and lengths past the end", () => {
  const body = encodeMetaBody(baseMeta);
  assert.throws(() => decodeMetaBody(flipBit(body, META_BODY_BYTES - 1)), /padding/);
  const long = new Uint8Array(body);
  long[0] = 0xff;
  assert.throws(() => decodeMetaBody(long));
  assert.throws(() => decodeMetaBody(body.subarray(1)));
});

test("a tampered chunk fails", async () => {
  const sent = await send(sequence(300, 5), 64);
  const chunks = [...sent.chunks];
  chunks[1] = flipBit(chunks[1] as Uint8Array, 20);
  await assert.rejects(receive(sent, { chunks }));
});

test("META or SEALED from another transfer fails", async () => {
  const a = await send(sequence(100, 1), 64);
  const b = await send(sequence(100, 2), 64);
  // b's META under a's link: wrong key and wrong stream header in the AAD.
  await assert.rejects(receive(a, { meta: b.meta }));
  // Same F, but META sealed for another transferId.
  const otherHeader = { ...a.header, transferId: b.transferId };
  await assert.rejects(openMeta(a.fragmentHalf, a.transferId, otherHeader, a.meta));
  await assert.rejects(receive(a, { sealed: b.sealed }));
});

test("META bound to the stream header: other chunkSize or paddedLength fails", async () => {
  const sent = await send(sequence(100, 1), 64);
  const header = { ...sent.header, paddedLength: sent.header.paddedLength + 64 };
  await assert.rejects(openMeta(sent.fragmentHalf, sent.transferId, header, sent.meta));
});

test("C mismatch is detected when the plaintext differs", async () => {
  const data = sequence(500, 8);
  const sent = await send(data, 64);
  // A sender whose chunks hold other bytes than the file behind C.
  const other = flipBit(data, 250);
  const contentKey = await deriveContentKey(sent.fragmentHalf, sent.serverHalf, sent.transferId);
  const writer = new StreamWriter(contentKey, sent.header);
  const chunks: Uint8Array[] = [];
  for await (const chunk of padChunks([other], 64, sent.header.paddedLength)) {
    chunks.push(await writer.encrypt(chunk));
  }
  await assert.rejects(receive(sent, { chunks }), /C does not match/);
});

test("non-zero padding after the file is refused", async () => {
  const data = sequence(100, 8);
  const sent = await send(data, 64);
  const contentKey = await deriveContentKey(sent.fragmentHalf, sent.serverHalf, sent.transferId);
  const writer = new StreamWriter(contentKey, sent.header);
  const padded = new Uint8Array(sent.header.paddedLength);
  padded.set(data);
  padded[padded.length - 1] = 1;
  const chunks = [];
  for (const chunk of pieces(padded, 64)) {
    chunks.push(await writer.encrypt(chunk));
  }
  await assert.rejects(receive(sent, { chunks }), /padding is not zeros/);
});

test("SEALED size must pad to paddedLength", async () => {
  const sent = await send(sequence(100, 8), 64);
  const contentKey = await deriveContentKey(sent.fragmentHalf, sent.serverHalf, sent.transferId);
  await assert.rejects(
    sealSealed(contentKey, sent.header, { salt: sent.salt, size: 10_000, type: "" }),
    /paddedLength/,
  );
});
