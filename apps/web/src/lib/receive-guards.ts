import type { RefusedReason } from "@fidant/protocol";

// The recipient page's answers to a repeated `join` (decision 0031). Once the data channel is
// open, these keep the server's answers from ending a transfer that goes on without it.

/** The same `join` again after the peer stalled: never after `host-gone`, which would pair with the sender's new socket. */
export function joinsAgain(attempt: { current: boolean; hostGone: boolean; aborted: boolean }) {
  return attempt.current && !attempt.hostGone && !attempt.aborted;
}

/** A `gate` once the channel is open can only answer a repeated `join`. */
export function takesGate(attempt: { current: boolean; ourLink: boolean; channelOpen: boolean }) {
  return attempt.current && attempt.ourLink && !attempt.channelOpen;
}

/**
 * Once the channel is open, `busy` answers a repeated `join` (the server's cap, or an older
 * sender's page), and so does any refusal after `host-gone`. Other refusals still end the attempt.
 */
export function takesRefusal(
  attempt: { channelOpen: boolean; hostGone: boolean },
  reason: RefusedReason,
) {
  return !(attempt.channelOpen && (reason === "busy" || attempt.hostGone));
}

/** A `joined` for this attempt pairs a new peer, or, once there is one, goes to it as the answer to a repeated `join`. */
export function joinedAction(attempt: {
  current: boolean;
  ours: boolean;
  hasPeer: boolean;
}): "ignore" | "rejoin" | "pair" {
  if (!attempt.current || !attempt.ours) {
    return "ignore";
  }
  return attempt.hasPeer ? "rejoin" : "pair";
}
