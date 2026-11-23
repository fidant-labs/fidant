// Where the pipeline writes decrypted plaintext, opened in the bench worker.
//
// | sink     | how                                                          |
// |----------|--------------------------------------------------------------|
// | fsa      | showSaveFilePicker on the page (needs a user gesture); the   |
// |          | handle is cloned to the worker, which calls createWritable   |
// | fsa-opfs | the same FileSystemWritableFileStream, on an OPFS handle, so |
// |          | automation can measure it without a picker                   |
// | opfs     | a sync access handle on an OPFS file; the page then          |
// |          | downloads the disk-backed File through a blob: URL           |
// | blob     | chunks collected in memory into one Blob, then downloaded;   |
// |          | shows where memory runs out                                  |
// | sw       | service worker streaming download: commit #7 adds it here   |
//
// fsa and blob reuse FileSystemSink and BlobSink from the app, so the bench
// measures the code the app ships. Every sink is feature-detected when opened
// and throws UnsupportedSinkError if the engine lacks what it needs, which the
// pipeline reports as "unsupported" rather than as a failure.

import { BlobSink, FileSystemSink } from "../../../../apps/web/src/lib/sink.ts";
import {
  benchFileHandle,
  hasCreateWritable,
  hasSyncAccessHandle,
  OUTPUT_NAME,
  removeBenchFile,
  SyncFile,
} from "./opfs.ts";
import type { SinkKind } from "./results.ts";

/** What the page gets back once a sink is closed. */
export type SinkOutput =
  /** Written to a file the user picked; nothing left to do. */
  | { kind: "picked-file" }
  /** In the bench's OPFS directory under `name`; the page downloads it. */
  | { kind: "opfs-file"; name: string }
  /** An in-memory Blob; the page downloads it. */
  | { kind: "blob"; blob: Blob };

export type BenchSink = {
  /** Writes the next plaintext bytes. Await it before reading more: that is the backpressure. */
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<SinkOutput>;
  /** Discards what was written. Safe to call more than once. */
  abort(): Promise<void>;
};

export class UnsupportedSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSinkError";
  }
}

/** Which sinks this worker can open. The page adds whether it has a save picker. */
export type SinkSupport = Record<SinkKind, boolean>;

export function workerSinkSupport(): SinkSupport {
  return {
    fsa: hasCreateWritable(),
    "fsa-opfs": hasCreateWritable(),
    opfs: hasSyncAccessHandle(),
    blob: true,
    sw: false,
  };
}

/**
 * Opens a sink. `saveHandle` is the handle the page got from
 * showSaveFilePicker, required for "fsa".
 */
export async function openSink(
  kind: SinkKind,
  saveHandle: FileSystemFileHandle | undefined,
): Promise<BenchSink> {
  switch (kind) {
    case "fsa": {
      if (!saveHandle) {
        throw new UnsupportedSinkError("no save handle: showSaveFilePicker is missing");
      }
      if (typeof saveHandle.createWritable !== "function") {
        throw new UnsupportedSinkError("FileSystemFileHandle.createWritable is missing");
      }
      return writableSink(new FileSystemSink(await saveHandle.createWritable()), {
        kind: "picked-file",
      });
    }
    case "fsa-opfs": {
      if (!hasCreateWritable()) {
        throw new UnsupportedSinkError("FileSystemFileHandle.createWritable is missing");
      }
      const handle = await benchFileHandle(OUTPUT_NAME);
      const sink = writableSink(
        new FileSystemSink(await handle.createWritable({ keepExistingData: false })),
        { kind: "opfs-file", name: OUTPUT_NAME },
      );
      return {
        ...sink,
        abort: async () => {
          await sink.abort();
          await removeBenchFile(OUTPUT_NAME).catch(() => {});
        },
      };
    }
    case "opfs":
      if (!hasSyncAccessHandle()) {
        throw new UnsupportedSinkError("FileSystemFileHandle.createSyncAccessHandle is missing");
      }
      return syncFileSink(await SyncFile.open(OUTPUT_NAME, true));
    case "blob":
      return blobSink(new BlobSink());
    case "sw":
      // Extension point for commit #7: a sink that streams into a service
      // worker, which answers a synthetic download URL.
      throw new UnsupportedSinkError("the service worker sink is not implemented yet");
  }
}

function writableSink(sink: FileSystemSink, output: SinkOutput): BenchSink {
  return {
    write: (chunk) => sink.write(chunk),
    close: async () => {
      await sink.close();
      return output;
    },
    abort: () => sink.abort(),
  };
}

function syncFileSink(file: SyncFile): BenchSink {
  let open = true;
  return {
    // Synchronous underneath; async only to share the interface.
    write: async (chunk) => {
      if (!open) {
        throw new Error("sink is closed");
      }
      file.append(chunk);
    },
    close: async () => {
      if (!open) {
        throw new Error("sink is closed");
      }
      open = false;
      file.close();
      return { kind: "opfs-file", name: OUTPUT_NAME };
    },
    abort: async () => {
      if (!open) {
        return;
      }
      open = false;
      file.close();
      await removeBenchFile(OUTPUT_NAME).catch(() => {});
    },
  };
}

function blobSink(sink: BlobSink): BenchSink {
  return {
    write: (chunk) => sink.write(chunk),
    close: async () => ({ kind: "blob", blob: await sink.close() }),
    abort: () => sink.abort(),
  };
}
