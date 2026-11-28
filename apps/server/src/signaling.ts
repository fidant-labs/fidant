// Relays signaling messages between a sender's browser (the host) and its
// recipients' browsers (guests) over the /signal WebSocket.
//
// The server only learns link IDs, whether the sender allows our TURN relay,
// and opaque base64url blobs, except from `email` (decision 0012). It knows
// which link IDs are hosted and binds at most one guest to each, but it keeps
// no record of used links: the sender decides that and refuses with `refuse`.
// Relay payloads are never inspected or logged.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { type BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
  type ClientMessage,
  type CodeResult,
  type ConnectionPath,
  type EmailMessage,
  type ErrorCode,
  emailedFragment,
  type IceServer,
  type LogEvent,
  type LogFields,
  maskAddress,
  parseClientMessage,
  type RefusedReason,
  type RefuseReason,
  SERVICE_RESTART,
  type ServerMessage,
  STARTING_MS,
} from "@fidant/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { Mailer } from "./mail.ts";

export type Logger = (event: LogEvent, fields?: LogFields) => void;

export const SIGNAL_PATH = "/signal";

export const HEARTBEAT_MS = 30_000;

/** How long the server holds a side of an armed attempt after its socket closed (decision 0032). */
export const TAKEOVER_MS = 30_000;

/** Caps on open sockets, incoming messages, bytes queued to a socket, and notices and codes emailed. Tests lower them through the `limits` option. */
export const LIMITS = {
  sockets: 1000,
  socketsPerAddress: 32,
  // ponytail: fixed window reset by the heartbeat, so a socket can send twice this across a
  // window boundary; a token bucket if that burst ever matters.
  /** Messages one socket may send per heartbeat window, counting ones that fail to parse. */
  messagesPerWindow: 1000,
  /**
   * Guests a link pairs per heartbeat window, a bound guest's repeated join included (decision
   * 0031). Each pairing can cost the sender's socket a message (a guest without the secret gets a
   * `refuse`), so without this one guest could spend the sender's message limit (FID-235). An
   * honest recipient pairs at most 5 times to open an attempt (the first join and the page's 4
   * rejoins before the channel opens), then once or twice per route that drops after it: on
   * `disconnected`, and on `failed` while a deadline runs (0031).
   * ponytail: per link, so a guest holding many of one sender's links could still spend the
   * sender's message limit. Each repeated `joined` costs that socket more than one `refuse`: a
   * `restart-offer` plus new candidates, roughly 5-10 messages (an estimate). So recipients
   * connected on roughly 7-20 of one sender's links could push it over `messagesPerWindow`,
   * versus about 100 before. It needs a recipient holding each link's secret. Count pairings per
   * host socket if that ever matters.
   */
  pairingsPerLink: 10,
  /**
   * Bytes queued to a socket beyond which relays to it are dropped, because it is not reading.
   * Past twice this, any message to it ends the socket.
   */
  bufferedBytes: 256 * 1024,
  /**
   * Notices per hour from one socket, from one client (an IPv6 client by its /48 here, since a
   * /48 is a site's usual allocation and holds 65,536 /64s), to one destination address, and
   * from the whole server, which keeps the total well under the mail service's daily quota.
   */
  noticesPerSocket: 20,
  noticesPerClient: 50,
  noticesPerRecipient: 5,
  noticesTotal: 500,
  /**
   * Codes one emailed link may send while hosted, and codes per hour to one destination address,
   * asked for by one client (keyed as for notices) and from the whole server.
   */
  codesPerLink: 5,
  codesPerRecipient: 10,
  codesPerClient: 5,
  codesTotal: 500,
};

/** How long a code works, the least time between two codes for one link, and wrong tries per code. */
const CODE_MS = 10 * 60 * 1000;
const CODE_GAP_MS = 30 * 1000;
const CODE_TRIES = 5;

const HOUR_MS = 60 * 60 * 1000;

/** Keys for the server-wide notice and code counts, beside the HMAC keys (hex) in the same map. */
const ALL_NOTICES = "notices";
const ALL_CODES = "codes";

/** WebSocket close code for a protocol violation. */
const POLICY_VIOLATION = 1008;

