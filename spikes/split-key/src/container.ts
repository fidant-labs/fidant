// META and SEALED frames and the salted commitment C for the SIG-7 spike.
//
// A transfer is: stream header || META || SEALED || CHUNK ... || CHUNK_FINAL.
// META and SEALED use the frame header, IV and AAD of stream.ts, each at seq 0
// with its own kind, so their nonces never meet a chunk's.
//
// | frame  | key         | plaintext body, zero-filled to a fixed size     |
// |--------|-------------|-------------------------------------------------|
// | META   | meta key    | 1024 B: nameLen(2) || name || C(32)             |
// |        | (F alone)   | || fromLen(2) || from || chunkSize(4)           |
// |        |             | || paddedLength(8)                              |
// | SEALED | content key | 512 B: salt(32) || size(8) || typeLen(2) || type |
// |        | (F and S)   |                                                 |
//
// Integers are big-endian, strings UTF-8 with a u16 byte-length prefix.
// Per docs/decisions/0002 (Key layering), the recipient reads the name, the
// sender's typed name and C with F alone, enough to render the receipt before
// signing. The salt, exact size and MIME type need S, which the server
// releases only after signing.
//
// C = SHA-256(salt || plaintext) over the exact file bytes, never the padding.
// The salt is 32 random bytes. Without it, C cannot be used to confirm a guess
// about the file, which is why the salt sits in SEALED and not in META.
//
// Differences from apps/web/src/lib/frames.ts:
// - META is binary with length prefixes, not length-prefixed JSON. Fields are
//   fixed, so a parser with a fixed layout is shorter and rejects more.
// - META drops size and type (now in SEALED) and adds C and paddedLength.
// - Two keys instead of one file key; the stream header, not the frame header
//   alone, is the AAD, so META is bound to its transfer, chunk size and padded
//   length.
// - The plain SHA-256 in END is replaced by C, checked after decryption.

import { hasForbiddenCharacters } from "../../../apps/web/src/lib/frames.ts";
import { Sha256 } from "../../../apps/web/src/lib/sha256.ts";
import { deriveMetaKey } from "./keys.ts";
import { chunkCount, paddedLength } from "./padding.ts";
import {
  decodeFrameHeader,
  encodeFrameHeader,
  encodeStreamHeader,
  FRAME_HEADER_BYTES,
  frameAad,
  frameIv,
  Kind,
  STREAM_VERSION,
  type StreamHeader,
  TAG_BYTES,
} from "./stream.ts";

export const META_BODY_BYTES = 1024;
export const SEALED_BODY_BYTES = 512;
export const SALT_BYTES = 32;
export const COMMITMENT_BYTES = 32;
/** Longest MIME type, in UTF-8 bytes. */
export const MAX_TYPE_BYTES = 255;

/** Fixed META fields: two length prefixes, C, chunkSize, paddedLength. */
const META_FIXED_BYTES = 2 + COMMITMENT_BYTES + 2 + 4 + 8;
/** Room left in META for the UTF-8 name and from together. */
export const MAX_META_TEXT_BYTES = META_BODY_BYTES - META_FIXED_BYTES;

export type Meta = {
  name: string;
  /** C = SHA-256(salt || plaintext). */
  commitment: Uint8Array;
  /** The sender's typed name, unverified. Empty if none. */
  from: string;
  chunkSize: number;
  paddedLength: number;
};

export type Sealed = {
  salt: Uint8Array;
  /** Exact file size in bytes. */
  size: number;
  /** MIME type, possibly empty. */
  type: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** 32 fresh random bytes for C. */
export function createSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/**
 * The sender's hash pass: C = SHA-256(salt || source) and the exact size.
 * Runs before META can be built, since META carries C. Holds no more than the
 * piece it is hashing.
 */
export async function commit(
  salt: Uint8Array,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<{ commitment: Uint8Array; size: number }> {
  checkLength(salt, SALT_BYTES, "salt");
  const hash = new Sha256().update(salt);
  let size = 0;
  for await (const piece of source) {
    hash.update(piece);
    size += piece.length;
  }
  return { commitment: hash.digest(), size };
}

function checkLength(bytes: Uint8Array, length: number, name: string): void {
  if (bytes.length !== length) {
    throw new Error(`${name} must be ${length} bytes`);
  }
}

function checkText(text: string, name: string): void {
  if (hasForbiddenCharacters(text)) {
    throw new Error(`${name} has forbidden characters`);
  }
}

function isZero(bytes: Uint8Array): boolean {
  let bits = 0;
  for (const byte of bytes) {
    bits |= byte;
  }
  return bits === 0;
}

/** Big-endian reader that throws instead of reading past the end. */
class Cursor {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new Error("body field out of range");
    }
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): number {
    const value =
      this.view.getUint32(this.offset) * 0x100000000 + this.view.getUint32(this.offset + 4);
    this.offset += 8;
    if (!Number.isSafeInteger(value)) {
      throw new Error("u64 out of range");
    }
    return value;
  }

  text(): string {
    return decoder.decode(this.take(this.u16()));
  }

  /** The rest must be zeros: the body has exactly one encoding. */
  end(): void {
    if (!isZero(this.bytes.subarray(this.offset))) {
      throw new Error("body padding is not zeros");
    }
  }
}

