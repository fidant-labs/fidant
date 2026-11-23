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
//   consent runs out) and the drop is reported as the sender's page closing.
// - When the data channel opens, receiveFile runs the transfer. The offer
//   screen resolves its decision with a Sink (Download) or undefined (Decline).
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
import { displayName, formatBytes, formatProgress, toHex } from "../lib/format.ts";
import { deriveSignalKey } from "../lib/keys.ts";
import { parseRecipientLocation } from "../lib/link.ts";
import { createRecipientPeer, type Peer } from "../lib/peer.ts";
import type { FileOffer } from "../lib/receive-file.ts";
import { ReceiveError, receiveFile } from "../lib/receive-file.ts";
import { connectSignaling, type SignalingClient } from "../lib/signaling-client.ts";
import { createSink, isPickerCancel, type Sink } from "../lib/sink.ts";
import { Direct, FileCard, Icon, Page, Problem, TechDetails } from "../ui.tsx";

type Message = { title: string; body: string; detail?: string };

type View =
  | { s: "connecting" }
  | { s: "refused"; message: Message }
  | { s: "offer"; offer: FileOffer }
  | { s: "receiving"; offer: FileOffer; bytes: number }
  | { s: "done"; offer: FileOffer; blob: Blob | undefined; sha256: string }
  | { s: "declined" }
  | { s: "failed"; message: Message };

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

