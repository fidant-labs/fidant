import { isUtf8 } from "node:buffer";
import { hash } from "node:crypto";
import {
  brotliDecompressSync,
  constants,
  inflateRawSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";

/**
 * One decoded form of a captured blob. The detector decodes the haystack rather than encoding
 * every needle: it matches raw needle bytes against every view.
 */
export interface View {
  /** How the view was made from the blob: `raw`, `percent`, `json>base64@1`, `gzip>hex@0`. */
  path: string;
  bytes: Buffer;
  /** The number of decoding steps from the raw blob. */
  depth: number;
}

export interface DecodeHints {
  /** The `content-encoding` header, such as `gzip` or `br`. Applies to the raw blob. */
  contentEncoding?: string;
}

export interface DecodeOptions {
  /** Decoding steps applied on top of each other. Default 3. */
  maxDepth?: number;
  /**
   * The most view bytes per blob, raw included: 64 MiB or 8 times the blob, whichever is more.
   * The bound stops a crafted blob from blowing up; hitting it sets `truncated`.
   */
  maxBytes?: number;
}

export interface Decoded {
  views: View[];
  /** True when the byte budget or a decompression cap cut decoding short, so some views are missing or partial. */
  truncated: boolean;
}

/** base64 and base64url runs this long or longer are decoded: 22 characters carry 16 bytes. */
const minBase64Run = 22;
/** Hex runs this long or longer are decoded: 32 characters carry 16 bytes. */
const minHexRun = 32;
/** UTF-16 runs of this many characters or more are decoded. */
const minUtf16Run = 8;
/** Decoded runs shorter than this cannot hold a needle window. */
const minViewBytes = 8;

/**
 * `min` or more of `unit` in a row. Written as `{min}` then `*`: V8 runs `{min,}` with a
 * backtracking stack that overflows on runs of a few MiB, but not `*`.
 */
const run = (unit: string, min: number) => new RegExp(`(?:${unit}){${min}}(?:${unit})*`, "g");

// A run may wrap across lines, as in MIME bodies and PEM. Line breaks are dropped before decoding.
const base64Run = run("[A-Za-z0-9+/_\\r\\n-]", minBase64Run);
const hexRun = run("[0-9A-Fa-f]", minHexRun);
// Separated hex such as fingerprints (`ab:cd:...`) or hex dumps (`ab cd ...`), 16 bytes or more.
const separatedHexRun = new RegExp(`[0-9A-Fa-f]{2}${run("[: -][0-9A-Fa-f]{2}", 15).source}`, "g");
// Text in one byte order usually also reads, one byte off, as the other: both views are kept.
const utf16leRun = run("[^\\0]\\0", minUtf16Run);
const utf16beRun = run("\\0[^\\0]", minUtf16Run);
const percentEscape = /%[0-9A-Fa-f]{2}/;
const jsonEscape = /\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/;
const qpEscape = /=(?:[0-9A-F]{2}|\r?\n)/;
const encodedWords = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=(?:\s+(?==\?[^?\s]+\?[BbQq]\?))?/g;

/**
 * Decodes a view into child views. Each child is one form of all or part of the parent. `text` is
 * the view as latin1, one char per byte. `regions` are the parts that text transforms apply to.
 */
type Decoder = (
  view: View,
  text: string,
  regions: string[],
  room: number,
) => { name: string; bytes: Buffer; limited?: boolean }[];

/**
 * Every view of `blob` the detector searches: the raw bytes plus, recursively up to `maxDepth`:
 * JSON string escapes, percent and form encoding, quoted-printable, RFC 2047 words, a binary
 * string sent as UTF-8 (`latin1`), UTF-16LE/BE runs, base64/base64url runs at each of the 4
 * character offsets, hex runs at both nibble offsets, and
 * gzip/zlib/zstd streams found by their magic bytes or brotli/deflate named by `hints`.
 * Views are made breadth first until `maxBytes` is used up.
 */
export function decodeViews(
  blob: Uint8Array,
  hints: DecodeHints = {},
  options: DecodeOptions = {},
): Decoded {
  const { maxDepth = 3, maxBytes = Math.max(64 * 1024 * 1024, 8 * blob.length) } = options;
  const rawBytes = Buffer.from(blob.buffer, blob.byteOffset, blob.length);
  const views: View[] = [{ path: "raw", bytes: rawBytes, depth: 0 }];
  // Different paths often reach the same bytes (json>percent and percent>json, or the same base64
  // run in two views). Each distinct result is kept once.
  const seen = new Set([digest(rawBytes)]);
  let used = rawBytes.length;
  let truncated = false;
  // A decompressor hit its output cap: the views made are partial, but decoding goes on.
  let limited = false;
  for (let i = 0; i < views.length && !truncated; i++) {
    const view = views[i] as View;
    if (view.depth >= maxDepth) {
      continue;
    }
    const text = view.bytes.toString("latin1");
    const regions = textRegions(view.bytes, text);
    const decoders = view.depth === 0 ? [...allDecoders, hinted(hints)] : allDecoders;
    for (const decoder of decoders) {
      for (const child of decoder(view, text, regions, maxBytes - used)) {
        if (child.limited) {
          limited = true;
        }
        if (child.bytes.length < minViewBytes) {
          continue;
        }
        const key = digest(child.bytes);
        if (seen.has(key)) {
          continue;
        }
        if (used + child.bytes.length > maxBytes) {
          truncated = true;
          break;
        }
        seen.add(key);
        used += child.bytes.length;
        const path = view.depth === 0 ? child.name : `${view.path}>${child.name}`;
        views.push({ path, bytes: child.bytes, depth: view.depth + 1 });
      }
      if (truncated) {
        break;
      }
    }
  }
  return { views, truncated: truncated || limited };
}

const digest = (bytes: Buffer) => hash("sha256", bytes, "base64");

const one = (name: string, result: Inflated | Buffer | undefined) => {
  if (!result) {
    return [];
  }
  return Buffer.isBuffer(result)
    ? [{ name, bytes: result }]
    : [{ name, bytes: result.bytes, limited: result.limited }];
};

const printableRun = run("[\\t\\n\\r\\x20-\\x7e]", 16);

/**
 * Where text transforms (JSON, percent, quoted-printable, RFC 2047) apply: the whole view when it
 * is UTF-8 text, otherwise each run of printable ASCII, such as a text part next to binary data.
 * Applied to a whole binary view, a stray `%41` would only copy it.
 */
function textRegions(bytes: Buffer, text: string): string[] {
  if (!hasControlChar(bytes) && isUtf8(bytes)) {
    return [text];
  }
  return matches(text, printableRun);
}

/** Whether `bytes` has a control character other than tab, line feed and carriage return. */
function hasControlChar(bytes: Buffer): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      return true;
    }
  }
  return false;
}

