// The recipient page: open a link, see what is offered, accept it, and save
// the file once its checksum is verified.
//
// One attempt (see lib/peer.ts and lib/receive-file.ts):
// - Connect to the signaling server, derive the link's signal key, create the
//   recipient peer, and only then send `join`, so the sender's offer always
//   finds a peer to answer it.
// - `relay` goes to the peer. `refused` ends the attempt with the matching
//   message, and so does `host-gone` until the file starts arriving. A
//   transfer under way no longer needs the server (the sender may only have
//   lost its signaling connection), so then `host-gone` is only remembered: if
//   the sender's tab really closed, the peer drops too (at the latest when ICE
//   consent runs out) and the drop is reported as "The sender is offline".
// - When the data channel opens, receiveFile runs the transfer. The offer
//   screen resolves its decision with a Sink (Accept) or undefined (Decline).
//
// When an attempt ends for any reason, its signaling socket is closed: the
// server keeps a guest bound to its link until then, and a later opener would
// get "in use" instead of the sender's answer. After DECLINE or RECEIPT the
// peer stays up for a moment so that frame reaches the sender, which closes
// the channel itself. "Try again" starts a fresh attempt with a new socket and
// a new peer.
//
// The secret stays in this tab (it is never stripped from the address bar in
// this demo). The file name and size are shown, never logged or sent anywhere.

import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { formatBytes } from "../lib/format.ts";
import { deriveSignalKey } from "../lib/keys.ts";
import { parseRecipientLocation } from "../lib/link.ts";
import { createRecipientPeer, type Peer } from "../lib/peer.ts";
import type { FileOffer } from "../lib/receive-file.ts";
import { ReceiveError, receiveFile } from "../lib/receive-file.ts";
import { connectSignaling, type SignalingClient } from "../lib/signaling-client.ts";
import { createSink, isPickerCancel, type Sink } from "../lib/sink.ts";

type View =
  | { s: "connecting" }
  | { s: "refused"; text: string }
  | { s: "offer"; offer: FileOffer }
  | { s: "receiving"; offer: FileOffer; bytes: number }
  | { s: "done"; offer: FileOffer; blob: Blob | undefined }
  | { s: "declined" }
  | { s: "failed"; text: string };

type Attempt = {
  abort: AbortController;
  signaling: SignalingClient;
  peer?: Peer;
  /** Set once the data channel opened; signaling problems no longer matter then. */
  channelOpen: boolean;
  /** Set once a signal from the sender arrived, so the sender took this join. */
  heardSender: boolean;
  /** Set once the recipient accepted and the file started arriving. */
  receiving: boolean;
  /** The server said the sender is gone while the file was arriving. */
  hostGone: boolean;
  /** Set once the attempt reached its final view. Later events are ignored. */
  ended: boolean;
  /** Resolves the offer: a Sink to accept, undefined to decline. */
  decide?: ((sink: Sink | undefined) => void) | undefined;
  timers: Array<ReturnType<typeof setTimeout>>;
};

const REFUSED_TEXT = {
  unknown: "Link not found",
  used: "This link has already been used",
  busy: "This link is in use",
} as const;
const OFFLINE_TEXT = "The sender is offline";
const LOST_TEXT = "Transfer failed. The connection to the sender was lost.";
const CHECKSUM_TEXT = "Transfer failed: the file did not match its checksum.";
const INVALID_TEXT = "Transfer failed: the sender sent invalid data.";
const SAVE_TEXT = "Transfer failed. Could not save the file.";
const CONNECT_TEXT = "Transfer failed. Could not connect to the sender.";
const SERVER_TEXT = "Transfer failed. Could not reach the server.";

/** How long to wait for `host-gone` after the peer drops, to tell "offline" from "failed". */
const HOST_GONE_GRACE_MS = 1000;
/** How long the peer stays up after DECLINE or RECEIPT for the sender to close it. */
const LINGER_MS = 5000;

