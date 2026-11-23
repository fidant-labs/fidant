// The recipient page: open a link, see what is offered, accept it, and save
// the file once its checksum is verified.
//
// One attempt (see lib/peer.ts and lib/receive-file.ts):
// - Connect to the signaling server, derive the link's signal key, create the
//   recipient peer, and only then send `join`, so the sender's offer always
//   finds a peer to answer it. Each attempt joins with a fresh random attempt
//   ID, so a sender's late refusal of an earlier attempt cannot end this one.
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

import { cn } from "cn";
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { Button, buttonVariants } from "#components/ui/button";
import type { Messages } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { encodeBase64url } from "../lib/base64url.ts";
import { displayName, formatBytes, formatProgress, toHex } from "../lib/format.ts";
import { deriveSignalKey } from "../lib/keys.ts";
import { LINK_ID_BYTES, parseRecipientLocation } from "../lib/link.ts";
import { createRecipientPeer, fetchIceServers, type Peer } from "../lib/peer.ts";
import type { FileOffer } from "../lib/receive-file.ts";
import { ReceiveError, receiveFile } from "../lib/receive-file.ts";
import { addRelay, NO_RELAYS, type Tie } from "../lib/server-facts.ts";
import { connectSignaling, type SignalingClient } from "../lib/signaling-client.ts";
import { createSink, isPickerCancel, type Sink } from "../lib/sink.ts";
import { Direct, FileCard, Icon, Page, Problem, ServerPanel, TechDetails } from "../ui.tsx";

const caption = "text-[0.9rem] text-muted-foreground";

/** Which problem to show. Text comes from the dictionary at render time, so a language switch re-renders it. */
type ProblemKey = keyof Messages["receive"]["problems"];

type View =
  | { s: "connecting" }
  | { s: "refused"; problem: ProblemKey }
  | { s: "offer"; offer: FileOffer }
  | { s: "receiving"; offer: FileOffer; bytes: number }
  | { s: "done"; offer: FileOffer; blob: Blob | undefined; sha256: string }
  | { s: "declined" }
  | { s: "failed"; problem: ProblemKey };

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

/** How long to wait for `host-gone` after the peer drops, to tell "offline" from "failed". */
const HOST_GONE_GRACE_MS = 1000;
/** How long the peer stays up after DECLINE or RECEIPT for the sender to close it. */
const LINGER_MS = 5000;

