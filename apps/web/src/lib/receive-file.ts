// Receiving one file from the sender over an open data channel.
//
// Frames on the channel (see frames.ts and send-file.ts):
//
//   sender → recipient   INIT(transferId)                     plaintext
//   both directions      CHECK(matches)                       only with the safety number on
//   sender → recipient   META{name, size, type, chunkSize, from}  → onOffer, user decides (or onResume)
//   recipient → sender   ACCEPT(offset)  (or DECLINE: stop here)
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
// and the bytes received and whose checksum matches the bytes received.
//
// A lost connection keeps what arrived: the rejection carries a Resumable (the
// META, the verifier with its running checksum, and the sink) if every frame so
// far checked out and the last write to the sink finished, unless the offer is
// a shared secret or the recipient said the safety numbers differ. Passed to
// the next attempt, it continues only if that attempt's META is the same in
// every field: then onOffer is skipped, ACCEPT carries the verifier's offset
// and the sender sends only the rest, which END's checksum still covers with
// the bytes kept.
// A different META discards it and the offer starts from zero. Any other ending
// (a frame that does not decrypt, wrong order, too many bytes, a decline, a
// differing check or checksum) aborts the sink, so no partial file is kept.
//
// If every frame was valid but the file bytes do not hash to END's checksum,
// the recipient still sends RECEIPT, with the checksum it computed, so the
// sender learns of the mismatch; then it rejects. Every rejection is a
// ReceiveError whose `reason` tells a checksum mismatch, a misbehaving sender,
// a lost connection and a failed save apart.
//
// The file key comes from the link secret, the sender's transferId in INIT and
// this attempt's own attempt ID (see keys.ts). The attempt ID is fresh for
// every join, so an INIT and META replayed from an earlier attempt give a key
// this recipient has never sealed a frame under: META fails to decrypt and
// nothing is sent back.
//
// No DOM or UI here beyond the data channel API, so tests can drive it with a
// fake channel. The file name only ever reaches onOffer or onResume.

import {
  ChecksumMismatchError,
  decodeInit,
  decodeMeta,
  encodeAccept,
  encodeCredit,
  type FileMeta,
  FRAME_VERSION,
  type Frame,
  FrameReader,
  FrameWriter,
  ReceiveVerifier,
  RecipientKind,
  SenderKind,
  VersionError,
} from "./frames.ts";
import { createInbox } from "./inbox.ts";
import { deriveFileKey } from "./keys.ts";
import { assertFrameFits } from "./peer.ts";
import {
  abortable,
  anySignal,
  exchangeCheck,
  type FrameChannel,
  PROGRESS_INTERVAL_MS,
} from "./send-file.ts";
import type { Sink } from "./sink.ts";
import { isTextOffer } from "./text-secret.ts";

/** CHUNKs the sender may have sent beyond those the sink has written. */
export const CREDIT_WINDOW_CHUNKS = 128;

/** The part of RTCDataChannel that receiving uses, so tests can pass a fake. */
export type ReceiveChannel = Pick<
  FrameChannel,
  "readyState" | "addEventListener" | "removeEventListener" | "send"
>;

/** What the recipient is shown before deciding. `from` is the sender's unverified name, or "". */
export type FileOffer = { name: string; size: number; type: string; from: string };

/** What a dropped transfer kept: its META, its verifier with the checksum so far, and the sink holding what arrived. */
export type Resumable = { meta: FileMeta; verifier: ReceiveVerifier; sink: Sink };

