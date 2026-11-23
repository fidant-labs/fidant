// The full pipeline, run in the bench worker: one sender and one recipient in
// the same worker, with OPFS standing in for the transfer.
//
// 1. hash     The sender's first pass: C = SHA-256(salt ‖ plaintext).
// 2. encrypt  Fresh F, S and transferId; stream header, META, SEALED and every
//             frame written to a staged OPFS file through a sync access
//             handle, with a SHA-256 of the ciphertext computed on the way
//             (the checksum hosted mode would send with the upload).
// 3. release  The server hands S over once the receipt is signed. Here it is
//             a marker only: the recipient simply gets S.
// 4. decrypt  The recipient reads the staged container back frame by frame,
//             opens META with F alone, derives the content key with S, opens
//             SEALED, decrypts every chunk, checks C, and writes the file
//             bytes to the sink.
// 5. cleanup  The staged file is deleted, so runs do not pile up in OPFS.
//
// Staging the whole ciphertext before decrypting models docs/decisions/0002:
// the recipient signs only once the full ciphertext is on the device.
//
// Memory: the source is read in pieces of max(chunkSize, 1 MiB), padChunks
// holds one chunk, and every write and decrypt is awaited before the next
// read, so no phase holds more than a few chunks. The blob sink is the
// exception by design. The hash phase includes generating or reading the
// source, so for seeded runs its MB/s is bounded by the generator.
//
// The META name is always DUMMY_NAME, never a picked file's real name, and no
// key, name or byte of content leaves this module: the result holds sizes,
// timings and browser readings only.

import { Sha256 } from "../../../../apps/web/src/lib/sha256.ts";
import {
  commit,
  createSalt,
  META_BODY_BYTES,
  openMeta,
  openSealed,
  PlaintextCheck,
  SEALED_BODY_BYTES,
  sealMeta,
  sealSealed,
} from "../container.ts";
import { createTransferId, deriveContentKey, deriveMetaKey, generateHalves } from "../keys.ts";
import { paddedLength } from "../padding.ts";
import {
  decodeStreamHeader,
  FRAME_HEADER_BYTES,
  padChunks,
  STREAM_HEADER_BYTES,
  StreamReader,
  StreamWriter,
  TAG_BYTES,
} from "../stream.ts";
import { seededChunks } from "./generator.ts";
import type { Progress } from "./micro.ts";
import {
  clearBenchDir,
  hasSyncAccessHandle,
  removeBenchFile,
  STAGED_NAME,
  SyncFile,
} from "./opfs.ts";
import {
  type PhaseName,
  type PhaseStat,
  type PipelineError,
  type PipelineParams,
  type PipelineResult,
  readMemory,
  readStorage,
} from "./results.ts";
import {
  type BenchSink,
  openSink,
  type SinkOutput,
  type SwBridge,
  UnsupportedSinkError,
} from "./sinks.ts";

/** The name in META. Never the picked file's name. */
export const DUMMY_NAME = "bench.bin";
const DUMMY_TYPE = "application/octet-stream";
const MIN_READ_BYTES = 1024 * 1024;

export type PipelineInput = {
  params: PipelineParams;
  /** The picked file, when params.source.kind is "file". */
  file?: File | undefined;
  /** From showSaveFilePicker on the page, when params.sink is "fsa". */
  saveHandle?: FileSystemFileHandle | undefined;
  /** The page's side of the service worker download, when params.sink is "sw". */
  swBridge?: SwBridge | undefined;
};

export type PipelineOutput = { result: PipelineResult; output?: SinkOutput };

/** A fresh pass over the plaintext, in pieces of at least 1 MiB. */
function openSource(input: PipelineInput, size: number): AsyncIterable<Uint8Array> {
  const pieceBytes = Math.max(input.params.chunkSize, MIN_READ_BYTES);
  const { source } = input.params;
  if (source.kind === "seeded") {
    return toAsync(seededChunks(source.seed, size, pieceBytes));
  }
  const file = input.file;
  if (!file) {
    throw new Error("source is a file, but no file was given");
  }
  return fileChunks(file, pieceBytes);
}

async function* toAsync(source: Iterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  yield* source;
}

/** Reads a File slice by slice; slice().arrayBuffer() works in every engine. */
async function* fileChunks(file: File, pieceBytes: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < file.size; offset += pieceBytes) {
    yield new Uint8Array(await file.slice(offset, offset + pieceBytes).arrayBuffer());
  }
}

/** Passes pieces through and reports progress. */
async function* counted(
  source: AsyncIterable<Uint8Array>,
  label: string,
  total: number,
  progress: Progress,
): AsyncGenerator<Uint8Array> {
  let done = 0;
  for await (const piece of source) {
    yield piece;
    done += piece.length;
    progress(label, done, total);
  }
}

function errorOf(phase: PipelineError["phase"], error: unknown): PipelineError {
  if (error instanceof Error || error instanceof DOMException) {
    return { phase, name: error.name, message: error.message };
  }
  return { phase, name: "Error", message: String(error) };
}

