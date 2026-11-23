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
// | sw       | service worker streaming download: the worker streams       |
// |          | plaintext through the page into sw.ts, which answers a       |
// |          | synthetic /spike-dl/<id> URL with an attachment response     |
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
import type { SinkKind, SwTransport } from "./results.ts";

/**
 * What the sw sink hands the page for the service worker: a ReadableStream
 * transferred by postMessage where the engine can transfer streams,
 * otherwise a MessagePort carrying one chunk per "pull" the service worker
 * sends. `size` becomes Content-Length.
 */
export type SwOffer =
  | { transport: "transferable-stream"; body: ReadableStream<Uint8Array>; size: number }
  | { transport: "message-port"; body: MessagePort; size: number };

/** Messages on the message-port transport. The service worker sends pull and cancel. */
export type SwPortMessage =
  | { type: "pull" }
  | { type: "cancel" }
  | { type: "chunk"; chunk: Uint8Array }
  | { type: "end" }
  | { type: "abort" };

/** The page's side of the sw sink, reached through the worker's messages. */
export type SwBridge = {
  /** Registers the service worker; throws UnsupportedSinkError where it cannot. */
  prepare(): Promise<void>;
  /** Hands over the plaintext and resolves once the download has started. */
  start(offer: SwOffer): Promise<void>;
};

/** What the page gets back once a sink is closed. */
export type SinkOutput =
  /** Written to a file the user picked; nothing left to do. */
  | { kind: "picked-file" }
  /** In the bench's OPFS directory under `name`; the page downloads it. */
  | { kind: "opfs-file"; name: string }
  /** An in-memory Blob; the page downloads it. */
  | { kind: "blob"; blob: Blob }
  /** Streamed to the service worker download, which may still be flushing. */
  | { kind: "sw-download"; transport: SwTransport };

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

/** The page adds whether it has a service worker container and a secure context for "sw". */
export function workerSinkSupport(): SinkSupport {
  return {
    fsa: hasCreateWritable(),
    "fsa-opfs": hasCreateWritable(),
    opfs: hasSyncAccessHandle(),
    blob: true,
    sw: typeof ReadableStream === "function" && typeof MessageChannel === "function",
  };
}

export type SinkOptions = {
  /** From showSaveFilePicker on the page, required for "fsa". */
  saveHandle?: FileSystemFileHandle | undefined;
  /** Plaintext bytes the sink will get, required for "sw". */
  size?: number | undefined;
  /** The page's side of the service worker download, required for "sw". */
  swBridge?: SwBridge | undefined;
};

/** Opens a sink. */
export async function openSink(kind: SinkKind, options: SinkOptions = {}): Promise<BenchSink> {
  const { saveHandle } = options;
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
    case "sw": {
      const { swBridge, size } = options;
      if (!swBridge || size === undefined) {
        throw new UnsupportedSinkError("no service worker bridge to the page");
      }
      await swBridge.prepare();
      return swSink(swBridge, size);
    }
  }
}

/** Whether this engine can transfer a ReadableStream with postMessage. */
export function canTransferStreams(): boolean {
  const { port1, port2 } = new MessageChannel();
  try {
    const stream = new ReadableStream();
    port1.postMessage(stream, [stream]);
    return true;
  } catch {
    return false;
  } finally {
    port1.close();
    port2.close();
  }
}

/** Chunks the transferable-stream transport may queue before write() waits. */
const STREAM_QUEUE_CHUNKS = 4;

/**
 * Streams plaintext to the service worker download. The download starts on
 * the first write (or on close, for an empty file), so it does not sit idle
 * while the pipeline hashes and encrypts. write() resolves only once the
 * transport has room, so decryption never outruns the download.
 */
function swSink(bridge: SwBridge, size: number): BenchSink {
  const transport: SwTransport = canTransferStreams() ? "transferable-stream" : "message-port";
  let open = true;
  let started: Promise<SwSinkWriter> | undefined;
  const writer = (): Promise<SwSinkWriter> => {
    started ??= (async () => {
      const opened = transport === "transferable-stream" ? streamWriter(size) : portWriter(size);
      try {
        await bridge.start(opened.offer);
      } catch (error) {
        await opened.abort(error);
        throw error;
      }
      return opened;
    })();
    return started;
  };
  return {
    write: async (chunk) => {
      if (!open) {
        throw new Error("sink is closed");
      }
      await (await writer()).write(chunk);
    },
    close: async () => {
      if (!open) {
        throw new Error("sink is closed");
      }
      open = false;
      await (await writer()).close();
      return { kind: "sw-download", transport };
    },
    abort: async () => {
      if (!open) {
        return;
      }
      open = false;
      if (started) {
        const reason = new Error("aborted");
        await started.then((opened) => opened.abort(reason)).catch(() => {});
      }
    },
  };
}

type SwSinkWriter = {
  offer: SwOffer;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
};

/**
 * Writes into a TransformStream whose readable side goes to the page and on
 * to the service worker. write() waits on writer.ready, so at most
 * STREAM_QUEUE_CHUNKS chunks wait here; a cancel from the service worker
 * rejects the next wait.
 */
function streamWriter(size: number): SwSinkWriter {
  const pipe = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    new CountQueuingStrategy({ highWaterMark: STREAM_QUEUE_CHUNKS }),
  );
  const writer = pipe.writable.getWriter();
  return {
    offer: { transport: "transferable-stream", body: pipe.readable, size },
    write: async (chunk) => {
      await writer.ready;
      // Errors surface through the next ready or close.
      writer.write(chunk).catch(() => {});
    },
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  };
}

/**
 * The fallback: one chunk per "pull" from the service worker over a
 * MessagePort, so the service worker sets the pace.
 */
function portWriter(size: number): SwSinkWriter {
  const { port1, port2 } = new MessageChannel();
  let credits = 0;
  let cancelled = false;
  let wake: (() => void) | undefined;
  port1.onmessage = (event: MessageEvent<SwPortMessage>) => {
    if (event.data.type === "pull") {
      credits += 1;
    } else if (event.data.type === "cancel") {
      cancelled = true;
    }
    wake?.();
    wake = undefined;
  };
  const send = (message: SwPortMessage): void => port1.postMessage(message);
  return {
    offer: { transport: "message-port", body: port2, size },
    write: async (chunk) => {
      while (credits === 0 && !cancelled) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (cancelled) {
        throw new Error("the service worker cancelled the download");
      }
      credits -= 1;
      send({ type: "chunk", chunk });
    },
    close: async () => {
      if (cancelled) {
        throw new Error("the service worker cancelled the download");
      }
      send({ type: "end" });
      port1.close();
    },
    abort: async () => {
      send({ type: "abort" });
      port1.close();
    },
  };
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
