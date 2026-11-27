import { createHash, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";

// A hostile signaling server for the specs: it drops, reads and writes a page's relayed signals
// with a link's secret, as our server could for an emailed link. Sealing follows
// apps/web/src/lib/keys.ts and the commit apps/web/src/lib/check.ts, written again here.

/** A signaling message as JSON; only a `relay` message has `data`, and `join` and `joined` carry the recipient's `attempt`. */
export type Signal = { t: string; data: string; link?: string; attempt?: string };

/** The plaintext of a relayed signal (see apps/web/src/lib/peer.ts). */
type Payload = { kind: string; [field: string]: unknown };

/** Who sealed a signal: "s" the sender, "r" the recipient. */
type Dir = "s" | "r";

/** A real page that the middle connects to. */
type Leg = "sender" | "recipient";

/** What the middle page keeps as `globalThis.middle` (see middleman). */
type Middle = {
  /**
   * Takes a signal that `leg`'s page sent, opened. Without one it connects to the sender, and the
   * recipient's commit makes it connect to the recipient. Returns its certificate's fingerprint
   * when it connects.
   */
  handle(leg: Leg, payload?: Payload): Promise<string | undefined>;
  /** Every frame the middle's channels received, in order: who sent it and its kind (byte 1, see apps/web/src/lib/frames.ts). */
  frames: { from: Leg; kind: number }[];
};

/**
 * Passes `page`'s signaling socket through `edit`, as a hostile server could: `sent` is true for
 * what the page sends, an `edit` that returns nothing drops the message, and `toPage` sends the page
 * a message of the server's own. Register it before the page loads. A page route takes precedence
 * over the recorder's context route, which then no longer blocks the sockets this one matches, so
 * match only the stack's own. The recorder still sees the frames on the wire, as the server sends
 * and receives them: what the page sends after `edit`, what the server sends before it, and nothing
 * that `toPage` sends.
 */
export function tamperSignal(
  page: Page,
  edit: (message: Signal, sent: boolean, toPage: (message: Signal) => void) => Signal | undefined,
) {
  return page.routeWebSocket(
    // A relative pattern resolves against baseURL, so this matches only the stack's own socket.
    "/signal",
    (ws) => {
      const server = ws.connectToServer();
      const toPage = (message: Signal) => ws.send(JSON.stringify(message));
      const pass = (text: string | Buffer, sent: boolean) => {
        const message = edit(JSON.parse(text.toString()) as Signal, sent, toPage);
        if (message) {
          (sent ? server : ws).send(JSON.stringify(message));
        }
      };
      ws.onMessage((text) => pass(text, true));
      server.onMessage((text) => pass(text, false));
    },
  );
}

/** Seals and opens the relayed signals of `link` with the secret in its fragment, as apps/web/src/lib/keys.ts does. */
export function signalsOf(link: string) {
  const url = new URL(link);
  const linkId = url.pathname.slice("/r/".length);
  // A copied link's fragment is the secret, an emailed link's `e.<mark>.<secret>`.
  const secret = url.hash.slice(1).split(".").at(-1) ?? "";
  const encoder = new TextEncoder();
  const key = crypto.subtle
    .importKey("raw", Buffer.from(secret, "base64url"), "HKDF", false, ["deriveKey"])
    .then((base) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: Buffer.from(linkId, "base64url"),
          info: encoder.encode("fidant/v1/signal"),
        },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
  const params = (iv: Uint8Array<ArrayBuffer>, attempt: string, dir: Dir) => ({
    name: "AES-GCM",
    iv,
    additionalData: encoder.encode(`fidant/v1/signal|${linkId}|${attempt}|${dir}`),
  });
  return {
    linkId,
    async seal(attempt: string, dir: Dir, payload: Payload): Promise<string> {
      const iv = randomBytes(12);
      const plain = encoder.encode(JSON.stringify(payload));
      const sealed = await crypto.subtle.encrypt(params(iv, attempt, dir), await key, plain);
      return Buffer.concat([iv, Buffer.from(sealed)]).toString("base64url");
    },
    async open(attempt: string, dir: Dir, data: string): Promise<Payload> {
      const sealed = Buffer.from(data, "base64url");
      const iv = sealed.subarray(0, 12);
      const plain = await crypto.subtle.decrypt(
        params(iv, attempt, dir),
        await key,
        sealed.subarray(12),
      );
      return JSON.parse(Buffer.from(plain).toString()) as Payload;
    },
  };
}

/** The recipient's commit to a DTLS fingerprint, as apps/web/src/lib/check.ts makes it. */
export const commitTo = (fingerprint: string) =>
  createHash("sha256").update(`fidant-commit-v1\n${fingerprint}`).digest("base64url");

/**
 * Runs in the middle page through evaluate, so it may use nothing from this module. Ends one
 * WebRTC connection at each real page, each with a fresh certificate: to the sender it is the
 * recipient, to the recipient the sender with the safety number on. Passes every data channel frame
 * on to the other page unchanged. Sends its signals in order through the exposed `toPage`.
 */
function middleman() {
  const toPage = (globalThis as unknown as { toPage(leg: Leg, payload: Payload): Promise<void> })
    .toPage;
  const peers = new Map<Leg, RTCPeerConnection>();
  const channels = new Map<Leg, RTCDataChannel>();
  const waiting: Record<Leg, ArrayBuffer[]> = { sender: [], recipient: [] };
  const frames: Middle["frames"] = [];

  function attach(leg: Leg, channel: RTCDataChannel) {
    const other: Leg = leg === "sender" ? "recipient" : "sender";
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      channels.set(leg, channel);
      for (const frame of waiting[leg].splice(0)) {
        channel.send(frame);
      }
    };
    channel.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      frames.push({ from: leg, kind: new Uint8Array(data)[1] ?? -1 });
      const to = channels.get(other);
      if (to) {
        to.send(data);
      } else {
        waiting[other].push(data);
      }
    };
  }

  async function connect(leg: Leg) {
    const cert = await RTCPeerConnection.generateCertificate({
      name: "ECDSA",
      namedCurve: "P-256",
    } as EcKeyGenParams);
    const pc = new RTCPeerConnection({ certificates: [cert] });
    peers.set(leg, pc);
    pc.onicecandidate = ({ candidate: c }) => {
      const candidate = c && {
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      };
      void toPage(leg, { kind: "ice", candidate });
    };
    if (leg === "sender") {
      pc.ondatachannel = ({ channel }) => attach(leg, channel);
    } else {
      attach(leg, pc.createDataChannel("fidant", { ordered: true }));
      await pc.setLocalDescription();
      await toPage(leg, { kind: "offer", sdp: pc.localDescription?.sdp, check: true });
    }
    return cert
      .getFingerprints()
      .find((f) => f.algorithm === "sha-256")
      ?.value?.toUpperCase();
  }

  const middle: Middle = {
    frames,
    async handle(leg, payload) {
      if (!payload || payload.kind === "commit") {
        return connect(leg);
      }
      const pc = peers.get(leg);
      if (!pc) {
        throw new Error(`${payload.kind} before a connection to the ${leg}`);
      }
      if (payload.kind === "offer" || payload.kind === "answer") {
        await pc.setRemoteDescription({ type: payload.kind, sdp: String(payload.sdp) });
      }
      if (payload.kind === "offer") {
        await pc.setLocalDescription();
        await toPage(leg, { kind: "answer", sdp: pc.localDescription?.sdp });
      }
      const candidate = payload.candidate as RTCIceCandidateInit | null | undefined;
      if (payload.kind === "ice" && candidate?.candidate) {
        await pc.addIceCandidate(candidate);
      }
      return undefined;
    },
  };
  (globalThis as unknown as { middle: Middle }).middle = middle;
}

