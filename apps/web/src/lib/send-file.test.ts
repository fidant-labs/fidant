import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  decodeInit,
  decodeMeta,
  encodeCredit,
  type FileMeta,
  FrameReader,
  FrameWriter,
  HEADER_BYTES,
  MAX_CHUNK_BYTES,
  META_PADDED_BYTES,
  MIN_CHUNK_BYTES,
  paddedLength,
  ReceiveVerifier,
  RecipientKind,
  SenderKind,
  TAG_BYTES,
} from "./frames.ts";
import { deriveFileKey } from "./keys.ts";
import { createLink } from "./link.ts";
import { DEFAULT_MAX_MESSAGE_SIZE } from "./peer.ts";
import {
  anySignal,
  anySignalFallback,
  FRAME_OVERHEAD_BYTES,
  type FrameChannel,
  HASH_SLICE_BYTES,
  hashFile,
  sendFile,
} from "./send-file.ts";
import { MAX_TEXT_BYTES, MAX_TEXT_LENGTH, TEXT_TYPE, textFile } from "./text-secret.ts";

type Behaviour =
  | "accept"
  | "decline"
  | "bad-receipt"
  | "close-after-meta"
  | "wrong-key"
  | "garbage-mid-stream"
  /** Never grants credit, so no CHUNK may be sent. */
  | "no-credit"
  /** Grants 1 chunk with ACCEPT, then 1 more per chunk received. */
  | "stingy"
  /** Sends one more CREDIT after END, before RECEIPT. */
  | "credit-after-end";

/** The window the scripted recipient grants unless it is "stingy". */
const WINDOW = 8;

/**
 * A fake open data channel whose far end is a scripted recipient using the
 * real frame code. Messages are delivered asynchronously, like a real channel.
 */
function fakeChannel(secret: string, behaviour: Behaviour) {
  const target = new EventTarget();
  const received: {
    meta?: FileMeta;
    bytes: number;
    frames: number;
    chunkFrames: number[];
    /** CHUNKs the sender sent beyond the credit delivered to it so far. */
    overdrawn: number;
  } = { bytes: 0, frames: 0, chunkFrames: [], overdrawn: 0 };
  let granted = 0;
  let delivered = 0;
  let chunksSent = 0;
  let readyState: RTCDataChannelState = "open";
  let incoming: Promise<void> = Promise.resolve();
  let reader: FrameReader | undefined;
  let writer: FrameWriter | undefined;
  const verifier = new ReceiveVerifier();

  const reply = async (kind: RecipientKind, body: Uint8Array) => {
    if (!writer) {
      throw new Error("no writer");
    }
    const frame = await writer.encrypt(kind, body);
    const to = granted;
    setTimeout(() => {
      if (kind === RecipientKind.CREDIT) {
        delivered = to;
      }
      target.dispatchEvent(new MessageEvent("message", { data: frame.buffer }));
    });
  };
  const grant = async (to: number) => {
    granted = to;
    await reply(RecipientKind.CREDIT, encodeCredit(to));
  };
  const close = () => {
    readyState = "closed";
    target.dispatchEvent(new Event("close"));
  };

  const handle = async (data: Uint8Array) => {
    received.frames++;
    if (!reader) {
      const transferId = decodeInit(data);
      const key = await deriveFileKey(secret, transferId);
      reader = new FrameReader(key, "s");
      const replyKey =
        behaviour === "wrong-key"
          ? await deriveFileKey(createLink("https://localhost").secret, transferId)
          : key;
      writer = new FrameWriter(replyKey, "r");
      return;
    }
    const frame = await reader.decrypt(data);
    if (frame.kind === SenderKind.CHUNK) {
      received.chunkFrames.push(data.length);
    }
    if (frame.kind === SenderKind.META) {
      received.meta = decodeMeta(frame.body);
      verifier.meta(received.meta);
      if (behaviour === "close-after-meta") {
        close();
      } else if (behaviour === "decline") {
        await reply(RecipientKind.DECLINE, new Uint8Array());
      } else {
        await reply(RecipientKind.ACCEPT, new Uint8Array());
        if (behaviour !== "no-credit") {
          await grant(behaviour === "stingy" ? 1 : WINDOW);
        }
      }
    } else if (frame.kind === SenderKind.CHUNK) {
      received.bytes += verifier.chunk(frame.body).length;
      await grant(received.chunkFrames.length + (behaviour === "stingy" ? 1 : WINDOW));
      if (behaviour === "garbage-mid-stream" && received.chunkFrames.length === 1) {
        const garbage = new Uint8Array(HEADER_BYTES + TAG_BYTES + 32);
        setTimeout(() =>
          target.dispatchEvent(new MessageEvent("message", { data: garbage.buffer })),
        );
      }
    } else if (frame.kind === SenderKind.END) {
      const sha = verifier.end(frame.body);
      if (behaviour === "bad-receipt") {
        sha[0] = (sha[0] as number) ^ 1;
      }
      if (behaviour === "credit-after-end") {
        await grant(granted + WINDOW);
      }
      await reply(RecipientKind.RECEIPT, sha);
    }
  };

  const channel: FrameChannel = {
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    get readyState() {
      return readyState;
    },
    send(data) {
      if (data[1] === SenderKind.CHUNK && chunksSent++ >= delivered) {
        received.overdrawn++;
      }
      const copy = data.slice();
      incoming = incoming.then(() => handle(copy));
    },
    addEventListener: target.addEventListener.bind(target) as FrameChannel["addEventListener"],
    removeEventListener: target.removeEventListener.bind(
      target,
    ) as FrameChannel["removeEventListener"],
  };
  return { channel, received, done: () => incoming };
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function options(channel: FrameChannel, secret: string, bytes: Uint8Array, signal?: AbortSignal) {
  const file = new File([bytes as Uint8Array<ArrayBuffer>], "report.bin", {
    type: "application/octet-stream",
  });
  const progress: number[] = [];
  let accepted = false;
  return {
    progress,
    wasAccepted: () => accepted,
    value: {
      channel,
      maxMessageSize: 65536,
      file,
      from: "Anna",
      secret,
      sha256: Promise.resolve(sha256(bytes)),
      signal: signal ?? new AbortController().signal,
      onAccepted: () => {
        accepted = true;
      },
      onProgress: (n: number) => {
        progress.push(n);
      },
    },
  };
}

test("sends a file and reports a matching receipt", async () => {
  const { secret } = createLink("https://localhost");
  const bytes = new Uint8Array(randomBytes(300_000));
  const fake = fakeChannel(secret, "accept");
  const o = options(fake.channel, secret, bytes);
  const result = await sendFile(o.value);
  await fake.done();
  assert.deepEqual(result, { type: "receipt", match: true });
  assert.equal(o.wasAccepted(), true);
  assert.equal(fake.received.bytes, bytes.length);
  assert.deepEqual(fake.received.meta, {
    name: "report.bin",
    size: bytes.length,
    type: "application/octet-stream",
    chunkSize: 48 * 1024,
    from: "Anna",
  });
  assert.equal(o.progress.at(-1), bytes.length);
});

test("sends an empty file", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "accept");
  const result = await sendFile(options(fake.channel, secret, new Uint8Array()).value);
  assert.deepEqual(result, { type: "receipt", match: true });
});

