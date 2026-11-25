import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { checkNumber, commitFingerprint } from "./check.ts";
import { deriveSignalKey, openSignal, sealSignal } from "./keys.ts";
import { createLink } from "./link.ts";
import {
  assertFrameFits,
  connectionPath,
  createRecipientPeer,
  createSenderPeer,
  errorName,
  type PeerCloseReason,
  type PeerOpenInfo,
  parseSignalPayload,
  RELAY_FALLBACK_MS,
} from "./peer.ts";

const candidate = {
  candidate: "candidate:1 1 udp 2122260223 192.168.1.2 54400 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: "abcd",
};

const HASH = "eJYHYAxO7JqecPu7xarRNkTK0oca8dgQDy9zzSxGpf4";

test("parseSignalPayload accepts commits, offers, answers and candidates", () => {
  assert.deepEqual(parseSignalPayload({ kind: "commit", hash: HASH }), {
    kind: "commit",
    hash: HASH,
  });
  for (const check of [true, false]) {
    assert.deepEqual(parseSignalPayload({ kind: "offer", sdp: "v=0", check }), {
      kind: "offer",
      sdp: "v=0",
      check,
    });
  }
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
    { kind: "commit" },
    { kind: "commit", hash: "" },
    { kind: "commit", hash: HASH.slice(1) },
    { kind: "commit", hash: `${HASH}A` },
    { kind: "commit", hash: `${HASH.slice(1)}+` },
    { kind: "commit", hash: HASH, extra: 1 },
    { kind: "offer" },
    { kind: "offer", sdp: "v=0" },
    { kind: "offer", sdp: "", check: true },
    { kind: "offer", sdp: 1, check: true },
    { kind: "offer", sdp: "v=0", check: "true" },
    { kind: "offer", sdp: "v=0", check: true, name: "x" },
    { kind: "answer", sdp: "v=0", check: true },
    { kind: "restart-offer" },
    { kind: "restart-offer", sdp: "" },
    { kind: "restart-offer", sdp: "v=0", check: true },
    { kind: "restart-answer" },
    { kind: "restart-answer", sdp: "" },
    { kind: "restart-answer", sdp: 1 },
    { kind: "restart-answer", sdp: "v=0", check: true },
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

const SENDER_FP =
  "00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F";
const RECIPIENT_FP =
  "FF:FE:FD:FC:FB:FA:F9:F8:F7:F6:F5:F4:F3:F2:F1:F0:EF:EE:ED:EC:EB:EA:E9:E8:E7:E6:E5:E4:E3:E2:E1:E0";
const OTHER_FP = SENDER_FP.replace("00:", "AA:");

function resetFake(...fingerprints: string[]) {
  FakePeerConnection.fingerprints = fingerprints;
  FakePeerConnection.readBack = undefined;
  FakePeerConnection.localFingerprint = undefined;
  FakePeerConnection.throwOnConstruct = false;
}

function fakeSdp(...lines: string[]): string {
  return ["v=0", "s=-", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", ...lines, ""].join(
    "\r\n",
  );
}

type FakeCert = { getFingerprints(): { algorithm: string; value: string }[] };
type FakeConfiguration = { iceServers?: RTCIceServer[] | undefined };

// Just enough of RTCPeerConnection for startPeer's signaling; each certificate it
// makes carries the next fingerprint from `fingerprints`.
class FakePeerConnection {
  static fingerprints: string[] = [];
  static last: FakePeerConnection | undefined;
  static readBack: ((sdp: string) => string) | undefined;
  static localFingerprint: string | undefined;
  static throwOnConstruct = false;
  static async generateCertificate(): Promise<FakeCert> {
    const value = FakePeerConnection.fingerprints.shift() ?? SENDER_FP;
    return { getFingerprints: () => [{ algorithm: "sha-256", value: value.toLowerCase() }] };
  }
  readonly certificate: FakeCert;
  config: FakeConfiguration;
  /** The ICE servers of each setConfiguration call. */
  configured: unknown[] = [];
  refuseConfiguration = false;
  restarts = 0;
  added: unknown[] = [];
  iceConnectionState = "checking";
  localDescription: { sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  connectionState = "new";
  sctp = null;
  channel: { onopen: (() => void) | null } | undefined;
  onicecandidate = null;
  onconnectionstatechange = null;
  ondatachannel = null;
  constructor(config: FakeConfiguration & { certificates: FakeCert[] }) {
    if (FakePeerConnection.throwOnConstruct) {
      throw new TypeError("bad iceServers");
    }
    this.config = config;
    this.certificate = config.certificates[0] as FakeCert;
    FakePeerConnection.last = this;
  }
  createDataChannel(label: string) {
    this.channel = { onopen: null };
    return Object.assign(this.channel, { label, ordered: true, binaryType: "", close() {} });
  }
  getConfiguration() {
    return this.config;
  }
  setConfiguration(config: FakeConfiguration) {
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
    const [fp] = this.certificate.getFingerprints();
    this.localDescription = {
      sdp: fakeSdp(`a=fingerprint:sha-256 ${FakePeerConnection.localFingerprint ?? fp?.value}`),
    };
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    const read = FakePeerConnection.readBack;
    this.remoteDescription = read ? { ...description, sdp: read(description.sdp) } : description;
  }
  async addIceCandidate(candidate?: unknown) {
    this.added.push(candidate);
  }
  async getStats() {
    return new Map();
  }
  close() {
    this.connectionState = "closed";
  }
}
(globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePeerConnection;

// Taken before any test mocks the timers, so waiting for signals still works.
const realSetTimeout = globalThis.setTimeout;

async function harness(side: "s" | "r", check?: boolean, iceServers: RTCIceServer[] = []) {
  const { linkId, secret } = createLink("https://localhost");
  const key = await deriveSignalKey(secret, linkId);
  const attempt = "A".repeat(22);
  const sent: unknown[] = [];
  const closes: Array<{ reason: PeerCloseReason; detail?: string | undefined }> = [];
  const opens: PeerOpenInfo[] = [];
  const options = {
    signaling: {
      send(message: { t: string; data?: string }) {
        if (message.t === "relay" && message.data) {
          sent.push(openSignal(key, linkId, attempt, side, message.data));
        }
        return true;
      },
    },
    linkId,
    attempt,
    signalKey: key,
    iceServers,
    ...(check === undefined ? {} : { check }),
    onOpen: (_channel: RTCDataChannel, info: PeerOpenInfo) => opens.push(info),
    onClose: (reason: PeerCloseReason, detail?: string) => closes.push({ reason, detail }),
  };
  const peer = side === "s" ? createSenderPeer(options) : createRecipientPeer(options);
  const from = side === "s" ? "r" : "s";
  const relay = async (payload: unknown) =>
    peer.handleRelay(await sealSignal(key, linkId, attempt, from, payload));
  const settle = () => new Promise((resolve) => realSetTimeout(resolve, 10));
  const relayFrom = async (otherAttempt: string, payload: unknown) =>
    peer.handleRelay(await sealSignal(key, linkId, otherAttempt, from, payload));
  /** Every signal sent so far, once at least `count` went out. */
  const signals = async (count = 0) => {
    for (let i = 0; i < 500 && sent.length < count && closes.length === 0; i++) {
      await settle();
    }
    await settle();
    return Promise.all(sent);
  };
  if (side === "r") {
    // The recipient seals its commit in the background, and a peer that fails
    // drops what it has not sent yet, so a test that fails it early waits first.
    await signals(1);
  }
  return { peer, relay, relayFrom, signals, closes, opens };
}

test("the sender offers only after the recipient's commitment, with its check setting", async () => {
  FakePeerConnection.fingerprints = [SENDER_FP];
  const h = await harness("s", true);
  assert.deepEqual(await h.signals(), []);
  await h.relay({ kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) });
  const [offer] = (await h.signals(1)) as Array<{ kind: string; sdp: string; check: boolean }>;
  assert.equal(offer?.kind, "offer");
  assert.equal(offer?.check, true);
  assert.match(offer?.sdp ?? "", new RegExp(SENDER_FP.toLowerCase()));
  assert.deepEqual(h.closes, []);
});

test("an answer that matches the commitment opens with both fingerprints' number", async () => {
  FakePeerConnection.fingerprints = [SENDER_FP];
  const h = await harness("s");
  await h.relay({ kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) });
  await h.relay({ kind: "answer", sdp: fakeSdp(`a=fingerprint:sha-256 ${RECIPIENT_FP}`) });
  FakePeerConnection.last?.channel?.onopen?.();
  const [info] = h.opens;
  assert.equal(info?.check, false);
  assert.equal(await info?.checkNumber, await checkNumber(SENDER_FP, RECIPIENT_FP));
  assert.deepEqual(h.closes, []);
});

test("the sender refuses an answer that does not match the commitment", async () => {
  FakePeerConnection.fingerprints = [SENDER_FP];
  const h = await harness("s");
  await h.relay({ kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) });
  await h.relay({ kind: "answer", sdp: fakeSdp(`a=fingerprint:sha-256 ${OTHER_FP}`) });
  assert.deepEqual(h.closes, [
    { reason: "bad-signal", detail: "answer does not match the commitment" },
  ]);
  assert.equal(FakePeerConnection.last?.remoteDescription, null);
});

test("the sender refuses an answer before any commitment", async () => {
  FakePeerConnection.fingerprints = [SENDER_FP];
  const h = await harness("s");
  await h.relay({ kind: "answer", sdp: fakeSdp(`a=fingerprint:sha-256 ${RECIPIENT_FP}`) });
  assert.equal(h.closes[0]?.reason, "bad-signal");
  assert.deepEqual(await h.signals(), []);
});

test("the sender refuses a second commitment", async () => {
  FakePeerConnection.fingerprints = [SENDER_FP];
  const h = await harness("s");
  const hash = await commitFingerprint(RECIPIENT_FP);
  await h.relay({ kind: "commit", hash });
  await h.relay({ kind: "commit", hash });
  assert.equal(h.closes[0]?.reason, "bad-signal");
});

test("the recipient commits to its certificate before anything else", async () => {
  FakePeerConnection.fingerprints = [RECIPIENT_FP];
  const h = await harness("r");
  assert.deepEqual(await h.signals(1), [
    { kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) },
  ]);
});

