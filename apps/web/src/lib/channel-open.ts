/**
 * Chromium's RTCDataChannel keeps its own copy of the channel state and applies
 * each change in a task posted from the WebRTC thread, with the state read when
 * the task was posted and no check that it moves forward. A stale "connecting"
 * can land after "open" fired, so readyState reads "connecting" for a moment and
 * then "open" again, which fires a second open event. send() throws in that gap
 * (FID-385), so senders wait it out here instead of failing the transfer.
 */

/** How long a channel that opened may read "connecting" before it counts as lost. */
const REOPEN_TIMEOUT_MS = 5000;

type OpenChannel = Pick<RTCDataChannel, "readyState" | "addEventListener" | "removeEventListener">;

/**
 * Returns undefined while `channel` is open, so the caller can go on
 * synchronously. While it reads "connecting" it returns a promise that resolves
 * on the channel's next open event and rejects when the channel closes, `signal`
 * aborts or `timeoutMs` passes while waiting. It throws, without returning a
 * promise, when the channel is already closing or closed or `signal` has
 * already aborted.
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
 * "connecting" (see above). While the channel is open it sends synchronously.
 * Frames keep their order only while each send is awaited before the next one
 * starts: a frame that waited goes out in a microtask after the open event.
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
