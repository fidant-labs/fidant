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
// | waiting, failed                | joined         | connecting | start              |
// | connecting, offered, receiving | joined         | (same)     | refuse busy        |
// | delivered                      | joined         | delivered  | refuse used        |
// | connecting                     | channel-open   | offered    |                    |
// | offered                        | accepted       | receiving  |                    |
// | offered                        | declined       | waiting    | close              |
// | receiving                      | progress       | receiving  |                    |
// | receiving                      | receipt(true)  | delivered  | close              |
// | receiving                      | receipt(false) | failed     | close              |
// | connecting, offered, receiving | dropped        | waiting    | refuse busy, close |
// | connecting                     | timeout        | waiting    | refuse busy, close |
// | connecting                     | left           | waiting    | close              |
// | (not on the list)              | joined         | -          | refuse unknown     |
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
//   reason is "busy": the protocol has no better one, and an honest recipient
//   that already got signals from the sender treats a refusal after them as a
//   failed attempt, not as "in use" (see ReceivePage). If the joiner already
//   left, the server ignores the refusal. `left` needs no refusal: the joiner
//   is gone.
// - A drop or decline before delivery returns the recipient to "waiting" with
//   bytesSent 0. There is no resume: the next join starts over.
// - A mismatching RECEIPT marks the recipient "failed" with an error. The link
//   stays usable: the next join clears the error and starts over, exactly like
//   a join from "waiting".
// - Events that do not fit the current status (for example a late progress
//   after a drop) are ignored, as are events for link IDs not on the list.
// - Removing a recipient is always allowed. If it was mid-transfer, the
//   result includes a close effect.
//
// Effects carry only link IDs and refusal reasons. Recipient names never
// leave this module through an effect, so nothing built from effects can
// send a name to the network.

import { MAX_LINKS, type RefuseReason } from "@sigill/protocol";
import type { Link } from "./link.ts";

export type RecipientStatus =
  | "waiting"
  | "connecting"
  | "offered"
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
};

/** Recipients in the order they were added. Link IDs are unique. */
export type SenderState = { readonly recipients: readonly Recipient[] };

export type SenderAction =
  | { type: "add"; link: Link; name: string }
  | { type: "remove"; linkId: string }
  | { type: "joined"; linkId: string }
  | { type: "channel-open"; linkId: string }
  | { type: "accepted"; linkId: string }
  | { type: "progress"; linkId: string; bytesSent: number }
  | { type: "receipt"; linkId: string; match: boolean }
  | { type: "dropped"; linkId: string }
  | { type: "timeout"; linkId: string }
  | { type: "left"; linkId: string }
  | { type: "declined"; linkId: string };

export type SenderEffect =
  | { type: "start"; linkId: string }
  | { type: "refuse"; linkId: string; reason: RefuseReason }
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

  const { linkId } = action;
  const current = findRecipient(state, linkId);
  if (!current) {
    const effects: SenderEffect[] =
      action.type === "joined" ? [{ type: "refuse", linkId, reason: "unknown" }] : [];
    return { state, effects };
  }

  switch (action.type) {
    case "remove": {
      const recipients = state.recipients.filter((r) => r.linkId !== linkId);
      const effects: SenderEffect[] = isActive(current) ? [{ type: "close", linkId }] : [];
      return { state: { recipients }, effects };
    }
    case "joined":
      if (current.status === "delivered") {
        return { state, effects: [{ type: "refuse", linkId, reason: "used" }] };
      }
      if (isActive(current)) {
        return { state, effects: [{ type: "refuse", linkId, reason: "busy" }] };
      }
      return {
        state: replace(state, reset(current, "connecting")),
        effects: [{ type: "start", linkId }],
      };
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
      return {
        state: replace(state, reset(current, "waiting")),
        effects: [
          { type: "refuse", linkId, reason: "busy" },
          { type: "close", linkId },
        ],
      };
    case "left":
      if (current.status !== "connecting") {
        return { state, effects: [] };
      }
      return {
        state: replace(state, reset(current, "waiting")),
        effects: [{ type: "close", linkId }],
      };
    case "declined":
      if (current.status !== "offered") {
        return { state, effects: [] };
      }
      return {
        state: replace(state, reset(current, "waiting")),
        effects: [{ type: "close", linkId }],
      };
  }
}

/** The recipient with a new status, no progress and no error. */
function reset(recipient: Recipient, status: RecipientStatus): Recipient {
  const { error: _error, ...rest } = recipient;
  return { ...rest, status, bytesSent: 0 };
}

function replace(state: SenderState, recipient: Recipient): SenderState {
  return {
    recipients: state.recipients.map((r) => (r.linkId === recipient.linkId ? recipient : r)),
  };
}
