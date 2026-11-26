import type { RefuseReason } from "@sigill/protocol";
import type { Messages } from "../i18n/en.ts";

/**
 * What the recipient shows when the peer dropped, the sender gave up on the attempt or the channel
 * never opened in time. A data channel that never opened means the browsers never reached each
 * other (for example, no direct path and no relay), so that is a failed connection, not a lost
 * one, and when the sender refused our relay and the attempt stalled (nothing had connected
 * RELAY_FALLBACK_MS after the answer) that refusal is the likely reason. An attempt that
 * resumes a kept part still holds it before the file arrives again, so Try again can continue it.
 * Once the recipient said the numbers differ, that is what ended the attempt.
 */
export function peerLostProblem(attempt: {
  channelOpen: boolean;
  receiving: boolean;
  resuming?: boolean | undefined;
  saidDiffers?: boolean | undefined;
  relayRefused: boolean;
  stalled?: boolean | undefined;
}): "connect" | "noRelay" | "lost" | "lostReceiving" | "differed" {
  if (attempt.saidDiffers) {
    return "differed";
  }
  if (!attempt.channelOpen) {
    return attempt.relayRefused && attempt.stalled ? "noRelay" : "connect";
  }
  return attempt.receiving || attempt.resuming ? "lostReceiving" : "lost";
}

/** A busy refusal while a part is kept means the sender's page still holds the last connection, so Try again can continue it. */
export function refusedProblem(
  reason: Exclude<RefuseReason, "drop" | "turn">,
  keeping: boolean,
):
  | { s: "failed"; problem: "senderBusy" }
  | { s: "refused"; problem: Exclude<RefuseReason, "drop" | "turn"> } {
  return reason === "busy" && keeping
    ? { s: "failed", problem: "senderBusy" }
    : { s: "refused", problem: reason };
}

/** Whether an attempt may hold a kept part: until it ends, then only on a failure whose Try again continues it, and never once the recipient said the numbers differ. */
export function keepsPart(attempt: {
  ended: boolean;
  saidDiffers?: boolean | undefined;
  ending?: { s: string; problem?: keyof Messages["receive"]["problems"] } | undefined;
}): boolean {
  const { ended, saidDiffers, ending } = attempt;
  return (
    !saidDiffers &&
    (!ended ||
      (ending?.s === "failed" && ending.problem !== "browser" && ending.problem !== "differed"))
  );
}
