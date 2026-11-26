import { createHash, hash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

/** The chunk size of SIG-21's file frames. Canary sizes avoid its multiples. */
export const defaultChunkSize = 48 * 1024;
/** The smallest size with six decimal digits. Smaller sizes are too common to search for. */
export const minCheckableSize = 100_000;

const seedBytes = 32;
const seedPattern = /^[0-9a-f]{64}$/i;

/**
 * A deterministic random stream: SHA-256 in counter mode over a 32-byte seed. The same seed gives
 * the same canaries, so a failing run can be reproduced. The seed is not a key and may be printed.
 */
export class SeededRandom {
  readonly seed: Buffer;
  #input = Buffer.alloc(seedBytes + 8);
  #counter = 0n;
  #pool: Buffer = Buffer.alloc(0);

  constructor(seed: Uint8Array) {
    if (seed.length !== seedBytes) {
      throw new Error(`A seed has ${seedBytes} bytes.`);
    }
    this.seed = Buffer.from(seed);
    this.seed.copy(this.#input);
  }

  /** A seed from a label, for tests that need a fixed stream. */
  static fromLabel(label: string): SeededRandom {
    return new SeededRandom(hash("sha256", label, "buffer"));
  }

  /** The next `length` bytes of the stream. */
  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`Bad length: ${length}`);
    }
    const out = Buffer.allocUnsafe(length);
    let filled = Math.min(this.#pool.length, length);
    this.#pool.copy(out, 0, 0, filled);
    this.#pool = this.#pool.subarray(filled);
    while (filled < length) {
      const block = this.#block();
      const take = Math.min(block.length, length - filled);
      block.copy(out, filled, 0, take);
      filled += take;
      this.#pool = block.subarray(take);
    }
    return out;
  }

  /** A uniform integer in `[0, bound)`, for `bound` up to 2^32. */
  int(bound: number): number {
    if (!Number.isSafeInteger(bound) || bound < 1 || bound > 2 ** 32) {
      throw new Error(`Bad bound: ${bound}`);
    }
    // Rejection sampling keeps the result uniform.
    const limit = 2 ** 32 - (2 ** 32 % bound);
    for (;;) {
      const value = this.bytes(4).readUInt32BE(0);
      if (value < limit) {
        return value % bound;
      }
    }
  }

  /** An independent stream for `label`, so adding one canary does not shift the others. */
  fork(label: string): SeededRandom {
    return new SeededRandom(
      hash("sha256", Buffer.concat([this.seed, Buffer.from(label)]), "buffer"),
    );
  }

  #block(): Buffer {
    this.#input.writeBigUInt64BE(this.#counter++, seedBytes);
    return hash("sha256", this.#input, "buffer");
  }
}

/**
 * The run's seed: `SIGILL_E2E_SEED` (64 hex characters) when set, otherwise fresh random bytes.
 * Print it with `formatSeed` so a failure can be replayed.
 */
export function runSeed(value: string | undefined = process.env.SIGILL_E2E_SEED): Buffer {
  if (value === undefined || value === "") {
    return randomBytes(seedBytes);
  }
  if (!seedPattern.test(value)) {
    throw new Error("SIGILL_E2E_SEED must be 64 hex characters.");
  }
  return Buffer.from(value, "hex");
}

export function formatSeed(seed: Uint8Array): string {
  return Buffer.from(seed).toString("hex");
}

const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567";

/** A random lowercase base32 token: 16 characters carry 80 bits. */
export function base32Token(random: SeededRandom, length = 16): string {
  // 256 is a multiple of 32, so the low five bits of each byte are uniform.
  return [...random.bytes(length)].map((byte) => base32Alphabet[byte & 31]).join("");
}

/** Whether size check (i) of 0001 applies: six or more digits and off every chunk boundary. */
export function sizeIsCheckable(size: number, chunkSize = defaultChunkSize): boolean {
  return size >= minCheckableSize && size % chunkSize !== 0;
}

export interface SizeOptions {
  /** At least `minCheckableSize`. */
  min?: number;
  max?: number;
  chunkSize?: number;
}

/** A random canary size in `[min, max]` that size check (i) can search for. */
export function pickCanarySize(random: SeededRandom, options: SizeOptions = {}): number {
  const { min = minCheckableSize, max = 1024 * 1024, chunkSize = defaultChunkSize } = options;
  if (min < minCheckableSize || max < min) {
    throw new Error(`Bad size range: ${min} to ${max}`);
  }
  for (;;) {
    const size = min + random.int(max - min + 1);
    if (sizeIsCheckable(size, chunkSize)) {
      return size;
    }
  }
}

