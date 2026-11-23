// Relays signaling messages between a sender's browser (the host) and its
// recipients' browsers (guests) over the /signal WebSocket.
//
// The server only learns link IDs and opaque base64url blobs. It knows which
// link IDs are hosted and binds at most one guest to each, but it keeps no
// record of used links: the sender decides that and refuses with `refuse`.
// Relay payloads are never inspected or logged.

import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import {
  type ClientMessage,
  type ErrorCode,
  type LogReason,
  parseClientMessage,
  type RefuseReason,
  type ServerMessage,
} from "@sigill/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";

/** The only fields a log line may carry. `link` is cut to its first 6 characters. */
export type LogFields = {
  link?: string;
  links?: number;
  bytes?: number;
  reason?: LogReason;
  code?: ErrorCode;
  port?: number;
};

export type Logger = (event: string, fields?: LogFields) => void;

export const SIGNAL_PATH = "/signal";

/** WebSocket close code for a protocol violation. */
const POLICY_VIOLATION = 1008;

type Peer = {
  role: "none" | "host" | "guest";
  /** Links this socket hosts. */
  hosted: Set<string>;
  /** The link this socket is bound to as a guest. */
  joined: string | undefined;
  alive: boolean;
};

function short(link: string): string {
  return link.slice(0, 6);
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function rejectUpgrade(socket: Duplex, status: 403 | 404): void {
  const text = status === 403 ? "Forbidden" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** True if the request has no Origin header or one whose host matches the Host header. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachSignaling(
  server: HttpServer | HttpsServer,
  options: { log: Logger; heartbeatMs?: number },
): { close(): void } {
  const { log } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const peers = new Map<WebSocket, Peer>();
  const hosts = new Map<string, WebSocket>();
  const guests = new Map<string, WebSocket>();

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "https://localhost").pathname;
    } catch {
      pathname = "";
    }
    if (pathname !== SIGNAL_PATH) {
      log("upgrade-rejected", { reason: "path" });
      rejectUpgrade(socket, 404);
      return;
    }
    if (!sameOrigin(req)) {
      log("upgrade-rejected", { reason: "origin" });
      rejectUpgrade(socket, 403);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws));
  }

  function connect(socket: WebSocket): void {
    const peer: Peer = { role: "none", hosted: new Set(), joined: undefined, alive: true };
    peers.set(socket, peer);
    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const text = isBinary ? undefined : data.toString();
      const message = text === undefined ? undefined : parseClientMessage(text);
      if (!message) {
        log("bad-message", { bytes: text?.length ?? 0 });
        send(socket, { t: "error", code: "bad-message" });
        socket.close(POLICY_VIOLATION);
        return;
      }
      handle(socket, peer, message);
    });
    socket.on("close", () => disconnect(socket, peer));
    socket.on("error", () => socket.terminate());
  }

  function handle(socket: WebSocket, peer: Peer, message: ClientMessage): void {
    switch (message.t) {
      case "host":
        host(socket, peer, message.links);
        return;
      case "join":
        join(socket, peer, message.link);
        return;
      case "relay":
        relay(socket, peer, message.link, message.data);
        return;
      case "refuse":
        refuse(socket, peer, message.link, message.reason);
        return;
    }
  }

  function error(socket: WebSocket, code: ErrorCode): void {
    log("error", { code });
    send(socket, { t: "error", code });
  }

  function host(socket: WebSocket, peer: Peer, links: string[]): void {
    if (peer.role === "guest") {
      error(socket, "wrong-role");
      return;
    }
    if (links.some((link) => hosts.has(link) && hosts.get(link) !== socket)) {
      error(socket, "already-hosted");
      return;
    }
    peer.role = "host";
    const next = new Set(links);
    for (const link of peer.hosted) {
      if (!next.has(link)) {
        unhost(link);
      }
    }
    for (const link of next) {
      hosts.set(link, socket);
    }
    peer.hosted = next;
    log("host", { links: next.size });
  }

  /** Stops hosting a link and tells its guest, if any, that the host is gone. */
  function unhost(link: string): void {
    hosts.delete(link);
    const guest = guests.get(link);
    if (!guest) {
      return;
    }
    guests.delete(link);
    const guestPeer = peers.get(guest);
    if (guestPeer) {
      guestPeer.joined = undefined;
    }
    log("host-gone", { link: short(link) });
    send(guest, { t: "host-gone" });
  }

  function join(socket: WebSocket, peer: Peer, link: string): void {
    if (peer.role === "host") {
      error(socket, "wrong-role");
      return;
    }
    if (peer.joined !== undefined) {
      error(socket, "already-joined");
      return;
    }
    peer.role = "guest";
    const hostSocket = hosts.get(link);
    if (!hostSocket || guests.has(link)) {
      const reason: RefuseReason = hostSocket ? "busy" : "unknown";
      log("refused", { link: short(link), reason });
      send(socket, { t: "refused", reason });
      return;
    }
    guests.set(link, socket);
    peer.joined = link;
    log("joined", { link: short(link) });
    send(hostSocket, { t: "joined", link });
  }

  function relay(socket: WebSocket, peer: Peer, link: string, data: string): void {
    let target: WebSocket | undefined;
    if (peer.hosted.has(link)) {
      target = guests.get(link);
    } else if (peer.joined === link) {
      target = hosts.get(link);
    } else {
      error(socket, "not-on-link");
      return;
    }
    if (!target) {
      // The other end left while this message was in flight.
      log("relay-dropped", { link: short(link), bytes: data.length });
      return;
    }
    log("relay", { link: short(link), bytes: data.length });
    send(target, { t: "relay", link, data });
  }

  function refuse(socket: WebSocket, peer: Peer, link: string, reason: RefuseReason): void {
    if (!peer.hosted.has(link)) {
      error(socket, "not-on-link");
      return;
    }
    const guest = guests.get(link);
    if (!guest) {
      return;
    }
    guests.delete(link);
    const guestPeer = peers.get(guest);
    if (guestPeer) {
      guestPeer.joined = undefined;
    }
    log("refused", { link: short(link), reason });
    send(guest, { t: "refused", reason });
  }

  function disconnect(socket: WebSocket, peer: Peer): void {
    peers.delete(socket);
    if (peer.hosted.size > 0) {
      log("host-closed", { links: peer.hosted.size });
      for (const link of peer.hosted) {
        unhost(link);
      }
      peer.hosted.clear();
    }
    const link = peer.joined;
    if (link !== undefined && guests.get(link) === socket) {
      guests.delete(link);
      peer.joined = undefined;
      log("left", { link: short(link) });
      const hostSocket = hosts.get(link);
      if (hostSocket) {
        send(hostSocket, { t: "left", link });
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const [socket, peer] of peers) {
      if (!peer.alive) {
        socket.terminate();
        continue;
      }
      peer.alive = false;
      socket.ping();
    }
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();

  server.on("upgrade", onUpgrade);

  return {
    close() {
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      for (const socket of peers.keys()) {
        socket.terminate();
      }
      wss.close();
    },
  };
}