export function ReceivePage() {
  const { t, lang } = useI18n();
  const link = useMemo(() => parseRecipientLocation(location), []);
  const [view, setView] = useState<View>({ s: "connecting" });
  const [picking, setPicking] = useState(false);
  const [relayed, countRelay] = useReducer(addRelay, NO_RELAYS);
  const [reachedServer, setReachedServer] = useState(false);
  const [tie, setTie] = useState<Tie>("closed");
  const [viaRelay, setViaRelay] = useState(false);
  const attemptRef = useRef<Attempt | undefined>(undefined);

  /** Closes everything an attempt holds. `linger` keeps the peer up for a moment. */
  const release = (attempt: Attempt, linger = false) => {
    attempt.ended = true;
    setTie("closed");
    attempt.abort.abort(new Error("attempt ended"));
    attempt.signaling.close();
    if (linger) {
      attempt.timers.push(setTimeout(() => attempt.peer?.close(), LINGER_MS));
    } else {
      for (const timer of attempt.timers) {
        clearTimeout(timer);
      }
      attempt.peer?.close();
    }
  };

  const start = () => {
    if (!link) {
      return;
    }
    const { linkId, secret } = link;
    const previous = attemptRef.current;
    if (previous && !previous.ended) {
      release(previous);
    }

    // A fresh ID per attempt, so the sender's refusal can name the attempt it refuses.
    const attemptId = encodeBase64url(crypto.getRandomValues(new Uint8Array(LINK_ID_BYTES)));
    const signaling = connectSignaling({ onRelay: countRelay });
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
    const lostMessage = () => (attempt.receiving ? "lostReceiving" : "lost");
    const finish = (next: View, linger = false) => {
      if (!current()) {
        return;
      }
      release(attempt, linger);
      setView(next);
    };
    // The peer dropped. If the sender's tab closed, `host-gone` arrives within
    // moments of the drop, before or after it; wait for it so the message says why.
    const lost = () => {
      if (!current()) {
        return;
      }
      if (attempt.hostGone) {
        finish({ s: "refused", problem: "offline" });
        return;
      }
      attempt.abort.abort(new Error("connection lost"));
      attempt.timers.push(
        setTimeout(() => finish({ s: "failed", problem: lostMessage() }), HOST_GONE_GRACE_MS),
      );
    };

    signaling.onClose(({ byClient }) => {
      if (byClient || !current()) {
        return;
      }
      setTie("closed");
      if (attempt.channelOpen && !attempt.abort.signal.aborted) {
        return;
      }
      finish({ s: "failed", problem: attempt.channelOpen ? lostMessage() : "server" });
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
            finish({ s: "failed", problem: attempt.channelOpen ? lostMessage() : "connect" });
          } else {
            finish({ s: "refused", problem: message.reason });
          }
          break;
        case "host-gone":
          if (current()) {
            setTie("unpaired");
          }
          // A transfer under way can finish without the server; the peer
          // closing ends it if the sender really went away. Before that,
          // browsers can take many seconds to notice a closed tab over the
          // data channel, so trust the server.
          if (attempt.receiving && !attempt.abort.signal.aborted) {
            attempt.hostGone = true;
            break;
          }
          finish({ s: "refused", problem: "offline" });
          break;
        case "error":
          if (!attempt.channelOpen) {
            finish({ s: "failed", problem: "server" });
          }
          break;
        default:
          break;
      }
    });

    const onOpen = (channel: RTCDataChannel, maxMessageSize: number) => {
      if (!current()) {
        return;
      }
      attempt.channelOpen = true;
      let offered: FileOffer | undefined;
      receiveFile({
        channel,
        maxMessageSize,
        secret,
        signal: attempt.abort.signal,
        onOffer(received) {
          return new Promise((resolve) => {
            if (!current()) {
              return;
            }
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
          if (!current()) {
            return;
          }
          setView((v) => (v.s === "receiving" ? { ...v, bytes } : v));
        },
      }).then(
        (result) => {
          if (result.type === "declined") {
            finish({ s: "declined" }, true);
          } else if (offered) {
            const sha256 = toHex(result.sha256);
            finish({ s: "done", offer: offered, blob: result.blob, sha256 }, true);
          }
        },
        (error: unknown) => {
          const reason = error instanceof ReceiveError ? error.reason : "connection";
          // RECEIPT went out for a mismatch: linger so it reaches the sender.
          if (reason === "checksum") {
            finish({ s: "failed", problem: "checksum" }, true);
          } else if (reason === "invalid") {
            finish({ s: "failed", problem: "invalid" });
          } else if (reason === "save") {
            finish({ s: "failed", problem: "save" });
          } else {
            lost();
          }
        },
      );
    };

    void (async () => {
      try {
        await signaling.ready;
        setReachedServer(true);
        if (current()) {
          setTie("unpaired");
        }
        const [signalKey, iceServers] = await Promise.all([
          deriveSignalKey(secret, linkId),
          fetchIceServers(),
        ]);
        if (!current()) {
          return;
        }
        attempt.peer = createRecipientPeer({
          signaling,
          linkId,
          signalKey,
          iceServers,
          onOpen: (channel, info) => {
            // A short transfer can end before the path resolves; it still went through the relay.
            void info.path.then((path) => {
              if (path === "relay" && attemptRef.current === attempt) {
                setViaRelay(true);
              }
            });
            onOpen(channel, info.maxMessageSize);
          },
          onClose: () => lost(),
        });
        if (signaling.send({ t: "join", link: linkId, attempt: attemptId })) {
          // ponytail: paired as soon as join is sent; the server sends no ack, so a refused join over-claims for one round trip
          setTie("paired");
        }
      } catch {
        finish({ s: "failed", problem: "server" });
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
        for (const timer of attempt.timers) {
          clearTimeout(timer);
        }
        if (!attempt.ended) {
          release(attempt);
        } else {
          attempt.peer?.close();
        }
      }
    };
  }, []);

  // Each step replaces the button that had focus, so focus moves to the new step's heading.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>("#receive h1");
    if (!heading) {
      return;
    }
    heading.tabIndex = -1;
    heading.focus();
  }, [view.s]);

  const onAccept = () => {
    const attempt = attemptRef.current;
    if (view.s !== "offer" || !attempt?.decide || picking) {
      return;
    }
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
        setView({ s: "failed", problem: "create" });
      },
    );
  };

  const onDecline = () => attemptRef.current?.decide?.(undefined);

  if (!link) {
    return (
      <Page>
        <Problem {...t.receive.problems.badLink} />
      </Page>
    );
  }

  const panel = reachedServer ? (
    <ServerPanel
      sees={t.server.seesRecipient}
      holds={t.server.recipientHolds(tie)}
      relayed={relayed}
      afterwards={t.server.afterwardsRecipient}
      viaRelay={viaRelay}
    />
  ) : null;

  let body: VNode;
  switch (view.s) {
    case "connecting":
      body = <h1>{t.receive.connecting}</h1>;
      break;
    case "refused":
      body = <Problem {...t.receive.problems[view.problem]} />;
      break;
    case "offer": {
      const { offer } = view;
      body = (
        <>
          <h1>{t.receive.offerTitle(offer.from)}</h1>
          {offer.from && <p class="text-muted-foreground">{t.receive.unverified}</p>}
          <FileCard name={offer.name} size={formatBytes(offer.size, lang)} />
          <div class="mt-6 mb-8 flex flex-col items-start gap-2">
            <Button type="button" size="lg" onClick={onAccept} disabled={picking}>
              <Icon name="download" class="size-4" /> {t.receive.download}
            </Button>
            <Button type="button" variant="link" onClick={onDecline} disabled={picking}>
              {t.receive.decline}
            </Button>
          </div>
          <Direct from={offer.from || t.common.sender} to={t.common.you} state="ready" />
          <p class={caption}>{t.receive.offerCaption(offer.from)}</p>
          <OfferDetails offer={offer} />
        </>
      );
      break;
    }
    case "receiving": {
      const { offer, bytes } = view;
      body = (
        <>
          <h1>{t.receive.receivingTitle}</h1>
          <FileCard name={offer.name} size={formatBytes(offer.size, lang)} />
          <div class="my-3 flex flex-wrap items-center gap-3">
            <progress
              class="min-w-40 flex-1 accent-primary"
              aria-label={t.receive.progressLabel}
              max={Math.max(offer.size, 1)}
              value={offer.size === 0 ? 0 : bytes}
            />
            <span class="text-[0.85rem] text-muted-foreground tabular-nums">
              {formatProgress(bytes, offer.size, lang)}
            </span>
          </div>
          <Direct from={t.common.sender} to={t.common.you} state="active" />
          <p class={caption}>{t.receive.receivingCaption}</p>
        </>
      );
      break;
    }
    case "done": {
      const { offer, blob, sha256 } = view;
      body = (
        <>
          <div class="flex items-center gap-[0.6rem] text-primary">
            <Icon name="check" class="size-8 stroke-[2.5]" />
            <h1 class="m-0">{t.receive.doneTitle}</h1>
          </div>
          <FileCard name={offer.name} size={formatBytes(offer.size, lang)} />
          <p>{t.receive.verified}</p>
          {blob ? (
            <div class="flex flex-wrap items-center gap-4">
              <p class="text-muted-foreground">{t.receive.autoDownload}</p>
              <SaveLink blob={blob} name={offer.name} label={t.receive.saveFile} />
            </div>
          ) : (
            <p class="text-muted-foreground">{t.receive.savedWhereChosen}</p>
          )}
          <Direct from={t.common.sender} to={t.common.you} state="done" />
          <p class={caption}>{t.receive.doneCaption}</p>
          <OfferDetails offer={offer} sha256={sha256} />
        </>
      );
      break;
    }
    case "declined":
      body = (
        <>
          <h1>{t.receive.declinedTitle}</h1>
          <p>{t.receive.declinedBody}</p>
          <Button type="button" variant="link" onClick={start}>
            {t.receive.showAgain}
          </Button>
        </>
      );
      break;
    case "failed": {
      const problem: { title: string; body: string; detail?: string } =
        t.receive.problems[view.problem];
      body = (
        <>
          <Problem {...problem} />
          <Button type="button" onClick={start}>
            {t.receive.tryAgain}
          </Button>
          {problem.detail && <TechDetails rows={[[t.receive.whatHappened, problem.detail]]} />}
        </>
      );
      break;
    }
  }
  return (
    <Page>
      {body}
      {panel}
    </Page>
  );
}

function OfferDetails({ offer, sha256 }: { offer: FileOffer; sha256?: string }) {
  const { t } = useI18n();
  const rows: Array<readonly [string, ComponentChildren]> = [
    [t.common.size, t.format.bytes(offer.size)],
    [t.common.type, offer.type || t.common.typeMissing],
    [t.receive.encryptionLabel, t.receive.encryption],
  ];
  if (sha256) {
    rows.push([t.receive.sha256Checked, <code key="sha256">{sha256}</code>]);
  }
  return <TechDetails rows={rows} />;
}

/** Starts the download once by itself, and stays as a button in case the browser blocked that. */
function SaveLink({ blob, name, label }: { blob: Blob; name: string; label: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  const anchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => anchor.current?.click(), [url]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    // cn drops the base `border-transparent`, which would otherwise hide the outline's border.
    <a ref={anchor} class={cn(buttonVariants({ variant: "outline" }))} href={url} download={name}>
      {label}
    </a>
  );
}