/** A file whose bytes, name, type and size are all random, so any trace of it is a leak. */
export interface CanaryFile {
  /** `sigill-<token>-räksmörgås.<ext>`, in NFC. The non-ASCII part exercises NFC/NFD handling. */
  name: string;
  /** `application/x-sigill-<mimeToken>`. */
  mime: string;
  bytes: Buffer;
  size: number;
  /** The base32 token in the name. */
  token: string;
  /** The base32 token in the MIME type. */
  mimeToken: string;
}

export interface CanaryFileOptions extends SizeOptions {
  /** An exact size, such as 0 or one chunk. Otherwise `pickCanarySize` picks one. */
  size?: number;
  /** The extension. Otherwise three random letters. */
  ext?: string;
}

/** A canary file from `random`. Use a fork per file so each canary has its own stream. */
export function canaryFile(random: SeededRandom, options: CanaryFileOptions = {}): CanaryFile {
  const head = canaryHead(random, options);
  return { ...head, bytes: random.bytes(head.size) };
}

/** Everything of a canary but its bytes, drawn from `random` before them. */
function canaryHead(random: SeededRandom, options: CanaryFileOptions): Omit<CanaryFile, "bytes"> {
  const size = options.size ?? pickCanarySize(random, options);
  const token = base32Token(random);
  const mimeToken = base32Token(random);
  const ext = options.ext ?? base32Token(random, 3).replace(/\d/g, "x");
  return {
    name: `sigill-${token}-räksmörgås.${ext}`.normalize("NFC"),
    mime: `application/x-sigill-${mimeToken}`,
    size,
    token,
    mimeToken,
  };
}

const MiB = 1024 * 1024;

/** Which bytes of a large file the leak check searches: `piece` bytes at every `every`. */
export interface SampleRule {
  piece: number;
  every: number;
}

/** 0001's rule for nightly large files: the first and last MiB, and one MiB at every 64 MiB. */
export const largeFileSamples: SampleRule = { piece: MiB, every: 64 * MiB };

/**
 * The bytes `rule` samples from a file of `size` bytes, as runs `[offset, offset + length)`:
 * `piece` bytes at every multiple of `every`, and the last `piece` bytes, in order, cut at the
 * end of the file, with runs that overlap or touch joined into one.
 */
export function sampledRanges(
  size: number,
  rule: SampleRule = largeFileSamples,
): Array<{ offset: number; length: number }> {
  const starts = [];
  for (let offset = 0; offset < size; offset += rule.every) {
    starts.push(offset);
  }
  if (size > 0) {
    starts.push(Math.max(0, size - rule.piece));
  }
  const ranges: Array<{ offset: number; length: number }> = [];
  for (const start of starts.sort((a, b) => a - b)) {
    const end = Math.min(start + rule.piece, size);
    const last = ranges.at(-1);
    if (last && start <= last.offset + last.length) {
      last.length = Math.max(last.length, end - last.offset);
    } else {
      ranges.push({ offset: start, length: end - start });
    }
  }
  return ranges;
}

/** A canary file on disk, too large to hold: its sampled bytes and the SHA-256 of all of them. */
export interface LargeCanaryFile extends Omit<CanaryFile, "bytes"> {
  path: string;
  /** The bytes at each of `sampledRanges`. */
  samples: Array<{ offset: number; bytes: Buffer }>;
  sha256: Buffer;
}

/**
 * Writes the canary that `canaryFile` would make from `random` to `dir`, under its name, a MiB at
 * a time, and keeps only the bytes `rule` samples.
 */
export async function writeLargeCanary(
  random: SeededRandom,
  dir: string,
  options: CanaryFileOptions & { rule?: SampleRule } = {},
): Promise<LargeCanaryFile> {
  const head = canaryHead(random, options);
  const path = join(dir, head.name);
  const samples = sampledRanges(head.size, options.rule).map(({ offset, length }) => ({
    offset,
    bytes: Buffer.alloc(length),
  }));
  const digest = createHash("sha256");
  await pipeline(function* () {
    for (let at = 0; at < head.size; at += MiB) {
      const piece = random.bytes(Math.min(MiB, head.size - at));
      digest.update(piece);
      for (const { offset, bytes } of samples) {
        const from = Math.max(at, offset);
        const to = Math.min(at + piece.length, offset + bytes.length);
        if (from < to) {
          piece.copy(bytes, from - offset, from - at, to - at);
        }
      }
      yield piece;
    }
  }, createWriteStream(path));
  return { ...head, path, samples, sha256: digest.digest() };
}

/** A random key shaped like a fragment secret: 32 bytes, and 43 characters of base64url. */
export interface CanaryKey {
  bytes: Buffer;
  text: string;
}

/** A throwaway key for the detector's self-tests. Never use it to protect anything. */
export function canaryKey(random: SeededRandom, length = 32): CanaryKey {
  const bytes = random.bytes(length);
  return { bytes, text: bytes.toString("base64url") };
}
