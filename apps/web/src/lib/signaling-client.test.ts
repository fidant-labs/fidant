import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { RETRY_MAX_MS } from "@sigill/protocol";
import { connectSignaling, retryDelay } from "./signaling-client.ts";

const STABLE = 10_000;
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
    created++;
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {}
}

let fake: FakeWebSocket;
let created = 0;
const original = globalThis.WebSocket;

beforeEach(() => {
  created = 0;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = original;
});

function open() {
  fake.readyState = 1;
  fake.dispatchEvent(new Event("open"));
}

function drop(code = 1006) {
  fake.readyState = 3;
  fake.dispatchEvent(Object.assign(new Event("close"), { code }));
}

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

test("does not count other messages, invalid frames or sends on a closed socket", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const seen: number[] = [];
  const client = connectSignaling({ url: "wss://x/signal", onRelay: (b) => seen.push(b) });
  fake.readyState = 1;
  client.send({ t: "host", links: [LINK], turn: true });
  client.send({ t: "join", link: LINK, attempt: LINK });
  receive({ t: "joined", link: LINK, attempt: LINK, iceServers: [], turn: true });
  fake.dispatchEvent(Object.assign(new Event("message"), { data: "not json" }));
  fake.readyState = 3;
  client.send({ t: "relay", link: LINK, data: "abc" });
  assert.deepEqual(seen, []);
  assert.equal(fake.sent.length, 2);
  assert.equal(warn.mock.callCount(), 1);
});

test("retryDelay waits a random time up to 1 s × 2^failures, capped at 30 s", () => {
  assert.equal(
    retryDelay(0, () => 0),
    0,
  );
  assert.equal(
    retryDelay(0, () => 1),
    1000,
  );
  assert.equal(
    retryDelay(3, () => 0.5),
    4000,
  );
  assert.equal(
    retryDelay(5, () => 1),
    RETRY_MAX_MS,
  );
  assert.equal(
    retryDelay(50, () => 1),
    RETRY_MAX_MS,
  );
});

test("reconnects after a drop and keeps its listeners", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(Math, "random", () => 1);
  const client = connectSignaling({ url: "wss://x/signal" });
  const events: string[] = [];
  client.onOpen(() => events.push("open"));
  client.onClose(({ code, byClient }) => events.push(`close ${code} ${byClient}`));
  client.subscribe((message) => events.push(message.t));
  open();
  t.mock.timers.tick(STABLE);
  drop();
  t.mock.timers.tick(999);
  assert.equal(created, 1);
  t.mock.timers.tick(1);
  assert.equal(created, 2);
  open();
  receive({ t: "error", code: "already-hosted" });
  assert.deepEqual(events, ["open", "close 1006 false", "open", "error"]);
});

test("a failed connect doubles the next wait, and a stable open resets it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(Math, "random", () => 1);
  connectSignaling({ url: "wss://x/signal" });
  drop();
  t.mock.timers.tick(1999);
  assert.equal(created, 1);
  t.mock.timers.tick(1);
  assert.equal(created, 2);
  drop();
  t.mock.timers.tick(3999);
  assert.equal(created, 2);
  t.mock.timers.tick(1);
  assert.equal(created, 3);
  open();
  t.mock.timers.tick(STABLE);
  drop();
  t.mock.timers.tick(1000);
  assert.equal(created, 4);
});

test("a close with 1012 reconnects at once and resets the wait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(Math, "random", () => 1);
  connectSignaling({ url: "wss://x/signal" });
  drop();
  t.mock.timers.tick(2000);
  assert.equal(created, 2);
  open();
  drop(1012);
  t.mock.timers.tick(0);
  assert.equal(created, 3);
  drop();
  t.mock.timers.tick(1999);
  assert.equal(created, 3);
  t.mock.timers.tick(1);
  assert.equal(created, 4);
});

test("a socket that opens and drops at once still backs off", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(Math, "random", () => 1);
  connectSignaling({ url: "wss://x/signal" });
  open();
  drop(1008);
  t.mock.timers.tick(1999);
  assert.equal(created, 1);
  t.mock.timers.tick(1);
  assert.equal(created, 2);
  open();
  drop(1008);
  t.mock.timers.tick(3999);
  assert.equal(created, 2);
  t.mock.timers.tick(1);
  assert.equal(created, 3);
});

test("a socket that stayed open for STABLE_MS retries within 1 s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(Math, "random", () => 1);
  connectSignaling({ url: "wss://x/signal" });
  drop();
  t.mock.timers.tick(2000);
  open();
  t.mock.timers.tick(STABLE);
  drop();
  t.mock.timers.tick(1000);
  assert.equal(created, 3);
});

test("close() from an onClose listener stops the retry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = connectSignaling({ url: "wss://x/signal" });
  client.onClose(() => client.close());
  open();
  drop();
  t.mock.timers.tick(RETRY_MAX_MS);
  assert.equal(created, 1);
});

test("close() during the wait stops reconnecting", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = connectSignaling({ url: "wss://x/signal" });
  const closes: boolean[] = [];
  client.onClose(({ byClient }) => closes.push(byClient));
  open();
  drop();
  client.close();
  t.mock.timers.tick(RETRY_MAX_MS);
  assert.equal(created, 1);
  assert.deepEqual(closes, [false]);
});

test("close() on an open socket reports byClient and does not reconnect", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = connectSignaling({ url: "wss://x/signal" });
  const closes: boolean[] = [];
  client.onClose(({ byClient }) => closes.push(byClient));
  open();
  client.close();
  drop(1000);
  t.mock.timers.tick(RETRY_MAX_MS);
  assert.equal(created, 1);
  assert.deepEqual(closes, [true]);
});