/**
 * Puts the page `middle` between a sender page and a recipient page, as a server that holds the
 * link's secret could: it takes over both pages' relayed signals, and each page connects to the
 * middle instead of to the other. Call `takeOver` for each page before it loads, and `start` with
 * the link before the recipient joins.
 */
export async function interpose(middle: Page) {
  await middle.goto("/");
  let signals: ReturnType<typeof signalsOf> | undefined;
  let attempt = "";
  const pages = new Map<Leg, (message: Signal) => void>();
  const queues = new Map<string, Promise<unknown>>();
  const queue = (name: string, step: () => Promise<unknown>) => {
    queues.set(name, (queues.get(name) ?? Promise.resolve()).then(step));
  };
  const keyed = () => {
    if (!signals) {
      throw new Error("the middle has no link yet");
    }
    return signals;
  };
  const send = (leg: Leg, payload: Payload) =>
    queue(`to ${leg}`, async () => {
      const { linkId, seal } = keyed();
      const data = await seal(attempt, leg === "sender" ? "r" : "s", payload);
      pages.get(leg)?.({ t: "relay", link: linkId, data });
    });
  const handle = (leg: Leg, payload?: Payload) =>
    middle.evaluate(
      ([leg, payload]) => (globalThis as unknown as { middle: Middle }).middle.handle(leg, payload),
      [leg, payload] as const,
    );
  await middle.exposeFunction("toPage", send);
  await middle.evaluate(middleman);
  return {
    start(link: string) {
      signals = signalsOf(link);
    },
    takeOver(page: Page, leg: Leg) {
      let marked = false;
      return tamperSignal(page, (message, sent, toPage) => {
        pages.set(leg, toPage);
        attempt = message.attempt ?? attempt;
        if (message.t !== "relay") {
          return message;
        }
        if (sent) {
          const opened = keyed().open(attempt, leg === "sender" ? "s" : "r", message.data);
          if (marked) {
            queue(`from ${leg}`, async () => handle(leg, await opened));
          } else {
            // A page's first signal is its version marker: the middle sends it back as the other side's.
            marked = true;
            queue(`from ${leg}`, async () => {
              send(leg, await opened);
              if (leg === "sender") {
                send("sender", { kind: "commit", hash: commitTo((await handle("sender")) ?? "") });
              }
            });
          }
        }
        return undefined;
      });
    },
    frames: () =>
      middle.evaluate(() => (globalThis as unknown as { middle: Middle }).middle.frames),
  };
}
