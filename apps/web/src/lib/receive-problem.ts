import type { RefuseReason } from "@sigill/protocol";

/**
 * What the recipient shows when the peer dropped, the sender gave up on the attempt or the channel
 * never opened in time. A data channel that never opened means the browsers never reached each
 * other (for example, no direct path and no relay), so that is a failed connection, not a lost
 * one, and when the sender refused our relay that refusal is the likely reason. An attempt that
 * resumes a kept part still holds it before the file arrives again, so Try again can continue it.
 */
export function peerLostProblem(attempt: {
  channelOpen: boolean;
  receiving: boolean;
  resuming?: boolean | undefined;
  relayRefused: boolean;
}): "connect" | "noRelay" | "lost" | "lostReceiving" {
  if (!attempt.channelOpen) {
    return attempt.relayRefused ? "noRelay" : "connect";
  }
  return attempt.receiving || attempt.resuming ? "lostReceiving" : "lost";
}

/** A busy refusal while a part is kept means the sender's page still holds the last connection, so Try again can continue it. */
export function refusedProblem(
  reason: Exclude<RefuseReason, "drop">,
  keeping: boolean,
):
  | { s: "failed"; problem: "senderBusy" }
  | { s: "refused"; problem: Exclude<RefuseReason, "drop"> } {
  return reason === "busy" && keeping
    ? { s: "failed", problem: "senderBusy" }
    : { s: "refused", problem: reason };
}
