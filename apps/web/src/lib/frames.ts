// Data channel framing and per-frame encryption.
//
// Frame  = header(10) || body
// Header = version(1) = 1 || kind(1) || seq(8, u64 big-endian). Plaintext, and
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
// |    1 | META    |  s  | UTF-8 JSON {name, size, type, chunkSize}, ≤ 8 KiB |
// |    2 | CHUNK   |  s  | 1 to 48 KiB of file bytes                        |
// |    3 | END     |  s  | sha256(32) || size(8, u64 big-endian)            |
// |   16 | ACCEPT  |  r  | empty (proves the recipient holds the key)       |
// |   17 | RECEIPT |  r  | sha256(32) the recipient computed                |
// |   18 | DECLINE |  r  | empty                                            |
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

import type { Direction } from "./keys.ts";
import { Sha256 } from "./sha256.ts";

export const FRAME_VERSION = 1;
export const HEADER_BYTES = 10;
export const TAG_BYTES = 16;
export const MAX_CHUNK_BYTES = 48 * 1024;
export const MAX_META_BYTES = 8 * 1024;
export const MAX_NAME_LENGTH = 1024;

export const SenderKind = { INIT: 0, META: 1, CHUNK: 2, END: 3 } as const;
export const RecipientKind = { ACCEPT: 16, RECEIPT: 17, DECLINE: 18 } as const;

export type SenderKind = (typeof SenderKind)[keyof typeof SenderKind];
export type RecipientKind = (typeof RecipientKind)[keyof typeof RecipientKind];
/** Kinds that travel encrypted. */
export type EncryptedKind = Exclude<SenderKind, 0> | RecipientKind;

export type Header = { version: number; kind: number; seq: number };
export type Frame = { kind: EncryptedKind; body: Uint8Array };

/** Allowed body size range per encrypted kind, and which direction sends it. */
const RULES: Record<EncryptedKind, { dir: Direction; min: number; max: number }> = {
  [SenderKind.META]: { dir: "s", min: 2, max: MAX_META_BYTES },
  [SenderKind.CHUNK]: { dir: "s", min: 1, max: MAX_CHUNK_BYTES },
  [SenderKind.END]: { dir: "s", min: 40, max: 40 },
  [RecipientKind.ACCEPT]: { dir: "r", min: 0, max: 0 },
  [RecipientKind.RECEIPT]: { dir: "r", min: 32, max: 32 },
  [RecipientKind.DECLINE]: { dir: "r", min: 0, max: 0 },
};

function rule(kind: number, dir: Direction) {
  const r = Object.hasOwn(RULES, kind) ? RULES[kind as EncryptedKind] : undefined;
  if (!r || r.dir !== dir) throw new Error(`frame kind ${kind} not allowed from "${dir}"`);
  return r;
}

function writeU64(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("u64 out of range");
  view.setUint32(offset, Math.floor(value / 0x100000000));
  view.setUint32(offset + 4, value >>> 0);
}

function readU64(view: DataView, offset: number): number {
  const value = view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4);
  if (!Number.isSafeInteger(value)) throw new Error("u64 out of range");
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
  if (frame.length < HEADER_BYTES) throw new Error("frame shorter than header");
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
  if (transferId.length !== 16) throw new Error("transferId must be 16 bytes");
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
    if (this.failed) throw new Error("frame reader has failed");
    this.failed = true;
    const header = decodeHeader(frame);
    if (header.version !== FRAME_VERSION) throw new Error("unknown frame version");
    const r = rule(header.kind, this.dir);
    if (header.seq !== this.expected) {
      throw new Error(`frame seq ${header.seq}, expected ${this.expected}`);
    }
    const bodyLength = frame.length - HEADER_BYTES - TAG_BYTES;
    if (bodyLength < r.min || bodyLength > r.max) throw new Error("frame length out of range");
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

export type FileMeta = { name: string; size: number; type: string; chunkSize: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeMeta(meta: FileMeta): Uint8Array<ArrayBuffer> {
  const checked = parseMeta(meta);
  if (!checked) throw new Error("invalid file metadata");
  const body = encoder.encode(JSON.stringify(checked));
  if (body.length > MAX_META_BYTES) throw new Error("file metadata too large");
  return body;
}

/** Parses a decrypted META body. Throws if it is not valid metadata. */
export function decodeMeta(body: Uint8Array): FileMeta {
  const meta = parseMeta(JSON.parse(decoder.decode(body)));
  if (!meta) throw new Error("invalid file metadata");
  return meta;
}

function parseMeta(value: unknown): FileMeta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "chunkSize,name,size,type") return undefined;
  const { name, size, type, chunkSize } = value as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return undefined;
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  if (typeof type !== "string" || type.length > 255) return undefined;
  if (
    typeof chunkSize !== "number" ||
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > MAX_CHUNK_BYTES
  ) {
    return undefined;
  }
  return { name, size, type, chunkSize };
}

export function encodeEnd(sha256: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  if (sha256.length !== 32) throw new Error("sha256 must be 32 bytes");
  const out = new Uint8Array(40);
  out.set(sha256);
  writeU64(new DataView(out.buffer), 32, size);
  return out;
}

export function decodeEnd(body: Uint8Array): { sha256: Uint8Array; size: number } {
  if (body.length !== 40) throw new Error("malformed END body");
  const view = new DataView(body.buffer, body.byteOffset, 40);
  return { sha256: body.slice(0, 32), size: readU64(view, 32) };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * Checks that a received file is complete. Feed it the decrypted META size,
 * every CHUNK body and the END body, in order. It hashes the chunks itself.
 * `finish()` throws unless an END arrived whose size matches META and the
 * bytes received and whose checksum matches the bytes received; anything
 * short of that counts as truncation. Any error leaves it failed for good.
 */
export class ReceiveVerifier {
  private size: number | undefined;
  private received = 0;
  private readonly hash = new Sha256();
  private digest: Uint8Array | undefined;
  private failed = false;

  /** Bytes of file content accepted so far. */
  get bytesReceived(): number {
    return this.received;
  }

  meta(meta: { size: number }): void {
    this.step(() => {
      if (this.size !== undefined) throw new Error("META received twice");
      if (!Number.isSafeInteger(meta.size) || meta.size < 0) throw new Error("invalid size");
      this.size = meta.size;
    });
  }

  chunk(body: Uint8Array): void {
    this.step(() => {
      if (this.size === undefined) throw new Error("CHUNK before META");
      if (this.digest) throw new Error("CHUNK after END");
      if (this.received + body.length > this.size) throw new Error("more bytes than META size");
      this.received += body.length;
      this.hash.update(body);
    });
  }

  /** Checks the END body. Returns the checksum of the received bytes. */
  end(endBody: Uint8Array): Uint8Array {
    return this.step(() => {
      if (this.size === undefined) throw new Error("END before META");
      if (this.digest) throw new Error("END received twice");
      const end = decodeEnd(endBody);
      if (end.size !== this.size) throw new Error("END size differs from META size");
      if (end.size !== this.received) throw new Error("END size differs from bytes received");
      const digest = this.hash.digest();
      if (!equalBytes(digest, end.sha256)) throw new Error("checksum mismatch");
      this.digest = digest;
      return digest.slice();
    });
  }

  /** Returns the verified checksum. Throws unless the transfer completed. */
  finish(): Uint8Array {
    if (this.failed || !this.digest) throw new Error("transfer incomplete");
    return this.digest.slice();
  }

  private step<T>(fn: () => T): T {
    if (this.failed) throw new Error("receive verifier has failed");
    try {
      return fn();
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}