/** A decoder that transforms each text region on its own. */
const textual =
  (decode: (text: string) => { name: string; bytes: Buffer }[]): Decoder =>
  (_view, _text, regions) =>
    regions.flatMap(decode);

const json = textual((text) => (jsonEscape.test(text) ? one("json", unescapeJson(text)) : []));

const percent = textual((text) => {
  if (!percentEscape.test(text)) {
    return [];
  }
  const children: ReturnType<Decoder> = one("percent", decodePercent(text, false));
  // Form encoding writes a space as `+`, which base64 also uses, so it gets a view of its own.
  if (text.includes("+") && text.includes("=")) {
    children.push(...one("form", decodePercent(text, true)));
  }
  return children;
});

const quotedPrintable = textual((text) =>
  qpEscape.test(text) ? one("qp", decodeQuotedPrintable(text)) : [],
);

const rfc2047 = textual((text) => {
  if (!text.includes("=?")) {
    return [];
  }
  let changed = false;
  const decoded = text.replace(
    encodedWords,
    (word, charset: string, kind: string, data: string) => {
      const bytes =
        kind.toUpperCase() === "B"
          ? Buffer.from(data, "base64")
          : decodeQuotedPrintable(data.replaceAll("_", " "));
      try {
        const decoded = new TextDecoder(charset).decode(bytes);
        changed = true;
        return Buffer.from(decoded).toString("latin1");
      } catch {
        return word;
      }
    },
  );
  return changed ? one("rfc2047", Buffer.from(decoded, "latin1")) : [];
});

/** UTF-8 text whose characters are all below 256, as when JS sends a binary string. */
const latin1: Decoder = (view) => {
  if (!isUtf8(view.bytes)) {
    return [];
  }
  const text = view.bytes.toString("utf8");
  return /[\u0080-ÿ]/.test(text) && !/[^\0-ÿ]/.test(text)
    ? one("latin1", Buffer.from(text, "latin1"))
    : [];
};

