import assert from "node:assert/strict";
import { test } from "node:test";
import { frameRecord, headersOf } from "./recorder.ts";

const url = "wss://localhost:51234/signal";

test("records a text frame as it is", () => {
  const record = frameRecord("frame-sent", url, '{"type":"hello"}');
  assert.deepEqual(record, {
    type: "frame-sent",
    time: record.time,
    url,
    payload: '{"type":"hello"}',
  });
  assert.ok(!Number.isNaN(Date.parse(record.time)), record.time);
});

test("records a binary frame as base64", () => {
  const record = frameRecord("frame-received", url, Buffer.from([0, 1, 254, 255]));
  assert.deepEqual(record, {
    type: "frame-received",
    time: record.time,
    url,
    payload: "AAH+/w==",
    base64: true,
  });
});

test("uses all headers when the browser has them", async () => {
  const all = { cookie: "a=1", host: "localhost:51234" };
  assert.deepEqual(await headersOf(Promise.resolve(all), { host: "localhost:51234" }), all);
});

test("falls back to the provisional headers once the context has closed", async () => {
  const closed = Promise.reject(new Error("Target page, context or browser has been closed"));
  assert.deepEqual(await headersOf(closed, { host: "localhost:51234" }), {
    host: "localhost:51234",
  });
});