test("every CHUNK frame is full size, so the exact file size stays hidden", async () => {
  const c = MAX_CHUNK_BYTES;
  for (const size of [0, 1, c - 1, c, c + 1, 3 * c + 7]) {
    const { secret } = createLink("https://localhost");
    const fake = fakeChannel(secret, "accept");
    const bytes = new Uint8Array(randomBytes(size));
    const o = options(fake.channel, secret, bytes);
    assert.deepEqual(await sendFile(o.value), { type: "receipt", match: true }, `size ${size}`);
    await fake.done();
    assert.equal(fake.received.bytes, size);
    assert.equal(fake.received.chunkFrames.length, paddedLength(size) / c, `size ${size}`);
    assert.ok(fake.received.chunkFrames.length >= 1);
    for (const length of fake.received.chunkFrames) {
      assert.equal(length, HEADER_BYTES + c + TAG_BYTES, `size ${size}`);
    }
    assert.equal(o.progress.at(-1) ?? 0, size);
    assert.ok(o.progress.every((n) => n <= size));
  }
});

test("a text goes as exactly one CHUNK on every connection that may carry it", async () => {
  const sizes = [262_144, DEFAULT_MAX_MESSAGE_SIZE, MAX_TEXT_BYTES + FRAME_OVERHEAD_BYTES];
  for (const maxMessageSize of sizes) {
    for (const text of ["x", "€".repeat(MAX_TEXT_LENGTH)]) {
      const label = `max message size ${maxMessageSize}, text of ${text.length} characters`;
      const file = textFile(text);
      assert.ok(file, label);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { secret } = createLink("https://localhost");
      const fake = fakeChannel(secret, "accept");
      const o = options(fake.channel, secret, bytes);
      const result = await sendFile({ ...o.value, file, maxMessageSize });
      await fake.done();
      const chunkSize = Math.min(MAX_CHUNK_BYTES, maxMessageSize - FRAME_OVERHEAD_BYTES);
      assert.deepEqual(result, { type: "receipt", match: true }, label);
      assert.deepEqual(fake.received.chunkFrames, [HEADER_BYTES + chunkSize + TAG_BYTES], label);
      assert.equal(fake.received.meta?.type, TEXT_TYPE, label);
      assert.equal(fake.received.meta?.chunkSize, chunkSize, label);
      assert.equal(fake.received.bytes, bytes.length, label);
    }
  }
});

