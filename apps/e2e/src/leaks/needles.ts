import { hash } from "node:crypto";
import {
  type CanaryFile,
  defaultChunkSize,
  type LargeCanaryFile,
  sizeIsCheckable,
} from "./canary.ts";

/** The secret classes of 0001: content, metadata, keys and the server key half. */
export type SecretClass = "C" | "M" | "K" | "S";

/** Bytes to look for. Any `window`-byte run of them in any view is a leak. */
export interface ByteSecret {
  class: SecretClass;
  /** Names the secret in findings, such as `file#1 name`. */
  label: string;
  bytes: Uint8Array;
  /** Default 16 (0001). At least 8. A secret shorter than its window must appear whole. */
  window?: number;
  /** ASCII letters match in either case, as for base32 tokens. */
  caseInsensitive?: boolean;
  /** Where it may appear, for a secret of an emailed link (`allowEmailed`). Nowhere if unset. */
  allowed?: Allowed;
}

/**
 * Where decision 0012 lets a secret of an emailed link appear: signaling messages about the link
 * and mail to its address alone. `allowEmailed` drops findings there; elsewhere they stand.
 */
export interface Allowed {
  /** The emailed link's ID. */
  link: string;
  /**
   * The signaling messages about `link` that may carry it, as direction and type, such as
   * `sent email`, `received token` or `sent join`. Of `sent email` only the first counts: a link
   * is registered for email once.
   */
  frames: readonly string[];
  /**
   * Mail as one plain-text part to `to` alone (one To, no Cc or Bcc) may carry it: with `notice`
   * (a Mailpit ID) only that message's body, without it any part of any such mail.
   */
  mail?: { to: string; notice?: string };
}

/** A file size N, found as a whole decimal or hex number (check (i) of 0001). */
export interface SizeSecret {
  class: "M";
  label: string;
  size: number;
}

export type Secret = ByteSecret | SizeSecret;

/** The shortest window. Shorter ones would match by chance; the index also keys on 8 bytes. */
export const minWindow = 8;
const defaultWindow = 16;
/** Any 12 characters of a 16-character base32 token (60 bits) are a match (0001). */
const tokenWindow = 12;
/** The fragment secret as text: 20 base64url characters carry 120 bits (0001). */
const keyTextWindow = 20;

const sha256 = (data: Uint8Array | string) => hash("sha256", data, "buffer");

export interface FileSecretOptions {
  /** The chunk size that decides whether the size check applies. Default 48 KiB. */
  chunkSize?: number;
}

/** What content must never leak: the bytes and their SHA-256 (C). */
export function contentSecrets(label: string, bytes: Uint8Array): Secret[] {
  const secrets: Secret[] = [];
  if (bytes.length >= minWindow) {
    secrets.push({ class: "C", label, bytes });
  }
  // SHA-256 of no bytes is a well-known constant that shows up legitimately.
  if (bytes.length > 0) {
    secrets.push({ class: "C", label: `${label} sha256`, bytes: sha256(bytes) });
  }
  return secrets;
}

/**
 * Everything a canary file must never leak: its bytes, or a large file's sampled bytes, each
 * sample on its own, and their SHA-256 (C); the tokens in its name and MIME type, the SHA-256 of
 * its name, and its size when check (i) applies (M).
 */
export function fileSecrets(
  label: string,
  file: CanaryFile | LargeCanaryFile,
  options: FileSecretOptions = {},
): Secret[] {
  const secrets: Secret[] =
    "bytes" in file
      ? contentSecrets(label, file.bytes)
      : [
          ...file.samples.map(({ offset, bytes }) => ({
            class: "C" as const,
            label: `${label} at ${offset}`,
            bytes,
          })),
          { class: "C", label: `${label} sha256`, bytes: file.sha256 },
        ];
  secrets.push(
    tokenSecret("M", `${label} name`, file.token),
    tokenSecret("M", `${label} type`, file.mimeToken),
    ...forms(file.name).map((name) => ({
      class: "M" as const,
      label: `${label} name sha256`,
      bytes: sha256(name),
    })),
  );
  if (sizeIsCheckable(file.size, options.chunkSize ?? defaultChunkSize)) {
    secrets.push({ class: "M", label: `${label} size`, size: file.size });
  }
  return secrets;
}