const utf16: Decoder = (_view, text) => [
  ...matches(text, utf16leRun).map((run) => ({
    name: "utf16le",
    bytes: Buffer.from(Buffer.from(run, "latin1").toString("utf16le")),
  })),
  ...matches(text, utf16beRun).map((run) => ({
    name: "utf16be",
    bytes: Buffer.from(Buffer.from(run, "latin1").swap16().toString("utf16le")),
  })),
];

const base64: Decoder = (_view, text) =>
  matches(text, base64Run).flatMap((match) => {
    const run = match.replace(/[\r\n]/g, "");
    if (run.length < minBase64Run) {
      return [];
    }
    // A run may start mid-quantum, after junk or a truncation, so try every offset.
    return [0, 1, 2, 3].map((offset) => ({
      name: `base64@${offset}`,
      bytes: Buffer.from(run.slice(offset), "base64"),
    }));
  });

const hex: Decoder = (_view, text) => [
  ...matches(text, hexRun).flatMap((run) =>
    [0, 1].map((offset) => ({
      name: `hex@${offset}`,
      bytes: Buffer.from(run.slice(offset), "hex"),
    })),
  ),
  ...matches(text, separatedHexRun).map((run) => ({
    name: "hex-separated",
    bytes: Buffer.from(run.replace(/[: -]/g, ""), "hex"),
  })),
];

const compressed: Decoder = (view, _text, _regions, room) => {
  const children: ReturnType<Decoder> = [];
  const bytes = view.bytes;
  for (const at of indexesOf(bytes, gzipMagic)) {
    // Raw inflate of the member's body ignores whatever follows the member; gunzip would not.
    const body = gzipBody(bytes.subarray(at));
    if (body) {
      children.push(...one("gzip", inflate(inflateRawSync, body, room)));
    }
  }
  for (const at of indexesOf(bytes, zstdMagic)) {
    children.push(...one("zstd", inflate(zstdDecompressSync, bytes.subarray(at), room)));
  }
  // The zlib header is two common bytes, so it is only tried at the start.
  const first = bytes[0] ?? 0;
  if ((first & 0x0f) === 8 && bytes.length > 2 && bytes.readUInt16BE(0) % 31 === 0) {
    children.push(...one("deflate", inflate(inflateSync, bytes, room)));
  }
  return children;
};

const hinted =
  (hints: DecodeHints): Decoder =>
  (view, _text, _regions, room) => {
    const encodings = (hints.contentEncoding ?? "").toLowerCase().split(",");
    return encodings.flatMap((encoding) => {
      switch (encoding.trim()) {
        case "br":
          return one("br", inflate(brotliDecompressSync, view.bytes, room));
        case "deflate":
          return one("deflate-raw", inflate(inflateRawSync, view.bytes, room));
        default:
          // gzip, zstd and zlib deflate are found by their magic bytes anyway.
          return [];
      }
    });
  };

const allDecoders: readonly Decoder[] = [
  compressed,
  json,
  percent,
  quotedPrintable,
  rfc2047,
  latin1,
  utf16,
  base64,
  hex,
];

const gzipMagic = Buffer.from([0x1f, 0x8b, 0x08]);
const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const maxInflated = 64 * 1024 * 1024;

type Inflater = (data: Buffer, options: object) => Buffer;

/** What a decompressor gave: `limited` when the output hit the cap and `bytes` is only its start. */
interface Inflated {
  bytes: Buffer;
  limited: boolean;
}

/**
 * Decompresses what it can, up to `min(maxInflated, room)` bytes. A stream cut short still yields
 * the bytes before the cut. A stream that would inflate past the cap yields the longest prefix of
 * it that fits, marked `limited`, so a secret early in a bomb is still found and the caller can
 * report that the rest was not scanned. A corrupt stream yields what it decodes to before the
 * damage, not marked: corrupt data is mostly a false magic in random bytes, so it reports no
 * `limit` (the gap this leaves is tracked in FID-275).
 */
