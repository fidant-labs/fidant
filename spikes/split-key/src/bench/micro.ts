// Stage microbenchmarks, run in the bench worker. Each stage pushes the same
// amount of data through one piece of the pipeline on its own, so the full
// pipeline's numbers can be read against them.
//
// AES-GCM runs through StreamWriter and StreamReader, so it includes the
// framing, AAD and copies the real pipeline pays. Encrypt and decrypt are
// interleaved per chunk and timed separately, which needs only one chunk of
// ciphertext in memory. The plaintext is one generated chunk reused, so
// generator cost stays out of the AES-GCM numbers. Keys are fresh random
// halves that never leave the worker.

import { Sha256 } from "../../../../apps/web/src/lib/sha256.ts";
import { createTransferId, deriveContentKey, generateHalves } from "../keys.ts";
import { StreamReader, StreamWriter } from "../stream.ts";
import { SeededBytes } from "./generator.ts";
import type { StageResult } from "./messages.ts";

/** Chunk size for the stages that have none of their own. */
const PLAIN_CHUNK = 1024 * 1024;

export type Progress = (label: string, done: number, total: number) => void;

function result(
  stage: StageResult["stage"],
  chunkSize: number,
  bytes: number,
  ms: number,
): StageResult {
  return { stage, chunkSize, bytes, ms, mbPerSecond: bytes / 1e6 / (ms / 1000) };
}

/** Encrypts and decrypts at least totalBytes in chunks of chunkSize. */
export async function benchAesGcm(
  chunkSize: number,
  totalBytes: number,
  progress: Progress,
): Promise<StageResult[]> {
  const count = Math.max(1, Math.ceil(totalBytes / chunkSize));
  const header = { transferId: createTransferId(), chunkSize, paddedLength: count * chunkSize };
  const { fragmentHalf, serverHalf } = generateHalves();
  const key = await deriveContentKey(fragmentHalf, serverHalf, header.transferId);
  const writer = new StreamWriter(key, header);
  const reader = new StreamReader(key, header);
  const plaintext = new Uint8Array(chunkSize);
  new SeededBytes(1).fill(plaintext);

  let encryptMs = 0;
  let decryptMs = 0;
  const label = `AES-GCM ${chunkSize / 1024} KiB`;
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const frame = await writer.encrypt(plaintext);
    const t1 = performance.now();
    await reader.decrypt(frame);
    const t2 = performance.now();
    encryptMs += t1 - t0;
    decryptMs += t2 - t1;
    progress(label, (i + 1) * chunkSize, count * chunkSize);
  }
  reader.finish();
  const bytes = count * chunkSize;
  return [
    result("aes-gcm-encrypt", chunkSize, bytes, encryptMs),
    result("aes-gcm-decrypt", chunkSize, bytes, decryptMs),
  ];
}

/** Hashes totalBytes with the app's JS SHA-256, in 1 MiB updates. */
export function benchSha256(totalBytes: number, progress: Progress): StageResult {
  const data = new Uint8Array(PLAIN_CHUNK);
  new SeededBytes(2).fill(data);
  const hash = new Sha256();
  const start = performance.now();
  for (let done = 0; done < totalBytes; ) {
    const take = Math.min(PLAIN_CHUNK, totalBytes - done);
    hash.update(take === PLAIN_CHUNK ? data : data.subarray(0, take));
    done += take;
    progress("SHA-256 (JS)", done, totalBytes);
  }
  hash.digest();
  return result("sha256-js", PLAIN_CHUNK, totalBytes, performance.now() - start);
}

/** Generates totalBytes of seeded data into one reused 1 MiB buffer. */
export function benchGenerator(totalBytes: number, progress: Progress): StageResult {
  const source = new SeededBytes(3);
  const out = new Uint8Array(PLAIN_CHUNK);
  const start = performance.now();
  for (let done = 0; done < totalBytes; ) {
    const take = Math.min(PLAIN_CHUNK, totalBytes - done);
    source.fill(take === PLAIN_CHUNK ? out : out.subarray(0, take));
    done += take;
    progress("Generator", done, totalBytes);
  }
  return result("generator", PLAIN_CHUNK, totalBytes, performance.now() - start);
}

/** Runs every stage: generator, SHA-256, then AES-GCM at each chunk size. */
export async function runMicro(
  totalBytes: number,
  chunkSizes: number[],
  progress: Progress,
): Promise<StageResult[]> {
  const results = [benchGenerator(totalBytes, progress), benchSha256(totalBytes, progress)];
  for (const chunkSize of chunkSizes) {
    results.push(...(await benchAesGcm(chunkSize, totalBytes, progress)));
  }
  return results;
}
