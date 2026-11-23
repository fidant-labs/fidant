// The page's side of the sw sink. The worker that decrypts cannot register a
// service worker or start a download, so it asks the page: "prepare" when the
// sink opens, "start" with the plaintext on the first write.
//
// The download is triggered by navigating a hidden iframe to
// /spike-dl/<random id>. An iframe navigation goes through the service
// worker in Chromium, Firefox and Safari, and the page itself stays put. A
// link with a download attribute is not used: whether such a request goes
// through the service worker has differed between engines. A top-level
// navigation would work as well but unloads the page if the response is not
// a download (a 404, say).

import type { SwOffer } from "./sinks.ts";
import type { SwControlEvent, SwControlRequest, SwMessage } from "./sw.ts";

/** The service worker's URL. vite.config.ts gives its bundle this fixed name. */
const SW_URL = "/sw.js";
/** The service worker serves downloads under this path. sw.ts has the same constant. */
const DOWNLOAD_PREFIX = "/spike-dl/";
/** How long a registration may take to activate and claim the page. */
const ACTIVATE_TIMEOUT_MS = 10_000;
/** How long the browser may take to fetch the download URL after the iframe navigates. */
const START_TIMEOUT_MS = 30_000;
/** Ping interval: well under the 30 s idle timeout of Chromium and Firefox. */
const PING_INTERVAL_MS = 10_000;

/** The engine or context cannot run the sink; the run reports "unsupported". */
export class SwUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwUnsupportedError";
  }
}

export type SwDownload = {
  /** Resolves with the bytes the browser read once the download body is complete. */
  finished: Promise<number>;
};

let registration: ServiceWorkerRegistration | undefined;
let frame: HTMLIFrameElement | undefined;

/**
 * Registers sw.js the first time the sw sink is used and waits until it is
 * active. On the very first load the page is not controlled yet; sw.js calls
 * clients.claim() on activate, and this waits for that too. Control is not
 * strictly needed (an iframe navigation goes to the worker whose scope
 * matches), but a controlled page is the state a real app would be in.
 */
export async function prepareSwDownload(): Promise<void> {
  if (!window.isSecureContext) {
    throw new SwUnsupportedError("not a secure context, so no service workers");
  }
  if (!("serviceWorker" in navigator)) {
    throw new SwUnsupportedError("navigator.serviceWorker is missing");
  }
  if (!registration) {
    try {
      registration = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    } catch (error) {
      // An untrusted certificate, private browsing or a policy can refuse registration.
      if (error instanceof DOMException && error.name === "SecurityError") {
        throw new SwUnsupportedError(`registration refused: ${error.message}`);
      }
      throw error;
    }
  }
  // A worker that never activates is blocked (Playwright's serviceWorkers:
  // "block" registers but never activates), which is the environment, not a bug.
  try {
    await withTimeout(navigator.serviceWorker.ready, ACTIVATE_TIMEOUT_MS, "activation");
    if (!navigator.serviceWorker.controller) {
      await withTimeout(
        new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
            once: true,
          });
        }),
        ACTIVATE_TIMEOUT_MS,
        "clients.claim()",
      );
    }
  } catch (error) {
    throw new SwUnsupportedError(
      `the service worker did not take control: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Hands the plaintext to the service worker, navigates the iframe to the
 * download URL and resolves once the service worker has answered it.
 */
export async function startSwDownload(offer: SwOffer): Promise<SwDownload> {
  const active = registration?.active;
  if (!active) {
    throw new Error("the service worker is not active");
  }
  const id = crypto.randomUUID();
  const { port1: control, port2: remote } = new MessageChannel();
  const events = controlEvents(control);
  const message: SwMessage = {
    type: "register",
    id,
    size: offer.size,
    transport: offer.transport,
    body: offer.body,
    control: remote,
  };
  active.postMessage(message, [offer.body, remote]);
  await events.next("registered", START_TIMEOUT_MS);

  frame ??= hiddenFrame();
  frame.src = `${DOWNLOAD_PREFIX}${id}`;
  try {
    await events.next("started", START_TIMEOUT_MS);
  } catch (error) {
    const cancel: SwControlRequest = { type: "cancel" };
    control.postMessage(cancel);
    control.close();
    throw error;
  }

  // While the body streams, keep the service worker from being stopped as idle.
  const ping = setInterval(() => {
    const ping: SwMessage = { type: "ping" };
    registration?.active?.postMessage(ping);
  }, PING_INTERVAL_MS);
  const finished = events.end().finally(() => {
    clearInterval(ping);
    control.close();
  });
  // A failure surfaces where the page awaits `finished`; this only avoids an unhandled rejection.
  finished.catch(() => {});
  return { finished };
}

function hiddenFrame(): HTMLIFrameElement {
  const created = document.createElement("iframe");
  created.hidden = true;
  created.title = "Download";
  document.body.append(created);
  return created;
}

/** Waits for the control port's events in order: registered, started, then done or failed. */
function controlEvents(control: MessagePort): {
  next(type: "registered" | "started", timeoutMs: number): Promise<void>;
  end(): Promise<number>;
} {
  const queue: SwControlEvent[] = [];
  let wake: (() => void) | undefined;
  control.onmessage = (event: MessageEvent<SwControlEvent>) => {
    queue.push(event.data);
    wake?.();
    wake = undefined;
  };
  const take = async (): Promise<SwControlEvent> => {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return queue.shift() as SwControlEvent;
  };
  return {
    next: async (type, timeoutMs) => {
      const event = await withTimeout(take(), timeoutMs, `the service worker's "${type}"`);
      if (event.type === "failed") {
        throw new Error(`service worker download failed: ${event.message}`);
      }
      if (event.type !== type) {
        throw new Error(`expected "${type}" from the service worker, got "${event.type}"`);
      }
    },
    end: async () => {
      const event = await take();
      if (event.type === "done") {
        return event.bytes;
      }
      throw new Error(
        event.type === "failed"
          ? `service worker download failed: ${event.message}`
          : `unexpected "${event.type}" from the service worker`,
      );
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
