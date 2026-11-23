import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  decodeInit,
  decodeMeta,
  type FileMeta,
  FrameReader,
  FrameWriter,
  ReceiveVerifier,
  RecipientKind,
  SenderKind,
} from "./frames.ts";
import { deriveFileKey } from "./keys.ts";
import { createLink } from "./link.ts";
import { type FrameChannel, HASH_SLICE_BYTES, hashFile, sendFile } from "./send-file.ts";

type Behaviour = "accept" | "decline" | "bad-receipt" | "close-after-meta" | "wrong-key";

/**
 * A fake open data channel whose far end is a scripted recipient using the
 * real frame code. Messages are delivered asynchronously, like a real channel.
 */
function fakeChannel(secret: string, behaviour: Behaviour) {
  const target = new EventTarget();
  const received: { meta?: FileMeta; bytes: number; frames: number } = { bytes: 0, frames: 0 };
  let readyState: RTCDataChannelState = "open";
  let incoming: Promise<void> = Promise.resolve();
  let reader: FrameReader | undefined;
  let writer: FrameWriter | undefined;
  const verifier = new ReceiveVerifier();

  const reply = async (kind: number, body: Uint8Array) => {
    if (!writer) throw new Error("no writer");
    const frame = await writer.encrypt(kind as 16 | 17 | 18, body);
    setTimeout(() => target.dispatchEvent(new MessageEvent("message", { data: frame.buffer })));
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
    if (frame.kind === SenderKind.META) {
      received.meta = decodeMeta(frame.body);
      verifier.meta(received.meta);
      if (behaviour === "close-after-meta") close();
      else if (behaviour === "decline") await reply(RecipientKind.DECLINE, new Uint8Array());
      else await reply(RecipientKind.ACCEPT, new Uint8Array());
    } else if (frame.kind === SenderKind.CHUNK) {
      verifier.chunk(frame.body);
      received.bytes += frame.body.length;
    } else if (frame.kind === SenderKind.END) {
      const sha = verifier.end(frame.body);
      if (behaviour === "bad-receipt") sha[0] = (sha[0] as number) ^ 1;
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
  });
  assert.equal(o.progress.at(-1), bytes.length);
});

test("sends an empty file", async () => {
  const { secret } = createLink("https://localhost");
  const fake = fakeChannel(secret, "accept");
  const result = await sendFile(options(fake.channel, secret, new Uint8Array()).value);
  assert.deepEqual(result, { type: "receipt", match: true });
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
  await assert.rejects(sendFile(options(fake.channel, secret, new Uint8Array(1000)).value));
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
