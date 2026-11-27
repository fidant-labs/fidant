// The bench page: plain DOM, no framework. It collects the browser
// environment, sends requests to the worker, and shows each result as a table
// row and in the JSON report. The report holds sizes, timings and the
// environment only: no keys, file names or file content.
//
// body[data-state] is idle, running, done or error, so a script driving the
// page can wait on it and read #json. A pipeline run whose sink the engine
// lacks ends "done" with outcome "unsupported" in its JSON; a run that fails
// ends "error". For sinks that leave a file in OPFS or a Blob, the page starts
// the download of bench-output.bin before it sets "done". For the sw sink the
// download starts during decryption, and "done" waits until the browser has
// read the whole download body from the service worker.

import {
  DEFAULT_MICRO_BYTES,
  DEFAULT_PIPELINE_CHUNK,
  MICRO_CHUNK_SIZES,
  PIPELINE_CHUNK_SIZES,
  PIPELINE_SIZES,
  type StageResult,
  type SwRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "./messages.ts";
import { BENCH_DIR } from "./opfs.ts";
import {
  formatBytes,
  type PipelineParams,
  type PipelineRun,
  readMemory,
  readStorage,
  renderPipelineRun,
  SINK_LABELS,
  type SinkKind,
} from "./results.ts";
import type { SinkOutput, SinkSupport } from "./sinks.ts";
import {
  prepareSwDownload,
  type SwDownload,
  SwUnsupportedError,
  startSwDownload,
  withTimeout,
} from "./sw-client.ts";

const MIB = 1024 * 1024;
/** A download's blob: URL is revoked this long after the click, or at the next run. */
const REVOKE_AFTER_MS = 60_000;
/** How long the service worker may take to flush the last chunks after the worker closed the sink. */
const SW_FINISH_TIMEOUT_MS = 60_000;

type Environment = Record<string, unknown>;

type MicroRun = {
  kind: "micro";
  startedAt: string;
  totalBytes: number;
  chunkSizes: number[];
  results?: StageResult[];
  error?: string;
};

type Run = MicroRun | PipelineRun;

type Report = { bench: "fidant-split-key"; version: 1; environment: Environment; runs: Run[] };

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`missing #${id}`);
  }
  return found as T;
}

const microForm = element<HTMLFormElement>("micro-form");
const mibInput = element<HTMLInputElement>("micro-mib");
const chunkBox = element<HTMLDivElement>("micro-chunks");
const microButton = element<HTMLButtonElement>("micro-run");
const pipelineForm = element<HTMLFormElement>("pipeline-form");
const sizeSelect = element<HTMLSelectElement>("pipe-size");
const customMibInput = element<HTMLInputElement>("pipe-custom-mib");
const pipeChunkSelect = element<HTMLSelectElement>("pipe-chunk");
const seedInput = element<HTMLInputElement>("pipe-seed");
const fileInput = element<HTMLInputElement>("pipe-file");
const sinkSelect = element<HTMLSelectElement>("pipe-sink");
const pipelineButton = element<HTMLButtonElement>("pipe-run");
const clearButton = element<HTMLButtonElement>("clear-opfs");
const statusLine = element<HTMLParagraphElement>("status");
const resultsBody = element<HTMLTableSectionElement>("results");
const pipelineBody = element<HTMLTableSectionElement>("pipeline-results");
const environmentBlock = element<HTMLPreElement>("environment");
const jsonBlock = element<HTMLPreElement>("json");
const copyButton = element<HTMLButtonElement>("copy");

const report: Report = { bench: "fidant-split-key", version: 1, environment: {}, runs: [] };
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 1;
let downloadUrl: string | undefined;
/** The service worker download of the running pipeline, once started. */
let swDownload: SwDownload | undefined;

type Pending = {
  resolve: (response: WorkerResponse) => void;
  progress: (label: string, done: number, total: number) => void;
};
const pending = new Map<number, Pending>();

/** Sends one request and resolves with its final response; progress goes to the status line. */
function call(request: WorkerRequest): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    pending.set(request.id, {
      resolve,
      progress: (label, done, total) => {
        statusLine.textContent = `${label}: ${Math.round((100 * done) / Math.max(total, 1))} %`;
      },
    });
    // A File and a FileSystemFileHandle are structured-cloneable, so they go as part of the message.
    worker.postMessage(request);
  });
}

