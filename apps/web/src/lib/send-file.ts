// Sending one file to one recipient over an open data channel, and hashing
// the file once when it is chosen.
//
// Frames on the channel (see frames.ts):
//
//   sender → recipient   INIT(transferId)                     plaintext
//   sender → recipient   META{name, size, type, chunkSize}    encrypted
//   recipient → sender   ACCEPT  (or DECLINE: stop here)
//   sender → recipient   CHUNK × n                            backpressured
//   sender → recipient   END(sha256, size)
//   recipient → sender   RECEIPT(sha256 the recipient computed)
//
// Every attempt gets a fresh transferId, so a restart after a drop never
// reuses a (file key, nonce) pair. Encryption happens in one sequential loop
// and incoming frames are decrypted through one promise queue, because frame
// writers and readers assign sequence numbers per call.
//
// No DOM or UI here beyond the data channel API, so tests can drive it with a
// fake channel. The file name only travels inside the encrypted META frame.

import {
  encodeEnd,
  encodeInit,
  encodeMeta,
  type Frame,
  FrameReader,
  FrameWriter,
  MAX_CHUNK_BYTES,
  RecipientKind,
  SenderKind,
} from "./frames.ts";
import { createTransferId, deriveFileKey } from "./keys.ts";
import { assertFrameFits } from "./peer.ts";
import { Sha256 } from "./sha256.ts";

/** The file is hashed in slices of this size, yielding to the page in between. */
export const HASH_SLICE_BYTES = 4 * 1024 * 1024;
/** Sending pauses while more than this many bytes wait in the channel's buffer... */
export const BUFFER_HIGH_BYTES = 4 * 1024 * 1024;
/** ...and resumes once the buffer falls to this. */
export const BUFFER_LOW_BYTES = 1024 * 1024;
/** Progress is reported at most this often. */
export const PROGRESS_INTERVAL_MS = 100;

/** The part of RTCDataChannel that sending uses, so tests can pass a fake. */
export type FrameChannel = Pick<
  RTCDataChannel,
  | "bufferedAmount"
  | "bufferedAmountLowThreshold"
  | "readyState"
  | "addEventListener"
  | "removeEventListener"
> & { send(data: Uint8Array<ArrayBuffer>): void };

export type SendFileOptions = {
  channel: FrameChannel;
  /** From PeerOpenInfo. Every frame is checked against it. */
  maxMessageSize: number;
  file: Blob & { readonly name: string; readonly type: string };
  /** The recipient's link secret. */
  secret: string;
  /** The file's SHA-256 from hashFile. Awaited before END. */
  sha256: Promise<Uint8Array>;
  /** Aborting stops the transfer; sendFile then rejects. */
  signal: AbortSignal;
  /** The recipient accepted; streaming starts. */
  onAccepted(): void;
  /** File bytes that have left the channel's buffer so far. Throttled. */
  onProgress(bytesSent: number): void;
};

export type SendResult =
  /** The recipient declined the offer. */
  | { type: "declined" }
  /** The recipient sent a RECEIPT; `match` says whether its checksum equals ours. */
  | { type: "receipt"; match: boolean };

/**
 * Sends `file` to one recipient. Resolves when the recipient declines or sends
 * a RECEIPT. Rejects if the channel closes, `signal` aborts, a frame fails to
 * decrypt, or the recipient sends something out of order.
 */
