// Incremental SHA-256 (FIPS 180-4).
//
// Web Crypto only hashes a whole buffer at once, so it cannot checksum a file
// that is streamed in chunks without holding all of it in memory. This class
// takes the bytes piece by piece. Full 64-byte blocks are compressed straight
// from the input; only a partial block at the end of an update is buffered.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/**
 * Streaming SHA-256. Call `update` any number of times, then `digest` once.
 * After `digest` the instance is finished; further calls throw.
 */
export class Sha256 {
  private state = new Uint32Array(INITIAL_STATE);
  private w = new Uint32Array(64);
  /** Partial block carried between updates. */
  private tail = new Uint8Array(64);
  private tailLength = 0;
  /** Total message length in bytes. */
  private length = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) {
      throw new Error("Sha256: update after digest");
    }
    this.length += data.length;
    let offset = 0;

    if (this.tailLength > 0) {
      const take = Math.min(64 - this.tailLength, data.length);
      this.tail.set(data.subarray(0, take), this.tailLength);
      this.tailLength += take;
      offset = take;
      if (this.tailLength < 64) {
        return this;
      }
      this.compress(this.tail, 0);
      this.tailLength = 0;
    }

    for (; offset + 64 <= data.length; offset += 64) {
      this.compress(data, offset);
    }

    if (offset < data.length) {
      this.tail.set(data.subarray(offset));
      this.tailLength = data.length - offset;
    }
    return this;
  }

  /** Returns the 32-byte hash. Can be called only once. */
  digest(): Uint8Array {
    if (this.finished) {
      throw new Error("Sha256: digest called twice");
    }
    this.finished = true;

    // Padding: 0x80, zeros, then the bit length as a 64-bit big-endian number.
    const bitLength = this.length * 8;
    const tail = this.tail;
    tail[this.tailLength] = 0x80;
    tail.fill(0, this.tailLength + 1);
    if (this.tailLength >= 56) {
      this.compress(tail, 0);
      tail.fill(0);
    }
    const view = new DataView(tail.buffer, tail.byteOffset, 64);
    view.setUint32(56, Math.floor(bitLength / 0x100000000));
    view.setUint32(60, bitLength >>> 0);
    this.compress(tail, 0);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) {
      outView.setUint32(i * 4, this.state[i] as number);
    }
    return out;
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] =
        ((block[j] as number) << 24) |
        ((block[j + 1] as number) << 16) |
        ((block[j + 2] as number) << 8) |
        (block[j + 3] as number);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }

    const s = this.state;
    let a = s[0] as number;
    let b = s[1] as number;
    let c = s[2] as number;
    let d = s[3] as number;
    let e = s[4] as number;
    let f = s[5] as number;
    let g = s[6] as number;
    let h = s[7] as number;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    s[0] = (s[0] as number) + a;
    s[1] = (s[1] as number) + b;
    s[2] = (s[2] as number) + c;
    s[3] = (s[3] as number) + d;
    s[4] = (s[4] as number) + e;
    s[5] = (s[5] as number) + f;
    s[6] = (s[6] as number) + g;
    s[7] = (s[7] as number) + h;
  }
}
