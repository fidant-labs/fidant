// The bench page: plain DOM, no framework. It collects the browser
// environment, sends requests to the worker, and shows each result as a table
// row and in the JSON report. The report holds sizes, timings and the
// environment only: no keys, file names or file content.
//
// body[data-state] is idle, running, done or error, so a script driving the
// page can wait on it and read #json.

import {
  DEFAULT_MICRO_BYTES,
  MICRO_CHUNK_SIZES,
  type MicroRequest,
  type StageResult,
  type WorkerResponse,
} from "./messages.ts";

const MIB = 1024 * 1024;

type Environment = Record<string, unknown>;

type Run = {
  kind: "micro";
  startedAt: string;
  totalBytes: number;
  chunkSizes: number[];
  results?: StageResult[];
  error?: string;
};

type Report = { bench: "sigill-split-key"; version: 1; environment: Environment; runs: Run[] };

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`missing #${id}`);
  }
  return found as T;
}

const form = element<HTMLFormElement>("micro-form");
const mibInput = element<HTMLInputElement>("micro-mib");
const chunkBox = element<HTMLDivElement>("micro-chunks");
const runButton = element<HTMLButtonElement>("micro-run");
const statusLine = element<HTMLParagraphElement>("status");
const resultsBody = element<HTMLTableSectionElement>("results");
const environmentBlock = element<HTMLPreElement>("environment");
const jsonBlock = element<HTMLPreElement>("json");
const copyButton = element<HTMLButtonElement>("copy");

const report: Report = { bench: "sigill-split-key", version: 1, environment: {}, runs: [] };
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 1;

function formatSize(bytes: number): string {
  return bytes >= MIB ? `${bytes / MIB} MiB` : `${bytes / 1024} KiB`;
}

function setState(state: "idle" | "running" | "done" | "error", text: string): void {
  document.body.dataset.state = state;
  statusLine.textContent = text;
}

function render(): void {
  environmentBlock.textContent = JSON.stringify(report.environment, null, 2);
  jsonBlock.textContent = JSON.stringify(report, null, 2);
}

function addRow(result: StageResult): void {
  const row = resultsBody.insertRow();
  const cells = [
    result.stage,
    formatSize(result.chunkSize),
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

function selectedChunkSizes(): number[] {
  return [...chunkBox.querySelectorAll<HTMLInputElement>("input:checked")].map((input) =>
    Number(input.value),
  );
}

function runMicro(totalBytes: number, chunkSizes: number[]): void {
  const run: Run = { kind: "micro", startedAt: new Date().toISOString(), totalBytes, chunkSizes };
  report.runs.push(run);
  const request: MicroRequest = { type: "micro", id: nextId++, totalBytes, chunkSizes };
  runButton.disabled = true;
  setState("running", "Starting…");

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.id !== request.id) {
      return;
    }
    switch (message.type) {
      case "progress":
        statusLine.textContent = `${message.label}: ${Math.round((100 * message.done) / message.total)} %`;
        return;
      case "micro-result":
        run.results = message.results;
        message.results.forEach(addRow);
        setState("done", "Done.");
        break;
      case "error":
        run.error = message.message;
        setState("error", `Failed: ${message.message}`);
        break;
    }
    runButton.disabled = false;
    render();
  };
  worker.postMessage(request);
}

worker.onerror = (event) => {
  setState("error", `Worker failed: ${event.message}`);
  runButton.disabled = false;
};

for (const size of MICRO_CHUNK_SIZES) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = String(size);
  input.checked = true;
  label.append(input, ` ${formatSize(size)}`);
  chunkBox.append(label);
}
mibInput.value = String(DEFAULT_MICRO_BYTES / MIB);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runMicro(Number(mibInput.value) * MIB, selectedChunkSizes());
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
render();
