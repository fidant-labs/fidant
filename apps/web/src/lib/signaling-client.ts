// A typed wrapper over the /signal WebSocket.
//
// Outgoing messages are ClientMessages serialised as JSON. Incoming text
// frames are parsed with parseServerMessage; anything invalid (bad JSON,
// unknown shape, binary frames) is dropped and reported with a warning that
// never includes the frame's content.
//
// When the socket closes, or a connection attempt fails, onClose listeners
// learn why and the client opens a new socket after retryDelay, until close()
// is called. Listeners stay registered across reconnects. onOpen fires on
// every open: the page re-sends host/join there, since it knows them and this
// wrapper does not.

import { type ClientMessage, parseServerMessage, type ServerMessage } from "@sigill/protocol";

export type SignalingClose = {
  /** WebSocket close code (1006 when the connection dropped). */
  code: number;
  /** True if close() was called on this client. */
  byClient: boolean;
};

export type SignalingClient = {
  /** Sends a message. Returns false (and sends nothing) if the socket is not open. */
  send(message: ClientMessage): boolean;
  /** Calls the listener for every valid server message. Returns an unsubscribe function. */
  subscribe(listener: (message: ServerMessage) => void): () => void;
  /** Calls the listener every time a socket opens. Returns an unsubscribe function. */
  onOpen(listener: () => void): () => void;
  /** Calls the listener every time a socket closes, including a failed attempt. Returns an unsubscribe function. */
  onClose(listener: (info: SignalingClose) => void): () => void;
  /** Closes the socket and stops reconnecting. Safe to call more than once. */
  close(): void;
};

/** The signaling endpoint on the server that served this page. */
export function defaultSignalingUrl(): string {
  return `wss://${location.host}/signal`;
}

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;

/** A random wait up to min(30 s, 1 s × 2^failures), so clients don't reconnect in step. */
export function retryDelay(failures: number, random = Math.random): number {
  return random() * Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures);
}

export type SignalingOptions = {
  url?: string;
  /** Called with the data length of each relay message sent or received. */
  onRelay?: (bytes: number) => void;
};

export function connectSignaling({
  url = defaultSignalingUrl(),
  onRelay,
}: SignalingOptions = {}): SignalingClient {
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const openListeners = new Set<() => void>();
  const closeListeners = new Set<(info: SignalingClose) => void>();
  let closedByClient = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const clearListeners = () => {
    messageListeners.clear();
    openListeners.clear();
    closeListeners.clear();
  };

  const open = (): WebSocket => {
    const next = new WebSocket(url);
    let opened = false;

    next.addEventListener("open", () => {
      opened = true;
      failures = 0;
      for (const listener of [...openListeners]) {
        listener();
      }
    });

    next.addEventListener("message", (event: MessageEvent) => {
      const message = typeof event.data === "string" ? parseServerMessage(event.data) : undefined;
      if (!message) {
        console.warn("sigill: ignored an invalid signaling message");
        return;
      }
      if (message.t === "relay") {
        onRelay?.(message.data.length);
      }
      for (const listener of [...messageListeners]) {
        listener(message);
      }
    });

    next.addEventListener("close", (event: CloseEvent) => {
      const info: SignalingClose = { code: event.code, byClient: closedByClient };
      for (const listener of [...closeListeners]) {
        listener(info);
      }
      if (closedByClient) {
        clearListeners();
        return;
      }
      retry = setTimeout(
        () => {
          socket = open();
        },
        retryDelay(opened ? 0 : ++failures),
      );
    });

    return next;
  };

  let socket = open();

  return {
    send(message) {
      if (socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      socket.send(JSON.stringify(message));
      if (message.t === "relay") {
        onRelay?.(message.data.length);
      }
      return true;
    },
    subscribe(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onOpen(listener) {
      openListeners.add(listener);
      return () => {
        openListeners.delete(listener);
      };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    close() {
      if (closedByClient) {
        return;
      }
      closedByClient = true;
      clearTimeout(retry);
      if (socket.readyState === WebSocket.CLOSED) {
        // Waiting to retry: no close event will come.
        clearListeners();
      } else {
        socket.close(1000);
      }
    },
  };
}
