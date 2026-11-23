// The bench worker. All crypto and data generation run here, off the page's
// main thread, so timings are not skewed by rendering and the page stays
// responsive. One request runs at a time; the page waits for the result.

import type { WorkerRequest, WorkerResponse, WorkerScope } from "./messages.ts";
import { type Progress, runMicro } from "./micro.ts";
import { clearBenchDir, hasSyncAccessHandle } from "./opfs.ts";
import { runPipeline } from "./pipeline.ts";
import { readStorage } from "./results.ts";
import { workerSinkSupport } from "./sinks.ts";

const scope = self as unknown as WorkerScope;

/** At most one progress message per this many ms, so posting does not cost throughput. */
const PROGRESS_INTERVAL_MS = 200;

function progressFor(id: number): Progress {
  let last = 0;
  return (label, done, total) => {
    const now = performance.now();
    if (done < total && now - last < PROGRESS_INTERVAL_MS) {
      return;
    }
    last = now;
    send({ type: "progress", id, label, done, total });
  };
}

function send(message: WorkerResponse): void {
  scope.postMessage(message);
}

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  switch (request.type) {
    case "micro": {
      const results = await runMicro(
        request.totalBytes,
        request.chunkSizes,
        progressFor(request.id),
      );
      return { type: "micro-result", id: request.id, results };
    }
    case "pipeline": {
      const { result, output } = await runPipeline(request, progressFor(request.id));
      return output
        ? { type: "pipeline-result", id: request.id, result, output }
        : { type: "pipeline-result", id: request.id, result };
    }
    case "clear-opfs":
      await clearBenchDir();
      return { type: "opfs-cleared", id: request.id, storage: await readStorage() };
    case "probe":
      return {
        type: "probe-result",
        id: request.id,
        sinks: workerSinkSupport(),
        syncAccessHandle: hasSyncAccessHandle(),
      };
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  handle(request).then(send, (error: unknown) => {
    send({
      type: "error",
      id: request.id,
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  });
};
