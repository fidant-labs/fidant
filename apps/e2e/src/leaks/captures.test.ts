import assert from "node:assert/strict";
import { test } from "node:test";
import type { ObservationRecord } from "../observations.ts";
import { logCaptures, logSlice, recordCaptures } from "./captures.ts";

const time = "2026-11-23T00:00:00.000Z";
const url = "https://localhost:51234/a?b=c";
const file = "observations/t/sender.jsonl";

/** `point = text` for each capture, for compact assertions. */
const shown = (captures: { point: string; bytes: Uint8Array }[]) =>
  captures.map(({ point, bytes }) => `${point} = ${Buffer.from(bytes).toString("latin1")}`);

test("captures a request's URL, each header and its decoded body", () => {
  const records: ObservationRecord[] = [
    { type: "websocket-open", time, url: "wss://localhost:51234/signal" },
    {
      type: "request",
      time,
      method: "POST",
      url,
      headers: { referer: "https://localhost:51234/", "content-type": "text/plain" },
      body: Buffer.from("hello").toString("base64"),
    },
  ];
  assert.deepEqual(shown(recordCaptures(file, records)), [
    `${file}#1 websocket-open.url = wss://localhost:51234/signal`,
    `${file}#2 request.url = ${url}`,
    `${file}#2 request.headers.referer = referer: https://localhost:51234/`,
    `${file}#2 request.headers.content-type = content-type: text/plain`,
    `${file}#2 request.body = hello`,
  ]);
});

test("passes the request's content-encoding as a decode hint", () => {
  const [, body] = recordCaptures(file, [
    {
      type: "request",
      time,
      method: "POST",
      url,
      headers: {},
      body: "AA==",
    },
    {
      type: "request",
      time,
      method: "POST",
      url,
      headers: { "content-encoding": "br" },
      body: "AA==",
    },
  ]).filter((capture) => capture.point.endsWith("body"));
  assert.deepEqual(body?.hints, { contentEncoding: "br" });
});

test("captures response headers, failures and blocked URLs", () => {
  const records: ObservationRecord[] = [
    { type: "response", time, url, status: 200, headers: { "set-cookie": "a=1" } },
    { type: "requestfailed", time, url, failure: "net::ERR_ABORTED" },
    { type: "blocked", time, url: "https://example.com/", kind: "http" },
  ];
  assert.deepEqual(shown(recordCaptures(file, records)), [
    `${file}#1 response.url = ${url}`,
    `${file}#1 response.headers.set-cookie = set-cookie: a=1`,
    `${file}#2 requestfailed.url = ${url}`,
    `${file}#2 requestfailed.failure = net::ERR_ABORTED`,
    `${file}#3 blocked.url = https://example.com/`,
  ]);
});

test("captures text frames as they are and binary frames decoded", () => {
  const ws = "wss://localhost:51234/signal";
  const captures = recordCaptures(file, [
    { type: "frame-sent", time, url: ws, payload: '{"t":"host","links":[]}' },
    { type: "frame-received", time, url: ws, payload: "AAH+/w==", base64: true },
  ]);
  assert.equal(captures[1]?.point, `${file}#1 frame-sent.payload`);
  assert.equal(Buffer.from(captures[1]?.bytes ?? []).toString(), '{"t":"host","links":[]}');
  assert.equal(captures[3]?.point, `${file}#2 frame-received.payload`);
  assert.deepEqual([...(captures[3]?.bytes ?? [])], [0, 1, 254, 255]);
});

const log = Buffer.from("one\ntwo\nthree\nfou");

test("slices a whole log into its complete lines", () => {
  assert.deepEqual(logSlice(log), { lines: ["one", "two", "three"], firstLine: 1 });
  assert.deepEqual(logSlice(Buffer.alloc(0)), { lines: [], firstLine: 1 });
  assert.deepEqual(logSlice(Buffer.from("a\n\nb\n")), { lines: ["a", "", "b"], firstLine: 1 });
});

test("slices from a line start, counting the lines before it", () => {
  assert.deepEqual(logSlice(log, 4), { lines: ["two", "three"], firstLine: 2 });
  assert.deepEqual(logSlice(log, 8), { lines: ["three"], firstLine: 3 });
});

test("leaves out a line that began before the start or is still being written", () => {
  assert.deepEqual(logSlice(log, 5), { lines: ["three"], firstLine: 3 });
  assert.deepEqual(logSlice(log, 14), { lines: [], firstLine: 4 });
  assert.deepEqual(logSlice(log, 100), { lines: [], firstLine: 4 });
});

test("names each log line by file and line number", () => {
  assert.deepEqual(shown(logCaptures("observations/run/server.stdout.log", logSlice(log, 4))), [
    "observations/run/server.stdout.log:2 = two",
    "observations/run/server.stdout.log:3 = three",
  ]);
});
