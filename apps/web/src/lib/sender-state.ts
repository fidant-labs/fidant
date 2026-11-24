// Per-recipient delivery state on the sender, as a pure reducer.
//
// The sender page owns one SenderState. User actions (add, remove) and
// network events (joined, channel-open, ...) go through `update`, which
// returns the next state and a list of effects for the caller to carry out
// (start a peer connection, refuse a joiner, close a connection).
//
// Transitions per recipient (anything not listed is ignored):
//
// | from                           | event          | to         | effect             |
// |--------------------------------|----------------|------------|--------------------|
// | waiting, declined, failed      | joined         | connecting | start              |
// | connecting, offered, receiving | joined         | (same)     | refuse busy        |
// | delivered                      | joined         | delivered  | refuse used        |
// | connecting                     | channel-open   | offered    |                    |
// | offered                        | accepted       | receiving  |                    |
// | offered                        | declined       | declined   | close              |
// | receiving                      | progress       | receiving  |                    |
// | receiving                      | receipt(true)  | delivered  | close              |
// | receiving                      | receipt(false) | failed     | close              |
// | connecting, offered, receiving | dropped        | waiting    | refuse drop, close |
// | connecting                     | timeout        | waiting    | refuse drop, close |
// | connecting                     | left           | waiting    | close              |
// | connecting                     | server-lost    | waiting    | close              |
// | connecting, offered, receiving | path relay (1) | waiting    | refuse drop, close |
// | (its attempt matches)          | path           | (same)     |                    |
// | (not on the list)              | joined         | -          | refuse unknown     |
//
// (1) For the current attempt, when its `joined` said the sender refused the relay.
//
// Rules:
// - A link is used only once the recipient's RECEIPT matches (delivered).
//   Any later join on it is refused with "used".
// - A join while a transfer is in progress (connecting, offered, receiving)
//   is refused with "busy". The server normally refuses a second joiner
//   itself; the sender is the authority either way.
// - A join for a link ID not on the list is refused with "unknown".
// - `left` (the server says the recipient's signaling socket closed) ends an
//   attempt only while it is still connecting. Once the data channel is open
//   the socket no longer matters: the recipient closes it right after sending
//   RECEIPT or DECLINE, so `left` can arrive before that frame is decrypted,
//   and a recipient whose socket drops mid-transfer can still finish. From
//   then on only the peer closing (dropped), a receipt or a decline end it.
// - `dropped` means the sender's peer for the link failed or closed before
//   delivery; `timeout` means its data channel did not open within
//   SETUP_TIMEOUT_MS of the join. Either way the server may still have the
//   joiner bound to the link (a peer can fail while the joiner's socket stays
//   open, and someone who knows a link ID but not its secret can join and then
//   stay silent or send garbage). So the sender also refuses the joiner, which
//   makes the server unbind it and frees the link for the real recipient. The
//   reason is "drop", which tells the recipient the attempt failed and the
//   link still works (see ReceivePage). "busy" is only for a join while a
//   transfer is in progress; the server also sends it for a second joiner.
//   If the joiner already left, the server ignores the refusal. `left` needs
//   no refusal: the joiner is gone.
// - `server-lost` (our own signaling socket dropped) does the same for every
//   connecting recipient, since the server forgot their joins with the socket.
//   Unlike `left` it never sets `noRelay`: the server dropped, not the relay.
// - Every join carries the recipient's attempt ID, and every refusal names the
//   attempt it refuses. A join is refused with its own attempt; `dropped` and
//   `timeout` refuse the attempt stored when the recipient started
//   connecting. The server ignores a refusal whose attempt is not the bound
//   joiner's, so a late drop of one attempt cannot turn away the next joiner.
// - A drop before delivery returns the recipient to "waiting" with bytesSent
//   0. There is no resume: the next join starts over.
// - A decline marks the recipient "declined", so the sender sees the link was
//   opened and turned down. The link stays usable: the next join starts over,
//   exactly like a join from "waiting".
// - A mismatching RECEIPT marks the recipient "failed" with an error. The link
//   stays usable: the next join clears the error and starts over, exactly like
//   a join from "waiting".
// - Events that do not fit the current status (for example a late progress
//   after a drop) are ignored, as are events for link IDs not on the list.
// - `path` records how the current attempt's connection runs. It applies only
//   to the attempt it names, so a path read late for an earlier attempt is
//   ignored. Anything that resets the recipient clears it; delivery keeps it.
// - Each attempt keeps the `turn` its `joined` carried: whether the sender
//   allowed our relay when the server paired it. An attempt that ends while
//   still connecting (dropped, timeout, left) under `turn` false returns to
//   "waiting" with `noRelay`, because a refused relay is the likely reason it
//   never connected. The next join clears it.
// - A `relay` path for an active attempt under `turn` false ends that attempt
//   like a timeout and sets `noRelay`. This is a best-effort backstop: an
//   honest recipient gets no relay for such a send, and the server is the
//   real enforcement.
// - Removing a recipient is always allowed. If it was mid-transfer, the
//   result includes a close effect.
//
// Effects carry only link IDs, attempt IDs, refusal reasons and the ICE servers from the
// server's `joined`. Recipient
// names never leave this module through an effect, so nothing built from
// effects can send a name to the network.

