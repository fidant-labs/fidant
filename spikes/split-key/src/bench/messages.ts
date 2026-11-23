// Messages between the bench page and its worker. Requests carry only sizes
// and settings, responses only measurements: keys stay inside the worker. The
// exceptions are handles, not data: a pipeline request may carry the File the
// user picked and the save handle from showSaveFilePicker, and a pipeline
// result may carry the decrypted Blob of the blob sink. Constants here are
// shared so the page does not import the crypto modules.

import type { PipelineParams, PipelineResult, StorageReading } from "./results.ts";
import type { SinkOutput, SinkSupport } from "./sinks.ts";

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

/** Chunk sizes the pipeline offers. */
export const PIPELINE_CHUNK_SIZES = [48 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
export const DEFAULT_PIPELINE_CHUNK = 256 * 1024;
/** Plaintext sizes the pipeline offers; the page also takes a custom size. */
export const PIPELINE_SIZES = [64 * 1024 * 1024, 1024 * 1024 * 1024, 5 * 1024 * 1024 * 1024];

export type PipelineRequest = {
  type: "pipeline";
  id: number;
  params: PipelineParams;
  /** The picked file, for a file source. Cloned by reference, not copied. */
  file?: File | undefined;
  /** From showSaveFilePicker, for the fsa sink. */
  saveHandle?: FileSystemFileHandle | undefined;
};

/** Deletes everything the bench keeps in OPFS. */
export type ClearOpfsRequest = { type: "clear-opfs"; id: number };

/** Asks which sinks the worker can open. */
export type ProbeRequest = { type: "probe"; id: number };

export type WorkerRequest = MicroRequest | PipelineRequest | ClearOpfsRequest | ProbeRequest;

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
  | { type: "pipeline-result"; id: number; result: PipelineResult; output?: SinkOutput }
  | { type: "opfs-cleared"; id: number; storage: StorageReading }
  | { type: "probe-result"; id: number; sinks: SinkSupport; syncAccessHandle: boolean }
  | { type: "error"; id: number; message: string };

/** The parts of a dedicated worker's global scope the bench uses, without the WebWorker lib. */
export type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};