const REFUSED: Record<"unknown" | "used" | "busy", Message> = {
  unknown: {
    title: "This link isn't active",
    body: "The file comes straight from the sender's browser, so the link only works while they have the page open. Ask them for a new link.",
  },
  used: {
    title: "This link has already been used",
    body: "Each link works once. If you still need the file, ask the sender for a new link.",
  },
  busy: {
    title: "This link is open somewhere else",
    body: "Each link can be open in one place at a time. Close the other tab and reload this page.",
  },
};
const OFFLINE: Message = {
  title: "The sender's page is closed",
  body: "The file comes straight from their browser, so it has to stay open. Ask them for a new link.",
};
const LOST: Message = {
  title: "The connection to the sender was lost",
  body: "The download may not be complete. Try again to get the whole file.",
};
const CHECKSUM: Message = {
  title: "The file didn't arrive intact",
  body: "It was changed or damaged on the way, so it was not saved. Try again, and tell the sender if it keeps happening.",
  detail: "The SHA-256 checksum of the received file did not match the sender's.",
};
const INVALID: Message = {
  title: "Something went wrong with the transfer",
  body: "The sender's browser sent data we couldn't read, so nothing was saved.",
  detail: "A frame from the sender failed to decrypt or broke the transfer format.",
};
const SAVE: Message = {
  title: "The file couldn't be saved",
  body: "Check that there's enough space on your disk.",
};
const CREATE: Message = {
  title: "The file couldn't be created",
  body: "Try again, or choose another place to save it.",
};
const CONNECT: Message = {
  title: "Couldn't connect to the sender's computer",
  body: "The file travels directly between your two computers, and they couldn't reach each other.",
};
const SERVER: Message = {
  title: "Couldn't reach the server",
  body: "The server connects you to the sender. Check your internet connection.",
};

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
        finish({ s: "refused", message: OFFLINE });
        return;
      }
      attempt.abort.abort(new Error("connection lost"));
      attempt.timers.push(
        setTimeout(() => finish({ s: "failed", message: LOST }), HOST_GONE_GRACE_MS),
      );
    };

    signaling.onClose(({ byClient }) => {
      if (byClient || !current()) return;
      if (attempt.channelOpen && !attempt.abort.signal.aborted) return;
      finish({ s: "failed", message: attempt.channelOpen ? LOST : SERVER });
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
            finish({ s: "failed", message: attempt.channelOpen ? LOST : CONNECT });
          } else {
            finish({ s: "refused", message: REFUSED[message.reason] });
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
          finish({ s: "refused", message: OFFLINE });
          break;
        case "error":
          if (!attempt.channelOpen) finish({ s: "failed", message: SERVER });
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
        onOffer(received) {
          return new Promise((resolve) => {
            if (!current()) return;
            const offer = { ...received, from: displayName(received.from) };
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
          else if (offered) {
            const sha256 = toHex(result.sha256);
            finish({ s: "done", offer: offered, blob: result.blob, sha256 }, true);
          }
        },
        (error: unknown) => {
          const reason = error instanceof ReceiveError ? error.reason : "connection";
          // RECEIPT went out for a mismatch: linger so it reaches the sender.
          if (reason === "checksum") finish({ s: "failed", message: CHECKSUM }, true);
          else if (reason === "invalid") finish({ s: "failed", message: INVALID });
          else if (reason === "save") finish({ s: "failed", message: SAVE });
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
        finish({ s: "failed", message: SERVER });
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
        setView({ s: "failed", message: CREATE });
      },
    );
  };

  const onDecline = () => attemptRef.current?.decide?.(undefined);

  if (!link) {
    return (
      <Page>
        <Problem
          title="This link doesn't work"
          body="Part of it may be missing. Check that you copied all of it, or ask the sender to send it again."
        />
      </Page>
    );
  }

  switch (view.s) {
    case "connecting":
      return (
        <Page>
          <div role="status">
            <h1>Connecting to the sender…</h1>
          </div>
        </Page>
      );
    case "refused":
      return (
        <Page>
          <Problem {...view.message} />
        </Page>
      );
    case "offer": {
      const { offer } = view;
      return (
        <Page>
          <h1>
            {offer.from ? `${offer.from} wants to send you a file` : "You've been sent a file"}
          </h1>
          {offer.from && <p class="muted">Name typed by the sender, not verified.</p>}
          <FileCard name={offer.name} size={formatBytes(offer.size)} />
          <div class="offer-actions">
            <button type="button" class="big" onClick={onAccept} disabled={picking}>
              <Icon name="download" /> Download
            </button>
            <button type="button" class="link" onClick={onDecline} disabled={picking}>
              Decline
            </button>
          </div>
          <Direct from={offer.from || "Sender"} to="You" state="ready" />
          <p class="caption">
            Sent straight from {offer.from ? `${offer.from}'s` : "the sender's"} computer to yours.
            Encrypted, never stored on a server.
          </p>
          <OfferDetails offer={offer} />
        </Page>
      );
    }
    case "receiving": {
      const { offer, bytes } = view;
      return (
        <Page>
          <h1>Downloading…</h1>
          <FileCard name={offer.name} size={formatBytes(offer.size)} />
          <div class="progress-row">
            <progress
              aria-label="Download progress"
              max={Math.max(offer.size, 1)}
              value={offer.size === 0 ? 0 : bytes}
            />
            <span class="progress-text">{formatProgress(bytes, offer.size)}</span>
          </div>
          <Direct from="Sender" to="You" state="active" />
          <p class="caption">
            Receiving directly from the sender. Keep this tab open until it's done.
          </p>
        </Page>
      );
    }
    case "done": {
      const { offer, blob, sha256 } = view;
      return (
        <Page>
          <div class="success" role="status">
            <Icon name="check" />
            <h1>Download complete</h1>
          </div>
          <FileCard name={offer.name} size={formatBytes(offer.size)} />
          <p>We checked it: this is exactly the file that was sent.</p>
          {blob ? (
            <div class="save-row">
              <p class="muted">Your download should start by itself.</p>
              <SaveLink blob={blob} name={offer.name} />
            </div>
          ) : (
            <p class="muted">It's saved where you chose.</p>
          )}
          <Direct from="Sender" to="You" state="done" />
          <p class="caption">
            Sent straight from the sender's computer to yours. Encrypted the whole way.
          </p>
          <OfferDetails offer={offer} sha256={sha256} />
        </Page>
      );
    }
    case "declined":
      return (
        <Page>
          <div role="status">
            <h1>You declined the file</h1>
            <p>You can close this tab.</p>
          </div>
        </Page>
      );
    case "failed":
      return (
        <Page>
          <Problem {...view.message} />
          <button type="button" onClick={start}>
            Try again
          </button>
          {view.message.detail && <TechDetails rows={[["What happened", view.message.detail]]} />}
        </Page>
      );
  }
}

function OfferDetails({ offer, sha256 }: { offer: FileOffer; sha256?: string }) {
  const rows: Array<readonly [string, ComponentChildren]> = [
    ["Size", `${offer.size.toLocaleString("en-US")} bytes`],
    ["Type", offer.type || "Not given"],
    [
      "Encryption",
      "AES-256-GCM, end to end. The key is in your link and never leaves this browser.",
    ],
  ];
  if (sha256) rows.push(["SHA-256, checked", <code key="sha256">{sha256}</code>]);
  return <TechDetails rows={rows} />;
}

/** Starts the download once by itself, and stays as a button in case the browser blocked that. */
function SaveLink({ blob, name }: { blob: Blob; name: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  const anchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => anchor.current?.click(), [url]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <a ref={anchor} class="button secondary" href={url} download={name}>
      Save file
    </a>
  );
}
