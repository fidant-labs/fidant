// Data channel framing and per-frame encryption.
//
// Frame  = header(10) || body
// Header = version(1) = 2 || kind(1) || seq(8, u64 big-endian). Plaintext, and
//          the AES-GCM additional data of its frame.
// Body   = AES-GCM-256(fileKey, iv, aad = header, plaintext body), 16-byte tag
//          appended. Only INIT is sent in clear.
// IV     = dir(1) || 00 00 00 || seq(8, u64 big-endian), exactly 12 bytes.
//          dir is 0 for frames from the sender ("s"), 1 for frames from the
//          recipient ("r"), so the two directions never share a nonce.
//
// | kind | name    | dir | plaintext body                                   |
// |------|---------|-----|--------------------------------------------------|
// |    0 | INIT    |  s  | transferId (16), in clear, seq 0, see below      |
// |    1 | META    |  s  | exactly 1024 bytes: length(2, u16 big-endian) || |
// |      |         |     | UTF-8 JSON {name, size, type, chunkSize, from}   |
// |      |         |     | || zeros (from: the sender's typed name, or "")  |
// |    2 | CHUNK   |  s  | exactly chunkSize bytes: file bytes, then zeros  |
// |      |         |     | after the end of the file (see Padding)          |
// |    3 | END     |  s  | sha256(32) || size(8, u64 big-endian)            |
// |    4 | CHECK   |  s  | 1 byte: 1 the check number matches, 0 it differs |
// |   16 | ACCEPT  |  r  | empty (proves the recipient holds the key)       |
// |   17 | RECEIPT |  r  | sha256(32) the recipient computed                |
// |   18 | DECLINE |  r  | empty                                            |
// |   19 | CREDIT  |  r  | granted(8, u64 big-endian): cumulative count of  |
// |      |         |     | CHUNKs the sender may send; it may send CHUNK i  |
// |      |         |     | (0-based) only while i < granted                 |
// |   20 | CHECK   |  r  | 1 byte: 1 the check number matches, 0 it differs |
//
// CHECK: with the check number on, each side's first frame after INIT is its CHECK,
// sent once its own person compared the numbers; META waits for both to say 1.
//
// Padding: anyone who can see frame sizes (the network, a TURN relay) learns
// only paddedLength(size, chunkSize) of the file, never its exact size, and
// META always has the same length whatever the file name and type. The sender
// sends paddedLength / chunkSize CHUNK frames, all exactly chunkSize bytes; the
// bytes after the end of the file are zeros. The exact size travels only inside
// the encrypted META and END. The recipient keeps only the first `size` bytes
// and checks that the padding is zeros. chunkSize and so the CHUNK frame size
// depends on the data channel's max message size, which observers see anyway.
//
// Sequence numbers: INIT carries the transferId that the file key is derived
// from, so it has to be sent before either side has the key. It sits outside
// the encrypted sequence: its header always says seq 0 and it uses no nonce.
// Encrypted frames are numbered from 0 in each direction (the sender's META is
// seq 0, the recipient's ACCEPT is seq 0). A reader accepts only the next
// seq, so dropped, reordered or replayed frames fail. Altering INIT changes
// the derived key, so META then fails to decrypt.
//
// Writers and readers keep state: await each encrypt or decrypt before
// starting the next one. A reader stops accepting frames after any failure.

import { hasForbiddenCharacters, MAX_FROM_LENGTH } from "@sigill/protocol";
import type { Direction } from "./keys.ts";
import { Sha256 } from "./sha256.ts";

export { hasForbiddenCharacters, MAX_FROM_LENGTH };

export const FRAME_VERSION = 2;
export const HEADER_BYTES = 10;
export const TAG_BYTES = 16;
export const MAX_CHUNK_BYTES = 48 * 1024;
/** Largest file size whose padded length is still a safe integer (2^52 bytes, 4 PiB). */
export const MAX_PADDABLE_SIZE = 2 ** 52;

/** Every META body is padded to exactly this many bytes. */
export const META_PADDED_BYTES = 1024;
/** META's length prefix. */
const META_LENGTH_BYTES = 2;
/** Bytes of each message that chunkSize leaves for the frame around a CHUNK body: the 10-byte header and 16-byte tag (HEADER_BYTES + TAG_BYTES), with room to spare. */
export const FRAME_OVERHEAD_BYTES = 64;
/**
 * Smallest chunk META accepts. A sender's chunk is maxMessageSize minus FRAME_OVERHEAD_BYTES, and
 * the META frame itself must fit maxMessageSize, so no honest sender goes below this. A smaller
 * chunk only lets a sender make the recipient hold many tiny parts.
 */