test("reports a declined offer without sending chunks", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "decline");
  const o = options(fake.channel, secret, new Uint8Array(randomBytes(100_000)));
  const result = await sendFile(o.value);
  await fake.done();
  assert.deepEqual(result, { type: "declined" });
  assert.equal(o.wasAccepted(), false);
  assert.equal(fake.received.frames, 2);
});

test("reports a receipt that does not match", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "bad-receipt");
  const result = await sendFile(options(fake.channel, secret, new Uint8Array(1000)).value);
  assert.deepEqual(result, { type: "receipt", match: false });
});

test("rejects when the channel closes", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "close-after-meta");
  await assert.rejects(
    sendFile(options(fake.channel, secret, new Uint8Array(1000)).value),
    /data channel closed/,
  );
});

test("rejects when aborted", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "accept");
  const controller = new AbortController();
  const o = options(fake.channel, secret, new Uint8Array(1000), controller.signal);
  const pending = sendFile(o.value);
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/);
});

test("rejects an answer sealed with the wrong key", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "wrong-key");
  await assert.rejects(sendFile(options(fake.channel, secret, new Uint8Array(10)).value));
});

test("stops sending as soon as the recipient sends a bad frame mid-stream", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "garbage-mid-stream");
  const size = 4 * 1024 * 1024;
  await assert.rejects(sendFile(options(fake.channel, secret, new Uint8Array(size)).value));
  await fake.done();
  const total = paddedLength(size) / MAX_CHUNK_BYTES;
  assert.ok(
    fake.received.chunkFrames.length < total / 2,
    `sent ${fake.received.chunkFrames.length} of ${total} chunks`,
  );
});

test("sends no CHUNK without credit, and aborting still rejects", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "no-credit");
  const controller = new AbortController();
  const o = options(fake.channel, secret, new Uint8Array(100_000), controller.signal);
  const pending = sendFile(o.value);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(o.wasAccepted(), true);
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/);
  await fake.done();
  assert.equal(fake.received.chunkFrames.length, 0);
});

test("never sends more CHUNKs than the recipient granted", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "stingy");
  const bytes = new Uint8Array(randomBytes(10 * MAX_CHUNK_BYTES + 5));
  const result = await sendFile(options(fake.channel, secret, bytes).value);
  await fake.done();
  assert.deepEqual(result, { type: "receipt", match: true });
  assert.equal(fake.received.chunkFrames.length, 11);
  assert.equal(fake.received.overdrawn, 0);
});

test("a CREDIT after END is accepted", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "credit-after-end");
  const result = await sendFile(options(fake.channel, secret, new Uint8Array(1000)).value);
  assert.deepEqual(result, { type: "receipt", match: true });
});

for (const [label, any] of [
  ["anySignal", anySignal],
  ["anySignalFallback", anySignalFallback],
] as const) {
  test(`${label} aborts with the first signal's reason`, () => {
    const a = new AbortController();
    const b = new AbortController();
    const signal = any([a.signal, b.signal]);
    assert.equal(signal.aborted, false);
    let events = 0;
    signal.addEventListener("abort", () => events++);
    b.abort(new Error("second"));
    a.abort(new Error("first"));
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as Error).message, "second");
    assert.equal(events, 1);

    const done = new AbortController();
    done.abort(new Error("already"));
    const early = any([new AbortController().signal, done.signal]);
    assert.equal(early.aborted, true);
    assert.equal((early.reason as Error).message, "already");
  });
}

test("hashFile matches node:crypto across slice boundaries", async () => {
  for (const size of [0, 1, HASH_SLICE_BYTES - 1, HASH_SLICE_BYTES, HASH_SLICE_BYTES + 7]) {
    const bytes = new Uint8Array(randomBytes(size));
    const digest = await hashFile(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    assert.deepEqual(digest, sha256(bytes), `size ${size}`);
  }
});

test("hashFile stops when aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("other file"));
  await assert.rejects(hashFile(new Blob([new Uint8Array(10)]), controller.signal), /other file/);
});

test("the smallest chunk a recipient accepts is the smallest an honest sender makes", () => {
  // A sender's META frame must fit maxMessageSize, and its chunk is maxMessageSize minus the overhead.
  assert.equal(
    MIN_CHUNK_BYTES,
    HEADER_BYTES + META_PADDED_BYTES + TAG_BYTES - FRAME_OVERHEAD_BYTES,
  );
});
