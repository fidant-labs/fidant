// Receiving one file from the sender over an open data channel.
//
// Frames on the channel (see frames.ts and send-file.ts):
//
//   sender → recipient   INIT(transferId)                     plaintext
//   sender → recipient   META{name, size, type, chunkSize, from}  → onOffer, user decides
//   recipient → sender   ACCEPT  (or DECLINE: stop here)
//   recipient → sender   CREDIT(granted)                      after ACCEPT, then as chunks are written
//   sender → recipient   CHUNK × n                            verified, file bytes to the sink
//   sender → recipient   END(sha256, size)                    checked against what arrived
//   recipient → sender   RECEIPT(sha256 the recipient computed)
//
// Flow control: the recipient grants CREDIT_WINDOW_CHUNKS chunks with ACCEPT
// and tops the grant back up to that many past the chunks the sink has
// written whenever half of it is used, so a slow sink never has more than the
// window of chunks on their way to it.
//
// The transfer only succeeds on an authenticated END whose size matches META
// and the bytes received and whose checksum matches the bytes received. Any
// other ending (a frame that does not decrypt, wrong order, too many bytes, the
// channel closing first) aborts the sink, so no partial file is kept.
//
// If every frame was valid but the file bytes do not hash to END's checksum,
// the recipient still sends RECEIPT, with the checksum it computed, so the
// sender learns of the mismatch; then it rejects. Every rejection is a
// ReceiveError whose `reason` tells a checksum mismatch, a misbehaving sender,
// a lost connection and a failed save apart.
//
// No DOM or UI here beyond the data channel API, so tests can drive it with a
// fake channel. The file name only ever reaches onOffer.

import {
  ChecksumMismatchError,
  decodeInit,
  decodeMeta,
  encodeCredit,
  type Frame,
  FrameReader,
  FrameWriter,
  ReceiveVerifier,
  RecipientKind,
  SenderKind,
} from "./frames.ts";
import { createInbox } from "./inbox.ts";
import { deriveFileKey } from "./keys.ts";
import { assertFrameFits } from "./peer.ts";
import { abortable, anySignal, type FrameChannel, PROGRESS_INTERVAL_MS } from "./send-file.ts";
import type { Sink } from "./sink.ts";

/** CHUNKs the sender may have sent beyond those the sink has written. */
export const CREDIT_WINDOW_CHUNKS = 128;

/** The part of RTCDataChannel that receiving uses, so tests can pass a fake. */
export type ReceiveChannel = Pick<
  FrameChannel,
  "readyState" | "addEventListener" | "removeEventListener" | "send"
>;

/** What the recipient is shown before deciding. `from` is the sender's unverified name, or "". */
export type FileOffer = { name: string; size: number; type: string; from: string };

export type ReceiveFileOptions = {
  channel: ReceiveChannel;
  /** From PeerOpenInfo. Every frame is checked against it. */
  maxMessageSize: number;
  /** The link secret from the URL fragment. */
  secret: string;
  /** Aborting stops the transfer; receiveFile then rejects. */
  signal: AbortSignal;
  /**
   * The sender offers a file. Resolve with a Sink to accept or undefined to
   * decline. Leaving it pending is fine: the transfer waits.
   */
  onOffer(offer: FileOffer): Promise<Sink | undefined>;
  /** File bytes received and verified so far. Throttled. */
  onProgress(bytesReceived: number): void;
};

export type ReceiveFailure =
  /** Every frame was valid, but the file did not match END's checksum. RECEIPT was sent. */
  | "checksum"
  /** The sender sent a frame that failed to decrypt, came out of order or broke the format. */
  | "invalid"
  /** The channel closed or the transfer was aborted. */
  | "connection"
  /** The sink failed to write or close the file. */
  | "save";

/** Why receiveFile rejected. The message is the underlying error's. */
export class ReceiveError extends Error {
  readonly reason: ReceiveFailure;

  constructor(reason: ReceiveFailure, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "ReceiveError";
    this.reason = reason;
  }
}

export type ReceiveResult =
  /** The recipient declined; DECLINE was sent. */
  | { type: "declined" }
  /** The file arrived intact and RECEIPT was sent. `blob` is set for a BlobSink. */
  | { type: "received"; sha256: Uint8Array; blob: Blob | undefined };

/**
 * Receives one file. Resolves after sending DECLINE or RECEIPT; the sender
 * closes the channel after either, which is then no longer an error. Rejects
 * with a ReceiveError (after aborting the sink) on any failure, abort or early
 * channel close.
 */