export type ReceiveFileOptions = {
  channel: ReceiveChannel;
  /** From PeerOpenInfo. Every frame is checked against it. */
  maxMessageSize: number;
  /** The link secret from the URL fragment. */
  secret: string;
  /** The attempt ID this join sent in `join`. Must be fresh for every join. */
  attempt: string;
  /** Aborting stops the transfer; receiveFile then rejects. */
  signal: AbortSignal;
  /**
   * With the safety number on: resolves with whether the recipient said the
   * numbers match. Nothing about the file arrives before both sides said so.
   */
  confirm?: Promise<boolean>;
  /**
   * The sender offers a file. Resolve with a Sink to accept or undefined to
   * decline. Leaving it pending is fine: the transfer waits.
   */
  onOffer(offer: FileOffer): Promise<Sink | undefined>;
  /**
   * What an earlier attempt kept. receiveFile owns it from the call on: it
   * continues it, hands it back in ReceiveError.resumable, or aborts its sink.
   */
  resumable?: Resumable;
  /** The sender offered the kept file again, so it continues without onOffer; `bytes` already arrived. */
  onResume?(offer: FileOffer, bytes: number): void;
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
  | "save"
  /** INIT named a newer frame version, so this page must reload. */
  | "outdated"
  /** INIT named an older frame version, so the sender's page must reload. */
  | "peer-outdated";

/** Why receiveFile rejected. The message is the underlying error's. */
export class ReceiveError extends Error {
  readonly reason: ReceiveFailure;
  /** Set only on a lost connection that kept what arrived; whoever catches it owns it. */
  readonly resumable: Resumable | undefined;

  constructor(
    reason: ReceiveFailure,
    message: string,
    options?: { cause: unknown; resumable?: Resumable },
  ) {
    super(message, options);
    this.name = "ReceiveError";
    this.reason = reason;
    this.resumable = options?.resumable;
  }
}

export type ReceiveResult =
  /** Someone said the safety numbers differ, so nothing about the file arrived. */
  | { type: "check-differs"; by: "sender" | "recipient" }
  /** The recipient declined; DECLINE was sent. */
  | { type: "declined" }
  /** The file arrived intact and RECEIPT was sent. `blob` is set for a BlobSink. */
  | { type: "received"; sha256: Uint8Array; blob: Blob | undefined };

/**
 * Receives one file. Resolves after sending DECLINE or RECEIPT; the sender
 * closes the channel after either, which is then no longer an error. Rejects
 * with a ReceiveError on any failure, abort or early channel close, after
 * aborting the sink unless the error carries it as `resumable`.
 */
export async function receiveFile(options: ReceiveFileOptions): Promise<ReceiveResult> {
  const { channel, maxMessageSize, secret, attempt } = options;
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
  // A sender that overruns its credit fails the inbox while the sink may be
  // stuck. Subscribe to that once: racing inbox.failed per CHUNK would leave
  // one reaction on it for every CHUNK of the transfer.
  const inboxFailed = new AbortController();
  inbox.failed.catch((error: unknown) => inboxFailed.abort(error));
  const writeSignal = anySignal([signal, inboxFailed.signal]);
  let part = options.resumable;
  let saidDiffers = false;
  let lastWrite: Promise<void> = Promise.resolve();

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
    const key = await abortable(deriveFileKey(secret, transferId, attempt), signal);
    const writer = new FrameWriter(key, "r");
    inbox.start(new FrameReader(key, "s"));

    if (options.confirm) {
      const own = options.confirm.then((matches) => {
        saidDiffers = !matches;
        return matches;
      });
      const differs = await exchangeCheck(own, "r", {
        channel,
        inbox,
        writer,
        send,
        signal,
      });
      if (differs) {
        return { type: "check-differs", by: differs };
      }
    }

    const first = await inbox.next();
    if (first.kind !== SenderKind.META) {
      throw new Error("expected META");
    }
    const meta = decodeMeta(first.body);
    const kept = part && sameMeta(part.meta, meta) ? part : undefined;
    if (part && !kept) {
      const replaced = part;
      part = undefined;
      await replaced.sink.abort().catch(() => {});
    }
    const verifier = kept?.verifier ?? new ReceiveVerifier();
    if (!kept) {
      verifier.meta(meta);
    }

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
    const offer = { name, size, type, from };
    let decision: Promise<Sink | undefined>;
    if (kept) {
      decision = Promise.resolve(kept.sink);
      options.onResume?.(offer, verifier.bytesReceived);
    } else {
      decision = options.onOffer(offer);
      // A sink that arrives after the transfer ended is discarded.
      decision.then(
        (late) => {
          if (signal.aborted) {
            void late?.abort();
          }
        },
        () => {},
      );
    }
    const answer = async (): Promise<Sink | undefined> => {
      const chosen = await abortable(decision, signal);
      part = chosen && { meta, verifier, sink: chosen };
      send(
        await (chosen
          ? writer.encrypt(RecipientKind.ACCEPT, encodeAccept(verifier.offset))
          : writer.encrypt(RecipientKind.DECLINE, new Uint8Array())),
      );
      return chosen;
    };
    const sink = await Promise.race([answer(), early]);
    if (!sink) {
      return { type: "declined" };
    }
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
          lastWrite = sink.write(data);
          await abortable(saving(lastWrite), writeSignal);
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
          part = undefined;
          await sink.abort().catch(() => {});
          send(await writer.encrypt(RecipientKind.RECEIPT, error.actual));
          throw new ReceiveError("checksum", error.message, { cause: error });
        }
      } else {
        throw new Error("expected CHUNK or END");
      }
    }
    options.onProgress(verifier.bytesReceived);

    const blob = await saving(sink.close());
    part = undefined;
    send(await writer.encrypt(RecipientKind.RECEIPT, sha256));
    return { type: "received", sha256, blob };
  } catch (error) {
    const failure = classify(error, signal);
    // A write still pending may yet fail and leave a hole the checksum can't show, so wait for it.
    if (
      part?.verifier.canContinue &&
      !isTextOffer(part.meta) &&
      !saidDiffers &&
      failure.reason === "connection" &&
      (await lastWrite.then(
        () => true,
        () => false,
      ))
    ) {
      const resumable = part;
      part = undefined;
      throw new ReceiveError("connection", failure.message, { cause: failure.cause, resumable });
    }
    throw failure;
  } finally {
    if (part) {
      await part.sink.abort().catch(() => {});
    }
    channel.removeEventListener("close", onClose);
    inbox.stop();
    abort.abort();
  }
}

function sameMeta(a: FileMeta, b: FileMeta): boolean {
  return (
    a.name === b.name &&
    a.size === b.size &&
    a.type === b.type &&
    a.chunkSize === b.chunkSize &&
    a.from === b.from
  );
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
  if (error instanceof VersionError) {
    const reason = error.version > FRAME_VERSION ? "outdated" : "peer-outdated";
    return new ReceiveError(reason, error.message, { cause: error });
  }
  return new ReceiveError("invalid", messageOf(error), { cause: error });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