export const MIN_CHUNK_BYTES = HEADER_BYTES + META_PADDED_BYTES + TAG_BYTES - FRAME_OVERHEAD_BYTES;
/**
 * Longest MIME type META accepts. The file name has no separate limit: name,
 * type and sender name together must fit in META_PADDED_BYTES (see metaFits).
 */
export const MAX_TYPE_LENGTH = 255;

export const SenderKind = { INIT: 0, META: 1, CHUNK: 2, END: 3, CHECK: 4 } as const;
export const RecipientKind = {
  ACCEPT: 16,
  RECEIPT: 17,
  DECLINE: 18,
  CREDIT: 19,
  CHECK: 20,
} as const;

export type SenderKind = (typeof SenderKind)[keyof typeof SenderKind];
export type RecipientKind = (typeof RecipientKind)[keyof typeof RecipientKind];
/** Kinds that travel encrypted. */
export type EncryptedKind = Exclude<SenderKind, 0> | RecipientKind;

export type Header = { version: number; kind: number; seq: number };
export type Frame = { kind: EncryptedKind; body: Uint8Array };

/** Allowed body size range per encrypted kind, and which direction sends it. */
const RULES: Record<EncryptedKind, { dir: Direction; min: number; max: number }> = {
  [SenderKind.META]: { dir: "s", min: META_PADDED_BYTES, max: META_PADDED_BYTES },
  [SenderKind.CHUNK]: { dir: "s", min: 1, max: MAX_CHUNK_BYTES },
  [SenderKind.END]: { dir: "s", min: 40, max: 40 },
  [SenderKind.CHECK]: { dir: "s", min: 1, max: 1 },
  [RecipientKind.ACCEPT]: { dir: "r", min: 0, max: 0 },
  [RecipientKind.RECEIPT]: { dir: "r", min: 32, max: 32 },
  [RecipientKind.DECLINE]: { dir: "r", min: 0, max: 0 },
  [RecipientKind.CREDIT]: { dir: "r", min: 8, max: 8 },
  [RecipientKind.CHECK]: { dir: "r", min: 1, max: 1 },
};

function rule(kind: number, dir: Direction) {
  const r = Object.hasOwn(RULES, kind) ? RULES[kind as EncryptedKind] : undefined;
  if (!r || r.dir !== dir) {
    throw new Error(`frame kind ${kind} not allowed from "${dir}"`);
  }
  return r;
}

function writeU64(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("u64 out of range");
  }
  view.setUint32(offset, Math.floor(value / 0x100000000));
  view.setUint32(offset + 4, value >>> 0);
}

function readU64(view: DataView, offset: number): number {
  const value = view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4);
  if (!Number.isSafeInteger(value)) {
    throw new Error("u64 out of range");
  }
  return value;
}

export function encodeHeader(header: Header): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, header.version);
  view.setUint8(1, header.kind);
  writeU64(view, 2, header.seq);
  return out;
}

export function decodeHeader(frame: Uint8Array): Header {
  if (frame.length < HEADER_BYTES) {
    throw new Error("frame shorter than header");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES);
  return { version: view.getUint8(0), kind: view.getUint8(1), seq: readU64(view, 2) };
}

function iv(dir: Direction, seq: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint8(0, dir === "s" ? 0 : 1);
  writeU64(view, 4, seq);
  return out;
}

/** The one plaintext frame: tells the recipient which transferId to derive the file key from. */
export function encodeInit(transferId: Uint8Array): Uint8Array<ArrayBuffer> {
  if (transferId.length !== 16) {
    throw new Error("transferId must be 16 bytes");
  }
  const out = new Uint8Array(HEADER_BYTES + 16);
  out.set(encodeHeader({ version: FRAME_VERSION, kind: SenderKind.INIT, seq: 0 }));
  out.set(transferId, HEADER_BYTES);
  return out;
}

/** Reads the transferId from an INIT frame. Throws if `frame` is not a well-formed INIT. */
export function decodeInit(frame: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = decodeHeader(frame);
  if (
    header.version !== FRAME_VERSION ||
    header.kind !== SenderKind.INIT ||
    header.seq !== 0 ||
    frame.length !== HEADER_BYTES + 16
  ) {
    throw new Error("malformed INIT frame");
  }
  return frame.slice(HEADER_BYTES);
}

