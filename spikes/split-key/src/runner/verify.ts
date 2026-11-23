// Checks a downloaded bench output against the plaintext it should be: the
// same size, and the same SHA-256 as Node regenerating the seeded stream.
// Both sides are streamed, so a 5 GiB file never sits in memory. The digests
// stay in the runner; results record only whether they matched.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { seededChunks } from "../bench/generator.ts";

export type Verification = {
  sizeMatches: boolean;
  /** Bytes on disk. */
  size: number;
  sha256Matches: boolean;
  /** Time spent hashing the download, in ms. */
  ms: number;
};

const expectedDigests = new Map<string, string>();

/** SHA-256 of the first `size` bytes of the stream for `seed`, hex. Cached per seed and size. */
export function expectedSha256(seed: number, size: number): string {
  const key = `${seed}:${size}`;
  let digest = expectedDigests.get(key);
  if (digest === undefined) {
    const hash = createHash("sha256");
    for (const chunk of seededChunks(seed, size, 1024 * 1024)) {
      hash.update(chunk);
    }
    digest = hash.digest("hex");
    expectedDigests.set(key, digest);
  }
  return digest;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function verifyDownload(
  path: string,
  seed: number,
  size: number,
): Promise<Verification> {
  const started = performance.now();
  const onDisk = (await stat(path)).size;
  // A file of the wrong size cannot match, so skip hashing it.
  const sha256Matches = onDisk === size && (await sha256File(path)) === expectedSha256(seed, size);
  return {
    sizeMatches: onDisk === size,
    size: onDisk,
    sha256Matches,
    ms: performance.now() - started,
  };
}
