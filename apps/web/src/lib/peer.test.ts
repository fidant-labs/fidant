import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFrameFits, connectionPath, errorName, parseSignalPayload } from "./peer.ts";

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

function statsWith(local: string, remote: string, selected = true): Map<string, object> {
  return new Map<string, object>([
    ["T1", { type: "transport", ...(selected ? { selectedCandidatePairId: "P1" } : {}) }],
    [
      "P0",
      {
        type: "candidate-pair",
        nominated: false,
        state: "failed",
        localCandidateId: "L0",
        remoteCandidateId: "R0",
      },
    ],
    [
      "P1",
      {
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        localCandidateId: "L1",
        remoteCandidateId: "R1",
      },
    ],
    ["L0", { type: "local-candidate", candidateType: "relay" }],
    ["R0", { type: "remote-candidate", candidateType: "relay" }],
    ["L1", { type: "local-candidate", candidateType: local }],
    ["R1", { type: "remote-candidate", candidateType: remote }],
  ]);
}

test("connectionPath reads the selected candidate pair's types", () => {
  assert.equal(connectionPath(statsWith("host", "host")), "direct");
  assert.equal(connectionPath(statsWith("srflx", "host")), "stun");
  assert.equal(connectionPath(statsWith("host", "prflx")), "stun");
  assert.equal(connectionPath(statsWith("host", "relay")), "relay");
  assert.equal(connectionPath(statsWith("relay", "srflx")), "relay");
});

test("connectionPath falls back to the nominated succeeded pair", () => {
  assert.equal(connectionPath(statsWith("relay", "host", false)), "relay");
  assert.equal(connectionPath(statsWith("host", "host", false)), "direct");
});

test("connectionPath says direct when no pair is found", () => {
  assert.equal(connectionPath(new Map()), "direct");
});

test("errorName keeps only names that are plain identifiers", () => {
  assert.equal(errorName(new DOMException("a=ice-pwd:x", "OperationError")), "OperationError");
  assert.equal(errorName(new TypeError("x")), "TypeError");
  for (const name of ["", "a=ice-pwd:x", "Operation Error", "Error2", "x".repeat(41)]) {
    assert.equal(errorName(Object.assign(new Error("x"), { name })), undefined, name);
  }
  assert.equal(errorName("OperationError"), undefined);
  assert.equal(errorName({ name: "OperationError" }), undefined);
});
