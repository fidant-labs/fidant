// Seeded, deterministic test data for the FID-7 bench.
//
// The bench encrypts synthetic files instead of real ones, so no user content
// is ever involved, and the runner can check a download by regenerating the
// same bytes in Node. The stream for a seed is fixed: xorshift128 words seeded
// by splitmix32, written little-endian. How the caller cuts it into chunks
// never changes the bytes.
//
// Words are generated a block at a time into an aligned Uint32Array and copied
// out with set(), so the hot loop is plain 32-bit integer work.

const BLOCK_WORDS = 16 * 1024;
const BLOCK_BYTES = BLOCK_WORDS * 4;

// The stream is defined as little-endian. Typed arrays use host order, and every
// engine the bench targets is little-endian; fail loudly rather than drift.
if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
  throw new Error("seeded generator needs a little-endian host");
}

/** Writes the byte stream for one seed, in order, across any number of fill() calls. */
export class SeededBytes {
  private x: number;
  private y: number;
  private z: number;
  private w: number;
  private readonly words = new Uint32Array(BLOCK_WORDS);
  private readonly bytes = new Uint8Array(this.words.buffer);
  /** Read position in `bytes`. BLOCK_BYTES means the block is used up. */
  private position = BLOCK_BYTES;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error("seed must be a u32");
    }
    // splitmix32 spreads the seed over the four state words. None can all be zero.
    let s = seed;
    const next = (): number => {
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
    this.x = next();
    this.y = next();
    this.z = next();
    this.w = next() || 1;
  }

  /** Overwrites `out` with the next out.length bytes of the stream. */
  fill(out: Uint8Array): void {
    let offset = 0;
    while (offset < out.length) {
      if (this.position === BLOCK_BYTES) {
        this.refill();
      }
      const take = Math.min(BLOCK_BYTES - this.position, out.length - offset);
      out.set(this.bytes.subarray(this.position, this.position + take), offset);
      this.position += take;
      offset += take;
    }
  }

  private refill(): void {
    const words = this.words;
    let { x, y, z, w } = this;
    for (let i = 0; i < BLOCK_WORDS; i++) {
      const t = x ^ (x << 11);
      x = y;
      y = z;
      z = w;
      w = w ^ (w >>> 19) ^ (t ^ (t >>> 8));
      words[i] = w;
    }
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    this.position = 0;
  }
}

/**
 * Yields totalBytes of the stream for `seed` in chunks of chunkSize bytes; the
 * last chunk holds the remainder. Each chunk is a fresh buffer, so callers may
 * keep or transfer it.
 */
export function* seededChunks(
  seed: number,
  totalBytes: number,
  chunkSize: number,
): Generator<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error("totalBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }
  const source = new SeededBytes(seed);
  for (let sent = 0; sent < totalBytes; ) {
    const chunk = new Uint8Array(Math.min(chunkSize, totalBytes - sent));
    source.fill(chunk);
    sent += chunk.length;
    yield chunk;
  }
}
