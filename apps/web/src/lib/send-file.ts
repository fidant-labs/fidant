// Sending one file to one recipient over an open data channel, and hashing
// the file once when it is chosen.
//
// Frames on the channel (see frames.ts):
//
//   sender → recipient   INIT(transferId)                     plaintext
//   both directions      CHECK(matches)                       only with the safety number on
//   sender → recipient   META{name, size, type, chunkSize, from}  encrypted
//   recipient → sender   ACCEPT(offset)  (or DECLINE: stop here)
//   recipient → sender   CREDIT(granted)                      again as chunks are written
//   sender → recipient   CHUNK × n                            from the offset, all chunkSize, zero-padded
//   sender → recipient   END(sha256, size)
//   recipient → sender   RECEIPT(sha256 the recipient computed)
//
// With the safety number on, each side sends CHECK once its own user compared
// the numbers, and META goes only after both said they match. Either side's
// CHECK(0) ends the transfer before anything about the file was sent.
//
// The sender sends CHUNK i (0-based from ACCEPT's offset) only while i < the
// highest CREDIT so far, so a recipient that writes slowly holds at most its
// credit window in memory. END needs no credit, and CREDITs that arrive after
// END change nothing. The channel's bufferedAmount still paces sending as well.
//
// ACCEPT's offset is the CHUNK data the recipient kept from a dropped attempt
// of the same file. The sender refuses one that is not a whole number of chunks
// within the padded length before sending any CHUNK. END carries the whole
// file's checksum either way.
//
// The file key comes from the link secret, a fresh transferId per attempt and
// the recipient's attempt ID (see keys.ts), so a restart after a drop never
// reuses a (file key, nonce) pair, and neither does a recipient shown a
// replayed INIT. Encryption happens in one sequential loop
// and incoming frames are decrypted through one promise queue, because frame
// writers and readers assign sequence numbers per call.
//
// No DOM or UI here beyond the data channel API, so tests can drive it with a
// fake channel. The file name only travels inside the encrypted META frame.

import { sendWhenOpen, whenOpen } from "./channel-open.ts";
import {
  decodeAccept,
  decodeCheck,
  decodeCredit,
  encodeCheck,
  encodeEnd,
  encodeInit,
  encodeMeta,
  FRAME_OVERHEAD_BYTES,
  FrameReader,
  FrameWriter,
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  paddedLength,
  RecipientKind,
  SenderKind,
} from "./frames.ts";
import { createInbox, type Inbox } from "./inbox.ts";
import { createTransferId, type Direction, deriveFileKey } from "./keys.ts";
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
/** After sending its own CHECK(0), a side waits at most this long for the other to close the channel. */
const CHECK_LINGER_MS = 2000;

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
  /** The sender's own name for the recipient to see, or "". Travels only inside META. */
  from: string;
  /** The recipient's link secret. */
  secret: string;
  /** The recipient's attempt ID for this connection, from the server's `joined`. */
  attempt: string;
  /** The file's SHA-256 from hashFile. Awaited before END. */
  sha256: Promise<Uint8Array>;
  /** Aborting stops the transfer; sendFile then rejects. */
  signal: AbortSignal;
  /** With the safety number on: resolves with whether the sender said the numbers match. */
  confirm?: Promise<boolean>;
  /** Both sides said the numbers match; META goes next. */
  onChecked?(): void;
  /** The recipient accepted; streaming starts. */
  onAccepted(): void;
  /** File bytes that have left the channel's buffer so far. Throttled. */
  onProgress(bytesSent: number): void;
};

