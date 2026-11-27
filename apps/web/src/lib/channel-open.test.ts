import assert from "node:assert/strict";
import { test } from "node:test";
import { sendWhenOpen, whenOpen } from "./channel-open.ts";

function fakeChannel(initial: RTCDataChannelState) {
  const target = new EventTarget();
  const sent: number[] = [];
  let readyState = initial;
  return {
    sent,
    set(state: RTCDataChannelState, event?: string) {
      readyState = state;
      if (event) {
        target.dispatchEvent(new Event(event));
      }
    },
    get readyState() {
      return readyState;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    send(data: Uint8Array<ArrayBuffer>) {
      if (readyState !== "open") {
        throw new DOMException("RTCDataChannel.readyState is not 'open'", "InvalidStateError");
      }
      sent.push(data[0] ?? -1);
    },
  };
}

const frame = (n: number) => new Uint8Array([n]);

test("an open channel sends synchronously", () => {
  const channel = fakeChannel("open");
  void sendWhenOpen(channel, frame(1), new AbortController().signal);
  assert.deepEqual(channel.sent, [1]);
});

test("a channel that reads connecting after open sends once it opens again, in order", async () => {
  const channel = fakeChannel("connecting");
  const signal = new AbortController().signal;
  const first = sendWhenOpen(channel, frame(1), signal);
  const second = sendWhenOpen(channel, frame(2), signal);
  await Promise.resolve();
  assert.deepEqual(channel.sent, []);
  channel.set("open", "open");
  await Promise.all([first, second]);
  assert.deepEqual(channel.sent, [1, 2]);
});

test("a channel that closes while connecting rejects the send", async () => {
  const channel = fakeChannel("connecting");
  const sending = sendWhenOpen(channel, frame(1), new AbortController().signal);
  channel.set("closed", "close");
  await assert.rejects(sending, /not open/);
  assert.deepEqual(channel.sent, []);
});

test("a closed channel rejects at once", async () => {
  for (const state of ["closing", "closed"] as const) {
    await assert.rejects(
      sendWhenOpen(fakeChannel(state), frame(1), new AbortController().signal),
      /not open/,
    );
  }
});

test("an abort while connecting rejects with its reason", async () => {
  const channel = fakeChannel("connecting");
  const abort = new AbortController();
  const sending = sendWhenOpen(channel, frame(1), abort.signal);
  abort.abort(new Error("stopped"));
  await assert.rejects(sending, /stopped/);
  channel.set("open", "open");
  assert.deepEqual(channel.sent, []);
});

test("a channel that stays connecting times out", async () => {
  const channel = fakeChannel("connecting");
  const waiting = whenOpen(channel, new AbortController().signal, 10);
  assert.ok(waiting);
  await assert.rejects(waiting, /stayed connecting/);
});
