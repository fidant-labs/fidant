// A WebRTC connection between the sender and one recipient, signaled through
// the server with every SDP and ICE message sealed by the link's signal key.
//
// Message flow for one link:
//
//   recipient → server   join {link, attempt}
//   server → recipient   joined {link, attempt, iceServers, turn}   (recipient: createRecipientPeer)
//   recipient → sender   relay seal_r({kind:"commit", hash})   hash = commitFingerprint(its fingerprint)
//   server → sender      joined {link, attempt, iceServers, turn}   (sender: createSenderPeer)
//   sender               waits for the commit, then makes the offer
//   sender → recipient   relay seal_s({kind:"offer", sdp, check})
//   recipient → sender   relay seal_r({kind:"answer", sdp})   its fingerprint must match the commit
//   both directions      relay seal({kind:"ice", candidate})   (trickle; null = end)
//   sender ⇄ recipient   data channel "sigill" opens → onOpen(channel, info)
//
// Each side makes a fresh DTLS certificate for every connection. The recipient
// commits to its certificate's fingerprint before the sender's offer exists, so
// someone in the middle must fix both certificates before it can learn the
// check number they give (check.ts). Every SDP must carry exactly one sha-256
// fingerprint. `check` says whether the sender's page will ask for the check
// number; the server can flip it only for an emailed link, and then the two
// pages disagree and nothing about the file is sent (see frames.ts).
//
// seal_s/seal_r are sealSignal with direction "s"/"r"; the receiving side opens
// with the other side's direction, so the server cannot reflect a message back,
// swap one link's signals into another, or replay one attempt's signals into
// another (the attempt ID is in the AAD too; see keys.ts). The server only sees link IDs and
// opaque blobs: no SDP, no candidates, no DTLS fingerprints.
//
// Outgoing signals are sealed and sent in order through one queue; incoming
// relay data is handled in order through another. ICE candidates that arrive
// before the remote description are held until it is set.
//
// No DOM or UI here, and nothing about files or names: the data channel
// carries only encrypted frames (frames.ts), and its label is fixed.

import type { ClientMessage, ConnectionPath } from "@sigill/protocol";
import { decodeBase64url } from "./base64url.ts";
import { certificateFingerprint, checkNumber, commitFingerprint, sdpFingerprint } from "./check.ts";
import { type Direction, openSignal, sealSignal } from "./keys.ts";

/** The data channel label. Fixed and neutral: never a file or recipient name. */
export const CHANNEL_LABEL = "sigill";

/**
 * SCTP max message size to assume if the browser does not report one. RFC 8841
 * says 64 KiB when the remote SDP has no max-message-size attribute.
 */
export const DEFAULT_MAX_MESSAGE_SIZE = 65536;

/** How long to wait before reading a "stun" path again (see readPath). */
const PATH_RECHECK_MS = 1000;

export type PeerCloseReason =
  /** The data channel closed (the other side went away or closed it). */
  | "channel-closed"
  /** ICE or DTLS failed: the browsers could not reach each other. */
  | "connection-failed"
  /** The connection closed. */
  | "connection-closed"
  /** A relayed signal failed to open, had the wrong shape, or came out of order. */
  | "bad-signal"
  /** Could not seal or send our own offer or answer. */
  | "signal-failed"
  /** Setting up the connection threw (createOffer, setRemoteDescription, ...). */
  | "setup-failed";

export type OpenPath = Exclude<ConnectionPath, "failed">;

export type PeerOpenInfo = {
  /** Largest message the channel accepts, in bytes. Check frames with assertFrameFits. */
  maxMessageSize: number;
  /**
   * How the browsers reached each other, from the selected candidate pair.
   * Resolves shortly after the channel opens; never rejects.
   */
  path: Promise<OpenPath>;
  /** Whether the check number is on: the sender's own setting, or the recipient's from the offer. */
  check: boolean;
  /** The check number from the two fingerprints, "ddd ddd". Show it; never send or log it. */
  checkNumber: Promise<string>;
};

export type PeerOptions = {
  /** Only `send` is used, so a fake works in place of a SignalingClient. */
  signaling: { send(message: ClientMessage): boolean };
  linkId: string;
  /** The recipient's attempt ID from its join; bound into every sealed signal. */
  attempt: string;
  /** From deriveSignalKey(secret, linkId). */
  signalKey: CryptoKey;
  /** From this pairing's `joined`, fresh for each peer: TURN credentials expire. */
  iceServers: RTCIceServer[];
  /** Sender only: whether this recipient's check number is on. The recipient reads it from the offer. */
  check?: boolean;
  /** The channel is open, ordered, reliable, binaryType "arraybuffer". */
  onOpen(channel: RTCDataChannel, info: PeerOpenInfo): void;
  /**
   * The peer closed on its own. Called at most once, and never after close()
   * was called by the owner. `detail` can quote SDP, so never log it; `name`
   * is a caught error's name (see errorName), safe to log.
   */
  onClose(reason: PeerCloseReason, detail?: string, name?: string): void;
};