export type SendResult =
  /** Someone said the safety numbers differ, so nothing about the file was sent. */
  | { type: "check-differs"; by: "sender" | "recipient" }
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
  const { channel, maxMessageSize, file, secret, attempt, from } = options;
  const abort = new AbortController();
  const signal = anySignal([options.signal, abort.signal]);
  const onClose = () => abort.abort(new Error("data channel closed"));
  channel.addEventListener("close", onClose);
  // The recipient sends ACCEPT or DECLINE, CREDITs and a RECEIPT, and the
  // receipt loop below reads them as they come. A correct recipient grants at
  // most window chunks past what we were last told, in steps of at least half
  // a window, so at most two CREDITs wait at a time; with ACCEPT and RECEIPT,
  // 8 leaves room and stops a recipient that floods us with frames.
  const inbox = createInbox(channel, signal, 8);
  let progressTimer: ReturnType<typeof setInterval> | undefined;

  try {
    // Only a channel that reads "connecting" after open waits; an open one goes on at once.
    const reopened = whenOpen(channel, signal);
    if (reopened) {
      await reopened;
    }
    channel.bufferedAmountLowThreshold = BUFFER_LOW_BYTES;

    const send = (frame: Uint8Array<ArrayBuffer>) => {
      signal.throwIfAborted();
      assertFrameFits(maxMessageSize, frame.byteLength);
      return sendWhenOpen(channel, frame, signal);
    };

    const transferId = createTransferId();
    await send(encodeInit(transferId));
    const key = await abortable(deriveFileKey(secret, transferId, attempt), signal);
    const writer = new FrameWriter(key, "s");
    inbox.start(new FrameReader(key, "r"));

    if (options.confirm) {
      const differs = await exchangeCheck(options.confirm, "s", {
        channel,
        inbox,
        writer,
        send,
        signal,
      });
      if (differs) {
        return { type: "check-differs", by: differs };
      }
      options.onChecked?.();
    }

    const chunkSize = Math.min(MAX_CHUNK_BYTES, maxMessageSize - FRAME_OVERHEAD_BYTES);
    if (chunkSize < MIN_CHUNK_BYTES) {
      throw new Error("max message size too small");
    }
    const meta = { name: file.name, size: file.size, type: file.type, chunkSize, from };
    await send(await writer.encrypt(SenderKind.META, encodeMeta(meta)));

    const answer = await inbox.next();
    if (answer.kind === RecipientKind.DECLINE) {
      return { type: "declined" };
    }
    if (answer.kind !== RecipientKind.ACCEPT) {
      throw new Error("expected ACCEPT or DECLINE");
    }
    // Every CHUNK is exactly chunkSize bytes, and there are as many as the
    // padded length needs; the bytes past the end of the file are zeros.
    const total = paddedLength(file.size, chunkSize);
    const start = decodeAccept(answer.body);
    if (start % chunkSize !== 0 || start > total) {
      throw new Error("ACCEPT offset is not a chunk boundary of this file");
    }
    options.onAccepted();

    // Read the recipient's frames in the background: CREDITs raise the limit
    // the chunk loop waits on, RECEIPT counts only after END, and anything else
    // (or a bad frame) stops sending right away instead of after the whole file.
    let granted = 0;
    let ended = false;
    let wake: (() => void) | undefined;
    const receipt = (async () => {
      for (;;) {
        const frame = await inbox.next();
        if (frame.kind === RecipientKind.CREDIT) {
          granted = Math.max(granted, decodeCredit(frame.body));
          wake?.();
        } else if (frame.kind === RecipientKind.RECEIPT && ended) {
          return frame.body;
        } else {
          throw new Error(ended ? "expected RECEIPT" : "recipient sent a frame before END");
        }
      }
    })();
    receipt.catch((error: unknown) => abort.abort(error));

    // Progress counts bytes handed to the channel minus what is still
    // buffered, so it follows what has actually gone out. Padding counts as
    // sent bytes, but progress never goes past the file size.
    let sent = start;
    let reported = -1;
    const report = () => {
      const value = Math.min(file.size, Math.max(0, sent - channel.bufferedAmount));
      if (value !== reported) {
        reported = value;
        options.onProgress(value);
      }
    };
    report();
    progressTimer = setInterval(report, PROGRESS_INTERVAL_MS);

    for (let offset = start, index = 0; offset < total; offset += chunkSize, index++) {
      while (index >= granted) {
        await abortable(
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          signal,
        );
      }
      if (channel.bufferedAmount > BUFFER_HIGH_BYTES) {
        await bufferLow(channel, signal);
      }
      const body = new Uint8Array(chunkSize);
      if (offset < file.size) {
        const end = Math.min(offset + chunkSize, file.size);
        body.set(new Uint8Array(await abortable(file.slice(offset, end).arrayBuffer(), signal)));
      }
      await send(await writer.encrypt(SenderKind.CHUNK, body));
      sent += body.length;
    }

    const sha256 = await abortable(options.sha256, signal);
    await send(await writer.encrypt(SenderKind.END, encodeEnd(sha256, file.size)));
    ended = true;

    const theirs = await abortable(receipt, signal);
    clearInterval(progressTimer);
    progressTimer = undefined;
    report();
    return { type: "receipt", match: equalBytes(theirs, sha256) };
  } finally {
    if (progressTimer !== undefined) {
      clearInterval(progressTimer);
    }
    channel.removeEventListener("close", onClose);
    inbox.stop();
    abort.abort();
  }
}

