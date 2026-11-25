import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ClientMessage } from "@sigill/protocol";
import { type Direction, openSignal, sealSignal } from "./keys.ts";
import {
  assertFrameFits,
  connectionPath,
  createRecipientPeer,
  createSenderPeer,
  errorName,
  parseSignalPayload,
  RELAY_FALLBACK_MS,
  type SignalPayload,
} from "./peer.ts";

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
  for (const kind of ["restart-offer", "restart-answer"]) {
    assert.deepEqual(parseSignalPayload({ kind, sdp: "v=0" }), { kind, sdp: "v=0" });
  }
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
    { kind: "restart-offer" },
    { kind: "restart-offer", sdp: "" },
    { kind: "restart-answer", sdp: 1 },
    { kind: "restart", sdp: "v=0" },
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

class FakePeerConnection {
  static last: FakePeerConnection;
  config: RTCConfiguration;
  /** The ICE servers of each setConfiguration call. */
  configured: unknown[] = [];
  refuseConfiguration = false;
  restarts = 0;
  added: unknown[] = [];
  iceConnectionState: RTCIceConnectionState = "checking";
  connectionState: RTCPeerConnectionState = "connecting";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate = null;
  onconnectionstatechange = null;
  ondatachannel = null;
  #answering = false;
  #count = 0;
  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePeerConnection.last = this;
  }
  createDataChannel(label: string) {
    return { label, ordered: true, close() {} };
  }
  getConfiguration() {
    return this.config;
  }
  setConfiguration(config: RTCConfiguration) {
    if (this.refuseConfiguration) {
      throw new DOMException("refused", "InvalidModificationError");
    }
    this.config = config;
    this.configured.push(config.iceServers);
  }
  restartIce() {
    this.restarts++;
  }
  async setLocalDescription() {
    const type = this.#answering ? "answer" : "offer";
    this.#answering = false;
    this.localDescription = { type, sdp: `${type} ${++this.#count}` };
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    this.#answering = description.type === "offer";
  }
  async addIceCandidate(candidate: unknown) {
    this.added.push(candidate);
  }
  close() {}
}
globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;

const stun = "stun:turn.example:3478";
const relayServers: RTCIceServer[] = [
  { urls: [stun, "turn:turn.example:3478?transport=udp"], username: "u", credential: "c" },
  { urls: "turns:turn.example:443?transport=tcp", username: "u", credential: "c" },
];
const stunServers: RTCIceServer[] = [{ urls: [stun] }];
const sdp = (ufrag: string) => `v=0\r\na=ice-ufrag:${ufrag}\r\n`;
const ice = (usernameFragment: string | null): SignalPayload => ({
  kind: "ice",
  candidate: { ...candidate, usernameFragment },
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !check(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(check(), "never happened");
}

/** A peer on a fake connection, fed signals sealed by the other side. */
async function open(side: Direction, iceServers = relayServers) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const link = "AAAAAAAAAAAAAAAAAAAAAA";
  const data: string[] = [];
  const closes: string[] = [];
  const options = {
    signaling: {
      send(message: ClientMessage) {
        if (message.t === "relay") {
          data.push(message.data);
        }
        return true;
      },
    },
    linkId: link,
    attempt: "attempt",
    signalKey: key,
    iceServers,
    onOpen() {},
    onClose(reason: string, detail?: string) {
      closes.push(detail ? `${reason}: ${detail}` : reason);
    },
  };
  const peer = side === "s" ? createSenderPeer(options) : createRecipientPeer(options);
  const other: Direction = side === "s" ? "r" : "s";
  return {
    peer,
    pc: FakePeerConnection.last,
    closes,
    deliver: async (payload: SignalPayload) =>
      peer.handleRelay(await sealSignal(key, link, "attempt", other, payload)),
    /** The kinds of the signals sent, once there are `count`. */
    async sent(count: number) {
      await until(() => data.length >= count);
      const opened = await Promise.all(data.map((d) => openSignal(key, link, "attempt", side, d)));
      return opened.map((payload) => (payload as SignalPayload).kind);
    },
  };
}

/** A sender whose relay fallback fired after the answer `sdp("r1")`. Needs mocked timers. */
async function restartedSender(t: TestContext) {
  const sender = await open("s");
  await sender.deliver({ kind: "answer", sdp: sdp("r1") });
  t.mock.timers.tick(RELAY_FALLBACK_MS);
  assert.deepEqual(await sender.sent(2), ["offer", "restart-offer"]);
  return sender;
}

test("both sides start with the STUN URLs only", async () => {
  for (const side of ["s", "r"] as const) {
    const { pc } = await open(side);
    assert.deepEqual(pc.config, { iceServers: [{ urls: [stun] }] });
  }
});

test("the sender adds the relay and restarts ICE once ICE has tried 3 s without it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await open("s");
  await sender.deliver({ kind: "answer", sdp: sdp("r1") });
  t.mock.timers.tick(RELAY_FALLBACK_MS - 1);
  await sender.deliver(ice("r1"));
  assert.equal(sender.pc.restarts, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await sender.sent(2), ["offer", "restart-offer"]);
  assert.equal(sender.pc.restarts, 1);
  assert.deepEqual(sender.pc.configured, [relayServers]);
  await sender.deliver({ kind: "restart-answer", sdp: sdp("r2") });
  assert.equal(sender.pc.remoteDescription?.sdp, sdp("r2"));
  assert.deepEqual(sender.closes, []);
});