test("the recipient answers an offer, keeps its check flag and refuses a commitment", async () => {
  FakePeerConnection.fingerprints = [RECIPIENT_FP];
  const h = await harness("r");
  assert.equal(h.peer.answered, false);
  await h.relay({ kind: "offer", sdp: fakeSdp(`a=fingerprint:sha-256 ${SENDER_FP}`), check: true });
  assert.equal(h.peer.answered, true);
  const [, answer] = (await h.signals(2)) as Array<{ kind: string }>;
  assert.equal(answer?.kind, "answer");
  const pc = FakePeerConnection.last as unknown as {
    ondatachannel: (event: { channel: object }) => void;
  };
  const channel: { onopen: (() => void) | null } = { onopen: null };
  pc.ondatachannel({
    channel: Object.assign(channel, { label: "sigill", ordered: true, close() {} }),
  });
  channel.onopen?.();
  const [info] = h.opens;
  assert.equal(info?.check, true);
  assert.equal(await info?.checkNumber, await checkNumber(SENDER_FP, RECIPIENT_FP));

  await h.relay({ kind: "commit", hash: await commitFingerprint(SENDER_FP) });
  assert.equal(h.closes[0]?.reason, "bad-signal");
});

test("the recipient refuses an offer with a second fingerprint of another algorithm", async () => {
  FakePeerConnection.fingerprints = [RECIPIENT_FP];
  const h = await harness("r");
  await h.relay({
    kind: "offer",
    sdp: fakeSdp(`a=fingerprint:sha-256 ${SENDER_FP}`, `a=fingerprint:sha-1 ${OTHER_FP}`),
    check: false,
  });
  assert.equal(h.closes[0]?.reason, "bad-signal");
  assert.equal(FakePeerConnection.last?.remoteDescription, null);
});

