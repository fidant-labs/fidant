import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  encodeEnd,
  encodeInit,
  encodeMeta,
  FRAME_OVERHEAD_BYTES,
  FrameWriter,
  HEADER_BYTES,
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  RecipientKind,
  SenderKind,
} from "./frames.ts";
import { createTransferId, deriveFileKey } from "./keys.ts";
import { createLink } from "./link.ts";
import {
  CREDIT_WINDOW_CHUNKS,
  type FileOffer,
  ReceiveError,
  type ReceiveFailure,
  type ReceiveFileOptions,
  receiveFile,
} from "./receive-file.ts";
import { type FrameChannel, type SendFileOptions, type SendResult, sendFile } from "./send-file.ts";
import { BlobSink, type Sink } from "./sink.ts";

type Transit = {
  /** Called for each sender → recipient frame. Return undefined to drop it, several to deliver them in order. */
  toRecipient?(
    frame: Uint8Array<ArrayBuffer>,
    pair: Pair,
  ): Uint8Array<ArrayBuffer> | Uint8Array<ArrayBuffer>[] | undefined;
  /** Called after each recipient → sender frame is delivered. */
  afterToSender?(frame: Uint8Array<ArrayBuffer>, pair: Pair): void;
};

type Pair = { sender: FrameChannel; recipient: FrameChannel; close(): void };

/**
 * Two fake data channel ends wired to each other. Messages are copied and
 * delivered asynchronously, like a real channel; closing either end closes both.
 */
function channelPair(transit: Transit = {}): Pair {
  const ends = [new EventTarget(), new EventTarget()] as const;
  let readyState: RTCDataChannelState = "open";

  const deliver = (to: EventTarget, data: Uint8Array<ArrayBuffer>) => {
    setTimeout(() => {
      if (readyState === "open") {
        to.dispatchEvent(new MessageEvent("message", { data: data.buffer }));
      }
    });
  };

  const make = (self: EventTarget, other: EventTarget, toRecipient: boolean): FrameChannel => ({
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    get readyState() {
      return readyState;
    },
    send(data) {
      if (readyState !== "open") {
        throw new Error("channel is closed");
      }
      const copy = data.slice();
      if (toRecipient) {
        const out = transit.toRecipient ? transit.toRecipient(copy, pair) : copy;
        for (const frame of out === undefined ? [] : [out].flat()) {
          deliver(other, frame);
        }
      } else {
        deliver(other, copy);
        setTimeout(() => transit.afterToSender?.(copy, pair));
      }
    },
    addEventListener: self.addEventListener.bind(self) as FrameChannel["addEventListener"],
    removeEventListener: self.removeEventListener.bind(self) as FrameChannel["removeEventListener"],
  });

  const pair: Pair = {
    sender: make(ends[0], ends[1], true),
    recipient: make(ends[1], ends[0], false),
    close() {
      if (readyState !== "open") {
        return;
      }
      readyState = "closed";
      for (const end of ends) {
        end.dispatchEvent(new Event("close"));
      }
    },
  };
  return pair;
}

/** A sink that records what happened to it. */
class RecordingSink extends BlobSink {
  aborted = false;
  closed = false;
  writes = 0;
  onWrite: (() => void) | undefined;