/** Does what the worker's sw sink asks and replies, so its prepare() or start() settles. */
async function answerSw(request: SwRequest): Promise<void> {
  const reply: WorkerRequest = { type: "sw-reply", id: request.id, seq: request.seq };
  try {
    if (request.step.kind === "prepare") {
      await prepareSwDownload();
    } else {
      const { kind: _, ...offer } = request.step;
      swDownload = await startSwDownload(offer);
    }
  } catch (error) {
    reply.error = {
      unsupported: error instanceof SwUnsupportedError,
      message: error instanceof SwUnsupportedError ? error.message : describe(error),
    };
  }
  worker.postMessage(reply);
}

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;
  if (message.type === "sw-request") {
    void answerSw(message);
    return;
  }
  const waiting = pending.get(message.id);
  if (!waiting) {
    return;
  }
  if (message.type === "progress") {
    waiting.progress(message.label, message.done, message.total);
    return;
  }
  pending.delete(message.id);
  waiting.resolve(message);
};

worker.onerror = (event) => {
  setState("error", `Worker failed: ${event.message}`);
  setBusy(false);
};

function setState(state: "idle" | "running" | "done" | "error", text: string): void {
  document.body.dataset.state = state;
  statusLine.textContent = text;
}

function setBusy(busy: boolean): void {
  microButton.disabled = busy;
  pipelineButton.disabled = busy;
  clearButton.disabled = busy;
}

function render(): void {
  environmentBlock.textContent = JSON.stringify(report.environment, null, 2);
  jsonBlock.textContent = JSON.stringify(report, null, 2);
}

function addMicroRow(result: StageResult): void {
  const row = resultsBody.insertRow();
  const cells = [
    result.stage,
    formatBytes(result.chunkSize),
    (result.bytes / MIB).toFixed(0),
    result.ms.toFixed(0),
    result.mbPerSecond.toFixed(1),
  ];
  for (const text of cells) {
    row.insertCell().textContent = text;
  }
}

/** What the browser offers that matters for large files. Presence checks only. */
async function collectEnvironment(): Promise<Environment> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const perf = performance as Performance & {
    memory?: { jsHeapSizeLimit: number };
    measureUserAgentSpecificMemory?: unknown;
  };
  let storage: StorageEstimate | string;
  try {
    storage = await navigator.storage.estimate();
  } catch (error) {
    storage = `unavailable: ${String(error)}`;
  }
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    storage,
    memoryApis: {
      performanceMemory: perf.memory !== undefined,
      jsHeapSizeLimit: perf.memory?.jsHeapSizeLimit ?? null,
      measureUserAgentSpecificMemory: typeof perf.measureUserAgentSpecificMemory === "function",
    },
    fileApis: {
      opfs: typeof navigator.storage?.getDirectory === "function",
      showSaveFilePicker: "showSaveFilePicker" in window,
      serviceWorker: "serviceWorker" in navigator,
    },
  };
}

/** Which pipeline sinks work here: the worker's answer, with fsa also needing the save picker. */
async function probeSinks(): Promise<SinkSupport | string> {
  const response = await call({ type: "probe", id: nextId++ });
  if (response.type !== "probe-result") {
    return response.type === "error" ? `probe failed: ${response.message}` : "probe failed";
  }
  return {
    ...response.sinks,
    fsa: response.sinks.fsa && "showSaveFilePicker" in window,
    sw: response.sinks.sw && window.isSecureContext && "serviceWorker" in navigator,
  };
}

// --- Microbenchmarks ---

function selectedChunkSizes(): number[] {
  return [...chunkBox.querySelectorAll<HTMLInputElement>("input:checked")].map((input) =>
    Number(input.value),
  );
}