test("the recipient sends no answer and no number when the browser read another fingerprint", async () => {
  for (const read of [
    (sdp: string) => sdp.replace(SENDER_FP, OTHER_FP),
    (sdp: string) => `${sdp}a=fingerprint:sha-256 ${OTHER_FP}\r\n`,
  ]) {
    resetFake(RECIPIENT_FP);
    FakePeerConnection.readBack = read;
    const h = await harness("r");
    // The commit goes out before the offer arrives; closing first would drop it.
    await h.signals(1);
    await h.relay({
      kind: "offer",
      sdp: fakeSdp(`a=fingerprint:sha-256 ${SENDER_FP}`),
      check: true,
    });
    assert.deepEqual(h.closes, [
      { reason: "bad-signal", detail: "the browser read another fingerprint" },
    ]);
    assert.equal(h.peer.answered, false);
    assert.deepEqual(await h.signals(1), [
      { kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) },
    ]);
  }
});

test("the sender opens no number when the browser read another fingerprint", async () => {
  for (const read of [
    (sdp: string) => sdp.replace(RECIPIENT_FP, OTHER_FP),
    (sdp: string) => `${sdp}a=fingerprint:sha-256 ${OTHER_FP}\r\n`,
  ]) {
    resetFake(SENDER_FP);
    FakePeerConnection.readBack = read;
    const h = await harness("s");
    await h.relay({ kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) });
    FakePeerConnection.last?.channel?.onopen?.();
    const [info] = h.opens;
    assert.ok(info);
    await h.relay({ kind: "answer", sdp: fakeSdp(`a=fingerprint:sha-256 ${RECIPIENT_FP}`) });
    assert.deepEqual(h.closes, [
      { reason: "bad-signal", detail: "the browser read another fingerprint" },
    ]);
    const pending = new Promise((resolve) => setTimeout(resolve, 10, "pending"));
    assert.equal(await Promise.race([info.checkNumber, pending]), "pending");
  }
});