/** Big-endian writer into a zero-filled body of fixed size. */
class Builder {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  put(bytes: Uint8Array): void {
    this.bytes.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  u16(value: number): void {
    this.view.setUint16(this.offset, value);
    this.offset += 2;
  }

  u32(value: number): void {
    this.view.setUint32(this.offset, value);
    this.offset += 4;
  }

  u64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("u64 out of range");
    }
    this.view.setUint32(this.offset, Math.floor(value / 0x100000000));
    this.view.setUint32(this.offset + 4, value >>> 0);
    this.offset += 8;
  }

  text(bytes: Uint8Array): void {
    this.u16(bytes.length);
    this.put(bytes);
  }
}

/** Encodes META as exactly META_BODY_BYTES. Throws if name and from do not fit. */
export function encodeMetaBody(meta: Meta): Uint8Array<ArrayBuffer> {
  if (meta.name.length === 0) {
    throw new Error("name is empty");
  }
  checkText(meta.name, "name");
  checkText(meta.from, "from");
  checkLength(meta.commitment, COMMITMENT_BYTES, "commitment");
  chunkCount(meta.paddedLength, meta.chunkSize);
  const name = encoder.encode(meta.name);
  const from = encoder.encode(meta.from);
  if (name.length + from.length > MAX_META_TEXT_BYTES) {
    throw new Error("name and from do not fit in META");
  }
  const out = new Builder(META_BODY_BYTES);
  out.text(name);
  out.put(meta.commitment);
  out.text(from);
  out.u32(meta.chunkSize);
  out.u64(meta.paddedLength);
  return out.bytes;
}

/** Decodes a META body. Throws for anything malformed. */
export function decodeMetaBody(body: Uint8Array): Meta {
  checkLength(body, META_BODY_BYTES, "META body");
  const read = new Cursor(body);
  const name = read.text();
  const commitment = read.take(COMMITMENT_BYTES);
  const from = read.text();
  const chunkSize = read.u32();
  const paddedLength = read.u64();
  read.end();
  if (name.length === 0) {
    throw new Error("name is empty");
  }
  checkText(name, "name");
  checkText(from, "from");
  chunkCount(paddedLength, chunkSize);
  return { name, commitment, from, chunkSize, paddedLength };
}

/** Encodes SEALED as exactly SEALED_BODY_BYTES. */
export function encodeSealedBody(sealed: Sealed): Uint8Array<ArrayBuffer> {
  checkLength(sealed.salt, SALT_BYTES, "salt");
  checkText(sealed.type, "type");
  const type = encoder.encode(sealed.type);
  if (type.length > MAX_TYPE_BYTES) {
    throw new Error("type too long");
  }
  const out = new Builder(SEALED_BODY_BYTES);
  out.put(sealed.salt);
  out.u64(sealed.size);
  out.text(type);
  return out.bytes;
}

/** Decodes a SEALED body. Throws for anything malformed. */
export function decodeSealedBody(body: Uint8Array): Sealed {
  checkLength(body, SEALED_BODY_BYTES, "SEALED body");
  const read = new Cursor(body);
  const salt = read.take(SALT_BYTES);
  const size = read.u64();
  const type = read.text();
  read.end();
  if (encoder.encode(type).length > MAX_TYPE_BYTES) {
    throw new Error("type too long");
  }
  checkText(type, "type");
  return { salt, size, type };
}

async function sealFrame(
  key: CryptoKey,
  kind: Kind,
  header: StreamHeader,
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const frameHeader = encodeFrameHeader({ version: STREAM_VERSION, kind, seq: 0 });
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: frameIv(kind, 0),
      additionalData: frameAad(frameHeader, encodeStreamHeader(header)),
      tagLength: TAG_BYTES * 8,
    },
    key,
    body,
  );
  const out = new Uint8Array(FRAME_HEADER_BYTES + ciphertext.byteLength);
  out.set(frameHeader);
  out.set(new Uint8Array(ciphertext), FRAME_HEADER_BYTES);
  return out;
}

async function openFrame(
  key: CryptoKey,
  kind: Kind,
  bodyBytes: number,
  header: StreamHeader,
  frame: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const frameHeader = decodeFrameHeader(frame);
  if (
    frameHeader.version !== STREAM_VERSION ||
    frameHeader.kind !== kind ||
    frameHeader.seq !== 0
  ) {
    throw new Error(`expected frame kind ${kind} at seq 0`);
  }
  if (frame.length !== FRAME_HEADER_BYTES + bodyBytes + TAG_BYTES) {
    throw new Error("frame length out of range");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: frameIv(kind, 0),
      additionalData: frameAad(frame.slice(0, FRAME_HEADER_BYTES), encodeStreamHeader(header)),
      tagLength: TAG_BYTES * 8,
    },
    key,
    frame.subarray(FRAME_HEADER_BYTES) as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(plaintext);
}

