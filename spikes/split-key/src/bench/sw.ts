// The bench's service worker, served as /sw.js with scope "/". It turns a
// stream of plaintext from the page into a download without the bytes ever
// leaving the browser:
//
// 1. The page posts "register" with a random id, the plaintext (a transferred
//    ReadableStream or a MessagePort, see SwTransport) and a control port.
// 2. The page navigates a hidden iframe to /spike-dl/<id>. The navigation
//    never reaches the network: this worker answers it with the stream as an
//    attachment named bench-output.bin. The name is set here, in the browser.
// 3. The entry is one-shot: it is removed when served, so a second fetch of
//    the same URL gets a 404, as does any unknown id.
//
// Over the control port the worker reports "registered", "started" when the
// download response is handed out, and "done" or "failed" when the browser
// has read the whole body or the body failed.
//
// Classic script on purpose: module service workers are not in every engine.
// So this file imports and exports types only, and the bundle has no import
// or export statements. The page repeats the /spike-dl/ prefix for that reason.

import type { SwTransport } from "./results.ts";
import type { SwPortMessage } from "./sinks.ts";

/** Page → service worker, through ServiceWorker.postMessage. */
export type SwMessage =
  | {
      type: "register";
      id: string;
      size: number;
      transport: SwTransport;
      body: ReadableStream<Uint8Array> | MessagePort;
      control: MessagePort;
    }
  /** Sent every few seconds during a download: a message event resets the idle timer. */
  | { type: "ping" };

/** Page → service worker over the control port. */
export type SwControlRequest = { type: "cancel" };

/** Service worker → page over the control port. */
export type SwControlEvent =
  | { type: "registered" }
  | { type: "started" }
  | { type: "done"; bytes: number }
  | { type: "failed"; message: string };

const DOWNLOAD_PREFIX = "/spike-dl/";
const DOWNLOAD_NAME = "bench-output.bin";

/** The parts of a service worker's global scope this file uses, without the WebWorker lib. */
type ExtendableEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
};
type ExtendableMessageEvent = ExtendableEvent & { data: SwMessage };
type ServiceWorkerScope = {
  oninstall: ((event: ExtendableEvent) => void) | null;
  onactivate: ((event: ExtendableEvent) => void) | null;
  onfetch: ((event: FetchEvent) => void) | null;
  onmessage: ((event: ExtendableMessageEvent) => void) | null;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

const scope = self as unknown as ServiceWorkerScope;

type Entry = { size: number; body: ReadableStream<Uint8Array>; control: MessagePort };

/** Registered downloads not yet fetched, by id. */
const entries = new Map<string, Entry>();

/**
 * Headers of the download response. The page is cross-origin isolated, so
 * the iframe's navigation response needs COEP and CORP too, or the browser
 * blocks it before it becomes a download. No CSP frame-ancestors here: the
 * response is loaded in the bench's own iframe.
 */
const SECURITY_HEADERS = {
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

scope.oninstall = (event) => {
  event.waitUntil(scope.skipWaiting());
};

// Take over the open bench page at once, so its first run does not need a reload.
scope.onactivate = (event) => {
  event.waitUntil(scope.clients.claim());
};

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type !== "register") {
    return;
  }
  const { id, size, control } = message;
  const body = message.body instanceof MessagePort ? portStream(message.body) : message.body;
  entries.set(id, { size, body, control });
  control.onmessage = (controlEvent: MessageEvent<SwControlRequest>) => {
    if (controlEvent.data.type === "cancel" && entries.delete(id)) {
      body.cancel("cancelled by the page").catch(() => {});
    }
  };
  post(control, { type: "registered" });
};

scope.onfetch = (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(DOWNLOAD_PREFIX)) {
    // Everything else goes to the network as if there were no service worker.
    return;
  }
  const id = url.pathname.slice(DOWNLOAD_PREFIX.length);
  const entry = entries.get(id);
  if (!entry) {
    event.respondWith(new Response(null, { status: 404, headers: SECURITY_HEADERS }));
    return;
  }
  entries.delete(id);
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${DOWNLOAD_NAME}"`,
    "content-length": String(entry.size),
  };
  event.respondWith(new Response(tracked(entry), { status: 200, headers }));
  post(entry.control, { type: "started" });
};

function post(control: MessagePort, message: SwControlEvent): void {
  control.postMessage(message);
}

/**
 * Passes the body through and tells the page how it ended: "done" once the
 * browser has read every byte, "failed" if the source errors or the browser
 * cancels the download.
 */
function tracked(entry: Entry): ReadableStream<Uint8Array> {
  const reader = entry.body.getReader();
  let bytes = 0;
  const finish = (message: SwControlEvent): void => {
    post(entry.control, message);
    entry.control.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        finish({ type: "failed", message: String(error) });
        controller.error(error);
        return;
      }
      if (next.done) {
        controller.close();
        finish({ type: "done", bytes });
        return;
      }
      bytes += next.value.byteLength;
      controller.enqueue(next.value);
    },
    cancel(reason) {
      finish({ type: "failed", message: `download cancelled: ${String(reason)}` });
      return reader.cancel(reason);
    },
  });
}

/**
 * The message-port transport as a ReadableStream: each pull asks the sink
 * for one chunk and waits for it, so the sink never runs ahead.
 */
function portStream(port: MessagePort): ReadableStream<Uint8Array> {
  let pulled: (() => void) | undefined;
  const send = (message: SwPortMessage): void => port.postMessage(message);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      port.onmessage = (event: MessageEvent<SwPortMessage>) => {
        const message = event.data;
        if (message.type === "chunk") {
          controller.enqueue(message.chunk);
        } else if (message.type === "end") {
          controller.close();
          port.close();
        } else if (message.type === "abort") {
          controller.error(new Error("the sink aborted"));
          port.close();
        } else {
          return;
        }
        pulled?.();
        pulled = undefined;
      };
    },
    pull() {
      return new Promise<void>((resolve) => {
        pulled = resolve;
        send({ type: "pull" });
      });
    },
    cancel() {
      send({ type: "cancel" });
      port.close();
    },
  });
}
