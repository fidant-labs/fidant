// The recipient page: open a link, see what is offered, accept it, and save
// the file, or show the text, once its checksum is verified.
//
// One attempt (see lib/peer.ts and lib/receive-file.ts):
// - Connect to the signaling server, derive the link's signal key, and send
//   `join` once both are done. The server answers with `joined`, carrying
//   this pairing's ICE servers, before it tells the sender; the recipient peer
//   is created synchronously on it, so the sender's offer, which comes later
//   on the same socket, always finds a peer to answer it. Each attempt joins
//   with a fresh random attempt ID, so a sender's late refusal of an earlier
//   attempt cannot end this one.
// - `relay` goes to the peer. `refused` ends the attempt with the matching
//   message, and so does `host-gone` until the file starts arriving. A
//   transfer under way no longer needs the server (the sender may only have
//   lost its signaling connection), so then `host-gone` is only remembered: if
//   the sender's tab really closed, the peer drops too (at the latest when ICE
//   consent runs out) and the drop is reported as the sender's page closing.
// - If the signaling socket drops before the data channel opens, a new
//   attempt starts (new socket, new attempt ID). A socket that never opened is
//   left to the signaling client's own retries. A server that restarted no
//   longer knows the sender's link until the sender re-hosts, so `refused:
//   unknown` after a drop or failed connect waits retryDelay and tries again,
//   up to MAX_REJOINS times. Once the channel is open the transfer no longer
//   needs the server, so a drop then only closes the signaling client.
// - If the data channel hasn't opened CONNECT_TIMEOUT_MS (30 s) after the
//   attempt starts, the attempt fails with "connect" (a peer exists) or
//   "server" (no `joined` yet), so "Connecting…" never stays up for good.
// - When the data channel opens, receiveFile runs the transfer. The offer
//   screen resolves its decision with a Sink (Download or Show) or undefined
//   (Decline). Show always collects a text in memory, never in a save dialog.
//
// When an attempt ends for any reason, its signaling socket is closed: the
// server keeps a guest bound to its link until then, and a later opener would
// get "in use" instead of the sender's answer. After DECLINE or RECEIPT the
// peer stays up for a moment so that frame reaches the sender, which closes
// the channel itself. "Try again" starts a fresh attempt with a new socket and
// a new peer.
//
// The secret stays in this tab (it is never stripped from the address bar in
// this demo). The file name and size, or the text, are shown, never logged or
// sent anywhere.

import { cn } from "cn";
import { type ComponentChildren, Fragment, type VNode } from "preact";
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { Button, buttonVariants } from "#components/ui/button";
import type { Messages } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { encodeBase64url } from "../lib/base64url.ts";
import { displayName, formatBytes, formatProgress, toHex } from "../lib/format.ts";
import { deriveSignalKey } from "../lib/keys.ts";
import { LINK_ID_BYTES, parseRecipientLocation } from "../lib/link.ts";
import { createRecipientPeer, type OpenPath, type Peer } from "../lib/peer.ts";
import type { FileOffer } from "../lib/receive-file.ts";
import { ReceiveError, receiveFile } from "../lib/receive-file.ts";
import { peerLostProblem } from "../lib/receive-problem.ts";
import { addRelay, NO_RELAYS, type Tie } from "../lib/server-facts.ts";
import { connectSignaling, retryDelay, type SignalingClient } from "../lib/signaling-client.ts";
import { BlobSink, createSink, isPickerCancel, type Sink } from "../lib/sink.ts";
import { decodeText, isTextOffer } from "../lib/text-secret.ts";
import {
  Direct,
  FileCard,
  Icon,
  Page,
  PathLine,
  Problem,
  ServerPanel,
  TechDetails,
} from "../ui.tsx";

const caption = "text-[0.9rem] text-muted-foreground";

type CopyNote = keyof Messages["secret"]["copyNote"];

/** Which problem to show. Text comes from the dictionary at render time, so a language switch re-renders it. */
type ProblemKey = keyof Messages["receive"]["problems"];

type ProblemText = { title: string; body: string; detail?: string };

type Offer = FileOffer & { text: boolean };

type View =
  | { s: "connecting" }
  | { s: "refused"; problem: ProblemKey; text?: boolean }
  | { s: "offer"; offer: Offer }
  | { s: "receiving"; offer: Offer; bytes: number }
  | { s: "done"; offer: Offer; blob: Blob | undefined; sha256: string }
  | { s: "declined"; text: boolean }
  | { s: "failed"; problem: ProblemKey; text?: boolean };

