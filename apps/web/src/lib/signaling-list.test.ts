import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { signalingUrl, signalingUrlFrom } from "./signaling-list.ts";

test("the committed list names the Stockholm signaling server", () => {
  const text = readFileSync(new URL("../../signals.json", import.meta.url), "utf8");
  assert.deepEqual(JSON.parse(text), [{ id: "sto", url: "wss://sto.signal.fidant.se/signal" }]);
  assert.equal(signalingUrlFrom(text), "wss://sto.signal.fidant.se/signal");
});

test("refuses a list that a page could not use", () => {
  const entry = (url: string, id = "sto") => JSON.stringify([{ id, url }]);
  for (const text of [
    "",
    "{}",
    "[]",
    '[{"id":"sto"}]',
    '[{"id":"sto","url":"wss://sto.signal.fidant.se/signal","more":1}]',
    entry("ws://sto.signal.fidant.se/signal"),
    entry("https://sto.signal.fidant.se/signal"),
    entry("wss://sto.signal.fidant.se/"),
    entry("wss://sto.signal.fidant.se/signal?x=1"),
    entry("wss://user@sto.signal.fidant.se/signal"),
    entry("wss://sto.signal.fidant.se/signal", "STO"),
    '[{"id":"sto","url":"wss://a.example/signal"},{"id":"sto","url":"wss://b.example/signal"}]',
  ]) {
    assert.throws(() => signalingUrlFrom(text), /^Error: The signaling list /, text);
  }
});

test("a page uses its own host unless the build named a server", () => {
  assert.equal(signalingUrl(undefined, "localhost:8443"), "wss://localhost:8443/signal");
  assert.equal(signalingUrl("", "fidant.se"), "wss://fidant.se/signal");
  assert.equal(
    signalingUrl("wss://sto.signal.fidant.se/signal", "fidant.se"),
    "wss://sto.signal.fidant.se/signal",
  );
});
