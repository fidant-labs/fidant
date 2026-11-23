// A typed wrapper over the /signal WebSocket.
//
// Outgoing messages are ClientMessages serialised as JSON. Incoming text
// frames are parsed with parseServerMessage; anything invalid (bad JSON,
// unknown shape, binary frames) is dropped and reported with a warning that
// never includes the frame's content.
//
// There is no automatic reconnect: if the socket closes, onClose listeners
// learn why and the page decides what to do (for now, tell the user). A
// reconnect would have to re-send host/join, which the page knows and this
// wrapper does not.

import { type ClientMessage, parseServerMessage, type ServerMessage } from "@sigill/protocol";

export type SignalingClose = {
  /** WebSocket close code (1006 when the connection dropped). */
  code: number;
  /** True if close() was called on this client. */
  byClient: boolean;
};

export type SignalingClient = {
  /** Resolves when the socket is open; rejects if it closes before opening. */
  readonly ready: Promise<void>;
  /** Sends a message. Returns false (and sends nothing) if the socket is not open. */
  send(message: ClientMessage): boolean;
  /** Calls the listener for every valid server message. Returns an unsubscribe function. */
  subscribe(listener: (message: ServerMessage) => void): () => void;
  /** Calls the listener once when the socket closes. Returns an unsubscribe function. */
  onClose(listener: (info: SignalingClose) => void): () => void;
  /** Closes the socket. Safe to call more than once. */
  close(): void;
};

/** The signaling endpoint on the server that served this page. */
export function defaultSignalingUrl(): string {
  return `wss://${location.host}/signal`;
}

export function connectSignaling(url: string = defaultSignalingUrl()): SignalingClient {
  const socket = new WebSocket(url);
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const closeListeners = new Set<(info: SignalingClose) => void>();
  let closedByClient = false;

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("close", () => reject(new Error("signaling closed before opening")), {
      once: true,
    });
  });
  // Callers that only use onClose should not see an unhandled rejection.
  ready.catch(() => {});

  socket.addEventListener("message", (event: MessageEvent) => {
    const message = typeof event.data === "string" ? parseServerMessage(event.data) : undefined;
    if (!message) {
      console.warn("sigill: ignored an invalid signaling message");
      return;
    }
    for (const listener of [...messageListeners]) {
      listener(message);
    }
  });

  socket.addEventListener(
    "close",
    (event: CloseEvent) => {
      const info: SignalingClose = { code: event.code, byClient: closedByClient };
      for (const listener of [...closeListeners]) {
        listener(info);
      }
      messageListeners.clear();
      closeListeners.clear();
    },
    { once: true },
  );

  return {
    ready,
    send(message) {
      if (socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      socket.send(JSON.stringify(message));
      return true;
    },
    subscribe(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    close() {
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        return;
      }
      closedByClient = true;
      socket.close(1000);
    },
  };
}