/** Encrypts outgoing frames for one direction of one transfer. Owns the seq counter. */
export class FrameWriter {
  private readonly key: CryptoKey;
  private readonly dir: Direction;
  private seq = 0;

  constructor(key: CryptoKey, dir: Direction) {
    this.key = key;
    this.dir = dir;
  }

  async encrypt(kind: EncryptedKind, body: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const r = rule(kind, this.dir);
    if (body.length < r.min || body.length > r.max) {
      throw new Error(`frame kind ${kind} body of ${body.length} bytes is out of range`);
    }
    const seq = this.seq++;
    const header = encodeHeader({ version: FRAME_VERSION, kind, seq });
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv(this.dir, seq), additionalData: header, tagLength: TAG_BYTES * 8 },
      this.key,
      body as Uint8Array<ArrayBuffer>,
    );
    const out = new Uint8Array(HEADER_BYTES + ciphertext.byteLength);
    out.set(header);
    out.set(new Uint8Array(ciphertext), HEADER_BYTES);
    return out;
  }
}

/** Decrypts incoming frames sent from `dir`. Accepts only contiguous seq numbers. */
export class FrameReader {
  private readonly key: CryptoKey;
  private readonly dir: Direction;
  private expected = 0;
  private failed = false;

  constructor(key: CryptoKey, dir: Direction) {
    this.key = key;
    this.dir = dir;
  }

  async decrypt(frame: Uint8Array): Promise<Frame> {
    if (this.failed) {
      throw new Error("frame reader has failed");
    }
    this.failed = true;
    const header = decodeHeader(frame);
    if (header.version !== FRAME_VERSION) {
      throw new Error("unknown frame version");
    }
    const r = rule(header.kind, this.dir);
    if (header.seq !== this.expected) {
      throw new Error(`frame seq ${header.seq}, expected ${this.expected}`);
    }
    const bodyLength = frame.length - HEADER_BYTES - TAG_BYTES;
    if (bodyLength < r.min || bodyLength > r.max) {
      throw new Error("frame length out of range");
    }
    const seq = this.expected++;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv(this.dir, seq),
        additionalData: frame.slice(0, HEADER_BYTES),
        tagLength: TAG_BYTES * 8,
      },
      this.key,
      frame.subarray(HEADER_BYTES) as Uint8Array<ArrayBuffer>,
    );
    this.failed = false;
    return { kind: header.kind as EncryptedKind, body: new Uint8Array(plaintext) };
  }
}

