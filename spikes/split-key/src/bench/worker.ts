// The bench worker. All crypto and data generation run here, off the page's
// main thread, so timings are not skewed by rendering and the page stays
// responsive. One request runs at a time; the page waits for the result.

import type { SwReply, SwRequest, WorkerRequest, WorkerResponse, WorkerScope } from "./messages.ts";
import { type Progress, runMicro } from "./micro.ts";
import { clearBenchDir, hasSyncAccessHandle } from "./opfs.ts";
import { runPipeline } from "./pipeline.ts";
import { readStorage } from "./results.ts";
import { type SwBridge, type SwOffer, UnsupportedSinkError, workerSinkSupport } from "./sinks.ts";

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

function send(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

/** Questions to the page that wait for its SwReply, by sequence number. */
const swWaiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
let nextSwSeq = 1;

function askPage(id: number, step: SwRequest["step"], transfer: Transferable[]): Promise<void> {
  const seq = nextSwSeq++;
  return new Promise((resolve, reject) => {
    swWaiting.set(seq, { resolve, reject });
    send({ type: "sw-request", id, seq, step }, transfer);
  });
}

function settleSw(reply: SwReply): void {
  const waiting = swWaiting.get(reply.seq);
  swWaiting.delete(reply.seq);
  if (!reply.error) {
    waiting?.resolve();
  } else if (reply.error.unsupported) {
    waiting?.reject(new UnsupportedSinkError(reply.error.message));
  } else {
    waiting?.reject(new Error(reply.error.message));
  }
}

/** The sw sink's way to the page, which owns the service worker registration. */
function swBridgeFor(id: number): SwBridge {
  return {
    prepare: () => askPage(id, { kind: "prepare" }, []),
    start: (offer: SwOffer) => askPage(id, { kind: "start", ...offer }, [offer.body]),
  };
}

async function handle(request: Exclude<WorkerRequest, SwReply>): Promise<WorkerResponse> {
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
      const { result, output } = await runPipeline(
        { ...request, swBridge: swBridgeFor(request.id) },
        progressFor(request.id),
      );
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
  if (request.type === "sw-reply") {
    settleSw(request);
    return;
  }
  handle(request).then(send, (error: unknown) => {
    send({
      type: "error",
      id: request.id,
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  });
};