  override async write(chunk: Uint8Array): Promise<void> {
    this.writes++;
    await super.write(chunk);
    this.onWrite?.();
  }
  override async close(): Promise<Blob> {
    this.closed = true;
    return super.close();
  }
  override async abort(): Promise<void> {
    this.aborted = true;
    await super.abort();
  }
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

type RunOptions = {
  bytes: Uint8Array;
  /** Sent instead of a File made from `bytes`; `bytes` is then unused but for the checksum default. */
  file?: SendFileOptions["file"];
  maxMessageSize?: number;
  pair?: Pair;
  recipientSecret?: string;
  sink?: Sink;
  onOffer?: ReceiveFileOptions["onOffer"];
  signal?: AbortSignal;
  /** The checksum the sender puts in END. Defaults to the real one. */
  senderSha256?: Uint8Array;
  /** Each side's own check verdict; without one, that side runs without the check. */
  senderConfirm?: Promise<boolean>;
  recipientConfirm?: Promise<boolean>;
};

/** Matches a ReceiveError with this reason. */
const failedWith = (reason: ReceiveFailure) => (error: unknown) =>
  error instanceof ReceiveError && error.reason === reason;

/** Runs the real sendFile against receiveFile over a channel pair. */
function run(options: RunOptions) {
  const { secret } = createLink("https://localhost");
  const pair = options.pair ?? channelPair();
  const sink = options.sink ?? new RecordingSink();
  const offers: FileOffer[] = [];
  const progress: number[] = [];
  const maxMessageSize = options.maxMessageSize ?? 65536;
  const file =
    options.file ??
    new File([options.bytes as Uint8Array<ArrayBuffer>], "report.bin", {
      type: "application/octet-stream",
    });
  const sending: Promise<SendResult> = sendFile({
    channel: pair.sender,
    maxMessageSize,
    file,
    from: "Anna",
    secret,
    sha256: Promise.resolve(options.senderSha256 ?? sha256(options.bytes)),
    signal: new AbortController().signal,
    ...(options.senderConfirm ? { confirm: options.senderConfirm } : {}),
    onAccepted: () => {},
    onProgress: () => {},
  });
  sending.catch(() => {});
  const receiving = receiveFile({
    channel: pair.recipient,
    maxMessageSize,
    secret: options.recipientSecret ?? secret,
    signal: options.signal ?? new AbortController().signal,
    ...(options.recipientConfirm ? { confirm: options.recipientConfirm } : {}),
    onOffer:
      options.onOffer ??
      (async (offer) => {
        offers.push(offer);
        return sink;
      }),
    onProgress: (n) => progress.push(n),
  });
  return { pair, sending, receiving, offers, progress, sink };
}

test("receives a file, verifies it and sends a matching receipt", async () => {
  const bytes = new Uint8Array(randomBytes(300_000));
  const r = run({ bytes });
  const result = await r.receiving;
  assert.equal(result.type, "received");
  if (result.type !== "received") {
    return;
  }
  assert.deepEqual(result.sha256, sha256(bytes));
  assert.ok(result.blob);
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
  assert.deepEqual(await r.sending, { type: "receipt", match: true });
  assert.deepEqual(r.offers, [
    { name: "report.bin", size: bytes.length, type: "application/octet-stream", from: "Anna" },
  ]);
  assert.equal(r.progress.at(-1), bytes.length);
});

test("receives an empty file", async () => {
  const r = run({ bytes: new Uint8Array() });
  const result = await r.receiving;
  assert.equal(result.type, "received");
  if (result.type === "received") {
    assert.equal(result.blob?.size, 0);
  }
  assert.deepEqual(await r.sending, { type: "receipt", match: true });
});

test("declines an offer", async () => {
  const sink = new RecordingSink();
  const r = run({ bytes: new Uint8Array(1000), onOffer: async () => undefined, sink });
  assert.deepEqual(await r.receiving, { type: "declined" });
  assert.deepEqual(await r.sending, { type: "declined" });
  assert.equal(sink.writes, 0);
});

test("succeeds when the sender closes the channel after the receipt", async () => {
  const pair = channelPair({
    afterToSender: (frame, p) => {
      if (frame[1] === RecipientKind.RECEIPT) {
        p.close();
      }
    },
  });
  const r = run({ bytes: new Uint8Array(randomBytes(100_000)), pair });
  const result = await r.receiving;
  assert.equal(result.type, "received");
});

function confirmation() {
  let resolve: (matches: boolean) => void = () => {};
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A channel pair that records the kind of every frame, and closes like a page does after a "differs". */
function watchedPair() {
  const kinds: number[] = [];
  const pair = channelPair({
    toRecipient(frame) {
      kinds.push(frame[1] as number);
      return frame;
    },
  });
  return { pair, kinds };
}

test("no offer before both checks", async () => {
  const bytes = new Uint8Array(randomBytes(1000));
  const own = confirmation();
  const { pair, kinds } = watchedPair();
  const r = run({
    bytes,
    pair,
    senderConfirm: Promise.resolve(true),
    recipientConfirm: own.promise,
  });
  await settle();
  assert.deepEqual(r.offers, []);
  assert.deepEqual(kinds, [SenderKind.INIT, SenderKind.CHECK]);
  own.resolve(true);
  const result = await r.receiving;
  assert.equal(result.type, "received");
  assert.equal(r.offers.length, 1);
  assert.deepEqual(kinds.slice(0, 3), [SenderKind.INIT, SenderKind.CHECK, SenderKind.META]);
  assert.deepEqual(await r.sending, { type: "receipt", match: true });
});

test("own differs: CHECK(0) goes out and both sides stop", async () => {
  const sink = new RecordingSink();
  const { pair, kinds } = watchedPair();
  const r = run({
    bytes: new Uint8Array(1000),
    pair,
    sink,
    senderConfirm: new Promise<boolean>(() => {}),
    recipientConfirm: Promise.resolve(false),
  });
  const sent = await r.sending;
  pair.close();
  assert.deepEqual(sent, { type: "check-differs", by: "recipient" });
  assert.deepEqual(await r.receiving, { type: "check-differs", by: "recipient" });
  assert.deepEqual(r.offers, []);
  assert.deepEqual(kinds, [SenderKind.INIT]);
  assert.equal(sink.writes, 0);
});

test("the sender differs: the recipient stops before its own click", async () => {
  const { pair, kinds } = watchedPair();
  const r = run({
    bytes: new Uint8Array(1000),
    pair,
    senderConfirm: Promise.resolve(false),
    recipientConfirm: new Promise<boolean>(() => {}),
  });
  const received = await r.receiving;
  pair.close();
  assert.deepEqual(received, { type: "check-differs", by: "sender" });
  assert.deepEqual(await r.sending, { type: "check-differs", by: "sender" });
  assert.deepEqual(r.offers, []);
  assert.deepEqual(kinds, [SenderKind.INIT, SenderKind.CHECK]);
});

test("a flipped flag: a recipient without the check refuses a CHECK", async () => {
  const r = run({ bytes: new Uint8Array(1000), senderConfirm: Promise.resolve(true) });
  await assert.rejects(r.receiving, failedWith("invalid"));
  assert.deepEqual(r.offers, []);
  r.pair.close();
  await assert.rejects(r.sending);
});

test("a flipped flag: a recipient with the check refuses META before CHECK", async () => {
  const r = run({ bytes: new Uint8Array(1000), recipientConfirm: new Promise<boolean>(() => {}) });
  await assert.rejects(r.receiving, failedWith("invalid"));
  assert.deepEqual(r.offers, []);
  r.pair.close();
  await assert.rejects(r.sending);
});

test("rejects a link with the wrong secret before offering anything", async () => {
  const sink = new RecordingSink();
  const r = run({
    bytes: new Uint8Array(1000),
    recipientSecret: createLink("https://localhost").secret,
    sink,
  });
  await assert.rejects(r.receiving);
  assert.equal(r.offers.length, 0);
  r.pair.close();
  await assert.rejects(r.sending);
});

test("a checksum mismatch discards the file and tells the sender", async () => {
  const sink = new RecordingSink();
  const bytes = new Uint8Array(randomBytes(100_000));
  const wrong = sha256(bytes);
  wrong[0] = (wrong[0] as number) ^ 1;
  const r = run({ bytes, sink, senderSha256: wrong });
  await assert.rejects(r.receiving, failedWith("checksum"));
  assert.equal(sink.aborted, true);
  assert.equal(sink.closed, false);
  assert.deepEqual(await r.sending, { type: "receipt", match: false });
});

test("failures say whether the sender, the connection or the sink failed", async () => {
  // A frame that does not decrypt: the sender sent invalid data.
  let chunks = 0;
  const tampered = channelPair({
    toRecipient(frame) {
      if (frame[1] === SenderKind.CHUNK && ++chunks === 2) {
        frame[HEADER_BYTES] = (frame[HEADER_BYTES] as number) ^ 1;
      }
      return frame;
    },
  });
  const invalid = run({ bytes: new Uint8Array(randomBytes(200_000)), pair: tampered });
  await assert.rejects(invalid.receiving, failedWith("invalid"));
  tampered.close();
  await assert.rejects(invalid.sending);

  // The channel closing first: the connection was lost.
  const closing = channelPair();
  const closed = run({
    bytes: new Uint8Array(1000),
    pair: closing,
    onOffer: async () => {
      closing.close();
      return new RecordingSink();
    },
  });
  await assert.rejects(closed.receiving, failedWith("connection"));

  // The sink failing: the file could not be saved.
  const broken = new RecordingSink();
  broken.write = () => Promise.reject(new Error("disk full"));
  const unsaved = run({ bytes: new Uint8Array(randomBytes(100_000)), sink: broken });
  await assert.rejects(
    unsaved.receiving,
    (error: unknown) => failedWith("save")(error) && /disk full/.test(String(error)),
  );
  assert.equal(broken.aborted, true);
  unsaved.pair.close();
  await assert.rejects(unsaved.sending);
});

test("aborts the sink when the channel closes mid-transfer", async () => {
  const sink = new RecordingSink();
  const pair = channelPair();
  sink.onWrite = () => pair.close();
  const r = run({ bytes: new Uint8Array(randomBytes(300_000)), pair, sink });
  await assert.rejects(r.receiving, /closed/);
  assert.equal(sink.aborted, true);
  assert.equal(sink.closed, false);
});

test("aborts the sink when a chunk is tampered with", async () => {
  const sink = new RecordingSink();
  let chunks = 0;
  const pair = channelPair({
    toRecipient(frame) {
      if (frame[1] === SenderKind.CHUNK && ++chunks === 3) {
        frame[HEADER_BYTES + 5] = (frame[HEADER_BYTES + 5] as number) ^ 1;
      }
      return frame;
    },
  });
  const r = run({ bytes: new Uint8Array(randomBytes(300_000)), pair, sink });
  await assert.rejects(r.receiving);
  assert.equal(sink.aborted, true);
  assert.equal(sink.writes, 2);
  pair.close();
  await assert.rejects(r.sending);
});

test("treats a missing END as truncation", async () => {
  const sink = new RecordingSink();
  const pair = channelPair({
    toRecipient(frame, p) {
      if (frame[1] !== SenderKind.END) {
        return frame;
      }
      setTimeout(() => p.close(), 10);
      return undefined;
    },
  });
  const r = run({ bytes: new Uint8Array(randomBytes(100_000)), pair, sink });
  await assert.rejects(r.receiving, /closed/);
  assert.equal(sink.aborted, true);
  assert.equal(sink.closed, false);
  await assert.rejects(r.sending);
});

async function failsOnSequence(toRecipient: NonNullable<Transit["toRecipient"]>): Promise<void> {
  const sink = new RecordingSink();
  const pair = channelPair({ toRecipient });
  const r = run({ bytes: new Uint8Array(randomBytes(300_000)), pair, sink });
  await assert.rejects(
    r.receiving,
    (error) => failedWith("invalid")(error) && /seq/.test(String(error)),
  );
  assert.equal(sink.aborted, true);
  pair.close();
  await assert.rejects(r.sending);
}

test("treats a dropped chunk as a failure", async () => {
  let chunks = 0;
  await failsOnSequence((frame) =>
    frame[1] === SenderKind.CHUNK && ++chunks === 2 ? undefined : frame,
  );
});

test("treats a dropped last chunk as invalid", async () => {
  let held: Uint8Array<ArrayBuffer> | undefined;
  await failsOnSequence((frame) => {
    if (frame[1] !== SenderKind.CHUNK) {
      return frame;
    }
    const before = held;
    held = frame;
    return before;
  });
});

test("treats a reordered chunk as invalid", async () => {
  let chunks = 0;
  let held: Uint8Array<ArrayBuffer> | undefined;
  await failsOnSequence((frame) => {
    if (frame[1] !== SenderKind.CHUNK) {
      return frame;
    }
    if (++chunks === 2) {
      held = frame;
      return undefined;
    }
    return chunks === 3 && held ? [frame, held] : frame;
  });
});

test("treats a repeated chunk as invalid", async () => {
  let chunks = 0;
  await failsOnSequence((frame) =>
    frame[1] === SenderKind.CHUNK && ++chunks === 2 ? [frame, frame.slice()] : frame,
  );
});

test("rejects when aborted during the offer and discards a late sink", async () => {
  const controller = new AbortController();
  const late = new RecordingSink();
  let decide: ((sink: Sink) => void) | undefined;
  let offered: () => void = () => {};
  const shown = new Promise<void>((resolve) => {
    offered = resolve;
  });
  const r = run({
    bytes: new Uint8Array(1000),
    signal: controller.signal,
    onOffer: () =>
      new Promise((resolve) => {
        decide = resolve;
        offered();
      }),
  });
  await shown;
  controller.abort(new Error("stopped"));
  await assert.rejects(r.receiving, /stopped/);
  decide?.(late);
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(late.aborted, true);
  r.pair.close();
  await assert.rejects(r.sending);
});

for (const early of ["CHUNK", "END"] as const) {
  test(`fails when the sender sends ${early} before the recipient answers`, async () => {
    const { secret } = createLink("https://localhost");
    const pair = channelPair();
    const sent: number[] = [];
    pair.sender.addEventListener("message", (event) => {
      sent.push(new Uint8Array((event as MessageEvent).data)[1] as number);
    });
    let offered = false;
    let decide: ((sink: Sink | undefined) => void) | undefined;
    const receiving = receiveFile({
      channel: pair.recipient,
      maxMessageSize: 65536,
      secret,
      signal: new AbortController().signal,
      onOffer: () => {
        offered = true;
        return new Promise((resolve) => {
          decide = resolve;
        });
      },
      onProgress: () => {},
    });

    // A sender that does not wait for ACCEPT.
    const transferId = createTransferId();
    const writer = new FrameWriter(await deriveFileKey(secret, transferId), "s");
    const meta = { name: "a.bin", size: 1, type: "", chunkSize: MAX_CHUNK_BYTES, from: "" };
    pair.sender.send(encodeInit(transferId));
    pair.sender.send(await writer.encrypt(SenderKind.META, encodeMeta(meta)));
    pair.sender.send(
      early === "CHUNK"
        ? await writer.encrypt(SenderKind.CHUNK, new Uint8Array(MAX_CHUNK_BYTES))
        : await writer.encrypt(SenderKind.END, encodeEnd(sha256(new Uint8Array(1)), 1)),
    );

    await assert.rejects(receiving, /before the recipient answered/);
    assert.equal(offered, true);
    // Accepting afterwards changes nothing: no answer is sent and the sink is discarded.
    const late = new RecordingSink();
    decide?.(late);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(sent, []);
    assert.equal(late.aborted, true);
    assert.equal(late.writes, 0);
  });
}

test("aborts when the sender ignores the credit window", async () => {
  const { secret } = createLink("https://localhost");
  const pair = channelPair();
  let accepted: (() => void) | undefined;
  const acceptance = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  pair.sender.addEventListener("message", (event) => {
    if (new Uint8Array((event as MessageEvent).data)[1] === RecipientKind.ACCEPT) {
      accepted?.();
    }
  });
  const sink = new RecordingSink();
  sink.write = () => new Promise(() => {});
  const receiving = receiveFile({
    channel: pair.recipient,
    maxMessageSize: 65536,
    secret,
    signal: new AbortController().signal,
    onOffer: async () => sink,
    onProgress: () => {},
  });
  receiving.catch(() => {});

  // A sender that sends far more CHUNKs than it was granted.
  const transferId = createTransferId();
  const writer = new FrameWriter(await deriveFileKey(secret, transferId), "s");
  const count = CREDIT_WINDOW_CHUNKS * 4;
  const meta = {
    name: "a.bin",
    size: count * MIN_CHUNK_BYTES,
    type: "",
    chunkSize: MIN_CHUNK_BYTES,
    from: "",
  };
  pair.sender.send(encodeInit(transferId));
  pair.sender.send(await writer.encrypt(SenderKind.META, encodeMeta(meta)));
  await acceptance;
  for (let i = 0; i < count; i++) {
    pair.sender.send(await writer.encrypt(SenderKind.CHUNK, new Uint8Array(MIN_CHUNK_BYTES)));
  }

  await assert.rejects(
    receiving,
    (error: unknown) =>
      failedWith("invalid")(error) && /exceeded the frame window/.test(String(error)),
  );
  assert.equal(sink.aborted, true);
  pair.close();
});

/**
 * Counts CHUNK frames the sender has put on the channel against chunks the
 * sink has finished writing; `peak` is the most that were ever in between.
 */
function inFlight() {
  const count = { sent: 0, written: 0, peak: 0 };
  const pair = channelPair({
    toRecipient(frame) {
      if (frame[1] === SenderKind.CHUNK) {
        count.sent++;
        count.peak = Math.max(count.peak, count.sent - count.written);
      }
      return frame;
    },
  });
  return { pair, count };
}

test("a slow sink holds the sender to the credit window", async () => {
  const maxMessageSize = 4096;
  const chunkSize = maxMessageSize - FRAME_OVERHEAD_BYTES;
  const bytes = new Uint8Array(randomBytes(4 * CREDIT_WINDOW_CHUNKS * chunkSize));
  const { pair, count } = inFlight();
  const sink = new RecordingSink();
  const write = sink.write.bind(sink);
  sink.write = async (chunk) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await write(chunk);
    count.written++;
  };
  const r = run({ bytes, pair, sink, maxMessageSize });
  const result = await r.receiving;
  assert.equal(result.type, "received");
  if (result.type !== "received") {
    return;
  }
  assert.deepEqual(new Uint8Array(await (result.blob as Blob).arrayBuffer()), bytes);
  assert.deepEqual(await r.sending, { type: "receipt", match: true });
  assert.equal(count.sent, 4 * CREDIT_WINDOW_CHUNKS);
  assert.ok(count.peak <= CREDIT_WINDOW_CHUNKS, `peak ${count.peak}`);
  assert.ok(count.peak > CREDIT_WINDOW_CHUNKS / 2, `peak ${count.peak}`);
});

/** Deterministic bytes for positions [start, end) of a generated file. */
function generated(start: number, end: number, out = new Uint8Array(end - start)) {
  for (let i = 0; i < out.length; i++) {
    const p = start + i;
    out[i] = (p ^ (p >>> 9) ^ (p >>> 17)) & 0xff;
  }
  return out;
}

/** A File-like input of `size` generated bytes that are made only when sliced. */
function generatedFile(size: number, start = 0, end = size): SendFileOptions["file"] {
  return {
    name: "big.bin",
    type: "application/octet-stream",
    size: end - start,
    slice: (a = 0, b = end - start) =>
      generatedFile(size, start + a, Math.min(start + b, end)) as unknown as Blob,
    arrayBuffer: async () => generated(start, end).buffer,
  } as unknown as SendFileOptions["file"];
}

// Moderate sizes keep `pnpm check` fast. SIGILL_FLOW_FULL=1 sends 1 GiB through
// a slow sink and checks memory stays bounded by the credit window.
const full = process.env.SIGILL_FLOW_FULL === "1";

test("1 GiB through a slow sink keeps memory bounded", {
  skip: full ? false : "set SIGILL_FLOW_FULL=1 to run",
}, async () => {
  const size = 1024 ** 3;
  // One reused buffer, so hashing leaves no garbage to skew the samples below.
  const expected = createHash("sha256");
  const piece = new Uint8Array(1024 ** 2);
  for (let offset = 0; offset < size; offset += piece.length) {
    expected.update(generated(offset, offset + piece.length, piece));
  }
  const digest = new Uint8Array(expected.digest());

  const used = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  // Growth is the highest sample minus the lowest, so a collection
  // mid-transfer cannot hide growth.
  (globalThis as { gc?: () => void }).gc?.();
  let low = used();
  let high = low;
  let writes = 0;
  const { pair, count } = inFlight();
  const sink: Sink = {
    async write() {
      await new Promise((resolve) => setTimeout(resolve, 1));
      count.written++;
      if (++writes % 16 === 0) {
        const now = used();
        low = Math.min(low, now);
        high = Math.max(high, now);
      }
    },
    close: async () => undefined,
    abort: async () => {},
  };
  const started = performance.now();
  const r = run({
    bytes: new Uint8Array(),
    file: generatedFile(size),
    senderSha256: digest,
    pair,
    sink,
    maxMessageSize: 65536,
  });
  const result = await r.receiving;
  const seconds = (performance.now() - started) / 1000;
  assert.equal(result.type, "received");
  if (result.type === "received") {
    assert.deepEqual(result.sha256, digest);
  }
  assert.deepEqual(await r.sending, { type: "receipt", match: true });
  const mib = (high - low) / 1024 ** 2;
  console.log(
    `1 GiB in ${seconds.toFixed(1)} s, peak memory growth ${mib.toFixed(1)} MiB, peak in flight ${count.peak} chunks`,
  );
  assert.ok(count.peak <= CREDIT_WINDOW_CHUNKS, `peak ${count.peak}`);
  assert.ok(mib < 64, `peak memory growth ${mib.toFixed(1)} MiB`);
});
