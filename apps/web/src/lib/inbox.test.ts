import assert from "node:assert/strict";
import { test } from "node:test";
import { type FrameReader, SenderKind } from "./frames.ts";
import { createInbox } from "./inbox.ts";

/** A reader that "decrypts" a message into a CHUNK carrying its bytes. */
const reader = {
  decrypt: async (bytes: Uint8Array) => ({ kind: SenderKind.CHUNK, body: bytes }),
} as unknown as FrameReader;

function setup(maxHeld: number) {
  const channel = new EventTarget();
  const inbox = createInbox(channel, new AbortController().signal, maxHeld);
  const deliver = (n: number) => {
    channel.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([n]).buffer }));
  };
  return { inbox, deliver };
}

test("fails when more messages arrive before start() than it may hold", async () => {
  const { inbox, deliver } = setup(2);
  deliver(1);
  deliver(2);
  deliver(3);
  await assert.rejects(inbox.takeRaw(), /exceeded the frame window/);
  await assert.rejects(inbox.failed, /exceeded the frame window/);
});

test("fails when more frames arrive after start() than it may hold", async () => {
  const { inbox, deliver } = setup(2);
  inbox.start(reader);
  deliver(1);
  deliver(2);
  deliver(3);
  await assert.rejects(inbox.failed, /exceeded the frame window/);
  await assert.rejects(inbox.next(), /exceeded the frame window/);
});

test("frames handed out free their place", async () => {
  const { inbox, deliver } = setup(2);
  deliver(0);
  assert.deepEqual(await inbox.takeRaw(), new Uint8Array([0]));
  inbox.start(reader);
  for (let i = 1; i <= 10; i += 2) {
    deliver(i);
    deliver(i + 1);
    assert.deepEqual((await inbox.next()).body, new Uint8Array([i]));
    assert.deepEqual((await inbox.next()).body, new Uint8Array([i + 1]));
  }
  // A waiting next() takes a frame as soon as it is decrypted.
  const waiting = inbox.next();
  deliver(11);
  deliver(12);
  assert.deepEqual((await waiting).body, new Uint8Array([11]));
  deliver(13);
  assert.deepEqual((await inbox.next()).body, new Uint8Array([12]));
  assert.deepEqual((await inbox.next()).body, new Uint8Array([13]));
  inbox.stop();
});