/**
 * A key as every byte value it stands for, and the SHA-256 of each. A string key, such as a
 * fragment secret, is also searched as text (any 20 characters), and its byte values are every
 * decoding of it as hex, base64url or base64 (padded or not) that encodes back to it and is at
 * least 8 bytes. The key's text forms (the given text, and the base64url, base64 and lowercase hex
 * of each byte value) are searched as their SHA-256 and the SHA-256 of `#` and the text, as a
 * lookup ID derived from a fragment would be.
 */
export function keySecrets(
  label: string,
  key: Uint8Array | string,
  cls: "K" | "S" = "K",
): Secret[] {
  const secrets: Secret[] = [];
  const texts = new Map<string, string>();
  if (typeof key === "string") {
    secrets.push({
      class: cls,
      label: `${label} text`,
      bytes: Buffer.from(key),
      window: keyTextWindow,
    });
    texts.set(key, "text");
  }
  for (const bytes of typeof key === "string" ? decodings(key) : [key]) {
    secrets.push(
      { class: cls, label, bytes },
      { class: cls, label: `${label} sha256`, bytes: sha256(bytes) },
    );
    for (const encoding of ["base64url", "base64", "hex"] as const) {
      const text = Buffer.from(bytes).toString(encoding);
      if (!texts.has(text)) {
        texts.set(text, encoding);
      }
    }
  }
  for (const [text, form] of texts) {
    secrets.push(
      { class: cls, label: `${label} ${form} sha256`, bytes: sha256(text) },
      { class: cls, label: `${label} #${form} sha256`, bytes: sha256(`#${text}`) },
    );
  }
  return secrets;
}

/** The distinct byte values of `text` as hex, base64url or base64, at least 8 bytes each. */
function decodings(text: string): Buffer[] {
  const values = new Map<string, Buffer>();
  for (const encoding of ["base64url", "base64", "hex"] as const) {
    // Node decodes leniently (base64 takes - and _, hex stops at a bad pair): keep round trips.
    const bytes = Buffer.from(text, encoding);
    const back = bytes.toString(encoding);
    const exact =
      encoding === "hex"
        ? back === text.toLowerCase()
        : back === text || back.replace(/=+$/, "") === text;
    if (exact && bytes.length >= minWindow) {
      values.set(bytes.toString("hex"), bytes);
    }
  }
  return [...values.values()];
}

/** Text such as a recipient label, in NFC and NFD UTF-8. By default it must appear whole. */
export function textSecrets(
  cls: SecretClass,
  label: string,
  text: string,
  options: { window?: number; caseInsensitive?: boolean } = {},
): ByteSecret[] {
  return forms(text).map((form) => {
    const bytes = Buffer.from(form);
    return {
      class: cls,
      label,
      bytes,
      window: options.window ?? bytes.length,
      ...caseOption(options),
    };
  });
}

function tokenSecret(cls: SecretClass, label: string, token: string): ByteSecret {
  return {
    class: cls,
    label,
    bytes: Buffer.from(token),
    window: tokenWindow,
    caseInsensitive: true,
  };
}

/** How many leading bytes of a secret get base64 text forms. */
const base64MaxBytes = 64 * 1024;

/**
 * The base64 characters fully determined by `window` bytes, however they are aligned in a base64
 * stream: the fewest over the 3 alignments. 16 bytes give 20 characters (120 bits, as 0001 says);
 * the 12 characters of a name token give 15 (90 bits, about 2^-90 per position by chance).
 */