type Peer = {
  role: "none" | "host" | "guest";
  /** Links this socket hosts. */
  hosted: Set<string>;
  /** Whether this host allows TURN for its next pairings, from its latest `host`. Never logged. */
  turn: boolean;
  /** The link this socket is bound to as a guest. */
  joined: string | undefined;
  /** The attempt ID the guest joined with. Never logged. */
  attempt: string | undefined;
  alive: boolean;
  /** Messages received in the current heartbeat window. */
  messages: number;
  /** The client address this socket counts against. Never logged. */
  address: string;
  /** When this socket's notices went out, for the hourly cap. */
  notices: number[];
};

/** A side of an armed attempt whose socket closed, kept for a takeover (decision 0032). */
type Hold = {
  /** The closed socket's state, kept so the hold's end can run what its close did before 0032. */
  peer: Peer;
  timer: ReturnType<typeof setTimeout>;
  /** Heartbeats left before the socket would have been ended had it stayed open. */
  beats: number;
};

/**
 * An attempt whose data channel opened, as the sender reported with its `path` (decision 0032).
 * The tokens are never logged.
 */
type Armed = {
  attempt: string;
  hostToken: string;
  guestToken: string;
  /**
   * Whether the bound recipient sent a repeated `join` that the sender has not answered yet:
   * set at each such join, held sender or not, and cleared when the sender next relays to it.
   * A sender's takeover then sends `joined` to both, since the `joined` of that join may have
   * gone to a socket that only looked open.
   */
  asked: boolean;
  /** The sender's relay choice for this attempt, from the socket that hosted it when armed. */
  turn: boolean;
  hostHeld: Hold | undefined;
  guestHeld: Hold | undefined;
};

/** What the server keeps about an emailed link while it is hosted: never its secret or the sender's name. */
type Emailed = {
  to: string;
  lang: EmailMessage["lang"];
  /** The value in the emailed link's fragment, picked for this registration. Never logged. */
  mark: string;
  /** When this link's codes went out. */
  codeTimes: number[];
  /** The latest code, until it is right, expires or runs out of tries. Never logged. */
  code: { value: string; expires: number; tries: number } | undefined;
  /** Tokens for right codes, each good for any join of this link while it is hosted. Never logged. */
  tokens: Set<string>;
};

function recent(times: number[], now: number): number[] {
  return times.filter((time) => now - time < HOUR_MS);
}

function short(link: string): string {
  return link.slice(0, 6);
}

