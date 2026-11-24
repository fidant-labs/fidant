/**
 * What the recipient shows when the peer dropped, the sender gave up on the attempt or the channel
 * never opened in time. A data channel that never opened means the browsers never reached each
 * other (for example, no direct path and no relay), so that is a failed connection, not a lost
 * one, and when the sender refused our relay that refusal is the likely reason.
 */
export function peerLostProblem(attempt: {
  channelOpen: boolean;
  receiving: boolean;
  relayRefused: boolean;
}): "connect" | "noRelay" | "lost" | "lostReceiving" {
  if (!attempt.channelOpen) {
    return attempt.relayRefused ? "noRelay" : "connect";
  }
  return attempt.receiving ? "lostReceiving" : "lost";
}