const base64Window = (window: number) =>
  Math.min(
    ...[0, 1, 2].map(
      (shift) => Math.floor((8 * (shift + window)) / 6) - Math.ceil((8 * shift) / 6),
    ),
  );

/**
 * The secret as base64 and base64url text, with padding stripped, at each of the 3 alignments it
 * can have in a base64 stream. The haystack decoder cannot find a secret that is only a short
 * base64 fragment (fewer than 22 characters), so the needle side does. At alignment `shift` the
 * secret follows `shift` bytes of something else, so the text starts at the first character that
 * holds secret bits only; the last character may hold fewer bits and is kept for a secret at the
 * end of a stream. Any `base64Window(window)` characters in a row match, case-sensitively.
 */
function base64Secrets(secret: ByteSecret): ByteSecret[] {
  const { class: cls, label } = secret;
  // Text forms are about 1.3 times as long, six of them, and each needs index space: for a large
  // canary only the first 64 KiB gets them. The rest is found by the haystack decoder, which
  // decodes any base64 run of 22 or more characters.
  const bytes = secret.bytes.subarray(0, base64MaxBytes);
  const w = Math.min(secret.window ?? defaultWindow, bytes.length);
  const secrets: ByteSecret[] = [];
  const seen = new Set<string>();
  for (const shift of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(shift), bytes]);
    for (const encoding of ["base64", "base64url"] as const) {
      const text = padded
        .toString(encoding)
        .replaceAll("=", "")
        .slice(Math.ceil((8 * shift) / 6));
      const textWindow = Math.min(base64Window(w), text.length);
      if (textWindow < minWindow || seen.has(text)) {
        continue;
      }
      seen.add(text);
      secrets.push({ class: cls, label, bytes: Buffer.from(text), window: textWindow });
    }
  }
  return secrets;
}

const caseOption = (options: { caseInsensitive?: boolean }) =>
  options.caseInsensitive ? { caseInsensitive: true } : {};

/** The NFC and NFD forms of `text`, once each. */
function forms(text: string): string[] {
  return [...new Set([text.normalize("NFC"), text.normalize("NFD")])];
}

/** One match of a byte secret in a view. */
export interface WindowMatch {
  secret: ByteSecret;
  /** Where the match starts in the view. */
  offset: number;
  /** How many bytes match in a row, at least the window. */
  length: number;
}

interface Segment {
  secret: ByteSecret;
  start: number;
  length: number;
  window: number;
  folded: boolean;
}

/**
 * Compiled secrets. Each byte secret also contributes its base64 and base64url text (see `base64Secrets`). Each text or byte form contributes 8-byte anchors taken every `stride` bytes, where
 * `stride + 7 <= window`, so every window of a secret contains a whole anchor. Matching looks up
 * the 8 bytes at each view position, whatever the number of secrets, and grows a hit both ways to
 * the full run of matching bytes. Case-insensitive secrets have a table of their own, keyed on
 * lowercase, so the large table of content stays free of folded lookups.
 */
export class Needles {
  readonly sizes: readonly SizeSecret[];
  #store: Buffer;
  #segments: Segment[] = [];
  #starts: number[] = [];
  #exact: AnchorTable;
  #folded: AnchorTable;