export type FileMeta = {
  name: string;
  size: number;
  type: string;
  chunkSize: number;
  /** The name the sender typed for themselves, unverified. Empty if they typed none. */
  from: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Thrown by encodeMeta when the file name, type and sender name do not fit in META_PADDED_BYTES. */
export class MetaTooLargeError extends Error {
  constructor() {
    super("file metadata does not fit in the META frame");
    this.name = "MetaTooLargeError";
  }
}

/**
 * Encodes META as exactly META_PADDED_BYTES bytes: the JSON's byte length as
 * a u16 big-endian, the UTF-8 JSON, then zeros. Throws MetaTooLargeError if the
 * JSON does not fit, and a plain Error if the metadata is invalid.
 */
export function encodeMeta(meta: FileMeta): Uint8Array<ArrayBuffer> {
  const checked = parseMeta(meta);
  if (!checked) {
    throw new Error("invalid file metadata");
  }
  const json = encoder.encode(JSON.stringify(checked));
  if (json.length > META_PADDED_BYTES - META_LENGTH_BYTES) {
    throw new MetaTooLargeError();
  }
  const body = new Uint8Array(META_PADDED_BYTES);
  new DataView(body.buffer).setUint16(0, json.length);
  body.set(json, META_LENGTH_BYTES);
  return body;
}

/**
 * Whether a file with this name, type and size can be offered by a sender
 * named `from`: its META fits for any chunk size.
 */
export function metaFits(file: { name: string; type: string; size: number }, from = ""): boolean {
  try {
    const { name, type, size } = file;
    encodeMeta({ name, type, size, chunkSize: MAX_CHUNK_BYTES, from });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses a decrypted META body. Throws unless it is exactly META_PADDED_BYTES
 * long, the length prefix fits, the bytes after the JSON are all zeros and the
 * JSON is valid metadata.
 */
export function decodeMeta(body: Uint8Array): FileMeta {
  if (body.length !== META_PADDED_BYTES) {
    throw new Error("META body has the wrong length");
  }
  const length = new DataView(body.buffer, body.byteOffset, META_LENGTH_BYTES).getUint16(0);
  if (length > META_PADDED_BYTES - META_LENGTH_BYTES) {
    throw new Error("META length out of range");
  }
  const end = META_LENGTH_BYTES + length;
  if (!isZero(body.subarray(end))) {
    throw new Error("META padding is not zeros");
  }
  const meta = parseMeta(JSON.parse(decoder.decode(body.subarray(META_LENGTH_BYTES, end))));
  if (!meta) {
    throw new Error("invalid file metadata");
  }
  return meta;
}

function isZero(bytes: Uint8Array): boolean {
  let bits = 0;
  for (const byte of bytes) {
    bits |= byte;
  }
  return bits === 0;
}

function parseMeta(value: unknown): FileMeta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "chunkSize,from,name,size,type") {
    return undefined;
  }
  const { name, size, type, chunkSize, from } = value as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0 || hasForbiddenCharacters(name)) {
    return undefined;
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return undefined;
  }
  if (typeof type !== "string" || type.length > MAX_TYPE_LENGTH || hasForbiddenCharacters(type)) {
    return undefined;
  }
  if (
    typeof chunkSize !== "number" ||
    !Number.isInteger(chunkSize) ||
    chunkSize < MIN_CHUNK_BYTES ||
    chunkSize > MAX_CHUNK_BYTES
  ) {
    return undefined;
  }
  if (typeof from !== "string" || from.length > MAX_FROM_LENGTH || hasForbiddenCharacters(from)) {
    return undefined;
  }
  // The padded transfer length must stay a safe integer too.
  if (size > MAX_PADDABLE_SIZE) {
    return undefined;
  }
  return { name, size, type, chunkSize, from };
}

/**
 * How many bytes of CHUNK data carry a file of `size` bytes: the size rounded
 * up with Padmé (Nikitin et al., "Reducing Metadata Leakage from Encrypted
 * Files and Communication with PURBs", 2019), which leaks O(log log size) bits
 * and adds at most 12 % (less for bigger files), then rounded up to a
 * whole number of chunks so every CHUNK frame has the same size. An empty file
 * is padded like a 1-byte file, to one full chunk, so it looks like any other
 * small file.
 *
 * Interim: SIG-7 owns the final padding function. Keep it this one exported
 * function so the sender and the recipient always agree.
 */
export function paddedLength(size: number, chunkSize: number = MAX_CHUNK_BYTES): number {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PADDABLE_SIZE) {
    throw new Error("size out of range");
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES) {
    throw new Error("chunk size out of range");
  }
  const padded = padme(Math.max(size, 1));
  return Math.ceil(padded / chunkSize) * chunkSize;
}

/** Padmé for L ≥ 1, in floating-point arithmetic that stays exact up to 2^53. */
function padme(length: number): number {
  if (length < 2) {
    return length;
  }
  const e = floorLog2(length);
  const s = floorLog2(e) + 1;
  const step = 2 ** (e - s);
  return Math.ceil(length / step) * step;
}

/** floor(log2(n)) for a safe integer n ≥ 1, corrected for Math.log2 rounding. */
function floorLog2(n: number): number {
  let e = Math.floor(Math.log2(n));
  while (2 ** e > n) {
    e--;
  }
  while (2 ** (e + 1) <= n) {
    e++;
  }
  return e;
}

export function encodeEnd(sha256: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  if (sha256.length !== 32) {
    throw new Error("sha256 must be 32 bytes");
  }
  const out = new Uint8Array(40);
  out.set(sha256);
  writeU64(new DataView(out.buffer), 32, size);
  return out;
}

export function decodeEnd(body: Uint8Array): { sha256: Uint8Array; size: number } {
  if (body.length !== 40) {
    throw new Error("malformed END body");
  }
  const view = new DataView(body.buffer, body.byteOffset, 40);
  return { sha256: body.slice(0, 32), size: readU64(view, 32) };
}

/** CREDIT body: the cumulative number of CHUNKs the recipient lets the sender send. */
export function encodeCredit(granted: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8);
  writeU64(new DataView(out.buffer), 0, granted);
  return out;
}