test("the recipient fails locally when its answer names another certificate", async () => {
  resetFake(RECIPIENT_FP);
  FakePeerConnection.localFingerprint = OTHER_FP;
  const h = await harness("r");
  await h.signals(1);
  await h.relay({ kind: "offer", sdp: fakeSdp(`a=fingerprint:sha-256 ${SENDER_FP}`), check: true });
  assert.equal(h.closes[0]?.reason, "setup-failed");
  assert.equal(h.peer.answered, false);
  assert.equal((await h.signals(1)).length, 1);
});

test("a recipient whose certificate has no sha-256 fingerprint closes as unsupported", async () => {
  resetFake("XX");
  const h = await harness("r");
  assert.equal(h.closes[0]?.reason, "unsupported");
  assert.deepEqual(await h.signals(), []);
});

test("a connection that will not construct closes as setup-failed, not unsupported", async () => {
  resetFake(SENDER_FP);
  FakePeerConnection.throwOnConstruct = true;
  const h = await harness("s");
  await h.signals();
  assert.equal(h.closes[0]?.reason, "setup-failed");
});

test("a browser without RTCPeerConnection closes as unsupported", async () => {
  const g = globalThis as { RTCPeerConnection?: unknown };
  g.RTCPeerConnection = undefined;
  try {
    resetFake(SENDER_FP);
    const h = await harness("s");
    await h.signals();
    assert.equal(h.closes[0]?.reason, "unsupported");
  } finally {
    g.RTCPeerConnection = FakePeerConnection;
  }
});

test("after the answer the sender ignores signals sealed for another attempt or garbage", async () => {
  resetFake(SENDER_FP);
  const h = await harness("s");
  await h.relay({ kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) });
  await h.relay({ kind: "answer", sdp: fakeSdp(`a=fingerprint:sha-256 ${RECIPIENT_FP}`) });
  await h.relayFrom("B".repeat(22), {
    kind: "commit",
    hash: await commitFingerprint(OTHER_FP),
  });
  await h.peer.handleRelay("not a sealed signal");
  assert.deepEqual(h.closes, []);
  FakePeerConnection.last?.channel?.onopen?.();
  assert.equal(h.opens.length, 1);
});

test("before the answer the sender still closes on a signal that does not open", async () => {
  resetFake(SENDER_FP);
  const h = await harness("s");
  await h.relay({ kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) });
  await h.relayFrom("B".repeat(22), { kind: "ice", candidate: null });
  assert.equal(h.closes[0]?.reason, "bad-signal");
});

test("the recipient closes on a signal that does not open, even after its answer", async () => {
  resetFake(RECIPIENT_FP);
  const h = await harness("r");
  await h.relay({ kind: "offer", sdp: fakeSdp(`a=fingerprint:sha-256 ${SENDER_FP}`), check: true });
  await h.peer.handleRelay("not a sealed signal");
  assert.equal(h.closes[0]?.reason, "bad-signal");
});

const stun = "stun:turn.example:3478";
const relayServers: RTCIceServer[] = [
  { urls: [stun, "turn:turn.example:3478?transport=udp"], username: "u", credential: "c" },
  { urls: "turns:turn.example:443?transport=tcp", username: "u", credential: "c" },
];
const stunServers: RTCIceServer[] = [{ urls: [stun] }];
const sdpWith = (fingerprint: string, ufrag: string) =>
  fakeSdp(`a=fingerprint:sha-256 ${fingerprint}`, `a=ice-ufrag:${ufrag}`);
