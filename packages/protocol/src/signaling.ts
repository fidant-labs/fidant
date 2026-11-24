// Signaling messages exchanged over the /signal WebSocket.
//
// The server only ever sees link IDs, whether the sender allows our TURN relay,
// and opaque base64url blobs. SDP and ICE candidates are encrypted in the
// browser before they are relayed, and keys never appear in these messages.

/** A link ID: 16 random bytes as base64url, without padding. */
export const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** The most links one sender may host at once. */
export const MAX_LINKS = 256;

/** The longest relay payload, in base64url characters. */
export const MAX_RELAY_DATA = 16384;

/** The most ICE servers, URLs per server, and characters per string a `joined` may carry. */
export const MAX_ICE_SERVERS = 4;
export const MAX_ICE_URLS = 4;
export const MAX_ICE_STRING = 256;

const ICE_URL_PATTERN = /^(turn|turns|stun):/;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Why a sender turns a recipient away. `drop`: it gave up on the attempt; the link still works. */
export const REFUSE_REASONS = ["used", "busy", "unknown", "drop"] as const;
export type RefuseReason = (typeof REFUSE_REASONS)[number];

/**
 * How a sender's connection to a recipient ended up: directly, directly through a STUN-found
 * address, through our TURN relay, or not at all.
 */
export const CONNECTION_PATHS = ["direct", "stun", "relay", "failed"] as const;
export type ConnectionPath = (typeof CONNECTION_PATHS)[number];

/** Protocol errors the server reports in an `error` message. */
export const ERROR_CODES = [
  "bad-message",
  "wrong-role",
  "already-hosted",
  "already-joined",
  "not-on-link",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Why the server rejects a WebSocket upgrade. */
export const UPGRADE_REJECT_REASONS = ["path", "origin", "full", "address"] as const;
export type UpgradeRejectReason = (typeof UPGRADE_REJECT_REASONS)[number];

/** Every value the server may write in a log line's `reason` field. */
export type LogReason = RefuseReason | UpgradeRejectReason;

/** The only events a log line may name. */
export type LogEvent =
  | "listening"
  | "upgrade-rejected"
  | "bad-message"
  | "error"
  | "host"
  | "host-gone"
  | "refused"
  | "joined"
  | "relay-dropped"
  | "rate-limited"
  | "relay"
  | "path"
  | "host-closed"
  | "left";

/** The only fields a log line may carry, besides `event`. `link` is cut to its first 6 characters. */
export type LogFields = {
  link?: string;
  links?: number;
  bytes?: number;
  reason?: LogReason;
  code?: ErrorCode;
  port?: number;
  path?: ConnectionPath;
};

/**
 * The sender announces its full list of link IDs, and in `turn` whether recipients who join from
 * now on may use our TURN relay. Re-sent whenever either changes.
 */
export type HostMessage = { t: "host"; links: string[]; turn: boolean };
/**
 * A recipient asks to be connected to the sender hosting a link. `attempt` is a fresh random ID
 * (same shape as a link ID) for this join, so a refusal can name the attempt it refuses. It is
 * not secret, but the server never logs it.
 */
export type JoinMessage = { t: "join"; link: string; attempt: string };
/** An encrypted payload for the other end of a link. */
export type RelayMessage = { t: "relay"; link: string; data: string };
/** The sender turns away the recipient on a link, if it is still the one from `attempt`. */
export type RefuseMessage = { t: "refuse"; link: string; attempt: string; reason: RefuseReason };

/** The sender reports how its connection on a link ended up. */
export type PathMessage = { t: "path"; link: string; path: ConnectionPath };

export type ClientMessage = HostMessage | JoinMessage | RelayMessage | RefuseMessage | PathMessage;

/**
 * A STUN or TURN server for RTCPeerConnection. For TURN, `username` and `credential` are
 * short-lived credentials the server minted; the shared secret behind them never leaves it. An
 * entry without them lists only `stun:` URLs.
 */
export type IceServer =
  | { urls: string[] }
  | { urls: string[]; username: string; credential: string };

/**
 * Pairs a recipient with the sender on a link: sent to the recipient first (its join ack), then
 * to the sender. Both get the ICE servers to use for this one connection, and in `turn` the
 * sender's relay choice as it stood when this recipient joined.
 */
export type JoinedMessage = {
  t: "joined";
  link: string;
  attempt: string;
  iceServers: IceServer[];
  turn: boolean;
};
/** Tells the sender that the recipient on a link went away. */
export type LeftMessage = { t: "left"; link: string };
/** Tells a recipient why it cannot connect. */
export type RefusedMessage = { t: "refused"; reason: RefuseReason };
/** Tells a recipient that the sender went away. */
export type HostGoneMessage = { t: "host-gone" };
/** Reports a protocol error. */
export type ErrorMessage = { t: "error"; code: ErrorCode };

export type ServerMessage =
  | JoinedMessage
  | LeftMessage
  | RelayMessage
  | RefusedMessage
  | HostGoneMessage
  | ErrorMessage;

type Fields = Record<string, unknown>;

function parseObject(raw: string): Fields | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Fields;
}

