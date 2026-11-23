import assert from "node:assert/strict";
import { test } from "node:test";
import { frameRecord, headersOf, requestBody } from "./recorder.ts";

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

test("records a request body as base64", () => {
  const body = Buffer.from([0, 1, 254, 255]);
  assert.deepEqual(requestBody("POST", {}, body), { body: "AAH+/w==" });
  assert.deepEqual(requestBody("GET", {}, Buffer.from("odd but kept")), {
    body: Buffer.from("odd but kept").toString("base64"),
  });
});

test("records no body for a method without one", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    assert.deepEqual(requestBody(method, {}, null), {}, method);
  }
});

test("marks a body that Playwright did not expose", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(requestBody(method, {}, null), { bodyMissing: true }, method);
  }
  assert.deepEqual(requestBody("POST", {}, Buffer.alloc(0)), { bodyMissing: true });
  assert.deepEqual(requestBody("POST", { "transfer-encoding": "chunked" }, null), {
    bodyMissing: true,
  });
});

test("records no body when the request says its length is 0", () => {
  assert.deepEqual(requestBody("POST", { "content-length": "0" }, null), {});
});