async function runMicro(totalBytes: number, chunkSizes: number[]): Promise<void> {
  const run: MicroRun = {
    kind: "micro",
    startedAt: new Date().toISOString(),
    totalBytes,
    chunkSizes,
  };
  report.runs.push(run);
  setBusy(true);
  setState("running", "Starting…");
  const response = await call({ type: "micro", id: nextId++, totalBytes, chunkSizes });
  if (response.type === "micro-result") {
    run.results = response.results;
    response.results.forEach(addMicroRow);
    setState("done", "Done.");
  } else {
    run.error = response.type === "error" ? response.message : `unexpected ${response.type}`;
    setState("error", `Failed: ${run.error}`);
  }
  setBusy(false);
  render();
}

// --- Pipeline ---

function revokeDownload(): void {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = undefined;
  }
}

/** Starts a download of `blob` as bench-output.bin. The URL is revoked later, not at once. */
function download(blob: Blob): void {
  revokeDownload();
  const url = URL.createObjectURL(blob);
  downloadUrl = url;
  const link = document.createElement("a");
  link.href = url;
  link.download = "bench-output.bin";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    if (downloadUrl === url) {
      revokeDownload();
    }
  }, REVOKE_AFTER_MS);
}

/** The OPFS output as a File: disk-backed, so the download does not load it into memory. */
async function opfsFile(name: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(BENCH_DIR);
  return (await dir.getFileHandle(name)).getFile();
}

async function deliver(output: SinkOutput, run: PipelineRun): Promise<void> {
  switch (output.kind) {
    case "picked-file":
      run.delivery = "picked-file";
      return;
    case "opfs-file":
      download(await opfsFile(output.name));
      run.delivery = "blob-url-disk";
      return;
    case "blob":
      download(output.blob);
      run.delivery = "blob-url-memory";
      return;
    case "sw-download": {
      run.delivery = "sw-stream";
      run.swTransport = output.transport;
      if (!swDownload) {
        throw new Error("the service worker download never started");
      }
      const bytes = await withTimeout(swDownload.finished, SW_FINISH_TIMEOUT_MS, "the download");
      if (bytes !== run.result?.outputBytes) {
        throw new Error(`the download got ${bytes} bytes, the sink ${run.result?.outputBytes}`);
      }
      return;
    }
  }
}

function pipelineParams(): PipelineParams | string {
  const source = pipelineForm.querySelector<HTMLInputElement>('input[name="pipe-source"]:checked');
  const sink = sinkSelect.value as SinkKind;
  const chunkSize = Number(pipeChunkSelect.value);
  if (source?.value === "file") {
    const file = fileInput.files?.[0];
    if (!file) {
      return "Pick a file first.";
    }
    return { size: file.size, chunkSize, source: { kind: "file" }, sink };
  }
  const size =
    sizeSelect.value === "custom" ? Number(customMibInput.value) * MIB : Number(sizeSelect.value);
  const seed = Number(seedInput.value);
  if (!Number.isSafeInteger(size) || size < 0) {
    return "Size must be a whole number of bytes.";
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    return "Seed must be between 0 and 4294967295.";
  }
  return { size, chunkSize, source: { kind: "seeded", seed }, sink };
}