test("the sender never restarts without TURN, or once ICE connected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [servers, state] of [
    [stunServers, "checking"],
    [relayServers, "connected"],
    [relayServers, "completed"],
  ] as const) {
    const sender = await open("s", servers);
    await sender.deliver({ kind: "answer", sdp: sdp("r1") });
    sender.pc.iceConnectionState = state;
    t.mock.timers.tick(RELAY_FALLBACK_MS);
    await sender.deliver(ice("r1"));
    assert.equal(sender.pc.restarts, 0, state);
    assert.deepEqual(sender.pc.configured, [], state);
    assert.deepEqual(sender.closes, [], state);
  }
});

test("a browser that refuses the new servers keeps the connection without the relay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await open("s");
  sender.pc.refuseConfiguration = true;
  await sender.deliver({ kind: "answer", sdp: sdp("r1") });
  t.mock.timers.tick(RELAY_FALLBACK_MS);
  await sender.deliver(ice("r1"));
  assert.equal(sender.pc.restarts, 0);
  assert.deepEqual(sender.closes, []);
  assert.deepEqual(await sender.sent(1), ["offer"]);
});

test("close() clears the fallback timer", async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const sender = await open("s");
  const before = timeouts();
  await sender.deliver({ kind: "answer", sdp: sdp("r1") });
  const armed = timeouts();
  assert.equal(armed, before + 1);
  sender.peer.close();
  assert.equal(timeouts(), armed - 1);
});

test("a sender takes one restart-answer, and only after its restart-offer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const early = await open("s");
  await early.deliver({ kind: "answer", sdp: sdp("r1") });
  await early.deliver({ kind: "restart-answer", sdp: sdp("r2") });
  assert.deepEqual(early.closes, ["bad-signal: unexpected restart-answer"]);

  const twice = await restartedSender(t);
  await twice.deliver({ kind: "restart-answer", sdp: sdp("r2") });
  await twice.deliver({ kind: "restart-answer", sdp: sdp("r3") });
  assert.deepEqual(twice.closes, ["bad-signal: unexpected restart-answer"]);
});

test("a recipient takes one restart-offer, and only after the first offer", async () => {
  const early = await open("r");
  await early.deliver({ kind: "restart-offer", sdp: sdp("s1") });
  assert.deepEqual(early.closes, ["bad-signal: unexpected restart-offer"]);

  const recipient = await open("r");
  await recipient.deliver({ kind: "offer", sdp: sdp("s1") });
  await recipient.deliver({ kind: "restart-offer", sdp: sdp("s2") });
  assert.deepEqual(await recipient.sent(2), ["answer", "restart-answer"]);
  assert.deepEqual(recipient.pc.configured, [relayServers]);
  assert.equal(recipient.pc.remoteDescription?.sdp, sdp("s2"));
  await recipient.deliver({ kind: "restart-offer", sdp: sdp("s3") });
  assert.deepEqual(recipient.closes, ["bad-signal: unexpected restart-offer"]);

  const noTurn = await open("r", stunServers);
  await noTurn.deliver({ kind: "offer", sdp: sdp("s1") });
  await noTurn.deliver({ kind: "restart-offer", sdp: sdp("s2") });
  assert.deepEqual(await noTurn.sent(2), ["answer", "restart-answer"]);
  assert.deepEqual(noTurn.pc.configured, []);
});

test("a replayed first offer or answer can't stand in for a restart one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await restartedSender(t);
  await sender.deliver({ kind: "answer", sdp: sdp("r2") });
  assert.deepEqual(sender.closes, ["bad-signal: unexpected answer"]);

  const recipient = await open("r");
  await recipient.deliver({ kind: "offer", sdp: sdp("s1") });
  await recipient.deliver({ kind: "offer", sdp: sdp("s2") });
  assert.deepEqual(recipient.closes, ["bad-signal: unexpected offer"]);
});

test("drops candidates for another ICE username fragment, queued ones too", async () => {
  const recipient = await open("r");
  await recipient.deliver(ice("s0"));
  await recipient.deliver(ice("s1"));
  await recipient.deliver({ kind: "offer", sdp: sdp("s1") });
  await recipient.deliver(ice(null));
  await recipient.deliver({ kind: "restart-offer", sdp: sdp("s2") });
  await recipient.deliver(ice("s1"));
  await recipient.deliver(ice("s2"));
  const added = recipient.pc.added as { usernameFragment: string | null }[];
  assert.deepEqual(
    added.map((c) => c.usernameFragment),
    ["s1", null, "s2"],
  );
  assert.deepEqual(recipient.closes, []);
});
