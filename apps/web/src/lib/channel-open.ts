/**
 * Chromium's RTCDataChannel keeps its own copy of the channel state and applies
 * each change in a task posted from the WebRTC thread, with the state read when
 * the task was posted and no check that it moves forward. A stale "connecting"
 * can land after "open" fired, so readyState reads "connecting" for a moment and
 * then "open" again, which fires a second open event. send() throws in that gap
 * (FID-385), so senders wait it out here instead of failing the transfer.
 */

/** How long a channel that opened may read "connecting" before it counts as lost. */
export const REOPEN_TIMEOUT_MS = 5000;

export type OpenChannel = Pick<
  RTCDataChannel,
  "readyState" | "addEventListener" | "removeEventListener"
>;

/**
 * Resolves at once while `channel` is open, and after its next open event while
 * it reads "connecting". Rejects when it is closing or closed, closes while
 * waiting, `signal` aborts or `timeoutMs` passes.
 */
export function whenOpen(
  channel: OpenChannel,
  signal: AbortSignal,
  timeoutMs = REOPEN_TIMEOUT_MS,
): Promise<void> | undefined {
  signal.throwIfAborted();
  if (channel.readyState === "open") {
    return undefined;
  }
  if (channel.readyState !== "connecting") {
    throw new Error("data channel is not open");
  }
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      done();
      resolve();
    };
    const onClose = () => {
      done();
      reject(new Error("data channel is not open"));
    };
    const onAbort = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("data channel stayed connecting after it opened"));
    }, timeoutMs);
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    signal.addEventListener("abort", onAbort);
  });
}

/**
 * Sends `frame` on `channel`, waiting first while the channel reads
 * "connecting" (see above). While the channel is open it sends synchronously,
 * so frames go out in call order.
 */
export async function sendWhenOpen(
  channel: OpenChannel & { send(data: Uint8Array<ArrayBuffer>): void },
  frame: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<void> {
  const waiting = whenOpen(channel, signal);
  if (waiting) {
    await waiting;
    signal.throwIfAborted();
  }
  channel.send(frame);
}