const ice = (usernameFragment: string | null) => ({
  kind: "ice",
  candidate: { ...candidate, usernameFragment },
});

function lastPc(): FakePeerConnection {
  assert.ok(FakePeerConnection.last, "no connection yet");
  return FakePeerConnection.last;
}

/** The kinds of the signals sent, once there are `count`. */
async function kinds(h: { signals(count: number): Promise<unknown[]> }, count: number) {
  return ((await h.signals(count)) as Array<{ kind: string }>).map((s) => s.kind);
}

/** A sender that took the recipient's commitment and its answer, ICE username fragment "r1". */
async function answeredSender(servers = relayServers) {
  resetFake(SENDER_FP);
  const h = await harness("s", undefined, servers);
  await h.relay({ kind: "commit", hash: await commitFingerprint(RECIPIENT_FP) });
  await h.relay({ kind: "answer", sdp: sdpWith(RECIPIENT_FP, "r1") });
  return { ...h, pc: lastPc() };
}

/** A recipient that answered an offer with ICE username fragment "s1". */
async function answeredRecipient(servers = relayServers) {
  resetFake(RECIPIENT_FP);
  const h = await harness("r", undefined, servers);
  await h.relay({ kind: "offer", sdp: sdpWith(SENDER_FP, "s1"), check: false });
  return { ...h, pc: lastPc() };
}

/** An answered sender whose relay fallback fired. Needs mocked timers. */
async function restartedSender(t: TestContext) {
  const sender = await answeredSender();
  t.mock.timers.tick(RELAY_FALLBACK_MS);
  assert.deepEqual(await kinds(sender, 2), ["offer", "restart-offer"]);
  return sender;
}

test("both sides start with the STUN URLs only", async () => {
  for (const side of ["s", "r"] as const) {
    resetFake();
    const h = await harness(side, undefined, relayServers);
    await h.relay(ice(null));
    assert.deepEqual(lastPc().config.iceServers, [{ urls: [stun] }], side);
  }
});

test("the sender adds the relay and restarts ICE once ICE has tried 3 s without it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await answeredSender();
  t.mock.timers.tick(RELAY_FALLBACK_MS - 1);
  await sender.relay(ice("r1"));
  assert.equal(sender.pc.restarts, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await kinds(sender, 2), ["offer", "restart-offer"]);
  assert.equal(sender.pc.restarts, 1);
  assert.deepEqual(sender.pc.configured, [relayServers]);
  await sender.relay({ kind: "restart-answer", sdp: sdpWith(RECIPIENT_FP, "r2") });
  assert.equal(sender.pc.remoteDescription?.sdp, sdpWith(RECIPIENT_FP, "r2"));
  assert.deepEqual(sender.closes, []);
});

test("the sender never restarts without TURN, or once ICE connected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [servers, state] of [
    [stunServers, "checking"],
    [relayServers, "connected"],
    [relayServers, "completed"],
  ] as const) {
    const sender = await answeredSender(servers);
    sender.pc.iceConnectionState = state;
    t.mock.timers.tick(RELAY_FALLBACK_MS);
    await sender.relay(ice("r1"));
    assert.equal(sender.pc.restarts, 0, state);
    assert.deepEqual(sender.pc.configured, [], state);
    assert.deepEqual(sender.closes, [], state);
  }
});

test("a browser that refuses the new servers keeps the connection without the relay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await answeredSender();
  sender.pc.refuseConfiguration = true;
  t.mock.timers.tick(RELAY_FALLBACK_MS);
  await sender.relay(ice("r1"));
  assert.equal(sender.pc.restarts, 0);
  assert.deepEqual(sender.closes, []);
  assert.deepEqual(await kinds(sender, 1), ["offer"]);
});

test("close() stops the relay fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await answeredSender();
  sender.peer.close();
  t.mock.timers.tick(RELAY_FALLBACK_MS);
  assert.deepEqual(await kinds(sender, 1), ["offer"]);
  assert.equal(sender.pc.restarts, 0);
  assert.deepEqual(sender.pc.configured, []);

  const fired = await answeredSender();
  t.mock.timers.tick(RELAY_FALLBACK_MS);
  fired.peer.close();
  assert.deepEqual(await kinds(fired, 1), ["offer"]);
  assert.equal(fired.pc.restarts, 0);
  assert.deepEqual(fired.pc.configured, []);
});

