// Chunked AES-GCM stream for the FID-7 spike.
//
// WebCrypto AES-GCM does not stream, so the padded file is cut into chunks of
// exactly chunkSize bytes and each chunk is its own AES-GCM message under the
// content key. The framing follows apps/web/src/lib/frames.ts so it can later
// be lifted into the app.
//
// Stream header = version(1) = 2 || transferId(16) || chunkSize(4, u32 BE)
//                 || paddedLength(8, u64 BE), 29 bytes, plaintext. Sent or
//                 stored once, before the frames.
// Frame         = frameHeader(10) || AES-GCM-256(contentKey, iv, aad, chunk)
//                 with the 16-byte tag appended.
// Frame header  = version(1) = 2 || kind(1) || seq(8, u64 BE), plaintext.
// AAD           = frameHeader || streamHeader, 39 bytes.
// IV            = kind(1) || 00 00 00 || seq(8, u64 BE), exactly 12 bytes.
//
// | kind | name        | body                                              |
// |------|-------------|---------------------------------------------------|
// |    1 | META        | reserved for container.ts, under the meta key     |
// |    2 | SEALED      | reserved for container.ts, under the content key  |
// |    3 | CHUNK       | exactly chunkSize bytes, seq 0 .. count - 2       |
// |    4 | CHUNK_FINAL | exactly chunkSize bytes, seq count - 1            |
//
// count = chunkCount(paddedLength, chunkSize). The last chunk has its own kind,
// and the kind is in the AAD, so dropping the tail is caught twice: the reader
// never sees CHUNK_FINAL (finish() throws), and no CHUNK can be relabelled as
// final without breaking its tag. A CHUNK_FINAL before seq count - 1, any frame
// after it, and any seq other than the next one all fail.
//
// AAD: the raw stream header bytes go into every chunk's AAD next to the frame
// header. Both have fixed lengths, so the concatenation is unambiguous, and a
// 29-byte copy per chunk is cheaper and simpler than a digest. A reader given a
// different transferId, chunkSize or paddedLength than the writer used fails on
// the first chunk. transferId is also the HKDF salt of the content key, so a
// changed transferId gives another key as well; binding it here keeps the
// stream sound even if key derivation changes.
//
// IV: the content key is unique per transfer (fresh random F and S, transferId
// as salt), so a counter IV is safe as long as no (kind, seq) pair is
// encrypted twice: the writer owns the counter and encrypts each seq once.
// frames.ts puts a direction byte first because both peers encrypt under one
// key. Here only the sender ever encrypts under the content key, so that byte
// carries the kind instead, which keeps the SEALED frame (kind 2, seq 0) from
// sharing a nonce with chunk 0.
//
// Writers and readers keep state: await each call before starting the next.
// A reader stops accepting frames after any failure, including finish().
// Frames are handled one at a time, so neither side holds more than one chunk.

import { TRANSFER_ID_BYTES } from "./keys.ts";
import { chunkCount } from "./padding.ts";

export const STREAM_VERSION = 2;
export const STREAM_HEADER_BYTES = 29;
export const FRAME_HEADER_BYTES = 10;
export const TAG_BYTES = 16;

export const Kind = { META: 1, SEALED: 2, CHUNK: 3, CHUNK_FINAL: 4 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export type StreamHeader = {
  transferId: Uint8Array;
  chunkSize: number;
  paddedLength: number;
};

export type FrameHeader = { version: number; kind: number; seq: number };

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

/** Encodes the stream header. Throws unless paddedLength is a whole number of chunks. */
export function encodeStreamHeader(header: StreamHeader): Uint8Array<ArrayBuffer> {
  if (header.transferId.length !== TRANSFER_ID_BYTES) {
    throw new Error("transferId must be 16 bytes");
  }
  chunkCount(header.paddedLength, header.chunkSize);
  const out = new Uint8Array(STREAM_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, STREAM_VERSION);
  out.set(header.transferId, 1);
  view.setUint32(17, header.chunkSize);
  writeU64(view, 21, header.paddedLength);
  return out;
}

/** Decodes and checks a stream header. Throws for anything malformed. */
export function decodeStreamHeader(bytes: Uint8Array): StreamHeader {
  if (bytes.length !== STREAM_HEADER_BYTES) {
    throw new Error("malformed stream header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (view.getUint8(0) !== STREAM_VERSION) {
    throw new Error("unknown stream version");
  }
  const header = {
    transferId: bytes.slice(1, 17),
    chunkSize: view.getUint32(17),
    paddedLength: readU64(view, 21),
  };
  chunkCount(header.paddedLength, header.chunkSize);
  return header;
}

export function encodeFrameHeader(header: FrameHeader): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, header.version);
  view.setUint8(1, header.kind);
  writeU64(view, 2, header.seq);
  return out;
}

export function decodeFrameHeader(frame: Uint8Array): FrameHeader {
  if (frame.length < FRAME_HEADER_BYTES) {
    throw new Error("frame shorter than header");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, FRAME_HEADER_BYTES);
  return { version: view.getUint8(0), kind: view.getUint8(1), seq: readU64(view, 2) };
}

/** IV for (kind, seq). Exported so container.ts derives the SEALED nonce the same way. */
export function frameIv(kind: Kind, seq: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  writeU64(view, 4, seq);
  return out;
}

/** frameHeader || streamHeader, the AAD of one frame. */
export function frameAad(
  frameHeader: Uint8Array,
  streamHeader: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(FRAME_HEADER_BYTES + STREAM_HEADER_BYTES);
  out.set(frameHeader);
  out.set(streamHeader, FRAME_HEADER_BYTES);
  return out;
}