  constructor(secrets: readonly Secret[]) {
    this.sizes = secrets.filter((secret): secret is SizeSecret => "size" in secret);
    const byteSecrets = secrets
      .filter((secret): secret is ByteSecret => "bytes" in secret)
      .flatMap((secret) => [
        secret,
        ...base64Secrets(secret),
        // The text is case-insensitive, its base64 is not: uppercase text encodes differently.
        // Mixed case stays unwatched in base64 (see SIG-275).
        ...(secret.caseInsensitive
          ? base64Secrets({ ...secret, bytes: asciiUpper(secret.bytes) })
          : []),
      ]);
    const anchors = { exact: 0, folded: 0 };
    let offset = 0;
    for (const secret of byteSecrets) {
      const window = Math.min(secret.window ?? defaultWindow, secret.bytes.length);
      if (window < minWindow) {
        throw new Error(`${secret.class} ${secret.label}: needs at least ${minWindow} bytes.`);
      }
      const folded = secret.caseInsensitive === true;
      const segment = { secret, start: offset, length: secret.bytes.length, window, folded };
      this.#segments.push(segment);
      this.#starts.push(offset);
      offset += secret.bytes.length;
      anchors[folded ? "folded" : "exact"] += Math.ceil(
        (segment.length - minWindow + 1) / stride(segment),
      );
    }
    if (offset >= 2 ** 31) {
      throw new Error("Secrets over 2 GiB in total are not supported.");
    }
    this.#store = Buffer.alloc(offset);
    this.#exact = new AnchorTable(anchors.exact);
    this.#folded = new AnchorTable(anchors.folded);
    for (const segment of this.#segments) {
      const { start, length, folded } = segment;
      this.#store.set(segment.secret.bytes, start);
      if (folded) {
        for (let i = start; i < start + length; i++) {
          this.#store[i] = lower(this.#store[i] as number);
        }
      }
      const table = folded ? this.#folded : this.#exact;
      for (let at = start; at + minWindow <= start + length; at += stride(segment)) {
        table.insert(at, word(this.#store, at), word(this.#store, at + 4));
      }
    }
  }

  /** Calls `found` for each run of `bytes` that matches a secret's window, left to right. */
  match(bytes: Uint8Array, found: (match: WindowMatch) => void): void {
    const exact = this.#exact;
    const folded = this.#folded;
    const end = bytes.length - minWindow;
    if (end < 0) {
      return;
    }
    let lo = word(bytes, 0);
    let hi = word(bytes, 4);
    for (let at = 0; ; ) {
      let next = 0;
      if (exact.has(lo, hi)) {
        next = this.#grow(exact, bytes, at, lo, hi, found);
      }
      if (next === 0 && folded.size > 0) {
        const foldedLo = foldWord(lo);
        const foldedHi = foldWord(hi);
        if (folded.has(foldedLo, foldedHi)) {
          next = this.#grow(folded, bytes, at, foldedLo, foldedHi, found);
        }
      }
      if (next === 0) {
        if (++at > end) {
          return;
        }
        // Roll the anchor one byte on instead of reading all eight again.
        lo = (lo >>> 8) | ((hi & 0xff) << 24);
        hi = (hi >>> 8) | ((bytes[at + 7] as number) << 24);
      } else {
        at = next;
        if (at > end) {
          return;
        }
        lo = word(bytes, at);
        hi = word(bytes, at + 4);
      }
    }
  }

  /**
   * Grows each hit of the anchor `lo`, `hi` at `at` both ways. Reports the first run at least a
   * window long and returns where to go on scanning, or returns 0.
   */
  #grow(
    table: AnchorTable,
    bytes: Uint8Array,
    at: number,
    lo: number,
    hi: number,
    found: (match: WindowMatch) => void,
  ): number {
    const store = this.#store;
    for (const from of table.offsets(lo, hi)) {
      const segment = this.#segmentAt(from);
      const { start, length, folded } = segment;
      let before = 0;
      while (
        before < at &&
        before < from - start &&
        same(bytes[at - before - 1] as number, store[from - before - 1] as number, folded)
      ) {
        before++;
      }
      let after = minWindow;
      while (
        at + after < bytes.length &&
        from + after < start + length &&
        same(bytes[at + after] as number, store[from + after] as number, folded)
      ) {
        after++;
      }
      if (before + after < segment.window) {
        continue;
      }
      found({ secret: segment.secret, offset: at - before, length: before + after });
      // Later anchors inside this run would report it again.
      return at + after - minWindow + 1;
    }
    return 0;
  }

  #segmentAt(offset: number): Segment {
    let low = 0;
    let high = this.#starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if ((this.#starts[mid] as number) <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return this.#segments[low] as Segment;
  }
}