test("the sender does not restart once its channel is open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await answeredSender();
  (sender.pc.channel as { readyState?: string }).readyState = "open";
  sender.pc.iceConnectionState = "disconnected";
  t.mock.timers.tick(RELAY_FALLBACK_MS);
  await sender.relay(ice("r1"));
  assert.equal(sender.pc.restarts, 0);
  assert.deepEqual(sender.pc.configured, []);
  assert.deepEqual(sender.closes, []);
  assert.deepEqual(await kinds(sender, 1), ["offer"]);
});

test("the sent restart-offer names the first certificate and carries no check flag", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await restartedSender(t);
  const restart = (await sender.signals(2))[1] as { sdp: string; check?: unknown };
  assert.equal("check" in restart, false);
  assert.match(restart.sdp, new RegExp(SENDER_FP.toLowerCase()));
});

test("each side refuses the restart signal meant for the other", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await answeredSender();
  await sender.relay({ kind: "restart-offer", sdp: sdpWith(RECIPIENT_FP, "r2") });
  assert.deepEqual(sender.closes, [{ reason: "bad-signal", detail: "unexpected restart-offer" }]);

  const recipient = await answeredRecipient();
  await recipient.relay({ kind: "restart-offer", sdp: sdpWith(SENDER_FP, "s2") });
  await recipient.relay({ kind: "restart-answer", sdp: sdpWith(SENDER_FP, "s3") });
  assert.deepEqual(recipient.closes, [
    { reason: "bad-signal", detail: "unexpected restart-answer" },
  ]);
});

/** Brings the path up as `how` and returns the function that takes it down again. */
function pathUp(pc: FakePeerConnection, how: "open" | "connected" | "completed") {
  if (how === "open") {
    const channel = pc.channel ?? { label: "sigill", ordered: true, readyState: "", close() {} };
    if (!pc.channel) {
      (pc.ondatachannel as unknown as (e: { channel: object }) => void)({ channel });
    }
    Object.assign(channel, { readyState: "open" });
    return () => Object.assign(channel, { readyState: "closed" });
  }
  pc.iceConnectionState = how;
  return () => {
    pc.iceConnectionState = "checking";
  };
}

test("the recipient ignores a restart-offer once its channel is open or ICE connected", async () => {
  for (const how of ["open", "connected", "completed"] as const) {
    const recipient = await answeredRecipient();
    const down = pathUp(recipient.pc, how);
    await recipient.relay({ kind: "restart-offer", sdp: sdpWith(SENDER_FP, "s2") });
    down();
    await recipient.relay({ kind: "restart-offer", sdp: sdpWith(SENDER_FP, "s2") });
    assert.deepEqual(recipient.closes, [], how);
    assert.deepEqual(recipient.pc.configured, [], how);
    assert.equal(recipient.pc.remoteDescription?.sdp, sdpWith(SENDER_FP, "s1"), how);
    assert.deepEqual(await kinds(recipient, 2), ["commit", "answer"], how);
  }
});

test("the sender ignores a restart-answer once its channel is open or ICE connected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const how of ["open", "connected", "completed"] as const) {
    const sender = await restartedSender(t);
    const down = pathUp(sender.pc, how);
    await sender.relay({ kind: "restart-answer", sdp: sdpWith(RECIPIENT_FP, "r2") });
    down();
    await sender.relay({ kind: "restart-answer", sdp: sdpWith(RECIPIENT_FP, "r2") });
    assert.deepEqual(sender.closes, [], how);
    assert.equal(sender.pc.remoteDescription?.sdp, sdpWith(RECIPIENT_FP, "r1"), how);
  }
});

test("a sender takes one restart-answer, and only after its restart-offer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const early = await answeredSender();
  await early.relay({ kind: "restart-answer", sdp: sdpWith(RECIPIENT_FP, "r2") });
  assert.deepEqual(early.closes, [{ reason: "bad-signal", detail: "unexpected restart-answer" }]);

  const twice = await restartedSender(t);
  await twice.relay({ kind: "restart-answer", sdp: sdpWith(RECIPIENT_FP, "r2") });
  await twice.relay({ kind: "restart-answer", sdp: sdpWith(RECIPIENT_FP, "r3") });
  assert.deepEqual(twice.closes, [{ reason: "bad-signal", detail: "unexpected restart-answer" }]);
});

