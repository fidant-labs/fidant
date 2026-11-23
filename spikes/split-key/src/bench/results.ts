// Results of a full pipeline run, as the worker reports them and the page
// shows and exports them. Only sizes, settings, timings and browser readings:
// no keys, no file names, no file content and no hashes of the file.
//
// No crypto imports here, so the page can use this without pulling the
// pipeline into its bundle.

/** Where decrypted plaintext goes. "sw" is the service worker download, commit #7. */
export type SinkKind = "fsa" | "fsa-opfs" | "opfs" | "blob" | "sw";

export const SINK_LABELS: Record<SinkKind, string> = {
  fsa: "File System Access: save picker → FileSystemWritableFileStream",
  "fsa-opfs": "FileSystemWritableFileStream on an OPFS handle (no picker, for automation)",
  opfs: "OPFS sync access handle, then blob: URL download of the disk-backed File",
  blob: "In-memory Blob, then blob: URL download",
  sw: "Service worker streaming download (not implemented yet)",
};

export type SourceParams = { kind: "seeded"; seed: number } | { kind: "file" };

export type PipelineParams = {
  /** Plaintext size in bytes. For a picked file, its size. */
  size: number;
  chunkSize: number;
  source: SourceParams;
  sink: SinkKind;
};

export type PhaseName = "hash" | "encrypt" | "release" | "decrypt" | "cleanup";

/** One reading of memory, if the engine exposes performance.memory where it ran. */
export type MemoryReading = { usedJSHeapSize: number; totalJSHeapSize: number } | null;

/** storage.estimate() after a phase, or null if the call is missing or failed. */
export type StorageReading = { usage: number; quota: number } | null;

export type PhaseStat = {
  phase: PhaseName;
  ms: number;
  /** Bytes the phase moved: plaintext for hash, container for encrypt and decrypt, 0 otherwise. */
  bytes: number;
  /** bytes / ms, 1 MB = 10^6 bytes. null for phases that move no data. */
  mbPerSecond: number | null;
  storage: StorageReading;
  memory: MemoryReading;
};

export type PipelineError = {
  /** The phase that failed, or "setup" / "pick" / "download" outside the phases. */
  phase: PhaseName | "setup" | "pick" | "download";
  name: string;
  message: string;
};

export type PipelineOutcome = "ok" | "error" | "unsupported";

/** What the worker reports for one run. */
export type PipelineResult = {
  outcome: PipelineOutcome;
  phases: PhaseStat[];
  /** paddedLength(size, chunkSize). */
  paddedLength: number;
  /** Bytes of the staged container: stream header, META, SEALED and every frame. */
  containerBytes: number;
  /** Bytes written to the sink. Equals size on success. */
  outputBytes: number;
  /** True once SHA-256(salt ‖ plaintext) matched C from META. */
  commitmentVerified: boolean;
  error?: PipelineError;
};

/** A pipeline run in the report: what was asked, what happened, and the browser at the time. */
export type PipelineRun = {
  kind: "pipeline";
  startedAt: string;
  params: PipelineParams;
  sinkLabel: string;
  /**
   * How the page handed the output to the user: written straight to the
   * picked file, downloaded from a blob: URL of a disk-backed OPFS File or of
   * an in-memory Blob, or nothing (failed or unsupported runs).
   */
  delivery: "picked-file" | "blob-url-disk" | "blob-url-memory" | "none";
  environment: { storageBefore: StorageReading; memoryBefore: MemoryReading };
  result?: PipelineResult;
};

const MIB = 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MIB) {
    return `${(bytes / (1024 * MIB)).toFixed(2)} GiB`;
  }
  return bytes >= MIB ? `${(bytes / MIB).toFixed(0)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

function mib(bytes: number | undefined): string {
  return bytes === undefined ? "–" : (bytes / MIB).toFixed(0);
}

/** One table row per phase, then one summary row with the outcome. */
export function pipelineRows(run: PipelineRun): string[][] {
  const { params } = run;
  const head = [params.sink, formatBytes(params.size), formatBytes(params.chunkSize)];
  const result = run.result;
  if (!result) {
    return [[...head, "running", "", "", "", "", ""]];
  }
  const rows = result.phases.map((stat) => [
    ...head,
    stat.phase,
    mib(stat.bytes),
    stat.ms.toFixed(0),
    stat.mbPerSecond === null ? "–" : stat.mbPerSecond.toFixed(1),
    mib(stat.storage?.usage),
    mib(stat.memory?.usedJSHeapSize),
  ]);
  const summary =
    result.outcome === "ok"
      ? `ok, ${formatBytes(result.outputBytes)} out, C verified`
      : `${result.outcome}${result.error ? ` in ${result.error.phase}: ${result.error.name}: ${result.error.message}` : ""}`;
  rows.push([...head, summary, "", "", "", "", ""]);
  return rows;
}

/** Appends the rows of one run to a table body. */
export function renderPipelineRun(body: HTMLTableSectionElement, run: PipelineRun): void {
  for (const cells of pipelineRows(run)) {
    const row = body.insertRow();
    for (const text of cells) {
      row.insertCell().textContent = text;
    }
  }
}

/** performance.memory where the engine has it (Chromium), else null. */
export function readMemory(): MemoryReading {
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
    }
  ).memory;
  return memory
    ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize }
    : null;
}

/** navigator.storage.estimate(), or null where it is missing or refused. */
export async function readStorage(): Promise<StorageReading> {
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return null;
  }
}