const SIDE = { s: "sender", r: "recipient" } as const;
const CHECK_OF = { s: SenderKind.CHECK, r: RecipientKind.CHECK } as const;

/**
 * The CHECK exchange for side `mine`: sends its own verdict once `own`
 * resolves, and reads the other side's CHECK meanwhile. Resolves undefined when
 * both said the numbers match, or with who said they differ, at once for the
 * other side's CHECK(0). After its own CHECK(0) it waits for the other side to
 * close, so that frame is not lost to its own page closing the connection.
 */
export async function exchangeCheck(
  own: Promise<boolean>,
  mine: Direction,
  io: {
    channel: Pick<FrameChannel, "readyState" | "addEventListener" | "removeEventListener">;
    inbox: Inbox;
    writer: FrameWriter;
    send(frame: Uint8Array<ArrayBuffer>): Promise<void>;
    signal: AbortSignal;
  },
): Promise<"sender" | "recipient" | undefined> {
  const other: Direction = mine === "s" ? "r" : "s";
  const theirs = io.inbox.next().then((frame) => {
    if (frame.kind !== CHECK_OF[other]) {
      throw new Error("expected CHECK");
    }
    return decodeCheck(frame.body);
  });
  theirs.catch(() => {});
  const first = await Promise.race([
    abortable(own, io.signal).then((matches) => ({ mine: matches })),
    theirs.then((matches) => ({ theirs: matches })),
  ]);
  if ("theirs" in first && !first.theirs) {
    return SIDE[other];
  }
  const matches = "mine" in first ? first.mine : await abortable(own, io.signal);
  await io.send(await io.writer.encrypt(CHECK_OF[mine], encodeCheck(matches)));
  if (!matches) {
    await closedOrLater(io.channel, io.signal);
    return SIDE[mine];
  }
  return (await abortable(theirs, io.signal)) ? undefined : SIDE[other];
}

/** Resolves when the channel closes, `signal` aborts or CHECK_LINGER_MS passed. */
function closedOrLater(
  channel: Pick<FrameChannel, "readyState" | "addEventListener" | "removeEventListener">,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      channel.removeEventListener("close", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, CHECK_LINGER_MS);
    channel.addEventListener("close", done);
    signal.addEventListener("abort", done);
    if (channel.readyState === "closing" || channel.readyState === "closed" || signal.aborted) {
      done();
    }
  });
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

/**
 * A signal that aborts when any of `signals` does, with its reason. Uses
 * AbortSignal.any where the browser has it (Safari 17.4+, Firefox 124+).
 */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const native = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") {
    return native.call(AbortSignal, [...signals]);
  }
  return anySignalFallback(signals);
}

/** anySignal for browsers without AbortSignal.any. Exported for tests. */
export function anySignalFallback(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const already = signals.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return controller.signal;
  }
  const onAbort = (event: Event) => {
    for (const s of signals) {
      s.removeEventListener("abort", onAbort);
    }
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const s of signals) {
    s.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/** Resolves or rejects like `promise`, or rejects as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
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
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/** Lets the page handle input and paint before continuing a long job. */
export function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) {
    return scheduler.yield();
  }
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