function inflate(inflater: Inflater, data: Buffer, room: number): Inflated | undefined {
  const cap = Math.min(maxInflated, room);
  const attempt = (input: Buffer) =>
    inflater(input, {
      maxOutputLength: Math.max(cap, 1),
      finishFlush: constants.Z_SYNC_FLUSH,
      ...(inflater === brotliDecompressSync && { finishFlush: constants.BROTLI_OPERATION_FLUSH }),
      // Z_SYNC_FLUSH is ZSTD_e_end to zstd, which throws on a cut-off frame. ZSTD_e_flush
      // returns every complete block that arrived.
      ...(inflater === zstdDecompressSync && { finishFlush: constants.ZSTD_e_flush }),
    });
  let limited = false;
  const tooLarge = (error: unknown) => {
    limited ||= (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE";
  };
  try {
    return { bytes: attempt(data), limited: false };
  } catch (error) {
    tooLarge(error);
  }
  // Output grows with the input prefix and damage stays once reached, so binary search the
  // longest prefix that decodes without error.
  let best: Buffer = Buffer.alloc(0);
  let low = 0;
  let high = data.length;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    try {
      best = attempt(data.subarray(0, mid));
      low = mid;
    } catch (error) {
      tooLarge(error);
      high = mid - 1;
    }
  }
  return { bytes: best, limited };
}

/** The deflate stream inside a gzip member, after its header (RFC 1952). */
function gzipBody(member: Buffer): Buffer | undefined {
  const flags = member[3] ?? 0;
  let at = 10;
  if (flags & 4) {
    at += 2 + (member.length >= at + 2 ? member.readUInt16LE(at) : 0);
  }
  for (const bit of [8, 16]) {
    if (!(flags & bit)) {
      continue;
    }
    const end = member.indexOf(0, at);
    if (end === -1) {
      return undefined;
    }
    at = end + 1;
  }
  if (flags & 2) {
    at += 2;
  }
  return at < member.length ? member.subarray(at) : undefined;
}

function indexesOf(bytes: Buffer, magic: Buffer): number[] {
  const found: number[] = [];
  for (let at = bytes.indexOf(magic); at !== -1; at = bytes.indexOf(magic, at + 1)) {
    found.push(at);
  }
  return found;
}

function matches(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), (match) => match[0]);
}

/** Decodes `%XX` escapes, and `+` as a space when `plusIsSpace`. Other bytes stay as they are. */
export function decodePercent(text: string, plusIsSpace: boolean): Buffer {
  const out = Buffer.allocUnsafe(text.length);
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x25 && percentEscape.test(text.slice(i, i + 3))) {
      out[length++] = Number.parseInt(text.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      out[length++] = plusIsSpace && code === 0x2b ? 0x20 : code;
    }
  }
  return out.subarray(0, length);
}

/** Decodes quoted-printable: `=XX` escapes and `=` soft line breaks. */
export function decodeQuotedPrintable(text: string): Buffer {
  const unwrapped = text.replace(/=\r?\n/g, "");
  return Buffer.from(
    unwrapped.replace(/=([0-9A-Fa-f]{2})/g, (_, hexByte: string) =>
      String.fromCharCode(Number.parseInt(hexByte, 16)),
    ),
    "latin1",
  );
}

const simpleEscapes: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Undoes JSON string escapes wherever they appear in `text` (latin1, one char per byte), so it
 * works on whole bodies and on JSON inside other text. `\uXXXX` becomes UTF-8. Bytes outside
 * escapes are kept as they are.
 */
export function unescapeJson(text: string): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  let pending = "";
  const flush = (end: number) => {
    if (pending) {
      parts.push(Buffer.from(pending.toWellFormed()));
    }
    pending = "";
    if (end > start) {
      parts.push(Buffer.from(text.slice(start, end), "latin1"));
    }
  };
  for (let i = text.indexOf("\\"); i !== -1 && i < text.length - 1; i = text.indexOf("\\", i)) {
    const next = text[i + 1] as string;
    if (next === "u" && /^[0-9A-Fa-f]{4}$/.test(text.slice(i + 2, i + 6))) {
      flush(i);
      // Collect consecutive \u escapes, so surrogate pairs join into one character.
      do {
        pending += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
      } while (text.startsWith("\\u", i) && /^[0-9A-Fa-f]{4}$/.test(text.slice(i + 2, i + 6)));
      start = i;
      flush(i);
    } else if (next in simpleEscapes) {
      flush(i);
      parts.push(Buffer.from(simpleEscapes[next] as string, "latin1"));
      i += 2;
      start = i;
    } else {
      i += 2;
    }
  }
  flush(text.length);
  return Buffer.concat(parts);
}