type Attempt = {
  abort: AbortController;
  signaling: SignalingClient;
  peer?: Peer;
  /** Set once the data channel opened; signaling problems no longer matter then. */
  channelOpen: boolean;
  /** Set once a signal from the sender arrived, so the sender took this join. */
  heardSender: boolean;
  /** Set once the offer turned out to be a text, so later problems use text wording. */
  text: boolean;
  /** Set once the recipient accepted and the file started arriving. */
  receiving: boolean;
  /** The server said the sender is gone while the file was arriving. */
  hostGone: boolean;
  /** The sender refused our relay for this attempt, as the server's `joined` said. */
  relayRefused: boolean;
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
/** How long to wait for the data channel before giving up on the sender. */
const CONNECT_TIMEOUT_MS = 30_000;
/** How many new attempts follow a dropped socket or an `unknown` refusal before giving up. */
const MAX_REJOINS = 4;

export function ReceivePage() {
  const { t, lang } = useI18n();
  const problemFor = (view: { problem: ProblemKey; text?: boolean }): ProblemText => {
    const problems: Record<ProblemKey, ProblemText> = view.text
      ? { ...t.receive.problems, ...t.secret.problems }
      : t.receive.problems;
    return problems[view.problem];
  };
  const link = useMemo(() => parseRecipientLocation(location), []);
  const [view, setView] = useState<View>({ s: "connecting" });
  const [picking, setPicking] = useState(false);
  const [relayed, countRelay] = useReducer(addRelay, NO_RELAYS);
  const [reachedServer, setReachedServer] = useState(false);
  const [tie, setTie] = useState<Tie>("closed");
  const [viaRelay, setViaRelay] = useState(false);
  const [path, setPath] = useState<OpenPath | undefined>(undefined);
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

  const start = (rejoins = 0) => {
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
      text: false,
      receiving: false,
      hostGone: false,
      relayRefused: false,
      ended: false,
      timers: [],
    };
    attemptRef.current = attempt;
    setPicking(false);
    setPath(undefined);
    setView({ s: "connecting" });

    const current = () => attemptRef.current === attempt && !attempt.ended;
    const lostMessage = () => peerLostProblem(attempt);
    const offlineMessage = () => (attempt.receiving ? "offlineReceiving" : "offline");
    const finish = (next: View, linger = false) => {
      if (!current()) {
        return;
      }
      release(attempt, linger);
      setView(
        attempt.text && (next.s === "refused" || next.s === "failed")
          ? { ...next, text: true }
          : next,
      );
    };
    // The peer dropped, or never connected (ICE failed). If the sender's tab
    // closed, `host-gone` arrives within moments of the drop, before or after
    // it; wait for it so the message says why.
    const lost = () => {
      if (!current()) {
        return;
      }
      if (attempt.hostGone) {
        finish({ s: "refused", problem: offlineMessage() });
        return;
      }
      attempt.abort.abort(new Error("connection lost"));
      attempt.timers.push(
        setTimeout(() => finish({ s: "failed", problem: lostMessage() }), HOST_GONE_GRACE_MS),
      );
    };
    // Without it, a sender whose signals never arrive leaves "Connecting…" up for good.
    attempt.timers.push(
      setTimeout(() => {
        if (!attempt.channelOpen) {
          finish({ s: "failed", problem: attempt.peer ? lostMessage() : "server" });
        }
      }, CONNECT_TIMEOUT_MS),
    );

    // Set before `join` is sent, so it is there when `joined` arrives.
    let signalKey: CryptoKey | undefined;
    let opened = false;
    /** A connection attempt failed, so the server may have restarted and lost the sender's link. */
    let failedBefore = false;
    const join = () => {
      if (opened && signalKey && current()) {
        signaling.send({ t: "join", link: linkId, attempt: attemptId });
      }
    };
    void deriveSignalKey(secret, linkId).then(
      (key) => {
        signalKey = key;
        join();
      },
      () => finish({ s: "failed", problem: "server" }),
    );
    signaling.onOpen(() => {
      setReachedServer(true);
      if (!current()) {
        return;
      }
      opened = true;
      setTie("unpaired");
      join();
    });
    signaling.onClose(({ byClient }) => {
      if (byClient || !current()) {
        return;
      }
      setTie("closed");
      if (!opened) {
        // The client retries; CONNECT_TIMEOUT_MS bounds the wait.
        failedBefore = true;
        return;
      }
      if (attempt.channelOpen) {
        if (attempt.abort.signal.aborted) {
          finish({ s: "failed", problem: lostMessage() });
        } else {
          signaling.close();
        }
        return;
      }
      if (rejoins < MAX_REJOINS) {
        start(rejoins + 1);
      } else {
        finish({ s: "failed", problem: "server" });
      }
    });
    signaling.subscribe((message) => {
      switch (message.t) {
        case "joined":
          if (
            !current() ||
            attempt.peer ||
            !signalKey ||
            message.link !== linkId ||
            message.attempt !== attemptId
          ) {
            break;
          }
          setTie("paired");
          attempt.relayRefused = !message.turn;
          try {
            attempt.peer = createRecipientPeer({
              signaling,
              linkId,
              attempt: attemptId,
              signalKey,
              iceServers: message.iceServers,
              onOpen: (channel, info) => {
                // A short transfer can end before the path resolves, so this checks the attempt, not current().
                void info.path.then((resolved) => {
                  if (attemptRef.current !== attempt) {
                    return;
                  }
                  setPath(resolved);
                  if (resolved === "relay") {
                    setViaRelay(true);
                  }
                });
                onOpen(channel, info.maxMessageSize);
              },
              onClose: () => lost(),
            });
          } catch {
            finish({ s: "failed", problem: "server" });
          }
          break;
        case "relay":
          attempt.heardSender = true;
          void attempt.peer?.handleRelay(message.data);
          break;
        case "refused":
          // A refusal after the sender's first signal means the sender gave up
          // on this attempt (its peer failed or never connected), not that the
          // link is in use or used: the sender only signals a join it took.
          if (attempt.heardSender) {
            finish({ s: "failed", problem: lostMessage() });
          } else if (
            message.reason === "unknown" &&
            (rejoins > 0 || failedBefore) &&
            rejoins < MAX_REJOINS
          ) {
            // The server may have restarted before the sender re-hosted.
            if (current()) {
              release(attempt);
              attempt.timers.push(
                setTimeout(() => {
                  if (attemptRef.current === attempt) {
                    start(rejoins + 1);
                  }
                }, retryDelay(rejoins)),
              );
            }
          } else {
            finish(
              message.reason === "drop"
                ? { s: "failed", problem: lostMessage() }
                : { s: "refused", problem: message.reason },
            );
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
          finish({ s: "refused", problem: offlineMessage() });
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
      let offered: Offer | undefined;
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
            const offer: Offer = {
              ...received,
              from: displayName(received.from),
              text: isTextOffer(received),
            };
            offered = offer;
            attempt.text = offer.text;
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
            finish({ s: "declined", text: offered?.text === true }, true);
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

  const onShow = () => {
    const attempt = attemptRef.current;
    if (view.s !== "offer" || !attempt?.decide || attempt.ended || attempt.abort.signal.aborted) {
      return;
    }
    attempt.decide(new BlobSink());
  };

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
      body = <Problem {...problemFor(view)} />;
      break;
    case "offer": {
      const { offer } = view;
      body = (
        <>
          <h1>{offer.text ? t.secret.offerTitle(offer.from) : t.receive.offerTitle(offer.from)}</h1>
          {offer.from && <p class="text-muted-foreground">{t.receive.unverified}</p>}
          {!offer.text && <FileCard name={offer.name} size={formatBytes(offer.size, lang)} />}
          <div class="mt-6 mb-8 flex flex-col items-start gap-2">
            {offer.text ? (
              <Button type="button" size="lg" onClick={onShow}>
                <Icon name="eye" class="size-4" /> {t.secret.show}
              </Button>
            ) : (
              <Button type="button" size="lg" onClick={onAccept} disabled={picking}>
                <Icon name="download" class="size-4" /> {t.receive.download}
              </Button>
            )}
            <Button type="button" variant="link" onClick={onDecline} disabled={picking}>
              {t.receive.decline}
            </Button>
          </div>
          <Direct from={offer.from || t.common.sender} to={t.common.you} state="ready" />
          <p class={caption}>{t.receive.offerCaption(offer.from)}</p>
          {path && <PathLine path={path} />}
          <OfferDetails offer={offer} />
        </>
      );
      break;
    }
    case "receiving": {
      const { offer, bytes } = view;
      body = (
        <>
          <h1>{offer.text ? t.secret.receivingTitle : t.receive.receivingTitle}</h1>
          {!offer.text && (
            <>
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
            </>
          )}
          <Direct from={t.common.sender} to={t.common.you} state="active" />
          <p class={caption}>{t.receive.receivingCaption}</p>
          {path && <PathLine path={path} />}
        </>
      );
      break;
    }
    case "done": {
      const { offer, blob, sha256 } = view;
      if (offer.text && blob) {
        body = (
          <>
            <div class="flex items-center gap-2.5 text-primary">
              <Icon name="check" class="size-8 stroke-[2.5]" />
              <h1 class="m-0">{t.secret.doneTitle}</h1>
            </div>
            <ShownText
              blob={blob}
              // RECEIPT already went out, so the link is spent: no Try again.
              onUnreadable={() => setView({ s: "refused", problem: "save", text: true })}
            />
            <p class="text-muted-foreground">{t.secret.notSaved}</p>
            <Direct from={t.common.sender} to={t.common.you} state="done" />
            <p class={caption}>{t.receive.doneCaption}</p>
            {path && <PathLine path={path} />}
            <OfferDetails offer={offer} />
          </>
        );
        break;
      }
      body = (
        <>
          <div class="flex items-center gap-2.5 text-primary">
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
          {path && <PathLine path={path} />}
          <OfferDetails offer={offer} sha256={sha256} />
        </>
      );
      break;
    }
    case "declined":
      body = (
        <>
          <h1>{view.text ? t.secret.declinedTitle : t.receive.declinedTitle}</h1>
          <p>{t.receive.declinedBody}</p>
          <Button type="button" variant="link" onClick={() => start()}>
            {view.text ? t.secret.showAgain : t.receive.showAgain}
          </Button>
        </>
      );
      break;
    case "failed": {
      const problem = problemFor(view);
      body = (
        <>
          <Problem {...problem} />
          <Button type="button" onClick={() => start()}>
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
      {/* A new key per step makes its heading a new node, so moving focus there is announced. */}
      <Fragment key={view.s}>{body}</Fragment>
      {panel}
    </Page>
  );
}

function OfferDetails({ offer, sha256 }: { offer: Offer; sha256?: string }) {
  const { t } = useI18n();
  const rows: Array<readonly [string, ComponentChildren]> = offer.text
    ? []
    : [
        [t.common.size, t.format.bytes(offer.size)],
        [t.common.type, offer.type || t.common.typeMissing],
      ];
  rows.push([t.receive.encryptionLabel, t.receive.encryption]);
  if (sha256) {
    rows.push([t.receive.sha256Checked, <code key="sha256">{sha256}</code>]);
  }
  return <TechDetails rows={rows} />;
}

/** A received text, as plain text outside any form field so session restore has none of it to save, with a button that copies it. */
function ShownText({ blob, onUnreadable }: { blob: Blob; onUnreadable(): void }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | undefined>(undefined);
  const [copyNote, setCopyNote] = useState<CopyNote | "">("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void decodeText(blob).then(setText, onUnreadable);
  }, [blob]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const showNote = (note: CopyNote) => {
    clearTimeout(timer.current);
    setCopyNote(note);
    timer.current = setTimeout(() => setCopyNote(""), 4000);
  };

  const copy = async () => {
    if (text === undefined) {
      return;
    }
    try {
      if (!navigator.clipboard) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(text);
      showNote("copied");
    } catch {
      showNote("failed");
    }
  };

  return (
    <div class="my-4 flex flex-col gap-3">
      <section
        class="max-h-52 overflow-y-auto rounded-lg border border-input px-2.5 py-2 text-base transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
        aria-label={t.secret.textLabel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the box scrolls, so keyboard users must reach it.
        tabIndex={0}
        translate={false}
      >
        <pre class="whitespace-pre-wrap wrap-anywhere">{text}</pre>
      </section>
      <div class="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={copy} disabled={text === undefined}>
          {t.secret.copy}
        </Button>
        <span class="text-[0.85rem] text-muted-foreground" role="status">
          {copyNote && t.secret.copyNote[copyNote]}
        </span>
      </div>
    </div>
  );
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