export function decodeCredit(body: Uint8Array): number {
  if (body.length !== 8) {
    throw new Error("malformed CREDIT body");
  }
  return readU64(new DataView(body.buffer, body.byteOffset, 8), 0);
}

/** CHECK body: whether this side's user said the check numbers match. */
export function encodeCheck(matches: boolean): Uint8Array<ArrayBuffer> {
  return new Uint8Array([matches ? 1 : 0]);
}

export function decodeCheck(body: Uint8Array): boolean {
  if (body.length !== 1 || (body[0] !== 0 && body[0] !== 1)) {
    throw new Error("malformed CHECK body");
  }
  return body[0] === 1;
}

/**
 * Thrown by ReceiveVerifier.end when every frame was valid but the file bytes
 * do not hash to END's checksum. `actual` is the checksum of what arrived, for
 * the RECEIPT that tells the sender.
 */
export class ChecksumMismatchError extends Error {
  readonly actual: Uint8Array;

  constructor(actual: Uint8Array) {
    super("checksum mismatch");
    this.name = "ChecksumMismatchError";
    this.actual = actual;
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
 * Checks that a received file is complete. Feed it the decrypted META, every
 * CHUNK body and the END body, in order. It hashes the file bytes itself.
 * Every CHUNK must be exactly META's chunkSize, and the chunks must add up to
 * exactly paddedLength(size, chunkSize); chunk() returns the part of each that
 * is file content, and the rest must be zeros. `finish()` throws unless an END
 * arrived whose size matches META and whose checksum matches the file bytes
 * received; anything short of that counts as truncation. Any error leaves it
 * failed for good.
 */
export class ReceiveVerifier {
  private size: number | undefined;
  private chunkSize = 0;
  private expected = 0;
  private received = 0;
  private readonly hash = new Sha256();
  private digest: Uint8Array | undefined;
  private failed = false;

  /** Bytes of file content accepted so far, not counting padding. */
  get bytesReceived(): number {
    return this.size === undefined ? 0 : Math.min(this.received, this.size);
  }

  meta(meta: { size: number; chunkSize: number }): void {
    this.step(() => {
      if (this.size !== undefined) {
        throw new Error("META received twice");
      }
      this.expected = paddedLength(meta.size, meta.chunkSize);
      this.chunkSize = meta.chunkSize;
      this.size = meta.size;
    });
  }

  /** Checks one CHUNK body and returns the file bytes in it (a view, possibly empty). */
  chunk(body: Uint8Array): Uint8Array {
    return this.step(() => {
      if (this.size === undefined) {
        throw new Error("CHUNK before META");
      }
      if (this.digest) {
        throw new Error("CHUNK after END");
      }
      if (body.length !== this.chunkSize) {
        throw new Error("CHUNK is not the chunk size");
      }
      if (this.received + body.length > this.expected) {
        throw new Error("more chunks than META size");
      }
      const fileBytes = Math.max(0, Math.min(body.length, this.size - this.received));
      if (!isZero(body.subarray(fileBytes))) {
        throw new Error("CHUNK padding is not zeros");
      }
      this.received += body.length;
      const data = body.subarray(0, fileBytes);
      this.hash.update(data);
      return data;
    });
  }

  /**
   * Checks the END body. Returns the checksum of the received file bytes, or
   * throws ChecksumMismatchError if it differs from END's.
   */
  end(endBody: Uint8Array): Uint8Array {
    return this.step(() => {
      if (this.size === undefined) {
        throw new Error("END before META");
      }
      if (this.digest) {
        throw new Error("END received twice");
      }
      const end = decodeEnd(endBody);
      if (end.size !== this.size) {
        throw new Error("END size differs from META size");
      }
      if (this.received !== this.expected) {
        throw new Error("END before all chunks were received");
      }
      const digest = this.hash.digest();
      if (!equalBytes(digest, end.sha256)) {
        throw new ChecksumMismatchError(digest.slice());
      }
      this.digest = digest;
      return digest.slice();
    });
  }

  /** Returns the verified checksum. Throws unless the transfer completed. */
  finish(): Uint8Array {
    if (this.failed || !this.digest) {
      throw new Error("transfer incomplete");
    }
    return this.digest.slice();
  }

  private step<T>(fn: () => T): T {
    if (this.failed) {
      throw new Error("receive verifier has failed");
    }
    try {
      return fn();
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}
