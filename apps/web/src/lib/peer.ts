// A WebRTC connection between the sender and one recipient, signaled through
// the server with every SDP and ICE message sealed by the link's signal key.
//
// Message flow for one link:
//
//   recipient → server   join {link}
//   server → sender      joined {link}            (sender: createSenderPeer)
//   sender → recipient   relay seal_s({kind:"offer", sdp})
//   recipient → sender   relay seal_r({kind:"answer", sdp})
//   both directions      relay seal({kind:"ice", candidate})   (trickle; null = end)
//   sender ⇄ recipient   data channel "sigill" opens → onOpen(channel, info)
//
// seal_s/seal_r are sealSignal with direction "s"/"r"; the receiving side opens
// with the other side's direction, so the server cannot reflect a message back
// or swap one link's signals into another. The server only sees link IDs and
// opaque blobs: no SDP, no candidates, no DTLS fingerprints.
//
// Outgoing signals are sealed and sent in order through one queue; incoming
// relay data is handled in order through another. ICE candidates that arrive
// before the remote description are held until it is set.
//
// No DOM or UI here, and nothing about files or names: the data channel
// carries only encrypted frames (frames.ts), and its label is fixed.

import type { ClientMessage } from "@sigill/protocol";
import { type Direction, openSignal, sealSignal } from "./keys.ts";

/** The data channel label. Fixed and neutral: never a file or recipient name. */
export const CHANNEL_LABEL = "sigill";

/**
 * SCTP max message size to assume if the browser does not report one. RFC 8841
 * says 64 KiB when the remote SDP has no max-message-size attribute.
 */
export const DEFAULT_MAX_MESSAGE_SIZE = 65536;

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

export type PeerOpenInfo = {
  /** Largest message the channel accepts, in bytes. Check frames with assertFrameFits. */
  maxMessageSize: number;
};