const STATUS_TEXT = {
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

function rejectUpgrade(socket: Duplex, status: keyof typeof STATUS_TEXT): void {
  const text = STATUS_TEXT[status];
  // Node drops its own error listener on 'upgrade' and ws adds one only in handleUpgrade, so a
  // reset here would crash the process. Destroy once flushed: a client that never sends its FIN
  // would otherwise keep the socket open past the caps.
  socket.on("error", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy(),
  );
}

/** Maps an IPv4-mapped IPv6 address to IPv4 and drops an IPv6 zone. */
function normalize(ip: string): string {
  const lower = ip.toLowerCase().split("%")[0] ?? "";
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(lower) ? lower.slice(7) : lower;
}

/** The client a notice or code counts against: an IPv6 client by its /48, others as they are. */
function mailClient(address: string): string {
  return address.endsWith("::/64") ? `${address.split(":").slice(0, 3).join(":")}::/48` : address;
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
 * from loopback (a reverse proxy on the same host) or a peer in `proxies`, and only its rightmost
 * entry, which that proxy wrote. IPv6 clients are keyed by their /64, since one host usually owns
 * a whole /64. The result is used only as a map key and is never logged.
 */
export function clientAddress(
  remote: string | undefined,
  forwardedFor: string | string[] | undefined,
  proxies?: BlockList,
): string {
  let ip = normalize(remote ?? "");
  const family = isIP(ip);
  if (
    ip === "::1" ||
    ip.startsWith("127.") ||
    (proxies !== undefined && family !== 0 && proxies.check(ip, family === 4 ? "ipv4" : "ipv6"))
  ) {
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "");
    const forwarded = normalize(header.split(",").at(-1)?.trim() ?? "");
    if (isIP(forwarded) !== 0) {
      ip = forwarded;
    }
  }
  return isIP(ip) === 6 ? prefix64(ip) : ip;
}

/** True with no Origin header, an Origin whose host matches Host, or one equal to `siteOrigin`. */
function sameOrigin(req: IncomingMessage, siteOrigin: string | undefined): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === siteOrigin) {
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
  options: {
    log: Logger;
    heartbeatMs?: number;
    /** How long after start a join for a link nobody hosts is refused as `starting`, not `unknown`. */
    startingMs?: number | undefined;
    limits?: Partial<typeof LIMITS>;
    /** Minted once per `joined`, so TURN credentials are fresh. Never logged. */
    iceServers?: (turn: boolean) => IceServer[];
    /** Sends notices that link to `${origin}/r/<link>#e.<mark>.<secret>`. Without it, no mail goes out. */
    mail?: { send: Mailer; origin: string } | undefined;
    /** Peers in these ranges are trusted to write X-Forwarded-For, as a loopback peer is. */
    proxies?: BlockList | undefined;
    /** The one other Origin, exactly as browsers send it, that may open a signaling socket. */
    siteOrigin?: string | undefined;
    /** How long a side of an armed attempt is held after its socket closed (`TAKEOVER_MS`). */
    takeoverMs?: number;
  },
): { close(): void } {
  const { log, iceServers = () => [], mail } = options;
  const limits = { ...LIMITS, ...options.limits };
  const startedAt = Date.now();
  const startingMs = options.startingMs ?? STARTING_MS;
  const takeoverMs = options.takeoverMs ?? TAKEOVER_MS;
  /** Sockets the server ended itself, whose armed attempts are not held. */
  const ended = new WeakSet<WebSocket>();
  /** Set once close() runs: the server's memory goes with it, so nothing is held. */
  let stopping = false;

  /** Ends a socket the server gives no second chance: none of its armed attempts is held. */
  function end(socket: WebSocket, code?: number): void {
    ended.add(socket);
    if (code === undefined) {
      socket.terminate();
    } else {
      socket.close(code);
    }
  }

  /**
   * Sends a message, unless the socket has stopped reading: once more than twice the relay limit
   * waits to go out to it, it is ended instead, so replies it provokes can't pile up in memory.
   */
  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (socket.bufferedAmount > 2 * limits.bufferedBytes) {
      end(socket);
      return;
    }
    socket.send(JSON.stringify(message));
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const peers = new Map<WebSocket, Peer>();
  const hosts = new Map<string, WebSocket>();
  const guests = new Map<string, WebSocket>();
  /** Pairings per link in the current heartbeat window. */
  const pairings = new Map<string, number>();
  /** Open sockets per client address. */
  const perAddress = new Map<string, number>();
  const emailed = new Map<string, Emailed>();
  /**
   * Armed attempts by link. While a side is held, `hosts` or `guests` still maps the link to its
   * closed socket, so the checks that guard a taken link keep answering as if it were open.
   */
  const armed = new Map<string, Armed>();
  /** Hosted links that take no more `email`: they had theirs, whatever came of it, or a guest. */
  const noEmail = new Set<string>();
  /** Notice and code times per HMAC of a destination or client address, so no address is kept. */
  const noticeTimes = new Map<string, number[]>();
  const noticeKey = randomBytes(32);
  const hmac = (name: string) => createHmac("sha256", noticeKey).update(name).digest("base64url");

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
    if (!sameOrigin(req, options.siteOrigin)) {
      log("upgrade-rejected", { reason: "origin" });
      rejectUpgrade(socket, 403);
      return;
    }
    if (peers.size >= limits.sockets) {
      log("upgrade-rejected", { reason: "full" });
      rejectUpgrade(socket, 503);
      return;
    }
    const address = clientAddress(
      req.socket.remoteAddress,
      req.headers["x-forwarded-for"],
      options.proxies,
    );
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
      turn: false,
      joined: undefined,
      attempt: undefined,
      alive: true,
      messages: 0,
      address,
      notices: [],
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
        end(socket, POLICY_VIOLATION);
        return;
      }
      const text = isBinary ? undefined : data.toString();
      const message = text === undefined ? undefined : parseClientMessage(text);
      if (!message) {
        log("bad-message", { bytes: text?.length ?? 0 });
        send(socket, { t: "error", code: "bad-message" });
        end(socket, POLICY_VIOLATION);
        return;
      }
      handle(socket, peer, message);
    });
    socket.on("close", (code: number) => disconnect(socket, peer, code));
    // ws emits errors only for frames that break the protocol, so this is a policy close too.
    socket.on("error", () => end(socket));
    send(socket, { t: "hello", mail: mail !== undefined });
  }

  function handle(socket: WebSocket, peer: Peer, message: ClientMessage): void {
    switch (message.t) {
      case "host":
        host(socket, peer, message.links, message.turn);
        return;
      case "join":
        join(socket, peer, message.link, message.attempt, message.token);
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
      case "email":
        void email(socket, peer, message);
        return;
      case "gate":
        gate(socket, peer, message.link, message.mark);
        return;
      case "send-code":
        void sendCode(socket, peer, message.link, message.mark);
        return;
      case "code":
        checkCode(socket, peer, message.link, message.code, message.mark);
        return;
      case "resume":
        resume(socket, peer, message.link, message.attempt, message.token);
        return;
    }
  }

  function error(socket: WebSocket, code: ErrorCode): void {
    log("error", { code });
    send(socket, { t: "error", code });
  }

  function host(socket: WebSocket, peer: Peer, links: string[], turn: boolean): void {
    if (peer.role === "guest") {
      error(socket, "wrong-role");
      return;
    }
    // A link another socket hosts is left out as if it were not in the list, so one taken link
    // (decisions 0006 and 0012) cannot block the sender's others. The error still tells the
    // page, which retries the whole list until the other socket is gone.
    const free = links.filter((link) => !hosts.has(link) || hosts.get(link) === socket);
    if (free.length < links.length) {
      error(socket, "already-hosted");
    }
    const next = new Set(free);
    const changed =
      peer.role !== "host" ||
      next.size !== peer.hosted.size ||
      free.some((link) => !peer.hosted.has(link));
    peer.role = "host";
    peer.turn = turn;
    for (const link of peer.hosted) {
      if (!next.has(link)) {
        unhost(link);
      }
    }
    for (const link of next) {
      hosts.set(link, socket);
      // A sender that took its attempt over sets its relay choice for it from here on (0032).
      const record = armed.get(link);
      if (record) {
        record.turn = turn;
      }
    }
    peer.hosted = next;
    // A re-host with the same links only changes `turn`, which must leave no trace in the log.
    if (changed) {
      log("host", { links: next.size });
    }
  }

  /** Ends a link's armed attempt, if any, and stops its holds. Returns what it was. */
  function disarm(link: string): Armed | undefined {
    const record = armed.get(link);
    if (!record) {
      return undefined;
    }
    armed.delete(link);
    clearTimeout(record.hostHeld?.timer);
    clearTimeout(record.guestHeld?.timer);
    return record;
  }

  /** Stops hosting a link, drops its email state and tells its guest, if any, that the host is gone. */
  function unhost(link: string): void {
    // A held guest leaves as its close did before 0032, so it gets no host-gone.
    const held = disarm(link)?.guestHeld;
    if (held) {
      leave(link, held.peer);
    }
    hosts.delete(link);
    emailed.delete(link);
    noEmail.delete(link);
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

  function join(
    socket: WebSocket,
    peer: Peer,
    link: string,
    attempt: string,
    token: string | undefined,
  ): void {
    if (peer.role === "host") {
      error(socket, "wrong-role");
      return;
    }
    // A bound socket may only repeat its own join, to get fresh ICE servers when its open
    // connection dropped (decision 0031). The repeat passes every check below, as a first join.
    if (peer.joined !== undefined && (peer.joined !== link || peer.attempt !== attempt)) {
      error(socket, "already-joined");
      return;
    }
    peer.role = "guest";
    // An email-bound link takes only a token its binding issued; any other link takes none.
    const state = emailed.get(link);
    if (state ? token === undefined || !state.tokens.has(token) : token !== undefined) {
      log("refused", { link: short(link), reason: "unverified" });
      send(socket, { t: "gate", link, to: "" });
      return;
    }
    const hostSocket = hosts.get(link);
    const paired = pairings.get(link) ?? 0;
    const bound = guests.get(link);
    // The bound recipient asks for a restart (0031). Its sender's side may be held, or its
    // socket may only look open, so a takeover of that side restarts ICE (0032).
    const record = armed.get(link);
    if (record && bound === socket && record.attempt === attempt) {
      record.asked = true;
    }
    // A repeated join that is refused here keeps its binding.
    if (
      !hostSocket ||
      (bound && bound !== socket) ||
      record?.hostHeld ||
      paired >= limits.pairingsPerLink
    ) {
      // Just after a start, senders may not have re-hosted yet, so the link may not be dead.
      const reason: RefusedReason = hostSocket
        ? "busy"
        : Date.now() - startedAt < startingMs
          ? "starting"
          : "unknown";
      log("refused", { link: short(link), reason });
      send(socket, { t: "refused", reason });
      return;
    }
    guests.set(link, socket);
    pairings.set(link, paired + 1);
    noEmail.add(link);
    peer.joined = link;
    peer.attempt = attempt;
    log("joined", { link: short(link) });
    // An armed attempt keeps the relay choice of the socket that hosted it until a new socket
    // that took it over sends `host` (0032).
    const turn = record?.turn ?? peers.get(hostSocket)?.turn ?? false;
    pair(link, attempt, turn, socket, hostSocket);
  }

  /**
   * Sends `joined` to the guest first, so its peer exists before the host's offer can arrive on
   * the same ordered socket.
   */
  function pair(
    link: string,
    attempt: string,
    turn: boolean,
    guest: WebSocket,
    hostSocket: WebSocket,
  ): void {
    const joined: ServerMessage = {
      t: "joined",
      link,
      attempt,
      iceServers: iceServers(turn),
      turn,
    };
    send(guest, joined);
    send(hostSocket, joined);
  }

  /** True when `token` is `expected`, compared in constant time. */
  function sameToken(token: string, expected: string): boolean {
    const [a, b] = [Buffer.from(token), Buffer.from(expected)];
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Lets a new socket take one side of an armed attempt with that side's current token (decision
   * 0032). Every refusal looks the same, so it tells nothing about which check failed.
   */
  function resume(
    socket: WebSocket,
    peer: Peer,
    link: string,
    attempt: string,
    token: string,
  ): void {
    const record = armed.get(link);
    const side =
      record === undefined || record.attempt !== attempt
        ? undefined
        : sameToken(token, record.hostToken)
          ? "host"
          : sameToken(token, record.guestToken)
            ? "guest"
            : undefined;
    const old = side === "host" ? hosts.get(link) : side === "guest" ? guests.get(link) : undefined;
    // The recipient's side takes a socket bound to no link that hosts nothing; the sender's side
    // a socket that is no recipient. The socket that holds the side has nothing to take.
    const allowed =
      side === "guest"
        ? peer.role !== "host" && peer.joined === undefined
        : side === "host" && peer.role !== "guest";
    if (!record || !side || !old || old === socket || !allowed) {
      log("resume-refused", { link: short(link) });
      send(socket, { t: "resume", link, attempt });
      return;
    }
    const oldPeer = peers.get(old);
    const fresh = randomBytes(16).toString("base64url");
    if (side === "host") {
      clearTimeout(record.hostHeld?.timer);
      record.hostHeld = undefined;
      oldPeer?.hosted.delete(link);
      hosts.set(link, socket);
      peer.role = "host";
      peer.hosted.add(link);
      record.hostToken = fresh;
    } else {
      clearTimeout(record.guestHeld?.timer);
      record.guestHeld = undefined;
      if (oldPeer) {
        oldPeer.joined = undefined;
        oldPeer.attempt = undefined;
      }
      guests.set(link, socket);
      peer.role = "guest";
      peer.joined = link;
      peer.attempt = attempt;
      record.guestToken = fresh;
    }
    log("resumed", { link: short(link) });
    send(socket, { t: "resume", link, attempt, token: fresh });
    // The old socket is still open on the server: it is ended as a close with no frame (1006), so
    // its idle links are unhosted and its other armed attempts held, not as one the server ended.
    if (oldPeer) {
      old.terminate();
    }
    // The recipient asked and the sender has not answered: the sender restarts ICE (0031).
    const guest = guests.get(link);
    if (side === "host" && record.asked && guest && peers.has(guest)) {
      record.asked = false;
      const paired = pairings.get(link) ?? 0;
      if (paired >= limits.pairingsPerLink) {
        log("refused", { link: short(link), reason: "busy" });
        send(guest, { t: "refused", reason: "busy" });
        return;
      }
      pairings.set(link, paired + 1);
      log("joined", { link: short(link) });
      pair(link, attempt, record.turn, guest, socket);
    }
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
    // The other end left while this message was in flight, its side is held (0032), or it is
    // not reading what it is sent.
    if (!target || !peers.has(target) || target.bufferedAmount > limits.bufferedBytes) {
      log("relay-dropped", { link: short(link), bytes: data.length });
      return;
    }
    log("relay", { link: short(link), bytes: data.length });
    send(target, { t: "relay", link, data });
    // The sender answered the recipient's last repeated join, so a takeover has nothing to restart.
    const record = peer.hosted.has(link) ? armed.get(link) : undefined;
    if (record) {
      record.asked = false;
    }
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
    const held = armed.get(link)?.guestHeld;
    const guestPeer = guest && (peers.get(guest) ?? held?.peer);
    // A late refusal of an earlier attempt must not turn away the guest that joined since.
    if (!guest || guestPeer?.attempt !== attempt) {
      return;
    }
    // The refusal ends the attempt, and a held guest leaves as its close did before 0032.
    if (held) {
      leave(link, held.peer);
      return;
    }
    disarm(link);
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
    arm(socket, peer, link, path);
  }

  /**
   * Arms the attempt of a link's bound guest once the sender's connection opened, and gives each
   * side its own resume token (decision 0032). A later report for the same attempt changes nothing.
   * The report can come after a short transfer's guest already left, so it needs a bound guest.
   */
  function arm(socket: WebSocket, peer: Peer, link: string, path: ConnectionPath): void {
    const guest = guests.get(link);
    const attempt = guest && peers.get(guest)?.attempt;
    if (path === "failed" || !guest || attempt === undefined || armed.has(link)) {
      return;
    }
    const record: Armed = {
      attempt,
      hostToken: randomBytes(16).toString("base64url"),
      guestToken: randomBytes(16).toString("base64url"),
      asked: false,
      turn: peer.turn,
      hostHeld: undefined,
      guestHeld: undefined,
    };
    armed.set(link, record);
    send(socket, { t: "resume", link, attempt, token: record.hostToken });
    send(guest, { t: "resume", link, attempt, token: record.guestToken });
  }

  /**
   * Holds one side of a link's armed attempt after its socket closed, until a takeover, the
   * attempt's end, `takeoverMs`, or the heartbeat at which the socket would have been ended had
   * it stayed open: the next one if it left a ping unanswered, otherwise the one after.
   */
  function hold(link: string, side: "host" | "guest", peer: Peer): boolean {
    const record = armed.get(link);
    if (!record || (side === "guest" && peer.attempt !== record.attempt)) {
      return false;
    }
    const timer = setTimeout(() => expire(link, side), takeoverMs);
    timer.unref();
    const held: Hold = { peer, timer, beats: peer.alive ? 2 : 1 };
    if (side === "host") {
      record.hostHeld = held;
    } else {
      record.guestHeld = held;
    }
    return true;
  }

  /** Ends a hold without a takeover: that side's close then does what it did before 0032. */
  function expire(link: string, side: "host" | "guest"): void {
    const record = armed.get(link);
    if (side === "host" && record?.hostHeld) {
      unhost(link);
    } else if (side === "guest" && record?.guestHeld) {
      leave(link, record.guestHeld.peer);
    }
  }

  /** Unbinds a link's guest, as its close does, and tells the host it left. */
  function leave(link: string, peer: Peer): void {
    guests.delete(link);
    peer.joined = undefined;
    peer.attempt = undefined;
    log("left", { link: short(link) });
    const hostSocket = hosts.get(link);
    if (hostSocket) {
      send(hostSocket, { t: "left", link });
    }
    // The attempt has ended, so a held sender's side is let go as its close did before 0032.
    if (disarm(link)?.hostHeld) {
      unhost(link);
    }
  }

  /** Emails a hosted link's notice once; the link is bound from before the send until unhosted. */
  async function email(socket: WebSocket, peer: Peer, message: EmailMessage): Promise<void> {
    const { link, to, secret, from, lang } = message;
    if (peer.role === "guest") {
      error(socket, "wrong-role");
      return;
    }
    if (!peer.hosted.has(link)) {
      send(socket, { t: "email", link, status: "failed" });
      return;
    }
    const reply = (status: "sent" | "failed" | "limit", mark?: string) => {
      log(
        "email",
        status === "sent" ? { link: short(link) } : { link: short(link), reason: status },
      );
      send(socket, mark ? { t: "email", link, status, mark } : { t: "email", link, status });
    };
    if (!mail || noEmail.has(link)) {
      reply("failed");
      return;
    }
    noEmail.add(link);
    const now = Date.now();
    const toKey = hmac(`to:${to.toLowerCase()}`);
    const clientKey = hmac(`ip:${mailClient(peer.address)}`);
    const toTimes = recent(noticeTimes.get(toKey) ?? [], now);
    const clientTimes = recent(noticeTimes.get(clientKey) ?? [], now);
    const allTimes = recent(noticeTimes.get(ALL_NOTICES) ?? [], now);
    peer.notices = recent(peer.notices, now);
    if (
      peer.notices.length >= limits.noticesPerSocket ||
      clientTimes.length >= limits.noticesPerClient ||
      toTimes.length >= limits.noticesPerRecipient ||
      allTimes.length >= limits.noticesTotal
    ) {
      reply("limit");
      return;
    }
    peer.notices.push(now);
    noticeTimes.set(toKey, [...toTimes, now]);
    noticeTimes.set(clientKey, [...clientTimes, now]);
    noticeTimes.set(ALL_NOTICES, [...allTimes, now]);
    const mark = randomBytes(16).toString("base64url");
    const state: Emailed = { to, lang, mark, codeTimes: [], code: undefined, tokens: new Set() };
    emailed.set(link, state);
    let sent = true;
    try {
      const url = `${mail.origin}/r/${link}#${emailedFragment(mark, secret)}`;
      await mail.send({ to, lang, from, url });
    } catch {
      // The error may quote the address, so none of it is kept.
      sent = false;
    }
    // The link was unhosted, and perhaps hosted and emailed again, while the mail was out.
    if (emailed.get(link) !== state) {
      return;
    }
    reply(sent ? "sent" : "failed", mark);
  }

  /** Sets a socket's role to guest, or answers `wrong-role` and returns false if it hosts. */
  function asGuest(socket: WebSocket, peer: Peer): boolean {
    if (peer.role === "host") {
      error(socket, "wrong-role");
      return false;
    }
    peer.role = "guest";
    return true;
  }

  function answerCode(socket: WebSocket, link: string, result: CodeResult): void {
    log("code", result === "sent" ? { link: short(link) } : { link: short(link), reason: result });
    send(socket, { t: "code", link, result });
  }

  /** A link's email binding, if `mark` is the one its notice carried; otherwise it acts as plain. */
  function binding(link: string, mark: string | undefined): Emailed | undefined {
    const state = emailed.get(link);
    return state !== undefined && state.mark === mark ? state : undefined;
  }

  /** Tells a recipient where a link's code goes, or "" unless `mark` matches the link's binding. */
  function gate(socket: WebSocket, peer: Peer, link: string, mark: string | undefined): void {
    if (!asGuest(socket, peer)) {
      return;
    }
    const state = binding(link, mark);
    send(socket, { t: "gate", link, to: state ? maskAddress(state.to) : "" });
  }

  /** Emails a fresh code for an emailed link to its address, replacing any earlier code. */
  async function sendCode(
    socket: WebSocket,
    peer: Peer,
    link: string,
    mark: string | undefined,
  ): Promise<void> {
    if (!asGuest(socket, peer)) {
      return;
    }
    const state = binding(link, mark);
    if (!mail || !state) {
      answerCode(socket, link, "failed");
      return;
    }
    const now = Date.now();
    const last = state.codeTimes.at(-1);
    const toKey = hmac(`code:${state.to.toLowerCase()}`);
    const clientKey = hmac(`code-ip:${mailClient(peer.address)}`);
    const toTimes = recent(noticeTimes.get(toKey) ?? [], now);
    const clientTimes = recent(noticeTimes.get(clientKey) ?? [], now);
    const allTimes = recent(noticeTimes.get(ALL_CODES) ?? [], now);
    if (state.codeTimes.length >= limits.codesPerLink) {
      answerCode(socket, link, "limit");
      return;
    }
    // A refused code is never counted, and a client's own cap (codesPerClient) is below the
    // address's (codesPerRecipient), so one client asking for codes on its own links can't lock
    // the address out.
    if (
      (last !== undefined && now - last < CODE_GAP_MS) ||
      clientTimes.length >= limits.codesPerClient ||
      toTimes.length >= limits.codesPerRecipient ||
      allTimes.length >= limits.codesTotal
    ) {
      answerCode(socket, link, "wait");
      return;
    }
    state.codeTimes.push(now);
    noticeTimes.set(toKey, [...toTimes, now]);
    noticeTimes.set(clientKey, [...clientTimes, now]);
    noticeTimes.set(ALL_CODES, [...allTimes, now]);
    const value = String(randomInt(1_000_000)).padStart(6, "0");
    state.code = { value, expires: now + CODE_MS, tries: 0 };
    let sent = true;
    try {
      await mail.send({ to: state.to, lang: state.lang, code: value });
    } catch {
      // The error may quote the address or the code, so none of it is kept.
      sent = false;
    }
    answerCode(socket, link, sent ? "sent" : "failed");
    const hostSocket = hosts.get(link);
    if (sent && hostSocket && emailed.get(link) === state) {
      send(hostSocket, { t: "email", link, status: "verifying" });
    }
  }

  /** Checks a recipient's code; a right one gets a token for this link's joins. */
  function checkCode(
    socket: WebSocket,
    peer: Peer,
    link: string,
    code: string,
    mark: string | undefined,
  ): void {
    if (!asGuest(socket, peer)) {
      return;
    }
    const state = binding(link, mark);
    const current = state?.code;
    if (!state || !current || Date.now() >= current.expires) {
      answerCode(socket, link, "expired");
      return;
    }
    // Both are six ASCII digits: the parser checks the guess, randomInt made the code.
    if (!timingSafeEqual(Buffer.from(code), Buffer.from(current.value))) {
      current.tries += 1;
      if (current.tries >= CODE_TRIES) {
        state.code = undefined;
      }
      answerCode(socket, link, current.tries >= CODE_TRIES ? "tries" : "wrong");
      return;
    }
    state.code = undefined;
    const token = randomBytes(16).toString("base64url");
    state.tokens.add(token);
    log("verified", { link: short(link) });
    send(socket, { t: "token", link, token });
    const hostSocket = hosts.get(link);
    if (hostSocket) {
      send(hostSocket, { t: "email", link, status: "verified" });
    }
  }

  function disconnect(socket: WebSocket, peer: Peer, code: number): void {
    peers.delete(socket);
    const count = (perAddress.get(peer.address) ?? 1) - 1;
    if (count > 0) {
      perAddress.set(peer.address, count);
    } else {
      perAddress.delete(peer.address);
    }
    // Only a socket that closed with no close frame, as when the network goes, is held. A page
    // that left (1000, or 1001 when its tab closes), a socket the server ended and a server that
    // stops hold nothing (decision 0032).
    const held = code === 1006 && !ended.has(socket) && !stopping;
    if (peer.hosted.size > 0) {
      log("host-closed", { links: peer.hosted.size });
      for (const link of peer.hosted) {
        if (!(held && hold(link, "host", peer))) {
          unhost(link);
        }
      }
      peer.hosted.clear();
    }
    const link = peer.joined;
    if (link !== undefined && guests.get(link) === socket && !(held && hold(link, "guest", peer))) {
      leave(link, peer);
    }
  }

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [key, times] of noticeTimes) {
      const kept = recent(times, now);
      if (kept.length > 0) {
        noticeTimes.set(key, kept);
      } else {
        noticeTimes.delete(key);
      }
    }
    pairings.clear();
    for (const [link, record] of armed) {
      for (const side of ["host", "guest"] as const) {
        const held = side === "host" ? record.hostHeld : record.guestHeld;
        if (held) {
          held.beats -= 1;
          if (held.beats <= 0) {
            expire(link, side);
          }
        }
      }
    }
    for (const [socket, peer] of peers) {
      peer.messages = 0;
      if (!peer.alive) {
        end(socket);
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
      stopping = true;
      clearInterval(heartbeat);
      for (const link of armed.keys()) {
        disarm(link);
      }
      server.off("upgrade", onUpgrade);
      for (const socket of peers.keys()) {
        socket.close(SERVICE_RESTART);
      }
      wss.close();
    },
  };
}
