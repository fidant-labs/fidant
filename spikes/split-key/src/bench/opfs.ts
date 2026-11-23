// The bench's corner of the origin private file system (OPFS).
//
// Everything the bench stores sits in one directory, so a run can clear what
// the last one left and "Clear OPFS" removes it all in one call. The staged
// container models the recipient's copy of the ciphertext: per
// docs/decisions/0002 the receipt is signed only once the whole ciphertext is
// on the device, so the pipeline stages it here before decrypting.
//
// FileSystemSyncAccessHandle exists only in dedicated workers. Its read and
// write are synchronous and take an explicit offset, which is the cheapest way
// to move large data in and out of OPFS. TypeScript's DOM library leaves it
// out, so a minimal local type describes it.

export const BENCH_DIR = "split-key-bench";
export const STAGED_NAME = "staged.sigill";
export const OUTPUT_NAME = "bench-output.bin";

type SyncAccessHandle = {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
};

type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
};

/** True if this context can open OPFS files with sync access handles (workers only). */
export function hasSyncAccessHandle(): boolean {
  return (
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createSyncAccessHandle" in FileSystemFileHandle.prototype
  );
}

/** True if OPFS file handles offer createWritable (FileSystemWritableFileStream). */
export function hasCreateWritable(): boolean {
  return (
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype
  );
}

/** The bench directory, created if missing. */
async function benchDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(BENCH_DIR, { create: true });
}

/** Removes the bench directory and everything in it. Missing is fine. */
export async function clearBenchDir(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(BENCH_DIR, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) {
      throw error;
    }
  }
}

/** Removes one file from the bench directory. Missing is fine. */
export async function removeBenchFile(name: string): Promise<void> {
  const dir = await benchDir();
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) {
      throw error;
    }
  }
}

/** The handle of a bench file, created empty if missing. */
export async function benchFileHandle(name: string): Promise<FileSystemFileHandle> {
  return (await benchDir()).getFileHandle(name, { create: true });
}

/**
 * An OPFS file opened through a sync access handle. Writes append at the
 * write position; reads take an offset and must fill the buffer exactly, so a
 * short file is an error rather than a silent truncation.
 */
export class SyncFile {
  private readonly handle: SyncAccessHandle;
  /** Next write offset. */
  size = 0;

  private constructor(handle: SyncAccessHandle) {
    this.handle = handle;
  }

  /** Opens `name` in the bench directory. `truncate` empties it first. */
  static async open(name: string, truncate: boolean): Promise<SyncFile> {
    const fileHandle = (await benchFileHandle(name)) as SyncFileHandle;
    const file = new SyncFile(await fileHandle.createSyncAccessHandle());
    if (truncate) {
      file.handle.truncate(0);
    } else {
      file.size = file.handle.getSize();
    }
    return file;
  }

  append(bytes: Uint8Array): void {
    let done = 0;
    while (done < bytes.length) {
      const written = this.handle.write(bytes.subarray(done), { at: this.size + done });
      if (written <= 0) {
        throw new Error("OPFS write made no progress");
      }
      done += written;
    }
    this.size += bytes.length;
  }

  /** Fills `buffer` from `at`. Throws if the file ends first. */
  readExactly(buffer: Uint8Array, at: number): void {
    let done = 0;
    while (done < buffer.length) {
      const read = this.handle.read(buffer.subarray(done), { at: at + done });
      if (read <= 0) {
        throw new Error("staged file ended early");
      }
      done += read;
    }
  }

  /** Flushes and closes. Safe to call more than once. */
  close(): void {
    try {
      this.handle.flush();
    } catch {}
    try {
      this.handle.close();
    } catch {}
  }
}
