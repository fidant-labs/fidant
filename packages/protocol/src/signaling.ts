// Signaling messages exchanged over the /signal WebSocket.
//
// The server only ever sees link IDs, whether the sender allows our TURN relay,
// and opaque base64url blobs, except in `email`, which carries the secret of a
// link the server emails for the sender (decision 0012). SDP and ICE candidates
// are encrypted in the browser before they are relayed, and no other message
// carries a key.

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

/** The longest email address SMTP allows. */
export const MAX_ADDRESS = 254;
/** Longest sender name META and `email` accept, in UTF-16 code units like `maxLength`. */
export const MAX_FROM_LENGTH = 100;

/** Starts the fragment of the link Fidant emails, `e.<mark>.<secret>`, so the recipient page knows it. */
export const EMAILED_LINK_MARKER = "e.";

const ICE_URL_PATTERN = /^(turn|turns|stun):/;

// The HTML spec's valid email address, so it matches what <input type="email"> accepts.
const ADDRESS_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** A link's secret: 32 random bytes as base64url, without padding, so its last 2 bits are zero. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const CODE_PATTERN = /^[0-9]{6}$/;

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

/** The languages an emailed notice or code can be written in. */
export const LANGS = ["sv", "en"] as const;

/** What the server tells a sender about a link it emails. */
export const EMAIL_STATUSES = ["sent", "failed", "limit", "verifying", "verified"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** What the server answers a recipient that asks for or enters an emailed code. */
export const CODE_RESULTS = [
  "sent",
  "wait",
  "limit",
  "failed",
  "wrong",
  "expired",
  "tries",
] as const;
export type CodeResult = (typeof CODE_RESULTS)[number];

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
export type LogReason = RefuseReason | UpgradeRejectReason | CodeResult | "unverified";

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
  | "left"
  | "email"
  | "code"
  | "verified";

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
 * not secret, but the server never logs it. `token`, the answer to a right code, is never logged.
 */
export type JoinMessage = { t: "join"; link: string; attempt: string; token?: string };
/** An encrypted payload for the other end of a link. */
export type RelayMessage = { t: "relay"; link: string; data: string };
/** The sender turns away the recipient on a link, if it is still the one from `attempt`. */
export type RefuseMessage = { t: "refuse"; link: string; attempt: string; reason: RefuseReason };

/** The sender reports how its connection on a link ended up. */
export type PathMessage = { t: "path"; link: string; path: ConnectionPath };

/**
 * The sender asks the server to email one of its links. Once per link, never folded into `host`.
 * The server builds the link from its own origin, `link` and `secret`.
 */
export type EmailMessage = {
  t: "email";
  link: string;
  to: string;
  secret: string;
  from: string;
  lang: (typeof LANGS)[number];
};
/**
 * A recipient asks whether a link needs an emailed code. `mark` is the value from the emailed
 * link's fragment, which the server picked when it emailed the link; it is never logged.
 */
export type GateMessage = { t: "gate"; link: string; mark?: string };
/** A recipient asks for a code by email. */
export type SendCodeMessage = { t: "send-code"; link: string; mark?: string };
/** A recipient enters the code it got by email. */
export type CodeMessage = { t: "code"; link: string; code: string; mark?: string };

export type ClientMessage =
  | HostMessage
  | JoinMessage
  | RelayMessage
  | RefuseMessage
  | PathMessage
  | EmailMessage
  | GateMessage
  | SendCodeMessage
  | CodeMessage;

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

/** The first message on every socket: whether this server can email links. */
export type HelloMessage = { t: "hello"; mail: boolean };
/**
 * Tells the sender what became of a link it asked the server to email. Once the server took the
 * request, `mark` is the value it put in the emailed link's fragment; it is never logged.
 */
export type EmailStatusMessage = { t: "email"; link: string; status: EmailStatus; mark?: string };
/** Tells a recipient where a link's code goes: a masked address, or "" if it needs no code. */
export type GateAnswerMessage = { t: "gate"; link: string; to: string };
/** Answers a recipient's `send-code` or `code`. */
export type CodeResultMessage = { t: "code"; link: string; result: CodeResult };
/** Gives a recipient that entered the right code its token for `join`. */
export type TokenMessage = { t: "token"; link: string; token: string };

export type ServerMessage =
  | JoinedMessage
  | LeftMessage
  | RelayMessage
  | RefusedMessage
  | HostGoneMessage
  | ErrorMessage
  | HelloMessage
  | EmailStatusMessage
  | GateAnswerMessage
  | CodeResultMessage
  | TokenMessage;

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

/** The fragment, without `#`, of the link Fidant emails. `mark` is the server's value for it. */
export function emailedFragment(mark: string, secret: string): string {
  return `${EMAILED_LINK_MARKER}${mark}.${secret}`;
}

/** Reads the mark from a fragment `emailedFragment` made. The caller checks the secret. */
export function parseEmailedFragment(
  fragment: string,
): { mark: string; secret: string } | undefined {
  if (!fragment.startsWith(EMAILED_LINK_MARKER)) {
    return undefined;
  }
  const rest = fragment.slice(EMAILED_LINK_MARKER.length);
  const dot = rest.indexOf(".");
  const mark = rest.slice(0, dot);
  return dot >= 0 && isLinkId(mark) ? { mark, secret: rest.slice(dot + 1) } : undefined;
}

/** A message's optional `mark`: `{}` without one, undefined if it is malformed or `keys` do not match. */
function markOf(value: Fields, keys: readonly string[]): { mark?: string } | undefined {
  const { mark } = value;
  if (mark === undefined) {
    return hasKeys(value, keys) ? {} : undefined;
  }
  return hasKeys(value, [...keys, "mark"]) && isLinkId(mark) ? { mark } : undefined;
}

/** Whether `value` is a valid email address by the HTML spec, at most MAX_ADDRESS long. */
export function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ADDRESS && ADDRESS_PATTERN.test(value);
}