export async function receiveFile(options: ReceiveFileOptions): Promise<ReceiveResult> {
  const { channel, maxMessageSize, secret } = options;
  const abort = new AbortController();
  const signal = anySignal([options.signal, abort.signal]);
  const onClose = () => abort.abort(new Error("data channel closed"));
  channel.addEventListener("close", onClose);
  // A sender that keeps to its credit has at most CREDIT_WINDOW_CHUNKS
  // CHUNKs held: it sends no more than `granted` (at most written + window),
  // and every written CHUNK has been handed out. END is the one frame on top.
  // INIT and META can be held together before takeRaw(), but no CHUNK comes
  // until ACCEPT, and by then both have been handed out.
  const inbox = createInbox(channel, signal, CREDIT_WINDOW_CHUNKS + 1);
  let sink: Sink | undefined;

  try {
    if (channel.readyState !== "open") {
      throw new Error("data channel is not open");
    }

    const send = (frame: Uint8Array<ArrayBuffer>) => {
      signal.throwIfAborted();
      assertFrameFits(maxMessageSize, frame.byteLength);
      channel.send(frame);
    };

    const transferId = decodeInit(await inbox.takeRaw());
    const key = await abortable(deriveFileKey(secret, transferId), signal);
    const writer = new FrameWriter(key, "r");
    inbox.start(new FrameReader(key, "s"));

    const first = await inbox.next();
    if (first.kind !== SenderKind.META) {
      throw new Error("expected META");
    }
    const meta = decodeMeta(first.body);
    const verifier = new ReceiveVerifier();
    verifier.meta(meta);

    // The sender may send nothing more until it has our answer, so any frame
    // that arrives before ACCEPT or DECLINE has gone out is a protocol error.
    // Wait for the next frame alongside the decision; once the answer is sent,
    // that frame is the first CHUNK or END.
    const firstAfterAnswer = inbox.next();
    firstAfterAnswer.catch(() => {});
    const early = firstAfterAnswer.then(() => {
      throw new Error("sender sent a frame before the recipient answered");
    });

    const { name, size, type, from } = meta;
    const decision = options.onOffer({ name, size, type, from });
    // A sink that arrives after the transfer ended is discarded.
    decision.then(
      (late) => {
        if (signal.aborted) {
          void late?.abort();
        }
      },
      () => {},
    );
    const answer = async (): Promise<Sink | undefined> => {
      const chosen = await abortable(decision, signal);
      const kind = chosen ? RecipientKind.ACCEPT : RecipientKind.DECLINE;
      send(await writer.encrypt(kind, new Uint8Array()));
      return chosen;
    };
    const chosen = await Promise.race([answer(), early]);
    if (!chosen) {
      return { type: "declined" };
    }
    sink = chosen;
    let granted = CREDIT_WINDOW_CHUNKS;
    let written = 0;
    send(await writer.encrypt(RecipientKind.CREDIT, encodeCredit(granted)));

    let reportedAt = 0;
    let sha256: Uint8Array | undefined;
    let pending: Promise<Frame> | undefined = firstAfterAnswer;
    while (!sha256) {
      const frame = await (pending ?? inbox.next());
      pending = undefined;
      if (frame.kind === SenderKind.CHUNK) {
        const data = verifier.chunk(frame.body);
        if (data.length > 0) {
          // A sender that overruns its credit fails the inbox while the sink
          // may be stuck, so stop waiting for the write then.
          await Promise.race([abortable(saving(sink.write(data)), signal), inbox.failed]);
        }
        written++;
        if (written + CREDIT_WINDOW_CHUNKS - granted >= CREDIT_WINDOW_CHUNKS / 2) {
          granted = written + CREDIT_WINDOW_CHUNKS;
          send(await writer.encrypt(RecipientKind.CREDIT, encodeCredit(granted)));
        }
        const now = Date.now();
        if (now - reportedAt >= PROGRESS_INTERVAL_MS) {
          reportedAt = now;
          options.onProgress(verifier.bytesReceived);
        }
      } else if (frame.kind === SenderKind.END) {
        try {
          sha256 = verifier.end(frame.body);
        } catch (error) {
          if (!(error instanceof ChecksumMismatchError)) {
            throw error;
          }
          // Discard the file first, then tell the sender what arrived.
          const discarded = sink;
          sink = undefined;
          await discarded.abort().catch(() => {});
          send(await writer.encrypt(RecipientKind.RECEIPT, error.actual));
          throw new ReceiveError("checksum", error.message, { cause: error });
        }
      } else {
        throw new Error("expected CHUNK or END");
      }
    }
    options.onProgress(verifier.bytesReceived);

    const blob = await saving(sink.close());
    send(await writer.encrypt(RecipientKind.RECEIPT, sha256));
    return { type: "received", sha256, blob };
  } catch (error) {
    if (sink) {
      await sink.abort().catch(() => {});
    }
    throw classify(error, signal);
  } finally {
    channel.removeEventListener("close", onClose);
    inbox.stop();
    abort.abort();
  }
}

/** Marks a sink failure as a save failure. */
async function saving<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw new ReceiveError("save", messageOf(error), { cause: error });
  }
}

/**
 * The ReceiveError for a failure. Once the transfer was aborted (channel
 * closed, caller gave up), whatever failed next counts as the connection.
 */
function classify(error: unknown, signal: AbortSignal): ReceiveError {
  if (error instanceof ReceiveError && error.reason === "checksum") {
    return error;
  }
  if (signal.aborted) {
    return new ReceiveError("connection", messageOf(signal.reason), { cause: error });
  }
  if (error instanceof ReceiveError) {
    return error;
  }
  return new ReceiveError("invalid", messageOf(error), { cause: error });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