test("a recipient takes one restart-offer, and only after its answer", async () => {
  resetFake(RECIPIENT_FP);
  const early = await harness("r", undefined, relayServers);
  await early.relay({ kind: "restart-offer", sdp: sdpWith(SENDER_FP, "s1") });
  assert.deepEqual(early.closes, [{ reason: "bad-signal", detail: "unexpected restart-offer" }]);

  const recipient = await answeredRecipient();
  await recipient.relay({ kind: "restart-offer", sdp: sdpWith(SENDER_FP, "s2") });
  assert.deepEqual(await kinds(recipient, 3), ["commit", "answer", "restart-answer"]);
  assert.deepEqual(recipient.pc.configured, [relayServers]);
  assert.equal(recipient.pc.restarts, 0);
  assert.equal(recipient.pc.remoteDescription?.sdp, sdpWith(SENDER_FP, "s2"));
  await recipient.relay({ kind: "restart-offer", sdp: sdpWith(SENDER_FP, "s3") });
  assert.deepEqual(recipient.closes, [
    { reason: "bad-signal", detail: "unexpected restart-offer" },
  ]);

  const noTurn = await answeredRecipient(stunServers);
  await noTurn.relay({ kind: "restart-offer", sdp: sdpWith(SENDER_FP, "s2") });
  assert.deepEqual(await kinds(noTurn, 3), ["commit", "answer", "restart-answer"]);
  assert.deepEqual(noTurn.pc.configured, []);
});

test("a replayed first offer or answer can't stand in for a restart one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = await restartedSender(t);
  await sender.relay({ kind: "answer", sdp: sdpWith(RECIPIENT_FP, "r2") });
  assert.deepEqual(sender.closes, [{ reason: "bad-signal", detail: "unexpected answer" }]);

  const recipient = await answeredRecipient();
  await recipient.relay({ kind: "offer", sdp: sdpWith(SENDER_FP, "s2"), check: false });
  assert.deepEqual(recipient.closes, [{ reason: "bad-signal", detail: "unexpected offer" }]);
});

test("a restart must name the same two certificates as the check number", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const recipient = await answeredRecipient();
  await recipient.relay({ kind: "restart-offer", sdp: sdpWith(OTHER_FP, "s2") });
  assert.deepEqual(recipient.closes, [
    { reason: "bad-signal", detail: "the restart names another certificate" },
  ]);
  assert.equal(recipient.pc.remoteDescription?.sdp, sdpWith(SENDER_FP, "s1"));
  assert.deepEqual(recipient.pc.configured, []);

  const sender = await restartedSender(t);
  await sender.relay({ kind: "restart-answer", sdp: sdpWith(OTHER_FP, "r2") });
  assert.deepEqual(sender.closes, [
    { reason: "bad-signal", detail: "the restart names another certificate" },
  ]);
  assert.equal(sender.pc.remoteDescription?.sdp, sdpWith(RECIPIENT_FP, "r1"));

  const own = await answeredSender();
  FakePeerConnection.localFingerprint = OTHER_FP;
  t.mock.timers.tick(RELAY_FALLBACK_MS);
  await own.relay(ice("r1"));
  assert.deepEqual(own.closes, [
    { reason: "setup-failed", detail: "the restart offer names another certificate" },
  ]);
  assert.deepEqual(await kinds(own, 1), ["offer"]);
  resetFake();
});

test("drops candidates for another ICE username fragment, queued ones too", async () => {
  resetFake(RECIPIENT_FP);
  const recipient = await harness("r", undefined, relayServers);
  await recipient.relay(ice("s0"));
  await recipient.relay(ice("s1"));
  await recipient.relay({ kind: "offer", sdp: sdpWith(SENDER_FP, "s1"), check: false });
  await recipient.relay(ice(null));
  await recipient.relay({ kind: "restart-offer", sdp: sdpWith(SENDER_FP, "s2") });
  await recipient.relay(ice("s1"));
  await recipient.relay(ice("s2"));
  const added = lastPc().added as { usernameFragment: string | null }[];
  assert.deepEqual(
    added.map((c) => c.usernameFragment),
    ["s1", null, "s2"],
  );
  assert.deepEqual(recipient.closes, []);
});