export type Peer = {
  /**
   * Handles the `data` of a relay message for this link. Never rejects: a bad
   * signal closes the peer with "bad-signal". Calls are processed in order.
   */
  handleRelay(data: string): Promise<void>;
  /** Closes the channel and the connection. Safe to call more than once. */
  close(): void;
};

/** Wire form of an ICE candidate inside a sealed signal. */
export type SignalCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
};

/** The plaintext inside a sealed relay message. `candidate: null` ends trickle ICE. */
export type SignalPayload =
  | { kind: "commit"; hash: string }
  | { kind: "offer"; sdp: string; check: boolean }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: SignalCandidate | null };

type Fields = Record<string, unknown>;

function hasKeys(value: Fields, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseCandidate(value: unknown): SignalCandidate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Fields;
  if (!hasKeys(fields, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])) {
    return undefined;
  }
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = fields;
  if (typeof candidate !== "string" || !isNullableString(sdpMid)) {
    return undefined;
  }
  if (!isNullableString(usernameFragment)) {
    return undefined;
  }
  if (
    sdpMLineIndex !== null &&
    !(typeof sdpMLineIndex === "number" && Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0)
  ) {
    return undefined;
  }
  return { candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

/** Checks an opened signal's shape. Returns undefined if it is not a SignalPayload. */
export function parseSignalPayload(value: unknown): SignalPayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Fields;
  switch (fields.kind) {
    case "commit":
      if (!hasKeys(fields, ["kind", "hash"]) || typeof fields.hash !== "string") {
        return undefined;
      }
      return decodeBase64url(fields.hash)?.length === 32
        ? { kind: "commit", hash: fields.hash }
        : undefined;
    case "offer":
      if (!hasKeys(fields, ["kind", "sdp", "check"]) || typeof fields.check !== "boolean") {
        return undefined;
      }
      if (typeof fields.sdp !== "string" || fields.sdp.length === 0) {
        return undefined;
      }
      return { kind: "offer", sdp: fields.sdp, check: fields.check };
    case "answer":
      if (!hasKeys(fields, ["kind", "sdp"]) || typeof fields.sdp !== "string") {
        return undefined;
      }
      if (fields.sdp.length === 0) {
        return undefined;
      }
      return { kind: "answer", sdp: fields.sdp };
    case "ice": {
      if (!hasKeys(fields, ["kind", "candidate"])) {
        return undefined;
      }
      if (fields.candidate === null) {
        return { kind: "ice", candidate: null };
      }
      const candidate = parseCandidate(fields.candidate);
      return candidate ? { kind: "ice", candidate } : undefined;
    }
    default:
      return undefined;
  }
}

/** Throws if a frame of `byteLength` bytes is larger than the channel accepts. */
export function assertFrameFits(maxMessageSize: number, byteLength: number): void {
  if (byteLength > maxMessageSize) {
    throw new Error(`frame of ${byteLength} bytes exceeds max message size ${maxMessageSize}`);
  }
}

/** The SCTP max message size for a connection, with a safe fallback. */
export function maxMessageSizeOf(pc: RTCPeerConnection): number {
  const size = pc.sctp?.maxMessageSize;
  // 0 or a missing value means the browser did not say; Infinity means no limit.
  return size !== undefined && size > 0 ? size : DEFAULT_MAX_MESSAGE_SIZE;
}

type StatsEntry = {
  type?: string;
  selectedCandidatePairId?: string;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
};

/**
 * How a connection runs, from an RTCStatsReport (or any Map of stats): "relay"
 * if either side of the selected candidate pair is a TURN relay candidate,
 * "stun" if either is server- or peer-reflexive, else "direct". Reads only
 * candidate types, never addresses or ports.
 */
export function connectionPath(stats: ReadonlyMap<string, StatsEntry>): OpenPath {
  const entries = [...stats.values()];
  const pairId = entries.find(
    (s) => s.type === "transport" && s.selectedCandidatePairId,
  )?.selectedCandidatePairId;
  const pair =
    (pairId ? stats.get(pairId) : undefined) ??
    entries.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
  // ponytail: no pair found (an old browser's stats) counts as direct; the
  // data channel is open, so ICE did connect, and direct is the common case.
  const types = [pair?.localCandidateId, pair?.remoteCandidateId].map((id) =>
    id ? stats.get(id)?.candidateType : undefined,
  );
  if (types.includes("relay")) {
    return "relay";
  }
  if (types.includes("srflx") || types.includes("prflx")) {
    return "stun";
  }
  return "direct";
}

