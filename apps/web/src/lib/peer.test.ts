import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFrameFits, parseIceServers, parseSignalPayload } from "./peer.ts";

const candidate = {
  candidate: "candidate:1 1 udp 2122260223 192.168.1.2 54400 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: "abcd",
};

test("parseSignalPayload accepts offers, answers and candidates", () => {
  assert.deepEqual(parseSignalPayload({ kind: "offer", sdp: "v=0" }), {
    kind: "offer",
    sdp: "v=0",
  });
  assert.deepEqual(parseSignalPayload({ kind: "answer", sdp: "v=0" }), {
    kind: "answer",
    sdp: "v=0",
  });
  assert.deepEqual(parseSignalPayload({ kind: "ice", candidate }), { kind: "ice", candidate });
  assert.deepEqual(parseSignalPayload({ kind: "ice", candidate: null }), {
    kind: "ice",
    candidate: null,
  });
  const nulls = { candidate: "", sdpMid: null, sdpMLineIndex: null, usernameFragment: null };
  assert.deepEqual(parseSignalPayload({ kind: "ice", candidate: nulls }), {
    kind: "ice",
    candidate: nulls,
  });
});

test("parseSignalPayload rejects anything else", () => {
  for (const value of [
    null,
    "offer",
    [],
    {},
    { kind: "offer" },
    { kind: "offer", sdp: "" },
    { kind: "offer", sdp: 1 },
    { kind: "offer", sdp: "v=0", name: "x" },
    { kind: "bye" },
    { kind: "ice" },
    { kind: "ice", candidate: "x" },
    { kind: "ice", candidate: { ...candidate, sdpMLineIndex: -1 } },
    { kind: "ice", candidate: { ...candidate, sdpMLineIndex: 0.5 } },
    { kind: "ice", candidate: { ...candidate, sdpMid: 0 } },
    { kind: "ice", candidate: { ...candidate, extra: 1 } },
    { kind: "ice", candidate: { candidate: candidate.candidate } },
  ]) {
    assert.equal(parseSignalPayload(value), undefined, JSON.stringify(value));
  }
});

test("assertFrameFits throws only for frames over the limit", () => {
  assertFrameFits(65536, 65536);
  assertFrameFits(Number.POSITIVE_INFINITY, 1 << 30);
  assert.throws(() => assertFrameFits(65536, 65537));
});

test("parseIceServers accepts the /ice-servers response", () => {
  assert.deepEqual(parseIceServers({ iceServers: [] }), []);
  const turn = {
    urls: ["turn:127.0.0.1:3478?transport=udp"],
    username: "1700000000",
    credential: "c2VjcmV0",
  };
  assert.deepEqual(parseIceServers({ iceServers: [turn] }), [turn]);
  assert.deepEqual(parseIceServers({ iceServers: [{ urls: "stun:127.0.0.1:3478" }] }), [
    { urls: "stun:127.0.0.1:3478" },
  ]);
});

test("parseIceServers drops unknown fields", () => {
  assert.deepEqual(parseIceServers({ iceServers: [{ urls: "turn:a", extra: 1 }], more: true }), [
    { urls: "turn:a" },
  ]);
});

test("parseIceServers rejects anything else", () => {
  for (const value of [
    null,
    "x",
    [],
    {},
    { iceServers: null },
    { iceServers: {} },
    { iceServers: [null] },
    { iceServers: ["turn:a"] },
    { iceServers: [{}] },
    { iceServers: [{ urls: 1 }] },
    { iceServers: [{ urls: [] }] },
    { iceServers: [{ urls: ["turn:a", 1] }] },
    { iceServers: [{ urls: "turn:a", username: 1 }] },
    { iceServers: [{ urls: "turn:a", credential: {} }] },
  ]) {
    assert.equal(parseIceServers(value), undefined, JSON.stringify(value));
  }
});
