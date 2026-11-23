// Length padding for the SIG-7 spike.
//
// Everything that crosses infrastructure is padded so an observer learns only
// paddedLength(size, chunkSize), never the exact size. The size is first
// padded with Padmé (Nikitin et al., "Reducing Metadata Leakage from Encrypted
// Files and Communication with PURBs", 2019), which leaks O(log log size) bits
// and adds at most 12 % (less for bigger files), then rounded up to a whole
// number of chunks so every chunk on the wire has the same size. An empty file
// is padded like a 1-byte file, to one full chunk.
//
// Same rule as paddedLength in apps/web/src/lib/frames.ts, but the chunk size
// is not capped at 48 KiB: the bench also tries 256 KiB, 1 MiB and 4 MiB.

/** Largest file size whose padded length is still a safe integer (2^52 bytes, 4 PiB). */
export const MAX_PADDABLE_SIZE = 2 ** 52;
/** Largest chunk size the spike accepts (64 MiB). */
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

/** Padded length of a file of `size` bytes: Padmé, then whole chunks. */
export function paddedLength(size: number, chunkSize: number): number {
  checkSize(size);
  checkChunkSize(chunkSize);
  const padded = padme(Math.max(size, 1));
  return Math.ceil(padded / chunkSize) * chunkSize;
}

/** Number of chunks in a padded length. Throws unless it is a whole, nonzero number. */
export function chunkCount(padded: number, chunkSize: number): number {
  checkChunkSize(chunkSize);
  if (!Number.isSafeInteger(padded) || padded < chunkSize || padded % chunkSize !== 0) {
    throw new Error("padded length must be a positive multiple of the chunk size");
  }
  return padded / chunkSize;
}

export type Overhead = {
  /** paddedLength(size, chunkSize). */
  padded: number;
  /** Padding bytes added. */
  bytes: number;
  /** Padding bytes per file byte (an empty file counts as 1 byte). */
  ratio: number;
};

/** Padding cost of a file of `size` bytes, for the findings table. */
export function overhead(size: number, chunkSize: number): Overhead {
  const padded = paddedLength(size, chunkSize);
  const bytes = padded - size;
  return { padded, bytes, ratio: bytes / Math.max(size, 1) };
}

function checkSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PADDABLE_SIZE) {
    throw new Error("size out of range");
  }
}

function checkChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error("chunk size out of range");
  }
}

/**
 * Padmé for L ≥ 1: keep the top floor(log2 E) + 1 bits of L's mantissa, where
 * E = floor(log2 L), and round the rest up. Powers of two are exact in
 * floating point and the result stays below 2^53, so no precision is lost.
 */
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
