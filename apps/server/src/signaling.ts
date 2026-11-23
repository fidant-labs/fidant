// Relays signaling messages between a sender's browser (the host) and its
// recipients' browsers (guests) over the /signal WebSocket.
//
// The server only learns link IDs and opaque base64url blobs. It knows which
// link IDs are hosted and binds at most one guest to each, but it keeps no
// record of used links: the sender decides that and refuses with `refuse`.
// Relay payloads are never inspected or logged.

import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
  type ClientMessage,
  type ConnectionPath,
  type ErrorCode,
  type LogFields,
  parseClientMessage,
  type RefuseReason,
  type ServerMessage,
} from "@sigill/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";

export type Logger = (event: string, fields?: LogFields) => void;

export const SIGNAL_PATH = "/signal";

export const HEARTBEAT_MS = 30_000;

/** Caps on open sockets, incoming messages and bytes queued to a socket. Tests lower them through the `limits` option. */
const LIMITS = {
  sockets: 1000,
  socketsPerAddress: 32,
  // ponytail: fixed window reset by the heartbeat, so a socket can send twice this across a
  // window boundary; a token bucket if that burst ever matters.
  /** Messages one socket may send per heartbeat window, counting ones that fail to parse. */
  messagesPerWindow: 1000,
  /** Bytes queued to a socket beyond which relays to it are dropped, because it is not reading. */
  bufferedBytes: 256 * 1024,
};

/** WebSocket close code for a protocol violation. */
const POLICY_VIOLATION = 1008;

type Peer = {
  role: "none" | "host" | "guest";
  /** Links this socket hosts. */
  hosted: Set<string>;
  /** The link this socket is bound to as a guest. */
  joined: string | undefined;
  /** The attempt ID the guest joined with. Never logged. */
  attempt: string | undefined;
  alive: boolean;
  /** Messages received in the current heartbeat window. */
  messages: number;
  /** The client address this socket counts against. Never logged. */
  address: string;
};

function short(link: string): string {
  return link.slice(0, 6);
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

const STATUS_TEXT = {
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

function rejectUpgrade(socket: Duplex, status: keyof typeof STATUS_TEXT): void {
  const text = STATUS_TEXT[status];
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Maps an IPv4-mapped IPv6 address to IPv4 and drops an IPv6 zone. */
function normalize(ip: string): string {
  const lower = ip.toLowerCase().split("%")[0] ?? "";
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(lower) ? lower.slice(7) : lower;
}

/** The first 64 bits of an IPv6 address, written as a /64 prefix. */
function prefix64(ip: string): string {
  const [head = "", tail = ""] = ip.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back]
    : front;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * The address a socket counts against for the per-address cap. X-Forwarded-For is trusted only
 * from loopback (a reverse proxy on the same host), and only its rightmost entry, which that
 * proxy wrote. IPv6 clients are keyed by their /64, since one host usually owns a whole /64.
 * The result is used only as a map key and is never logged.
 */
export function clientAddress(
  remote: string | undefined,
  forwardedFor: string | string[] | undefined,
): string {
  let ip = normalize(remote ?? "");
  if (ip === "::1" || ip.startsWith("127.")) {
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "");
    const forwarded = normalize(header.split(",").at(-1)?.trim() ?? "");
    if (isIP(forwarded) !== 0) {
      ip = forwarded;
    }
  }
  return isIP(ip) === 6 ? prefix64(ip) : ip;
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
  options: { log: Logger; heartbeatMs?: number; limits?: Partial<typeof LIMITS> },
): { close(): void } {
  const { log } = options;
  const limits = { ...LIMITS, ...options.limits };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const peers = new Map<WebSocket, Peer>();
  const hosts = new Map<string, WebSocket>();
  const guests = new Map<string, WebSocket>();
  /** Open sockets per client address. */
  const perAddress = new Map<string, number>();

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
    if (peers.size >= limits.sockets) {
      log("upgrade-rejected", { reason: "full" });
      rejectUpgrade(socket, 503);
      return;
    }
    const address = clientAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"]);
    if ((perAddress.get(address) ?? 0) >= limits.socketsPerAddress) {
      log("upgrade-rejected", { reason: "address" });
      rejectUpgrade(socket, 429);
      return;
    }
    // Without verifyClient, ws calls back synchronously, so the counts above are current.
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws, address));
  }

  function connect(socket: WebSocket, address: string): void {
    const peer: Peer = {
      role: "none",
      hosted: new Set(),
      joined: undefined,
      attempt: undefined,
      alive: true,
      messages: 0,
      address,
    };
    peers.set(socket, peer);
    perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      // ws still emits messages that arrive after close(); they are dropped unread.
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      peer.messages += 1;
      if (peer.messages > limits.messagesPerWindow) {
        log("rate-limited");
        socket.close(POLICY_VIOLATION);
        return;
      }
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
        join(socket, peer, message.link, message.attempt);
        return;
      case "relay":
        relay(socket, peer, message.link, message.data);
        return;
      case "refuse":
        refuse(socket, peer, message.link, message.attempt, message.reason);
        return;
      case "path":
        reportPath(socket, peer, message.link, message.path);
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
      guestPeer.attempt = undefined;
    }
    log("host-gone", { link: short(link) });
    send(guest, { t: "host-gone" });
  }

  function join(socket: WebSocket, peer: Peer, link: string, attempt: string): void {
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
    peer.attempt = attempt;
    log("joined", { link: short(link) });
    send(hostSocket, { t: "joined", link, attempt });
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
    // The other end left while this message was in flight, or is not reading what it is sent.
    if (!target || target.bufferedAmount > limits.bufferedBytes) {
      log("relay-dropped", { link: short(link), bytes: data.length });
      return;
    }
    log("relay", { link: short(link), bytes: data.length });
    send(target, { t: "relay", link, data });
  }

  function refuse(
    socket: WebSocket,
    peer: Peer,
    link: string,
    attempt: string,
    reason: RefuseReason,
  ): void {
    if (!peer.hosted.has(link)) {
      error(socket, "not-on-link");
      return;
    }
    const guest = guests.get(link);
    const guestPeer = guest && peers.get(guest);
    // A late refusal of an earlier attempt must not turn away the guest that joined since.
    if (!guest || guestPeer?.attempt !== attempt) {
      return;
    }
    guests.delete(link);
    if (guestPeer) {
      guestPeer.joined = undefined;
      guestPeer.attempt = undefined;
    }
    log("refused", { link: short(link), reason });
    send(guest, { t: "refused", reason });
  }

  /**
   * Logs how a sender's connection ended up. Only the path is logged, never the link, so the
   * line cannot be tied to a transfer. Each report is one line; the server keeps no counts.
   */
  function reportPath(socket: WebSocket, peer: Peer, link: string, path: ConnectionPath): void {
    if (!peer.hosted.has(link)) {
      error(socket, "not-on-link");
      return;
    }
    // ponytail: no dedup, the sender reports once per connection; a repeat is one more line.
    log("path", { path });
  }

  function disconnect(socket: WebSocket, peer: Peer): void {
    peers.delete(socket);
    const count = (perAddress.get(peer.address) ?? 1) - 1;
    if (count > 0) {
      perAddress.set(peer.address, count);
    } else {
      perAddress.delete(peer.address);
    }
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
      peer.attempt = undefined;
      log("left", { link: short(link) });
      const hostSocket = hosts.get(link);
      if (hostSocket) {
        send(hostSocket, { t: "left", link });
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const [socket, peer] of peers) {
      peer.messages = 0;
      if (!peer.alive) {
        socket.terminate();
        continue;
      }
      peer.alive = false;
      socket.ping();
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
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
