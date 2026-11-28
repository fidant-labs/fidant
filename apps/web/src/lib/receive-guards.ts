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

// Taking the recipient's side of an attempt back on a new socket (decision 0033). The server
// gives the page a resume token once the attempt's connection opened, and a new one after each
// takeover. A token is sent at most once: sending it uses it up here, whatever the answer.

/**
 * What the page does when its signaling socket closes: take the attempt back on the next socket
 * while it holds an unsent token, otherwise as before 0033. Once the channel is open, signaling
 * is closed for good, or the attempt ends if its peer already dropped; before it opens, a peer
 * that answered the sender's offer ends the attempt, and otherwise a new attempt starts.
 */
export function onSocketClose(attempt: {
  channelOpen: boolean;
  aborted: boolean;
  answered: boolean;
  hasToken: boolean;
}): "resume" | "close" | "lost" | "restart" {
  if (attempt.channelOpen && attempt.aborted) {
    return "lost";
  }
  if (attempt.hasToken && !attempt.aborted) {
    return "resume";
  }
  if (attempt.channelOpen) {
    return "close";
  }
  return attempt.answered ? "lost" : "restart";
}

/** What a new socket sends first: `resume` with a token, else `gate` or `join`, which never follow an open channel. */
export function onSocketOpen(attempt: {
  channelOpen: boolean;
  hasToken: boolean;
}): "resume" | "ask" | "none" {
  if (attempt.hasToken) {
    return "resume";
  }
  return attempt.channelOpen ? "none" : "ask";
}

/**
 * The server's `resume` for this attempt. One with a token is kept, replacing any earlier one;
 * if it answers this page's `resume` and the peer stalled meanwhile, the repeated `join` that
 * could not go out goes now (0031). One without a token refuses this page's `resume`.
 */
export function resumeAction(attempt: {
  current: boolean;
  ours: boolean;
  token: boolean;
  waiting: boolean;
  stalled: boolean;
}): "ignore" | "keep" | "keep-and-join" | "refused" {
  if (!attempt.current || !attempt.ours) {
    return "ignore";
  }
  if (!attempt.token) {
    return attempt.waiting ? "refused" : "ignore";
  }
  return attempt.waiting && attempt.stalled ? "keep-and-join" : "keep";
}