/** A caught error's name, such as "OperationError", if it is a plain identifier. */
export function errorName(error: unknown): string | undefined {
  return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : undefined;
}

class PeerError extends Error {
  readonly reason: PeerCloseReason;
  constructor(reason: PeerCloseReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function toCandidate(candidate: RTCIceCandidate): SignalCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}

function startPeer(options: PeerOptions, side: Direction): Peer {
  const { signaling, linkId, attempt, signalKey } = options;
  const other: Direction = side === "s" ? "r" : "s";

  let pc: RTCPeerConnection | undefined;
  let closed = false;
  let channel: RTCDataChannel | undefined;
  let gotOffer = false;
  let gotAnswer = false;
  let commit: string | undefined;
  let offerFingerprint: string | undefined;
  let check = side === "s" && options.check === true;
  let resolveNumber: (value: string) => void = () => {};
  const number = new Promise<string>((resolve) => {
    resolveNumber = resolve;
  });
  const pendingCandidates: Array<SignalCandidate | null> = [];
  let outgoing: Promise<void> = Promise.resolve();
  let incoming: Promise<void> = Promise.resolve();

  function teardown(): void {
    closed = true;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.close();
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.ondatachannel = null;
      pc.close();
    }
  }

  function connection(): RTCPeerConnection {
    if (!pc) {
      throw new PeerError("setup-failed", "no connection");
    }
    return pc;
  }

  function fail(reason: PeerCloseReason, detail?: string, name?: string): void {
    if (closed) {
      return;
    }
    teardown();
    if (detail === undefined) {
      options.onClose(reason);
    } else {
      options.onClose(reason, detail, name);
    }
  }

  function failWith(error: unknown, fallback: PeerCloseReason): void {
    if (error instanceof PeerError) {
      fail(error.reason, error.message);
    } else {
      fail(fallback, error instanceof Error ? error.message : String(error), errorName(error));
    }
  }

  /** Seals and sends a signal, in order. `required` signals close the peer if they fail. */
  function sendSignal(payload: SignalPayload, required: boolean): void {
    outgoing = outgoing.then(async () => {
      if (closed) {
        return;
      }
      try {
        const data = await sealSignal(signalKey, linkId, attempt, side, payload);
        if (closed) {
          return;
        }
        const sent = signaling.send({ t: "relay", link: linkId, data });
        if (!sent && required) {
          fail("signal-failed", "signaling is not connected");
        }
      } catch (error) {
        if (required) {
          failWith(error, "signal-failed");
        }
      }
    });
  }

  function attachChannel(next: RTCDataChannel): void {
    channel = next;
    next.binaryType = "arraybuffer";
    next.onopen = () => {
      // onOpen must not wait for the path: the other side may send at once,
      // and messages that arrive before onmessage is set are lost.
      if (!closed) {
        options.onOpen(next, {
          maxMessageSize: maxMessageSizeOf(connection()),
          path: readPath(),
          check,
          checkNumber: number,
        });
      }
    };
    next.onclose = () => fail("channel-closed");
  }

  async function readPath(): Promise<OpenPath> {
    const read = () =>
      connection()
        .getStats()
        .then(connectionPath, () => "direct" as const);
    const first = await read();
    if (first !== "stun" || closed) {
      return first;
    }
    // A remote candidate shows as peer-reflexive while its trickled signal is
    // still being opened, even on one network. The browser corrects the type
    // once the candidate is added, so read again a moment later.
    await new Promise((resolve) => setTimeout(resolve, PATH_RECHECK_MS));
    return closed ? first : read();
  }

  async function addCandidate(candidate: SignalCandidate | null): Promise<void> {
    if (candidate === null || candidate.candidate === "") {
      // End of candidates. Older browsers reject this; it only speeds up
      // ICE completing, so a failure is harmless.
      try {
        await connection().addIceCandidate(candidate ?? undefined);
      } catch {}
      return;
    }
    await connection().addIceCandidate(candidate);
  }

  async function setRemote(type: "offer" | "answer", sdp: string): Promise<void> {
    await connection().setRemoteDescription({ type, sdp });
    const queued = pendingCandidates.splice(0);
    for (const candidate of queued) {
      await addCandidate(candidate);
    }
  }

  /** Sets and returns our own description, and its one fingerprint. */
  async function describe(kind: "offer" | "answer"): Promise<{ sdp: string; fingerprint: string }> {
    const pc = connection();
    await pc.setLocalDescription();
    const sdp = pc.localDescription?.sdp;
    const fingerprint = sdp ? sdpFingerprint(sdp) : undefined;
    if (!sdp || !fingerprint) {
      throw new PeerError("setup-failed", `no local ${kind} with one fingerprint`);
    }
    return { sdp, fingerprint };
  }

