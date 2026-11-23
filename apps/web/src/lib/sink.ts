// Where a received file goes while it arrives.
//
// - FileSystemSink: where the browser has showSaveFilePicker (Chromium), the
//   user picks the destination when they click Download and the file streams
//   straight to disk. On failure the writable is aborted, so no partial file
//   is committed.
// - BlobSink: everywhere else. Chunks are collected in memory and folded into
//   one Blob as they arrive; the page starts its download at the end.
//
// No Preact here, so tests can run it in Node.

export type Sink = {
  write(chunk: Uint8Array): Promise<void>;
  /** Finishes the file. Resolves with the Blob for BlobSink, undefined for FileSystemSink. */
  close(): Promise<Blob | undefined>;
  /** Discards everything written so far. Safe to call more than once; after close() the finished file stays. */
  abort(): Promise<void>;
};

/** Parts are folded into the Blob every this many bytes, so the part list stays short. */
export const BLOB_FOLD_BYTES = 16 * 1024 * 1024;

/**
 * The received Blob always gets this type, whatever type the sender claims. A
 * blob: URL has this page's origin, so a text/html Blob opened in a tab could
 * run script here.
 */
export const BLOB_TYPE = "application/octet-stream";

export class BlobSink {
  private blob = new Blob([], { type: BLOB_TYPE });
  private parts: BlobPart[] = [];
  private pending = 0;
  private finished = false;
  private readonly foldBytes: number;

  constructor(foldBytes: number = BLOB_FOLD_BYTES) {
    this.foldBytes = foldBytes;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.finished) {
      throw new Error("sink is closed");
    }
    this.parts.push(chunk as Uint8Array<ArrayBuffer>);
    this.pending += chunk.length;
    if (this.pending >= this.foldBytes) {
      this.fold();
    }
  }

  async close(): Promise<Blob> {
    if (this.finished) {
      throw new Error("sink is closed");
    }
    this.fold();
    this.finished = true;
    return this.blob;
  }

  async abort(): Promise<void> {
    this.finished = true;
    this.parts = [];
    this.pending = 0;
    this.blob = new Blob([], { type: BLOB_TYPE });
  }

  private fold(): void {
    if (this.parts.length === 0) {
      return;
    }
    this.blob = new Blob([this.blob, ...this.parts], { type: BLOB_TYPE });
    this.parts = [];
    this.pending = 0;
  }
}

// Minimal local types for the File System Access API, which TypeScript's DOM
// library does not fully describe.
export type SaveWritable = {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};
export type SaveFileHandle = { createWritable(): Promise<SaveWritable> };
export type ShowSaveFilePicker = (options?: { suggestedName?: string }) => Promise<SaveFileHandle>;

export class FileSystemSink {
  private readonly writable: SaveWritable;
  private state: "open" | "closed" | "aborted" = "open";

  constructor(writable: SaveWritable) {
    this.writable = writable;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.state !== "open") {
      throw new Error("sink is closed");
    }
    await this.writable.write(chunk as Uint8Array<ArrayBuffer>);
  }

  async close(): Promise<undefined> {
    if (this.state !== "open") {
      throw new Error("sink is closed");
    }
    this.state = "closed";
    await this.writable.close();
    return undefined;
  }

  async abort(): Promise<void> {
    if (this.state !== "open") {
      return;
    }
    this.state = "aborted";
    try {
      await this.writable.abort();
    } catch {}
  }
}

function savePicker(): ShowSaveFilePicker | undefined {
  const picker = (globalThis as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  return typeof picker === "function" ? picker : undefined;
}

/** True if the file will be saved through the browser's save dialog. */
export function canPickSaveFile(): boolean {
  return savePicker() !== undefined;
}

/**
 * Makes the sink for an accepted file. Call it first thing in the Download click
 * handler: the save dialog may only open during a user gesture, so the picker
 * is called synchronously, before this returns. Rejects with an AbortError
 * DOMException if the user cancels the dialog (see isPickerCancel).
 */
export function createSink(suggestedName: string): Promise<Sink> {
  const picker = savePicker();
  if (!picker) {
    return Promise.resolve(new BlobSink());
  }
  let handle: Promise<SaveFileHandle>;
  try {
    handle = picker.call(globalThis, { suggestedName });
  } catch (error) {
    return Promise.reject(error);
  }
  return handle.then(async (h) => new FileSystemSink(await h.createWritable()));
}

/** True if `error` means the user closed the save dialog without choosing. */
export function isPickerCancel(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