function checkMatchesHeader(meta: Meta, header: StreamHeader): void {
  if (meta.chunkSize !== header.chunkSize || meta.paddedLength !== header.paddedLength) {
    throw new Error("META does not match the stream header");
  }
}

/** Encrypts META under the meta key. META's chunkSize and paddedLength must match the header. */
export async function sealMeta(
  metaKey: CryptoKey,
  header: StreamHeader,
  meta: Meta,
): Promise<Uint8Array<ArrayBuffer>> {
  checkMatchesHeader(meta, header);
  return sealFrame(metaKey, Kind.META, header, encodeMetaBody(meta));
}

/**
 * Opens META with F alone. transferId is what the recipient expects (from the
 * link or the server); a stream header naming another transfer is refused.
 */
export async function openMeta(
  fragmentHalf: Uint8Array,
  transferId: Uint8Array,
  header: StreamHeader,
  frame: Uint8Array,
): Promise<Meta> {
  if (!equalBytes(transferId, header.transferId)) {
    throw new Error("stream header is for another transfer");
  }
  const metaKey = await deriveMetaKey(fragmentHalf, transferId);
  const meta = decodeMetaBody(await openFrame(metaKey, Kind.META, META_BODY_BYTES, header, frame));
  checkMatchesHeader(meta, header);
  return meta;
}

/** Encrypts SEALED under the content key. size must pad to the header's paddedLength. */
export async function sealSealed(
  contentKey: CryptoKey,
  header: StreamHeader,
  sealed: Sealed,
): Promise<Uint8Array<ArrayBuffer>> {
  checkSize(sealed.size, header);
  return sealFrame(contentKey, Kind.SEALED, header, encodeSealedBody(sealed));
}

/** Opens SEALED with the content key, which needs F and S. */
export async function openSealed(
  contentKey: CryptoKey,
  header: StreamHeader,
  frame: Uint8Array,
): Promise<Sealed> {
  const sealed = decodeSealedBody(
    await openFrame(contentKey, Kind.SEALED, SEALED_BODY_BYTES, header, frame),
  );
  checkSize(sealed.size, header);
  return sealed;
}

/**
 * The exact size must be one that pads to the stream's paddedLength. Otherwise
 * the sender chose padding the recipient would not, and the padded length
 * would leak more than Padmé allows.
 */
function checkSize(size: number, header: StreamHeader): void {
  if (paddedLength(size, header.chunkSize) !== header.paddedLength) {
    throw new Error("size does not match paddedLength");
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/**
 * The recipient's check after decrypting. Feed every padded chunk in order;
 * `update` returns the file bytes in it (a subarray, empty once past the end).
 * `finish` throws unless SHA-256(salt || file bytes) equals C from META.
 *
 * The padding after the file must be zeros, and a non-zero byte fails at once.
 * C covers only the file bytes, so without this check a sender could put
 * anything in the padding (up to 12 % of the file, plus a chunk) and the
 * transfer would still verify. Requiring zeros makes the decrypted stream a
 * single, canonical encoding of the file that C commits to, the same rule as
 * frames.ts.
 */
export class PlaintextCheck {
  private readonly hash: Sha256;
  private readonly commitment: Uint8Array;
  private readonly size: number;
  private seen = 0;
  private failed = false;

  constructor(sealed: Sealed, commitment: Uint8Array) {
    checkLength(sealed.salt, SALT_BYTES, "salt");
    checkLength(commitment, COMMITMENT_BYTES, "commitment");
    this.hash = new Sha256().update(sealed.salt);
    this.commitment = commitment;
    this.size = sealed.size;
  }

  update(chunk: Uint8Array): Uint8Array {
    if (this.failed) {
      throw new Error("plaintext check has failed");
    }
    const keep = Math.max(0, Math.min(chunk.length, this.size - this.seen));
    this.seen += chunk.length;
    if (!isZero(chunk.subarray(keep))) {
      this.failed = true;
      throw new Error("padding is not zeros");
    }
    const file = chunk.subarray(0, keep);
    this.hash.update(file);
    return file;
  }

  /** Throws unless at least `size` bytes arrived and C matches. */
  finish(): void {
    if (this.failed) {
      throw new Error("plaintext check has failed");
    }
    this.failed = true;
    if (this.seen < this.size) {
      throw new Error("plaintext shorter than size");
    }
    const computed = this.hash.digest();
    if (!equalBytes(computed, this.commitment)) {
      throw new Error("C does not match");
    }
  }
}