export type PeerOptions = {
  /** Only `send` is used, so a fake works in place of a SignalingClient. */
  signaling: { send(message: ClientMessage): boolean };
  linkId: string;
  /** From deriveSignalKey(secret, linkId). */
  signalKey: CryptoKey;
  /** The channel is open, ordered, reliable, binaryType "arraybuffer". */
  onOpen(channel: RTCDataChannel, info: PeerOpenInfo): void;
  /**
   * The peer closed on its own. Called at most once, and never after close()
   * was called by the owner.
   */
  onClose(reason: PeerCloseReason, detail?: string): void;
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
  | { kind: "offer"; sdp: string }
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Fields;
  if (!hasKeys(fields, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])) {
    return undefined;
  }
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = fields;
  if (typeof candidate !== "string" || !isNullableString(sdpMid)) return undefined;
  if (!isNullableString(usernameFragment)) return undefined;
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Fields;
  switch (fields.kind) {
    case "offer":
    case "answer":
      if (!hasKeys(fields, ["kind", "sdp"]) || typeof fields.sdp !== "string") return undefined;
      if (fields.sdp.length === 0) return undefined;
      return { kind: fields.kind, sdp: fields.sdp };
    case "ice": {
      if (!hasKeys(fields, ["kind", "candidate"])) return undefined;
      if (fields.candidate === null) return { kind: "ice", candidate: null };
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
  const { signaling, linkId, signalKey } = options;
  const other: Direction = side === "s" ? "r" : "s";

  // Sender and recipients are on the same network, so host candidates are
  // enough. No STUN or TURN: the demo must run without internet, and a TURN
  // relay is infrastructure we do not want in the path.
  const pc = new RTCPeerConnection({ iceServers: [] });

  let closed = false;
  let channel: RTCDataChannel | undefined;
  let gotOffer = false;
  let gotAnswer = false;
  const pendingCandidates: Array<SignalCandidate | null> = [];
  let outgoing: Promise<void> = Promise.resolve();
  let incoming: Promise<void> = Promise.resolve();

  function teardown(): void {
    closed = true;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.close();
    }
    pc.close();
  }

  function fail(reason: PeerCloseReason, detail?: string): void {
    if (closed) return;
    teardown();
    if (detail === undefined) options.onClose(reason);
    else options.onClose(reason, detail);
  }

  function failWith(error: unknown, fallback: PeerCloseReason): void {
    if (error instanceof PeerError) fail(error.reason, error.message);
    else fail(fallback, error instanceof Error ? error.message : String(error));
  }

  /** Seals and sends a signal, in order. `required` signals close the peer if they fail. */
  function sendSignal(payload: SignalPayload, required: boolean): void {
    outgoing = outgoing.then(async () => {
      if (closed) return;
      try {
        const data = await sealSignal(signalKey, linkId, side, payload);
        if (closed) return;
        const sent = signaling.send({ t: "relay", link: linkId, data });
        if (!sent && required) fail("signal-failed", "signaling is not connected");
      } catch (error) {
        if (required) failWith(error, "signal-failed");
      }
    });
  }

  function attachChannel(next: RTCDataChannel): void {
    channel = next;
    next.binaryType = "arraybuffer";
    next.onopen = () => {
      if (!closed) options.onOpen(next, { maxMessageSize: maxMessageSizeOf(pc) });
    };
    next.onclose = () => fail("channel-closed");
  }

  async function addCandidate(candidate: SignalCandidate | null): Promise<void> {
    if (candidate === null || candidate.candidate === "") {
      // End of candidates. Older browsers reject this; it only speeds up
      // ICE completing, so a failure is harmless.
      try {
        await pc.addIceCandidate(candidate ?? undefined);
      } catch {}
      return;
    }
    await pc.addIceCandidate(candidate);
  }

  async function setRemote(type: "offer" | "answer", sdp: string): Promise<void> {
    await pc.setRemoteDescription({ type, sdp });
    const queued = pendingCandidates.splice(0);
    for (const candidate of queued) await addCandidate(candidate);
  }

  async function sendLocalDescription(kind: "offer" | "answer"): Promise<void> {
    await pc.setLocalDescription();
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new PeerError("setup-failed", `no local ${kind}`);
    sendSignal({ kind, sdp }, true);
  }

  async function handleSignal(payload: SignalPayload): Promise<void> {
    switch (payload.kind) {
      case "offer":
        if (side !== "r" || gotOffer) throw new PeerError("bad-signal", "unexpected offer");
        gotOffer = true;
        await setRemote("offer", payload.sdp);
        await sendLocalDescription("answer");
        return;
      case "answer":
        if (side !== "s" || gotAnswer) throw new PeerError("bad-signal", "unexpected answer");
        gotAnswer = true;
        await setRemote("answer", payload.sdp);
        return;
      case "ice":
        if (pc.remoteDescription) await addCandidate(payload.candidate);
        else pendingCandidates.push(payload.candidate);
        return;
    }
  }

  pc.onicecandidate = (event) => {
    sendSignal(
      { kind: "ice", candidate: event.candidate ? toCandidate(event.candidate) : null },
      false,
    );
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") fail("connection-failed");
    else if (pc.connectionState === "closed") fail("connection-closed");
  };

  if (side === "s") {
    attachChannel(pc.createDataChannel(CHANNEL_LABEL, { ordered: true }));
    incoming = sendLocalDescription("offer").catch((error: unknown) => {
      failWith(error, "setup-failed");
    });
  } else {
    pc.ondatachannel = (event) => {
      if (channel || event.channel.label !== CHANNEL_LABEL || !event.channel.ordered) {
        fail("bad-signal", "unexpected data channel");
        return;
      }
      attachChannel(event.channel);
    };
  }

  return {
    handleRelay(data) {
      incoming = incoming.then(async () => {
        if (closed) return;
        let payload: SignalPayload | undefined;
        try {
          payload = parseSignalPayload(await openSignal(signalKey, linkId, other, data));
        } catch {
          payload = undefined;
        }
        if (closed) return;
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
      if (!closed) teardown();
    },
  };
}

/**
 * Starts the sender side for a recipient that joined `linkId`: creates the
 * data channel and sends the offer right away.
 */
export function createSenderPeer(options: PeerOptions): Peer {
  return startPeer(options, "s");
}

/**
 * Starts the recipient side after it joined `linkId`: waits for the sender's
 * offer (passed in through handleRelay) and answers it.
 */
export function createRecipientPeer(options: PeerOptions): Peer {
  return startPeer(options, "r");
}
