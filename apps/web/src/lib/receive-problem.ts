/**
 * What the recipient shows when the peer dropped or the sender gave up on the attempt. A data
 * channel that never opened means the browsers never reached each other (for example, no direct
 * path and no relay), so that is a failed connection, not a lost one.
 */
export function peerLostProblem(attempt: {
  channelOpen: boolean;
  receiving: boolean;
}): "connect" | "lost" | "lostReceiving" {
  if (!attempt.channelOpen) {
    return "connect";
  }
  return attempt.receiving ? "lostReceiving" : "lost";
}