import { type IceServer, MAX_LINKS, type RefuseReason } from "@sigill/protocol";
import type { Link } from "./link.ts";
import type { OpenPath } from "./peer.ts";

export type RecipientStatus =
  | "waiting"
  | "connecting"
  | "offered"
  | "declined"
  | "receiving"
  | "delivered"
  | "failed";

export type Recipient = {
  readonly name: string;
  readonly linkId: string;
  readonly secret: string;
  readonly url: string;
  readonly status: RecipientStatus;
  readonly bytesSent: number;
  readonly error?: string;
  /** The attempt ID of the join that started the current connection. */
  readonly attempt?: string;
  /** How the current attempt's connection runs, once its data channel opened. */
  readonly path?: OpenPath;
  /** Whether the server's `joined` for the current attempt allowed our relay. */
  readonly turn?: boolean;
  /** The last attempt couldn't connect directly while the sender refused our relay. */
  readonly noRelay?: true;
};

/** Recipients in the order they were added. Link IDs are unique. */
export type SenderState = { readonly recipients: readonly Recipient[] };

export type SenderAction =
  | { type: "add"; link: Link; name: string }
  | { type: "remove"; linkId: string }
  | { type: "joined"; linkId: string; attempt: string; iceServers: IceServer[]; turn: boolean }
  | { type: "channel-open"; linkId: string }
  | { type: "accepted"; linkId: string }
  | { type: "progress"; linkId: string; bytesSent: number }
  | { type: "receipt"; linkId: string; match: boolean }
  | { type: "dropped"; linkId: string }
  | { type: "timeout"; linkId: string }
  | { type: "left"; linkId: string }
  | { type: "server-lost" }
  | { type: "declined"; linkId: string }
  | { type: "path"; linkId: string; attempt: string; path: OpenPath };

export type SenderEffect =
  | { type: "start"; linkId: string; attempt: string; iceServers: IceServer[] }
  | { type: "refuse"; linkId: string; attempt: string; reason: RefuseReason }
  | { type: "close"; linkId: string };

export type SenderUpdate = { state: SenderState; effects: SenderEffect[] };

/** How long after a join the data channel may take to open before the attempt is dropped. */
export const SETUP_TIMEOUT_MS = 20_000;

export const CHECKSUM_MISMATCH = "The recipient's checksum did not match.";

export const initialSenderState: SenderState = { recipients: [] };

const ACTIVE: ReadonlySet<RecipientStatus> = new Set(["connecting", "offered", "receiving"]);

/** True while a peer connection for the recipient is being set up or used. */
export function isActive(recipient: Recipient): boolean {
  return ACTIVE.has(recipient.status);
}

/** True for a relay path on the recipient's active `attempt` whose `joined` refused the relay. */
export function refusesRelay(recipient: Recipient, attempt: string, path: OpenPath): boolean {
  return (
    path === "relay" &&
    recipient.attempt === attempt &&
    recipient.turn === false &&
    isActive(recipient)
  );
}

/** Finds a recipient by link ID. */
export function findRecipient(state: SenderState, linkId: string): Recipient | undefined {
  return state.recipients.find((r) => r.linkId === linkId);
}

/**
 * Every link ID the sender should host: all recipients, including delivered
 * ones, so that the sender can answer a late join on them with "used".
 */
export function hostedLinks(state: SenderState): string[] {
  return state.recipients.map((r) => r.linkId);
}