/** Compiles secrets for `scan`. Build once and reuse: the index costs time and memory. */
export function buildNeedles(secrets: readonly Secret[]): Needles {
  return new Needles(secrets);
}

/** An open-addressing hash table from 8-byte anchors, as two int32 words, to store offsets. */
class AnchorTable {
  readonly size: number;
  /** Per slot: the store offset plus one (0 for an empty slot), then the anchor's two words. */
  #slots: Int32Array;
  #mask: number;

  constructor(anchors: number) {
    this.size = anchors;
    let slots = 16;
    // A quarter full, so a lookup of an absent anchor mostly ends at its first slot.
    while (slots < anchors * 4) {
      slots *= 2;
    }
    this.#slots = new Int32Array(slots * 3);
    this.#mask = slots - 1;
  }

  insert(offset: number, lo: number, hi: number): void {
    const slots = this.#slots;
    let slot = hashSlot(lo, hi) & this.#mask;
    // Low-entropy secrets repeat anchors. A few copies are enough to find any run, and the cap
    // keeps a secret of zeros from making the insert quadratic.
    let copies = 0;
    while (slots[slot * 3] !== 0) {
      if (slots[slot * 3 + 1] === lo && slots[slot * 3 + 2] === hi && ++copies >= maxCopies) {
        return;
      }
      slot = (slot + 1) & this.#mask;
    }
    slots[slot * 3] = offset + 1;
    slots[slot * 3 + 1] = lo;
    slots[slot * 3 + 2] = hi;
  }

  /** Whether the anchor is in the table. Cheap, so `match` calls it at every byte. */
  has(lo: number, hi: number): boolean {
    const slots = this.#slots;
    for (let slot = hashSlot(lo, hi) & this.#mask; slots[slot * 3] !== 0; ) {
      if (slots[slot * 3 + 1] === lo && slots[slot * 3 + 2] === hi) {
        return true;
      }
      slot = (slot + 1) & this.#mask;
    }
    return false;
  }

  /** The store offsets of the anchor, in insertion order. */
  *offsets(lo: number, hi: number): Generator<number> {
    const slots = this.#slots;
    for (let slot = hashSlot(lo, hi) & this.#mask; slots[slot * 3] !== 0; ) {
      if (slots[slot * 3 + 1] === lo && slots[slot * 3 + 2] === hi) {
        yield (slots[slot * 3] as number) - 1;
      }
      slot = (slot + 1) & this.#mask;
    }
  }
}

/** Anchors repeated more often than this are left out of the table. */
const maxCopies = 4;

/** How far apart a segment's anchors are, so that every window holds a whole anchor. */
const stride = (segment: Segment) => Math.min(8, segment.window - minWindow + 1);

/** Four bytes as a little-endian int32. */
const word = (bytes: Uint8Array, at: number) =>
  (bytes[at] as number) |
  ((bytes[at + 1] as number) << 8) |
  ((bytes[at + 2] as number) << 16) |
  ((bytes[at + 3] as number) << 24);

function hashSlot(lo: number, hi: number): number {
  let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

const asciiUpper = (bytes: Uint8Array) =>
  Buffer.from(bytes.map((byte) => (byte >= 0x61 && byte <= 0x7a ? byte & ~0x20 : byte)));

const lower = (byte: number) => (byte >= 0x41 && byte <= 0x5a ? byte | 0x20 : byte);

const same = (byte: number, stored: number, folded: boolean) =>
  byte === stored || (folded && lower(byte) === stored);

/** Lowercases the ASCII letters among the four bytes of `word`. */
function foldWord(word: number): number {
  const low7 = word & 0x7f7f7f7f;
  // The high bit of each byte ends up set for bytes 0x41 to 0x5a, with no carries between bytes.
  const upper = (low7 + 0x3f3f3f3f) & ~(low7 + 0x25252525) & ~word & 0x80808080;
  return word | (upper >>> 2);
}