/** `a***@example.se`: always three stars after the first character, so the length stays hidden. */
export function maskAddress(address: string): string {
  return `${address.slice(0, 1)}***${address.slice(address.indexOf("@"))}`;
}

function isMaskedAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.slice(1, 5) === "***@" &&
    isAddress(value.slice(0, 1) + value.slice(4))
  );
}

/**
 * C0 and C1 control characters (U+0000–001F, U+007F–009F), the line and paragraph
 * separators (U+2028, U+2029), every Unicode Bidi_Control character (U+061C, U+200E,
 * U+200F, U+202A–202E, U+2066–2069), the fillers that always draw as blank (U+115F, U+1160,
 * U+2800, U+3164, U+FFA0) and three or more spaces of any kind (Unicode Zs), whether
 * next to each other or with invisible characters (Default_Ignorable_Code_Point, such as
 * U+200B, U+2060, U+00AD, U+FEFF) between them. A run of invisible characters with no
 * spaces is allowed: it takes no width, so it hides nothing.
 */
const FORBIDDEN_CHARACTERS =
  /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\u115F\u1160\u2800\u3164\uFFA0]|(?:\p{Zs}\p{Default_Ignorable_Code_Point}*){3,}/u;

/**
 * Whether a file name, type or sender name contains characters META refuses: control
 * characters and separators, which could break how the name is shown or saved or start
 * a new line in a mail; direction controls, which can make a name ending in ".exe"
 * display as if it ended in ".pdf"; and blank fillers or long runs of spaces, which can
 * push ".exe" out of sight after a name that looks like it ends in ".pdf". A single space
 * of any kind stays allowed: macOS puts U+202F in screenshot names. The sender checks it
 * when a file is chosen; decodeMeta and `email` reject such names.
 */
export function hasForbiddenCharacters(text: string): boolean {
  return FORBIDDEN_CHARACTERS.test(text);
}

function isFrom(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_FROM_LENGTH && !hasForbiddenCharacters(value)
  );
}

function isSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET_PATTERN.test(value);
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

function isLang(value: unknown): value is (typeof LANGS)[number] {
  return (LANGS as readonly unknown[]).includes(value);
}

function isEmailStatus(value: unknown): value is EmailStatus {
  return (EMAIL_STATUSES as readonly unknown[]).includes(value);
}

function isCodeResult(value: unknown): value is CodeResult {
  return (CODE_RESULTS as readonly unknown[]).includes(value);
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
    case "join": {
      const { link, attempt, token } = value;
      const keys =
        token === undefined ? ["t", "link", "attempt"] : ["t", "link", "attempt", "token"];
      if (!hasKeys(value, keys) || !isLinkId(link) || !isLinkId(attempt)) {
        return undefined;
      }
      if (token === undefined) {
        return { t: "join", link, attempt };
      }
      return isLinkId(token) ? { t: "join", link, attempt, token } : undefined;
    }
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
    case "email": {
      if (!hasKeys(value, ["t", "link", "to", "secret", "from", "lang"])) {
        return undefined;
      }
      const { link, to, secret, from, lang } = value;
      if (
        !isLinkId(link) ||
        !isAddress(to) ||
        !isSecret(secret) ||
        !isFrom(from) ||
        !isLang(lang)
      ) {
        return undefined;
      }
      return { t: "email", link, to, secret, from, lang };
    }
    case "gate":
    case "send-code": {
      const mark = markOf(value, ["t", "link"]);
      if (!mark || !isLinkId(value.link)) {
        return undefined;
      }
      return { t: value.t, link: value.link, ...mark };
    }
    case "code": {
      const mark = markOf(value, ["t", "link", "code"]);
      if (!mark || !isLinkId(value.link)) {
        return undefined;
      }
      if (typeof value.code !== "string" || !CODE_PATTERN.test(value.code)) {
        return undefined;
      }
      return { t: "code", link: value.link, code: value.code, ...mark };
    }
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
    case "hello":
      if (!hasKeys(value, ["t", "mail"]) || typeof value.mail !== "boolean") {
        return undefined;
      }
      return { t: "hello", mail: value.mail };
    case "email": {
      const mark = markOf(value, ["t", "link", "status"]);
      if (!mark || !isLinkId(value.link) || !isEmailStatus(value.status)) {
        return undefined;
      }
      return { t: "email", link: value.link, status: value.status, ...mark };
    }
    case "gate":
      if (!hasKeys(value, ["t", "link", "to"]) || !isLinkId(value.link)) {
        return undefined;
      }
      if (value.to !== "" && !isMaskedAddress(value.to)) {
        return undefined;
      }
      return { t: "gate", link: value.link, to: value.to };
    case "code":
      if (!hasKeys(value, ["t", "link", "result"])) {
        return undefined;
      }
      if (!isLinkId(value.link) || !isCodeResult(value.result)) {
        return undefined;
      }
      return { t: "code", link: value.link, result: value.result };
    case "token":
      if (!hasKeys(value, ["t", "link", "token"])) {
        return undefined;
      }
      if (!isLinkId(value.link) || !isLinkId(value.token)) {
        return undefined;
      }
      return { t: "token", link: value.link, token: value.token };
    default:
      return undefined;
  }
}