export function update(state: SenderState, action: SenderAction): SenderUpdate {
  if (action.type === "add") {
    if (state.recipients.length >= MAX_LINKS || findRecipient(state, action.link.linkId)) {
      return { state, effects: [] };
    }
    const { linkId, secret, url } = action.link;
    const recipient: Recipient = {
      name: action.name,
      linkId,
      secret,
      url,
      status: "waiting",
      bytesSent: 0,
    };
    return { state: { recipients: [...state.recipients, recipient] }, effects: [] };
  }
  if (action.type === "server-lost") {
    const effects: SenderEffect[] = [];
    const recipients = state.recipients.map((r) => {
      if (r.status !== "connecting") {
        return r;
      }
      effects.push({ type: "close", linkId: r.linkId });
      return waiting(r, false);
    });
    return { state: effects.length ? { recipients } : state, effects };
  }

  const { linkId } = action;
  const current = findRecipient(state, linkId);
  if (!current) {
    const effects: SenderEffect[] =
      action.type === "joined"
        ? [{ type: "refuse", linkId, attempt: action.attempt, reason: "unknown" }]
        : [];
    return { state, effects };
  }

  switch (action.type) {
    case "remove": {
      const recipients = state.recipients.filter((r) => r.linkId !== linkId);
      const effects: SenderEffect[] = isActive(current) ? [{ type: "close", linkId }] : [];
      return { state: { recipients }, effects };
    }
    case "joined": {
      const { attempt, iceServers, turn } = action;
      if (current.status === "delivered") {
        return { state, effects: [{ type: "refuse", linkId, attempt, reason: "used" }] };
      }
      if (isActive(current)) {
        return { state, effects: [{ type: "refuse", linkId, attempt, reason: "busy" }] };
      }
      return {
        state: replace(state, { ...reset(current, "connecting"), attempt, turn }),
        effects: [{ type: "start", linkId, attempt, iceServers }],
      };
    }
    case "channel-open":
      if (current.status !== "connecting") {
        return { state, effects: [] };
      }
      return { state: replace(state, { ...current, status: "offered" }), effects: [] };
    case "accepted":
      if (current.status !== "offered") {
        return { state, effects: [] };
      }
      return { state: replace(state, { ...current, status: "receiving" }), effects: [] };
    case "progress":
      if (current.status !== "receiving") {
        return { state, effects: [] };
      }
      return {
        state: replace(state, { ...current, bytesSent: Math.max(0, action.bytesSent) }),
        effects: [],
      };
    case "receipt": {
      if (current.status !== "receiving") {
        return { state, effects: [] };
      }
      const next: Recipient = action.match
        ? { ...current, status: "delivered" }
        : { ...reset(current, "failed"), error: CHECKSUM_MISMATCH };
      return { state: replace(state, next), effects: [{ type: "close", linkId }] };
    }
    case "dropped":
    case "timeout":
      if (action.type === "dropped" ? !isActive(current) : current.status !== "connecting") {
        return { state, effects: [] };
      }
      return end(state, current, current.status === "connecting");
    case "left":
      if (current.status !== "connecting") {
        return { state, effects: [] };
      }
      return {
        state: replace(state, waiting(current, true)),
        effects: [{ type: "close", linkId }],
      };
    case "declined":
      if (current.status !== "offered") {
        return { state, effects: [] };
      }
      return {
        state: replace(state, reset(current, "declined")),
        effects: [{ type: "close", linkId }],
      };
    case "path":
      if (current.attempt !== action.attempt) {
        return { state, effects: [] };
      }
      if (refusesRelay(current, action.attempt, action.path)) {
        return end(state, current, true);
      }
      return { state: replace(state, { ...current, path: action.path }), effects: [] };
  }
}

/** Ends the current attempt: back to waiting, its joiner refused and its connection closed. */
function end(state: SenderState, current: Recipient, blocked: boolean): SenderUpdate {
  const { linkId, attempt } = current;
  return {
    state: replace(state, waiting(current, blocked)),
    effects: [
      // An active recipient always has the attempt its join stored.
      ...(attempt === undefined
        ? []
        : [{ type: "refuse", linkId, attempt, reason: "drop" } as const]),
      { type: "close", linkId },
    ],
  };
}

/** Back to waiting, with `noRelay` if the attempt was `blocked` while the sender refused our relay. */
function waiting(recipient: Recipient, blocked: boolean): Recipient {
  const next = reset(recipient, "waiting");
  return blocked && recipient.turn === false ? { ...next, noRelay: true } : next;
}

/** The recipient with a new status, no progress, error, attempt, path, relay choice or noRelay. */
function reset(recipient: Recipient, status: RecipientStatus): Recipient {
  const {
    error: _error,
    attempt: _attempt,
    path: _path,
    turn: _turn,
    noRelay: _noRelay,
    ...rest
  } = recipient;
  return { ...rest, status, bytesSent: 0 };
}

function replace(state: SenderState, recipient: Recipient): SenderState {
  return {
    recipients: state.recipients.map((r) => (r.linkId === recipient.linkId ? recipient : r)),
  };
}