export async function runPipeline(
  input: PipelineInput,
  progress: Progress,
): Promise<PipelineOutput> {
  const { params } = input;
  const { chunkSize } = params;
  const phases: PhaseStat[] = [];
  const result: PipelineResult = {
    outcome: "error",
    phases,
    paddedLength: 0,
    containerBytes: 0,
    outputBytes: 0,
    commitmentVerified: false,
  };
  let current: PipelineError["phase"] = "setup";
  let started = 0;
  let sink: BenchSink | undefined;
  let staged: SyncFile | undefined;
  let output: SinkOutput | undefined;

  const begin = (phase: PhaseName): void => {
    current = phase;
    started = performance.now();
  };
  const end = async (phase: PhaseName, bytes: number): Promise<void> => {
    const ms = performance.now() - started;
    phases.push({
      phase,
      ms,
      bytes,
      mbPerSecond: bytes > 0 ? bytes / 1e6 / (ms / 1000) : null,
      storage: await readStorage(),
      memory: readMemory(),
    });
  };

  try {
    if (!hasSyncAccessHandle()) {
      throw new UnsupportedSinkError(
        "OPFS sync access handles are missing, so the ciphertext cannot be staged",
      );
    }
    // Whatever the last run left (its output file, a staged file after a crash) goes now.
    await clearBenchDir();
    const size = params.source.kind === "file" ? (input.file?.size ?? 0) : params.size;
    const padded = paddedLength(size, chunkSize);
    result.paddedLength = padded;
    sink = await openSink(params.sink, {
      saveHandle: input.saveHandle,
      size,
      swBridge: input.swBridge,
    });

    // 1. hash
    begin("hash");
    const salt = createSalt();
    const hashed = await commit(salt, counted(openSource(input, size), "Hash", size, progress));
    if (hashed.size !== size) {
      throw new Error(`source gave ${hashed.size} bytes, expected ${size}`);
    }
    await end("hash", size);

    // 2. encrypt
    begin("encrypt");
    const { fragmentHalf, serverHalf } = generateHalves();
    const transferId = createTransferId();
    const header = { transferId, chunkSize, paddedLength: padded };
    const metaKey = await deriveMetaKey(fragmentHalf, transferId);
    const sendKey = await deriveContentKey(fragmentHalf, serverHalf, transferId);
    const writer = new StreamWriter(sendKey, header);
    const ciphertextHash = new Sha256();
    const stagedOut = await SyncFile.open(STAGED_NAME, true);
    staged = stagedOut;
    const put = (bytes: Uint8Array): void => {
      stagedOut.append(bytes);
      ciphertextHash.update(bytes);
    };
    put(writer.streamHeader);
    put(
      await sealMeta(metaKey, header, {
        name: DUMMY_NAME,
        commitment: hashed.commitment,
        from: "",
        chunkSize,
        paddedLength: padded,
      }),
    );
    put(await sealSealed(sendKey, header, { salt, size, type: DUMMY_TYPE }));
    const plaintext = counted(openSource(input, size), "Encrypt", size, progress);
    for await (const chunk of padChunks(plaintext, chunkSize, padded)) {
      put(await writer.encrypt(chunk));
    }
    if (!writer.done) {
      throw new Error("writer did not reach CHUNK_FINAL");
    }
    // Computed for its cost only; hosted mode would send it with the upload.
    ciphertextHash.digest();
    result.containerBytes = stagedOut.size;
    stagedOut.close();
    staged = undefined;
    await end("encrypt", result.containerBytes);

    // 3. release
    begin("release");
    const releasedHalf = serverHalf.slice();
    await end("release", 0);

    // 4. decrypt
    begin("decrypt");
    const stagedIn = await SyncFile.open(STAGED_NAME, false);
    staged = stagedIn;
    let at = 0;
    const read = (length: number): Uint8Array<ArrayBuffer> => {
      const bytes = new Uint8Array(length);
      stagedIn.readExactly(bytes, at);
      at += length;
      return bytes;
    };
    const readHeader = decodeStreamHeader(read(STREAM_HEADER_BYTES));
    const meta = await openMeta(
      fragmentHalf,
      transferId,
      readHeader,
      read(FRAME_HEADER_BYTES + META_BODY_BYTES + TAG_BYTES),
    );
    const receiveKey = await deriveContentKey(fragmentHalf, releasedHalf, transferId);
    const sealed = await openSealed(
      receiveKey,
      readHeader,
      read(FRAME_HEADER_BYTES + SEALED_BODY_BYTES + TAG_BYTES),
    );
    const reader = new StreamReader(receiveKey, readHeader);
    const check = new PlaintextCheck(sealed, meta.commitment);
    // One frame buffer, reused: each decrypt is awaited before the next read.
    const frame = new Uint8Array(FRAME_HEADER_BYTES + reader.chunkSize + TAG_BYTES);
    for (let i = 0; i < reader.count; i++) {
      stagedIn.readExactly(frame, at);
      at += frame.length;
      const fileBytes = check.update(await reader.decrypt(frame));
      if (fileBytes.length > 0) {
        await sink.write(fileBytes);
        result.outputBytes += fileBytes.length;
      }
      progress("Decrypt", at, result.containerBytes);
    }
    reader.finish();
    check.finish();
    result.commitmentVerified = true;
    if (at !== stagedIn.size) {
      throw new Error("staged file has bytes after CHUNK_FINAL");
    }
    stagedIn.close();
    staged = undefined;
    const closing = sink;
    sink = undefined;
    output = await closing.close();
    await end("decrypt", result.containerBytes);

    // 5. cleanup
    begin("cleanup");
    await removeBenchFile(STAGED_NAME);
    await end("cleanup", 0);
    result.outcome = "ok";
  } catch (error) {
    result.outcome = error instanceof UnsupportedSinkError ? "unsupported" : "error";
    result.error = errorOf(current, error);
    staged?.close();
    await sink?.abort().catch(() => {});
    await removeBenchFile(STAGED_NAME).catch(() => {});
    output = undefined;
  }
  return output ? { result, output } : { result };
}