/** True if the object has exactly these keys. */
function hasKeys(value: Fields, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isLinkId(value: unknown): value is string {
  return typeof value === "string" && LINK_ID_PATTERN.test(value);
}

function isRelayData(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_RELAY_DATA && BASE64URL_PATTERN.test(value)
  );
}

function isRefuseReason(value: unknown): value is RefuseReason {
  return (REFUSE_REASONS as readonly unknown[]).includes(value);
}

function isConnectionPath(value: unknown): value is ConnectionPath {
  return (CONNECTION_PATHS as readonly unknown[]).includes(value);
}

function isErrorCode(value: unknown): value is ErrorCode {
  return (ERROR_CODES as readonly unknown[]).includes(value);
}

function isIceString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ICE_STRING;
}

function parseIceServer(value: unknown): IceServer | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Fields;
  const { urls, username, credential } = fields;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_ICE_URLS) {
    return undefined;
  }
  if (!urls.every((url) => isIceString(url) && ICE_URL_PATTERN.test(url))) {
    return undefined;
  }
  if (hasKeys(fields, ["urls"])) {
    return urls.every((url) => url.startsWith("stun:")) ? { urls: [...urls] } : undefined;
  }
  if (!hasKeys(fields, ["urls", "username", "credential"])) {
    return undefined;
  }
  if (!isIceString(username) || !isIceString(credential)) {
    return undefined;
  }
  return { urls: [...urls], username, credential };
}

/** Parses a list of ICE servers. Returns undefined if any entry is invalid or there are too many. */
export function parseIceServers(value: unknown): IceServer[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ICE_SERVERS) {
    return undefined;
  }
  const servers = value.map(parseIceServer);
  return servers.every((server) => server !== undefined) ? servers : undefined;
}

function parseRelay(value: Fields): RelayMessage | undefined {
  if (!hasKeys(value, ["t", "link", "data"])) {
    return undefined;
  }
  if (!isLinkId(value.link) || !isRelayData(value.data)) {
    return undefined;
  }
  return { t: "relay", link: value.link, data: value.data };
}

/** Parses a message a browser sent to the server. Returns undefined if it is invalid. */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  const value = parseObject(raw);
  if (!value) {
    return undefined;
  }
  switch (value.t) {
    case "host": {
      if (!hasKeys(value, ["t", "links", "turn"]) || typeof value.turn !== "boolean") {
        return undefined;
      }
      const links = value.links;
      if (!Array.isArray(links) || links.length > MAX_LINKS) {
        return undefined;
      }
      if (!links.every(isLinkId)) {
        return undefined;
      }
      if (new Set(links).size !== links.length) {
        return undefined;
      }
      return { t: "host", links: [...links], turn: value.turn };
    }
    case "join":
      if (!hasKeys(value, ["t", "link", "attempt"])) {
        return undefined;
      }
      if (!isLinkId(value.link) || !isLinkId(value.attempt)) {
        return undefined;
      }
      return { t: "join", link: value.link, attempt: value.attempt };
    case "relay":
      return parseRelay(value);
    case "refuse":
      if (!hasKeys(value, ["t", "link", "attempt", "reason"])) {
        return undefined;
      }
      if (!isLinkId(value.link) || !isLinkId(value.attempt) || !isRefuseReason(value.reason)) {
        return undefined;
      }
      return { t: "refuse", link: value.link, attempt: value.attempt, reason: value.reason };
    case "path":
      if (!hasKeys(value, ["t", "link", "path"])) {
        return undefined;
      }
      if (!isLinkId(value.link) || !isConnectionPath(value.path)) {
        return undefined;
      }
      return { t: "path", link: value.link, path: value.path };
    default:
      return undefined;
  }
}

/** Parses a message the server sent to a browser. Returns undefined if it is invalid. */
export function parseServerMessage(raw: string): ServerMessage | undefined {
  const value = parseObject(raw);
  if (!value) {
    return undefined;
  }
  switch (value.t) {
    case "joined": {
      if (
        !hasKeys(value, ["t", "link", "attempt", "iceServers", "turn"]) ||
        typeof value.turn !== "boolean"
      ) {
        return undefined;
      }
      const iceServers = parseIceServers(value.iceServers);
      if (!isLinkId(value.link) || !isLinkId(value.attempt) || !iceServers) {
        return undefined;
      }
      return {
        t: "joined",
        link: value.link,
        attempt: value.attempt,
        iceServers,
        turn: value.turn,
      };
    }
    case "left":
      if (!hasKeys(value, ["t", "link"]) || !isLinkId(value.link)) {
        return undefined;
      }
      return { t: "left", link: value.link };
    case "relay":
      return parseRelay(value);
    case "refused":
      if (!hasKeys(value, ["t", "reason"]) || !isRefuseReason(value.reason)) {
        return undefined;
      }
      return { t: "refused", reason: value.reason };
    case "host-gone":
      if (!hasKeys(value, ["t"])) {
        return undefined;
      }
      return { t: "host-gone" };
    case "error":
      if (!hasKeys(value, ["t", "code"]) || !isErrorCode(value.code)) {
        return undefined;
      }
      return { t: "error", code: value.code };
    default:
      return undefined;
  }
}
