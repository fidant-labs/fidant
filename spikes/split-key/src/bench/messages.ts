// Messages between the bench page and its worker. Requests carry only sizes
// and settings, responses only measurements: keys stay inside the worker, and
// the data is synthetic. Constants here are shared so the page does not import
// the crypto modules.

/** Chunk sizes the AES-GCM microbenchmarks offer. */
export const MICRO_CHUNK_SIZES = [48 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
export const DEFAULT_MICRO_BYTES = 256 * 1024 * 1024;

export type MicroStage = "aes-gcm-encrypt" | "aes-gcm-decrypt" | "sha256-js" | "generator";

export type MicroRequest = {
  type: "micro";
  id: number;
  /** Bytes pushed through each stage. */
  totalBytes: number;
  /** Chunk sizes for the AES-GCM stages. */
  chunkSizes: number[];
};

export type WorkerRequest = MicroRequest;

export type StageResult = {
  stage: MicroStage;
  chunkSize: number;
  bytes: number;
  ms: number;
  /** Throughput in MB/s, 1 MB = 10^6 bytes. */
  mbPerSecond: number;
};

export type WorkerResponse =
  | { type: "progress"; id: number; label: string; done: number; total: number }
  | { type: "micro-result"; id: number; results: StageResult[] }
  | { type: "error"; id: number; message: string };

/** The parts of a dedicated worker's global scope the bench uses, without the WebWorker lib. */
export type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};
