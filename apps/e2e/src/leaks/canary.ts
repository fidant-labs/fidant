import { hash, randomBytes } from "node:crypto";

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
    if (seed.length !== seedBytes) throw new Error(`A seed has ${seedBytes} bytes.`);
    this.seed = Buffer.from(seed);
    this.seed.copy(this.#input);
  }

  /** A seed from a label, for tests that need a fixed stream. */
  static fromLabel(label: string): SeededRandom {
    return new SeededRandom(hash("sha256", label, "buffer"));
  }

  /** The next `length` bytes of the stream. */
  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`Bad length: ${length}`);
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
      if (value < limit) return value % bound;
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
  if (value === undefined || value === "") return randomBytes(seedBytes);
  if (!seedPattern.test(value)) throw new Error("SIGILL_E2E_SEED must be 64 hex characters.");
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
  if (min < minCheckableSize || max < min) throw new Error(`Bad size range: ${min} to ${max}`);
  for (;;) {
    const size = min + random.int(max - min + 1);
    if (sizeIsCheckable(size, chunkSize)) return size;
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
  const size = options.size ?? pickCanarySize(random, options);
  const token = base32Token(random);
  const mimeToken = base32Token(random);
  const ext = options.ext ?? base32Token(random, 3).replace(/\d/g, "x");
  return {
    name: `sigill-${token}-räksmörgås.${ext}`.normalize("NFC"),
    mime: `application/x-sigill-${mimeToken}`,
    bytes: random.bytes(size),
    size,
    token,
    mimeToken,
  };
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