/** Encrypts the chunks of one stream in order. The last one goes out as CHUNK_FINAL. */
export class StreamWriter {
  private readonly key: CryptoKey;
  private readonly header: Uint8Array<ArrayBuffer>;
  readonly chunkSize: number;
  readonly count: number;
  private seq = 0;

  constructor(key: CryptoKey, header: StreamHeader) {
    this.key = key;
    this.header = encodeStreamHeader(header);
    this.chunkSize = header.chunkSize;
    this.count = chunkCount(header.paddedLength, header.chunkSize);
  }

  /** The encoded stream header, to send or store before the frames. */
  get streamHeader(): Uint8Array<ArrayBuffer> {
    return this.header.slice();
  }

  /** True once CHUNK_FINAL has been produced. */
  get done(): boolean {
    return this.seq === this.count;
  }

  /** Encrypts the next chunk, which must be exactly chunkSize bytes of padded plaintext. */
  async encrypt(chunk: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (this.done) {
      throw new Error("stream already finished");
    }
    if (chunk.length !== this.chunkSize) {
      throw new Error(`chunk of ${chunk.length} bytes, expected ${this.chunkSize}`);
    }
    const seq = this.seq++;
    const kind = seq === this.count - 1 ? Kind.CHUNK_FINAL : Kind.CHUNK;
    const frameHeader = encodeFrameHeader({ version: STREAM_VERSION, kind, seq });
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: frameIv(kind, seq),
        additionalData: frameAad(frameHeader, this.header),
        tagLength: TAG_BYTES * 8,
      },
      this.key,
      chunk as Uint8Array<ArrayBuffer>,
    );
    const out = new Uint8Array(FRAME_HEADER_BYTES + ciphertext.byteLength);
    out.set(frameHeader);
    out.set(new Uint8Array(ciphertext), FRAME_HEADER_BYTES);
    return out;
  }
}

/** Decrypts the frames of one stream. Accepts only the next seq; fails for good on any error. */
export class StreamReader {
  private readonly key: CryptoKey;
  private readonly header: Uint8Array<ArrayBuffer>;
  readonly chunkSize: number;
  readonly count: number;
  private expected = 0;
  private failed = false;

  constructor(key: CryptoKey, header: StreamHeader) {
    this.key = key;
    this.header = encodeStreamHeader(header);
    this.chunkSize = header.chunkSize;
    this.count = chunkCount(header.paddedLength, header.chunkSize);
  }

  /** True once CHUNK_FINAL has been decrypted. */
  get done(): boolean {
    return this.expected === this.count;
  }

  /** Decrypts the next frame and returns its chunkSize bytes of padded plaintext. */
  async decrypt(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (this.failed) {
      throw new Error("stream reader has failed");
    }
    this.failed = true;
    if (this.done) {
      throw new Error("frame after CHUNK_FINAL");
    }
    const header = decodeFrameHeader(frame);
    if (header.version !== STREAM_VERSION) {
      throw new Error("unknown frame version");
    }
    if (header.seq !== this.expected) {
      throw new Error(`frame seq ${header.seq}, expected ${this.expected}`);
    }
    const kind = header.seq === this.count - 1 ? Kind.CHUNK_FINAL : Kind.CHUNK;
    if (header.kind !== kind) {
      throw new Error(`frame kind ${header.kind} at seq ${header.seq}, expected ${kind}`);
    }
    if (frame.length !== FRAME_HEADER_BYTES + this.chunkSize + TAG_BYTES) {
      throw new Error("frame length out of range");
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: frameIv(kind, header.seq),
        additionalData: frameAad(frame.slice(0, FRAME_HEADER_BYTES), this.header),
        tagLength: TAG_BYTES * 8,
      },
      this.key,
      frame.subarray(FRAME_HEADER_BYTES) as Uint8Array<ArrayBuffer>,
    );
    this.expected++;
    this.failed = false;
    return new Uint8Array(plaintext);
  }

  /** Call after the last frame. Throws, and fails the reader, unless CHUNK_FINAL arrived. */
  finish(): void {
    if (this.failed) {
      throw new Error("stream reader has failed");
    }
    if (!this.done) {
      this.failed = true;
      throw new Error(`stream incomplete: ${this.expected} of ${this.count} chunks`);
    }
  }
}

/**
 * Cuts `source` into chunks of exactly chunkSize bytes, zero-filling after the
 * end of the data, until paddedLength bytes have been yielded. Holds at most
 * one chunk. Throws if the source has more than paddedLength bytes. Each
 * yielded chunk is a fresh buffer the caller may keep.
 */
export async function* padChunks(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  chunkSize: number,
  paddedLength: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const count = chunkCount(paddedLength, chunkSize);
  let emitted = 0;
  let chunk = new Uint8Array(chunkSize);
  let filled = 0;
  for await (const piece of source) {
    let offset = 0;
    while (offset < piece.length) {
      if (emitted === count) {
        throw new Error("source longer than paddedLength");
      }
      const take = Math.min(chunkSize - filled, piece.length - offset);
      chunk.set(piece.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === chunkSize) {
        yield chunk;
        emitted++;
        chunk = new Uint8Array(chunkSize);
        filled = 0;
      }
    }
  }
  // The tail: the partly filled chunk (already zero after `filled`), then whole zero chunks.
  while (emitted < count) {
    yield chunk;
    emitted++;
    chunk = new Uint8Array(chunkSize);
  }
}