export async function sendFile(options: SendFileOptions): Promise<SendResult> {
  const { channel, maxMessageSize, file, secret } = options;
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const onClose = () => abort.abort(new Error("data channel closed"));
  channel.addEventListener("close", onClose);
  const inbox = createInbox(channel, signal);
  let progressTimer: ReturnType<typeof setInterval> | undefined;

  try {
    if (channel.readyState !== "open") throw new Error("data channel is not open");
    channel.bufferedAmountLowThreshold = BUFFER_LOW_BYTES;

    const send = (frame: Uint8Array<ArrayBuffer>) => {
      signal.throwIfAborted();
      assertFrameFits(maxMessageSize, frame.byteLength);
      channel.send(frame);
    };

    const transferId = createTransferId();
    send(encodeInit(transferId));
    const key = await abortable(deriveFileKey(secret, transferId), signal);
    const writer = new FrameWriter(key, "s");
    inbox.start(new FrameReader(key, "r"));

    const chunkSize = Math.min(MAX_CHUNK_BYTES, maxMessageSize - 64);
    if (chunkSize < 1) throw new Error("max message size too small");
    const meta = { name: file.name, size: file.size, type: file.type, chunkSize };
    send(await writer.encrypt(SenderKind.META, encodeMeta(meta)));

    const answer = await inbox.next();
    if (answer.kind === RecipientKind.DECLINE) return { type: "declined" };
    if (answer.kind !== RecipientKind.ACCEPT) throw new Error("expected ACCEPT or DECLINE");
    options.onAccepted();

    // Progress counts file bytes handed to the channel minus what is still
    // buffered, so it follows what has actually gone out.
    let sent = 0;
    let reported = -1;
    const report = () => {
      const value = Math.max(0, sent - channel.bufferedAmount);
      if (value !== reported) {
        reported = value;
        options.onProgress(value);
      }
    };
    progressTimer = setInterval(report, PROGRESS_INTERVAL_MS);

    for (let offset = 0; offset < file.size; offset += chunkSize) {
      if (channel.bufferedAmount > BUFFER_HIGH_BYTES) await bufferLow(channel, signal);
      const end = Math.min(offset + chunkSize, file.size);
      const body = new Uint8Array(await abortable(file.slice(offset, end).arrayBuffer(), signal));
      send(await writer.encrypt(SenderKind.CHUNK, body));
      sent += body.length;
    }

    const sha256 = await abortable(options.sha256, signal);
    send(await writer.encrypt(SenderKind.END, encodeEnd(sha256, file.size)));

    const receipt = await inbox.next();
    if (receipt.kind !== RecipientKind.RECEIPT) throw new Error("expected RECEIPT");
    clearInterval(progressTimer);
    progressTimer = undefined;
    report();
    return { type: "receipt", match: equalBytes(receipt.body, sha256) };
  } finally {
    if (progressTimer !== undefined) clearInterval(progressTimer);
    channel.removeEventListener("close", onClose);
    inbox.stop();
    abort.abort();
  }
}

type Inbox = {
  /** Starts decrypting with `reader`. Messages that arrived earlier are queued, not lost. */
  start(reader: FrameReader): void;
  /** The next decrypted frame. Rejects on abort or on any bad frame. */
  next(): Promise<Frame>;
  stop(): void;
};

/**
 * Decrypts incoming messages one at a time, in arrival order, and hands them
 * out through next(). The first failure is permanent.
 */
function createInbox(channel: FrameChannel, signal: AbortSignal): Inbox {
  const frames: Frame[] = [];
  const raw: unknown[] = [];
  let reader: FrameReader | undefined;
  let waiter: { resolve(frame: Frame): void; reject(error: unknown): void } | undefined;
  let failure: { error: unknown } | undefined;
  let queue: Promise<void> = Promise.resolve();

  const fail = (error: unknown) => {
    if (failure) return;
    failure = { error };
    waiter?.reject(error);
    waiter = undefined;
  };
  const onAbort = () => fail(signal.reason);

  const enqueue = (data: unknown) => {
    queue = queue
      .then(async () => {
        if (failure || !reader) return;
        if (!(data instanceof ArrayBuffer)) throw new Error("unexpected text message");
        const frame = await reader.decrypt(new Uint8Array(data));
        if (failure) return;
        if (waiter) {
          const w = waiter;
          waiter = undefined;
          w.resolve(frame);
        } else {
          frames.push(frame);
        }
      })
      .catch(fail);
  };

  const onMessage = (event: MessageEvent) => {
    if (reader) enqueue(event.data);
    else raw.push(event.data);
  };

  channel.addEventListener("message", onMessage);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  return {
    start(next) {
      reader = next;
      for (const data of raw.splice(0)) enqueue(data);
    },
    next() {
      if (failure) return Promise.reject(failure.error);
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    stop() {
      channel.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
      fail(new Error("inbox stopped"));
    },
  };
}

/** Waits for the channel's "bufferedamountlow" event. */
function bufferLow(channel: FrameChannel, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      signal.removeEventListener("abort", onAbort);
    };
    const onLow = () => {
      done();
      resolve();
    };
    const onAbort = () => {
      done();
      reject(signal.reason);
    };
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    channel.addEventListener("bufferedamountlow", onLow);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolves or rejects like `promise`, or rejects as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Lets the page handle input and paint before continuing a long job. */
export function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The SHA-256 of a file, read in 4 MiB slices with a yield after each so the
 * page stays responsive. Rejects with `signal.reason` if `signal` aborts (for
 * example because a different file was chosen).
 */
export async function hashFile(file: Blob, signal?: AbortSignal): Promise<Uint8Array> {
  const hash = new Sha256();
  for (let offset = 0; offset < file.size; offset += HASH_SLICE_BYTES) {
    signal?.throwIfAborted();
    const slice = file.slice(offset, Math.min(offset + HASH_SLICE_BYTES, file.size));
    hash.update(new Uint8Array(await slice.arrayBuffer()));
    await yieldToPage();
  }
  signal?.throwIfAborted();
  return hash.digest();
}