export function ReceivePage() {
  const link = useMemo(() => parseRecipientLocation(location), []);
  const [view, setView] = useState<View>({ s: "connecting" });
  const [picking, setPicking] = useState(false);
  const attemptRef = useRef<Attempt | undefined>(undefined);

  /** Closes everything an attempt holds. `linger` keeps the peer up for a moment. */
  const release = (attempt: Attempt, linger = false) => {
    attempt.ended = true;
    attempt.abort.abort(new Error("attempt ended"));
    attempt.signaling.close();
    if (linger) {
      attempt.timers.push(setTimeout(() => attempt.peer?.close(), LINGER_MS));
    } else {
      for (const timer of attempt.timers) clearTimeout(timer);
      attempt.peer?.close();
    }
  };

  const start = () => {
    if (!link) return;
    const { linkId, secret } = link;
    const previous = attemptRef.current;
    if (previous && !previous.ended) release(previous);

    const signaling = connectSignaling();
    const attempt: Attempt = {
      abort: new AbortController(),
      signaling,
      channelOpen: false,
      heardSender: false,
      receiving: false,
      hostGone: false,
      ended: false,
      timers: [],
    };
    attemptRef.current = attempt;
    setPicking(false);
    setView({ s: "connecting" });

    const current = () => attemptRef.current === attempt && !attempt.ended;
    const finish = (next: View, linger = false) => {
      if (!current()) return;
      release(attempt, linger);
      setView(next);
    };
    // The peer dropped. If the sender's tab closed, `host-gone` arrives within
    // moments of the drop, before or after it; wait for it so the message says why.
    const lost = () => {
      if (!current()) return;
      if (attempt.hostGone) {
        finish({ s: "refused", text: OFFLINE_TEXT });
        return;
      }
      attempt.abort.abort(new Error("connection lost"));
      attempt.timers.push(
        setTimeout(() => finish({ s: "failed", text: LOST_TEXT }), HOST_GONE_GRACE_MS),
      );
    };

    signaling.onClose(({ byClient }) => {
      if (byClient || !current()) return;
      if (attempt.channelOpen && !attempt.abort.signal.aborted) return;
      finish({ s: "failed", text: attempt.channelOpen ? LOST_TEXT : SERVER_TEXT });
    });
    signaling.subscribe((message) => {
      switch (message.t) {
        case "relay":
          attempt.heardSender = true;
          void attempt.peer?.handleRelay(message.data);
          break;
        case "refused":
          // A refusal after the sender's first signal means the sender gave up
          // on this attempt (its peer failed or never connected), not that the
          // link is in use or used: the sender only signals a join it took.
          if (attempt.heardSender) {
            finish({ s: "failed", text: attempt.channelOpen ? LOST_TEXT : CONNECT_TEXT });
          } else {
            finish({ s: "refused", text: REFUSED_TEXT[message.reason] });
          }
          break;
        case "host-gone":
          // A transfer under way can finish without the server; the peer
          // closing ends it if the sender really went away. Before that,
          // browsers can take many seconds to notice a closed tab over the
          // data channel, so trust the server.
          if (attempt.receiving && !attempt.abort.signal.aborted) {
            attempt.hostGone = true;
            break;
          }
          finish({ s: "refused", text: OFFLINE_TEXT });
          break;
        case "error":
          if (!attempt.channelOpen) finish({ s: "failed", text: SERVER_TEXT });
          break;
        default:
          break;
      }
    });

    const onOpen = (channel: RTCDataChannel, maxMessageSize: number) => {
      if (!current()) return;
      attempt.channelOpen = true;
      let offered: FileOffer | undefined;
      receiveFile({
        channel,
        maxMessageSize,
        secret,
        signal: attempt.abort.signal,
        onOffer(offer) {
          return new Promise((resolve) => {
            if (!current()) return;
            offered = offer;
            attempt.decide = (sink) => {
              attempt.decide = undefined;
              if (sink) {
                attempt.receiving = true;
                setView({ s: "receiving", offer, bytes: 0 });
              }
              resolve(sink);
            };
            setView({ s: "offer", offer });
          });
        },
        onProgress(bytes) {
          if (!current()) return;
          setView((v) => (v.s === "receiving" ? { ...v, bytes } : v));
        },
      }).then(
        (result) => {
          if (result.type === "declined") finish({ s: "declined" }, true);
          else if (offered) finish({ s: "done", offer: offered, blob: result.blob }, true);
        },
        (error: unknown) => {
          const reason = error instanceof ReceiveError ? error.reason : "connection";
          // RECEIPT went out for a mismatch: linger so it reaches the sender.
          if (reason === "checksum") finish({ s: "failed", text: CHECKSUM_TEXT }, true);
          else if (reason === "invalid") finish({ s: "failed", text: INVALID_TEXT });
          else if (reason === "save") finish({ s: "failed", text: SAVE_TEXT });
          else lost();
        },
      );
    };

    void (async () => {
      try {
        await signaling.ready;
        const signalKey = await deriveSignalKey(secret, linkId);
        if (!current()) return;
        attempt.peer = createRecipientPeer({
          signaling,
          linkId,
          signalKey,
          onOpen: (channel, info) => onOpen(channel, info.maxMessageSize),
          onClose: () => lost(),
        });
        signaling.send({ t: "join", link: linkId });
      } catch {
        finish({ s: "failed", text: SERVER_TEXT });
      }
    })();
  };

  // Runs once on mount; "Try again" calls start() again.
  useEffect(() => {
    start();
    return () => {
      const attempt = attemptRef.current;
      attemptRef.current = undefined;
      if (attempt) {
        for (const timer of attempt.timers) clearTimeout(timer);
        if (!attempt.ended) release(attempt);
        else attempt.peer?.close();
      }
    };
  }, []);

  const onAccept = () => {
    const attempt = attemptRef.current;
    if (view.s !== "offer" || !attempt?.decide || picking) return;
    // First thing in the click handler: the save dialog needs the user gesture.
    const pending = createSink(view.offer.name);
    setPicking(true);
    pending.then(
      (sink) => {
        setPicking(false);
        if (
          attemptRef.current !== attempt ||
          attempt.ended ||
          attempt.abort.signal.aborted ||
          !attempt.decide
        ) {
          void sink.abort();
          return;
        }
        attempt.decide(sink);
      },
      (error: unknown) => {
        setPicking(false);
        // Cancelling the save dialog leaves the offer open.
        if (
          isPickerCancel(error) ||
          attemptRef.current !== attempt ||
          attempt.ended ||
          attempt.abort.signal.aborted
        ) {
          return;
        }
        release(attempt);
        setView({ s: "failed", text: "Transfer failed. Could not create the file." });
      },
    );
  };

  const onDecline = () => attemptRef.current?.decide?.(undefined);

  if (!link) {
    return (
      <Shell>
        <p class="notice error">This link is not valid. Check that you copied all of it.</p>
      </Shell>
    );
  }

  switch (view.s) {
    case "connecting":
      return (
        <Shell>
          <p role="status">Connecting…</p>
        </Shell>
      );
    case "refused":
      return (
        <Shell>
          <p class="notice error" role="alert">
            {view.text}
          </p>
        </Shell>
      );
    case "offer":
      return (
        <Shell titled>
          <p class="lede">You have been sent a file.</p>
          <OfferSummary offer={view.offer} />
          <div class="offer-actions">
            <button type="button" onClick={onAccept} disabled={picking}>
              Accept
            </button>
            <button type="button" class="secondary" onClick={onDecline} disabled={picking}>
              Decline
            </button>
          </div>
          <p class="hint">The file is encrypted until it reaches this browser.</p>
        </Shell>
      );
    case "receiving":
      return (
        <Shell titled>
          <OfferSummary offer={view.offer} />
          <div class="progress-row">
            <progress
              aria-label="Download progress"
              max={Math.max(view.offer.size, 1)}
              value={view.offer.size === 0 ? 0 : view.bytes}
            />
            <span class="progress-text">
              {formatBytes(view.bytes)} of {formatBytes(view.offer.size)}
            </span>
          </div>
          <p class="hint">Keep this tab open until the transfer finishes.</p>
        </Shell>
      );
    case "done":
      return (
        <Shell titled>
          <OfferSummary offer={view.offer} />
          <p class="notice ok" role="status">
            Checksum verified
          </p>
          {view.blob ? (
            <SaveLink blob={view.blob} name={view.offer.name} />
          ) : (
            <p class="hint">The file is saved where you chose.</p>
          )}
        </Shell>
      );
    case "declined":
      return (
        <Shell>
          <p role="status">You declined the file. You can close this tab.</p>
        </Shell>
      );
    case "failed":
      return (
        <Shell>
          <p class="notice error" role="alert">
            {view.text}
          </p>
          <button type="button" onClick={start}>
            Try again
          </button>
        </Shell>
      );
  }
}

/** Page frame. `titled` means the content brings its own h1 (the file name). */
function Shell({ children, titled = false }: { children: ComponentChildren; titled?: boolean }) {
  return (
    <main>
      <header>{titled ? <p class="brand">Sigill</p> : <h1>Sigill</h1>}</header>
      {children}
    </main>
  );
}

function OfferSummary({ offer }: { offer: FileOffer }) {
  return (
    <div class="file-info">
      <h1 class="file-name">{offer.name}</h1>
      <p>
        <span title={`${offer.size} bytes`}>{formatBytes(offer.size)}</span>{" "}
        <span class="hint">({offer.size.toLocaleString("en-US")} bytes)</span>
      </p>
    </div>
  );
}

/** A download link for a received Blob. The object URL is revoked on unmount. */
function SaveLink({ blob, name }: { blob: Blob; name: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <a class="button" href={url} download={name}>
      Save file
    </a>
  );
}