  function remoteFingerprint(sdp: string): string {
    const fingerprint = sdpFingerprint(sdp);
    if (!fingerprint) {
      throw new PeerError("bad-signal", "no single sha-256 fingerprint");
    }
    return fingerprint;
  }

  async function handleSignal(payload: SignalPayload): Promise<void> {
    switch (payload.kind) {
      case "commit": {
        if (side !== "s" || commit !== undefined) {
          throw new PeerError("bad-signal", "unexpected commit");
        }
        commit = payload.hash;
        const offer = await describe("offer");
        offerFingerprint = offer.fingerprint;
        sendSignal({ kind: "offer", sdp: offer.sdp, check }, true);
        return;
      }
      case "offer": {
        if (side !== "r" || gotOffer) {
          throw new PeerError("bad-signal", "unexpected offer");
        }
        gotOffer = true;
        const theirs = remoteFingerprint(payload.sdp);
        check = payload.check;
        await setRemote("offer", payload.sdp);
        const answer = await describe("answer");
        sendSignal({ kind: "answer", sdp: answer.sdp }, true);
        resolveNumber(await checkNumber(theirs, answer.fingerprint));
        return;
      }
      case "answer": {
        if (side !== "s" || gotAnswer || commit === undefined || !offerFingerprint) {
          throw new PeerError("bad-signal", "unexpected answer");
        }
        gotAnswer = true;
        const theirs = remoteFingerprint(payload.sdp);
        if ((await commitFingerprint(theirs)) !== commit) {
          throw new PeerError("bad-signal", "answer does not match the commitment");
        }
        await setRemote("answer", payload.sdp);
        resolveNumber(await checkNumber(offerFingerprint, theirs));
        return;
      }
      case "ice":
        if (connection().remoteDescription) {
          await addCandidate(payload.candidate);
        } else {
          pendingCandidates.push(payload.candidate);
        }
        return;
    }
  }

  async function setup(): Promise<void> {
    const cert = await RTCPeerConnection.generateCertificate({
      name: "ECDSA",
      namedCurve: "P-256",
    } as EcKeyGenParams);
    const fingerprint = await certificateFingerprint(cert);
    if (closed) {
      return;
    }
    // Host candidates are enough on one network. The app server may add a TURN
    // relay for browsers that cannot reach each other; it sees only encrypted
    // DTLS traffic. Without one (the local demo), iceServers is [].
    const next = new RTCPeerConnection({ iceServers: options.iceServers, certificates: [cert] });
    pc = next;

    next.onicecandidate = (event) => {
      sendSignal(
        { kind: "ice", candidate: event.candidate ? toCandidate(event.candidate) : null },
        false,
      );
    };

    next.onconnectionstatechange = () => {
      if (next.connectionState === "failed") {
        fail("connection-failed");
      } else if (next.connectionState === "closed") {
        fail("connection-closed");
      }
    };

    if (side === "s") {
      attachChannel(next.createDataChannel(CHANNEL_LABEL, { ordered: true }));
    } else {
      next.ondatachannel = (event) => {
        if (channel || event.channel.label !== CHANNEL_LABEL || !event.channel.ordered) {
          fail("bad-signal", "unexpected data channel");
          return;
        }
        attachChannel(event.channel);
      };
      sendSignal({ kind: "commit", hash: await commitFingerprint(fingerprint) }, true);
    }
  }

  // Relayed signals wait for the certificate and the connection.
  incoming = setup().catch((error: unknown) => {
    failWith(error, "setup-failed");
  });

  return {
    handleRelay(data) {
      incoming = incoming.then(async () => {
        if (closed) {
          return;
        }
        let payload: SignalPayload | undefined;
        try {
          payload = parseSignalPayload(await openSignal(signalKey, linkId, attempt, other, data));
        } catch {
          payload = undefined;
        }
        if (closed) {
          return;
        }
        if (!payload) {
          fail("bad-signal", "signal did not open or had the wrong shape");
          return;
        }
        try {
          await handleSignal(payload);
        } catch (error) {
          failWith(error, "setup-failed");
        }
      });
      return incoming;
    },
    close() {
      if (!closed) {
        teardown();
      }
    },
  };
}

/**
 * Starts the sender side for a recipient that joined `linkId`: creates the
 * data channel, and sends the offer once the recipient's commit arrives.
 */
export function createSenderPeer(options: PeerOptions): Peer {
  return startPeer(options, "s");
}

/**
 * Starts the recipient side after it joined `linkId`: commits to its
 * certificate, then waits for the sender's offer (passed in through
 * handleRelay) and answers it.
 */
export function createRecipientPeer(options: PeerOptions): Peer {
  return startPeer(options, "r");
}