type ShowSaveFilePicker = (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;

/**
 * Runs the pipeline. For the fsa sink, showSaveFilePicker is called before
 * anything is awaited, so it still runs inside the click's user gesture.
 */
async function runPipeline(params: PipelineParams): Promise<void> {
  let picking: Promise<FileSystemFileHandle> | undefined;
  const picker = (window as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (params.sink === "fsa" && typeof picker === "function") {
    picking = picker.call(window, { suggestedName: "bench-output.bin" });
  }
  // "running" before the first await, so a driver never sees the last run's state.
  revokeDownload();
  swDownload = undefined;
  setBusy(true);
  setState("running", "Starting…");
  const run: PipelineRun = {
    kind: "pipeline",
    startedAt: new Date().toISOString(),
    params,
    sinkLabel: SINK_LABELS[params.sink],
    delivery: "none",
    environment: { storageBefore: await readStorage(), memoryBefore: readMemory() },
  };
  report.runs.push(run);
  const finish = (state: "done" | "error", text: string): void => {
    renderPipelineRun(pipelineBody, run);
    setState(state, text);
    setBusy(false);
    render();
  };

  let saveHandle: FileSystemFileHandle | undefined;
  if (picking) {
    try {
      saveHandle = await picking;
    } catch (error) {
      run.result = failedBeforeStart("pick", error);
      finish("error", `Failed: ${describe(error)}`);
      return;
    }
  }

  const file = params.source.kind === "file" ? fileInput.files?.[0] : undefined;
  const response = await call({ type: "pipeline", id: nextId++, params, file, saveHandle });
  if (response.type !== "pipeline-result") {
    const message = response.type === "error" ? response.message : `unexpected ${response.type}`;
    run.result = failedBeforeStart("setup", new Error(message));
    finish("error", `Failed: ${message}`);
    return;
  }
  run.result = response.result;
  const { result } = response;
  if (result.outcome !== "ok" || !response.output) {
    const reason = result.error ? `${result.error.name}: ${result.error.message}` : "no output";
    if (result.outcome === "unsupported") {
      finish("done", `Unsupported: ${reason}`);
    } else {
      finish("error", `Failed in ${result.error?.phase ?? "?"}: ${reason}`);
    }
    return;
  }
  try {
    await deliver(response.output, run);
  } catch (error) {
    result.outcome = "error";
    result.error = { phase: "download", ...nameAndMessage(error) };
    finish("error", `Failed in download: ${describe(error)}`);
    return;
  }
  finish("done", "Done.");
}

function nameAndMessage(error: unknown): { name: string; message: string } {
  return error instanceof Error || error instanceof DOMException
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function describe(error: unknown): string {
  const { name, message } = nameAndMessage(error);
  return `${name}: ${message}`;
}

/** The result of a run that failed before the worker started its phases. */
function failedBeforeStart(
  phase: "pick" | "setup",
  error: unknown,
): NonNullable<PipelineRun["result"]> {
  return {
    outcome: "error",
    phases: [],
    paddedLength: 0,
    containerBytes: 0,
    outputBytes: 0,
    commitmentVerified: false,
    error: { phase, ...nameAndMessage(error) },
  };
}

async function clearOpfs(): Promise<void> {
  revokeDownload();
  setBusy(true);
  setState("running", "Clearing OPFS…");
  const response = await call({ type: "clear-opfs", id: nextId++ });
  if (response.type === "opfs-cleared") {
    const usage = response.storage ? formatBytes(response.storage.usage) : "unknown";
    setState("done", `OPFS cleared. Origin storage in use: ${usage}.`);
  } else {
    setState("error", `Clear failed: ${response.type === "error" ? response.message : "?"}`);
  }
  setBusy(false);
}

// --- Setup ---

function option(select: HTMLSelectElement, value: string, text: string, selected = false): void {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = text;
  item.selected = selected;
  select.append(item);
}

for (const size of MICRO_CHUNK_SIZES) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = String(size);
  input.checked = true;
  label.append(input, ` ${formatBytes(size)}`);
  chunkBox.append(label);
}
mibInput.value = String(DEFAULT_MICRO_BYTES / MIB);

PIPELINE_SIZES.forEach((size, index) => {
  option(sizeSelect, String(size), formatBytes(size), index === 0);
});
option(sizeSelect, "custom", "Custom");
for (const size of PIPELINE_CHUNK_SIZES) {
  option(pipeChunkSelect, String(size), formatBytes(size), size === DEFAULT_PIPELINE_CHUNK);
}
for (const kind of Object.keys(SINK_LABELS) as SinkKind[]) {
  option(sinkSelect, kind, `${kind}: ${SINK_LABELS[kind]}`, kind === "opfs");
}

microForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runMicro(Number(mibInput.value) * MIB, selectedChunkSizes());
});

pipelineForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const params = pipelineParams();
  if (typeof params === "string") {
    setState("error", params);
    return;
  }
  void runPipeline(params);
});

clearButton.addEventListener("click", () => {
  void clearOpfs();
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(jsonBlock.textContent ?? "");
    copyButton.textContent = "Copied";
  } catch {
    // Clipboard access can be refused; selecting the text lets the user copy by hand.
    getSelection()?.selectAllChildren(jsonBlock);
    copyButton.textContent = "Select and copy";
  }
});

report.environment = await collectEnvironment();
report.environment.sinks = await probeSinks();
render();
