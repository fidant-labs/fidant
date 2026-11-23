import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { connectSignaling } from "./signaling-client.ts";

const LINK = "AAAAAAAAAAAAAAAAAAAAAA";

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  constructor(_url: string) {
    super();
    fake = this;
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {}
}

let fake: FakeWebSocket;
const original = globalThis.WebSocket;

beforeEach(() => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = original;
});

function receive(message: unknown) {
  fake.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) }));
}

test("counts relay messages it sends and receives, by data length", () => {
  const seen: number[] = [];
  const client = connectSignaling({ url: "wss://x/signal", onRelay: (b) => seen.push(b) });
  fake.readyState = 1;
  client.send({ t: "relay", link: LINK, data: "abc" });
  receive({ t: "relay", link: LINK, data: "abcdef" });
  assert.deepEqual(seen, [3, 6]);
});

test("does not count other messages, invalid frames or sends on a closed socket", () => {
  const seen: number[] = [];
  const client = connectSignaling({ url: "wss://x/signal", onRelay: (b) => seen.push(b) });
  fake.readyState = 1;
  client.send({ t: "host", links: [LINK] });
  client.send({ t: "join", link: LINK });
  receive({ t: "joined", link: LINK });
  fake.dispatchEvent(Object.assign(new Event("message"), { data: "not json" }));
  fake.readyState = 3;
  client.send({ t: "relay", link: LINK, data: "abc" });
  assert.deepEqual(seen, []);
  assert.equal(fake.sent.length, 2);
});
