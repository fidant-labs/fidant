// Receiving one file from the sender over an open data channel.
//
// Frames on the channel (see frames.ts and send-file.ts):
//
//   sender → recipient   INIT(transferId)                     plaintext
//   sender → recipient   META{name, size, type, chunkSize}    → onOffer, user decides
//   recipient → sender   ACCEPT  (or DECLINE: stop here)
//   sender → recipient   CHUNK × n                            verified, written to the sink
//   sender → recipient   END(sha256, size)                    checked against what arrived
//   recipient → sender   RECEIPT(sha256 the recipient computed)
//
// The transfer only succeeds on an authenticated END whose size matches META
// and the bytes received and whose checksum matches the bytes received. Any
// other ending (a frame that does not decrypt, wrong order, too many bytes, the
// channel closing first) aborts the sink, so no partial file is kept.
//
// No DOM or UI here beyond the data channel API, so tests can drive it with a
// fake channel. The file name only ever reaches onOffer.

import {
  decodeInit,
  decodeMeta,
  FrameReader,
  FrameWriter,
  ReceiveVerifier,
  RecipientKind,
  SenderKind,
} from "./frames.ts";
import { createInbox } from "./inbox.ts";
import { deriveFileKey } from "./keys.ts";
import { assertFrameFits } from "./peer.ts";
import { abortable, type FrameChannel, PROGRESS_INTERVAL_MS } from "./send-file.ts";
import type { Sink } from "./sink.ts";

/** The part of RTCDataChannel that receiving uses, so tests can pass a fake. */
export type ReceiveChannel = Pick<
  FrameChannel,
  "readyState" | "addEventListener" | "removeEventListener" | "send"
>;

/** What the recipient is shown before deciding. */
export type FileOffer = { name: string; size: number; type: string };

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

export type ReceiveResult =
  /** The recipient declined; DECLINE was sent. */
  | { type: "declined" }
  /** The file arrived intact and RECEIPT was sent. `blob` is set for a BlobSink. */
  | { type: "received"; sha256: Uint8Array; blob: Blob | undefined };

/**
 * Receives one file. Resolves after sending DECLINE or RECEIPT; the sender
 * closes the channel after either, which is then no longer an error. Rejects
 * (after aborting the sink) on any failure, abort or early channel close.
 */
export async function receiveFile(options: ReceiveFileOptions): Promise<ReceiveResult> {
  const { channel, maxMessageSize, secret } = options;
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const onClose = () => abort.abort(new Error("data channel closed"));
  channel.addEventListener("close", onClose);
  const inbox = createInbox(channel, signal);
  let sink: Sink | undefined;

  try {
    if (channel.readyState !== "open") throw new Error("data channel is not open");

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
    if (first.kind !== SenderKind.META) throw new Error("expected META");
    const meta = decodeMeta(first.body);
    const verifier = new ReceiveVerifier();
    verifier.meta(meta);

    const decision = options.onOffer({ name: meta.name, size: meta.size, type: meta.type });
    // A sink that arrives after the transfer ended is discarded.
    decision.then(
      (late) => {
        if (signal.aborted) void late?.abort();
      },
      () => {},
    );
    const chosen = await abortable(decision, signal);
    if (!chosen) {
      send(await writer.encrypt(RecipientKind.DECLINE, new Uint8Array()));
      return { type: "declined" };
    }
    sink = chosen;
    send(await writer.encrypt(RecipientKind.ACCEPT, new Uint8Array()));

    let reportedAt = 0;
    let sha256: Uint8Array | undefined;
    while (!sha256) {
      const frame = await inbox.next();
      if (frame.kind === SenderKind.CHUNK) {
        verifier.chunk(frame.body);
        await abortable(sink.write(frame.body), signal);
        const now = Date.now();
        if (now - reportedAt >= PROGRESS_INTERVAL_MS) {
          reportedAt = now;
          options.onProgress(verifier.bytesReceived);
        }
      } else if (frame.kind === SenderKind.END) {
        sha256 = verifier.end(frame.body);
      } else {
        throw new Error("expected CHUNK or END");
      }
    }
    options.onProgress(verifier.bytesReceived);

    const blob = await sink.close();
    send(await writer.encrypt(RecipientKind.RECEIPT, sha256));
    return { type: "received", sha256, blob };
  } catch (error) {
    if (sink) await sink.abort().catch(() => {});
    throw error;
  } finally {
    channel.removeEventListener("close", onClose);
    inbox.stop();
    abort.abort();
  }
}
