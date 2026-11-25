// The recipient page: open a link, see what is offered, accept it, and save
// the file, or show the text, once its checksum is verified.
//
// One attempt (see lib/peer.ts and lib/receive-file.ts):
// - Connect to the signaling server and derive the link's signal key. Once
//   both are done, a plain link sends `join`. A link Fidant emailed carries
//   the server's mark (`#e.<mark>.<secret>`), and its page sends `gate` with
//   the mark first, on every attempt. Unless the server answers with the
//   masked address, the mark no longer matches a binding and the page joins
//   nothing (`unbound`). Otherwise it joins with this tab's token from
//   sessionStorage, or first asks the server to email a code and trades the
//   right code for a token. A `gate` answer to a `join` is a refusal: the
//   token is dropped and an emailed link asks `gate` again; a plain link is
//   email-bound and ends as `unbound`.
// - The server answers `join` with `joined`, carrying this pairing's ICE
//   servers, before it tells the sender; the recipient peer is created
//   synchronously on it, so the sender's offer, which comes later on the same
//   socket, always finds a peer to answer it. Each attempt joins with a fresh
//   random attempt ID, so a sender's late refusal of an earlier attempt cannot
//   end this one.
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
//   Reaching the code step resets the rejoin count (a token holder's rejoins
//   do not), and the code field survives a rejoin. A `failed` or `expired`
//   code result asks the gate again, so a binding that is gone ends as "no
//   longer works".
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

import { type CodeResult, isLinkId } from "@sigill/protocol";
import { cn } from "cn";
import { type ComponentChildren, Fragment, type VNode } from "preact";
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { Button, buttonVariants } from "#components/ui/button";
import { Card, CardContent } from "#components/ui/card";
import { Input } from "#components/ui/input";
import { Label } from "#components/ui/label";
import type { Messages } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { encodeBase64url } from "../lib/base64url.ts";
import {
  displayName,
  etaTracker,
  formatBytes,
  formatProgress,
  formatTimeLeft,
  toHex,
} from "../lib/format.ts";
import { deriveSignalKey } from "../lib/keys.ts";
import { LINK_ID_BYTES, parseRecipientLocation } from "../lib/link.ts";
import { createRecipientPeer, type OpenPath, type Peer } from "../lib/peer.ts";
import type { FileOffer } from "../lib/receive-file.ts";
import { ReceiveError, receiveFile } from "../lib/receive-file.ts";
import { peerLostProblem } from "../lib/receive-problem.ts";
import { addRelay, type Kind, NO_RELAYS, type Tie } from "../lib/server-facts.ts";
import { connectSignaling, retryDelay, type SignalingClient } from "../lib/signaling-client.ts";
import {
  BLOB_WARN_BYTES,
  BlobSink,
  canPickSaveFile,
  createSink,
  isPickerCancel,
  type Sink,
} from "../lib/sink.ts";
import { decodeText, isTextOffer } from "../lib/text-secret.ts";
import {
  Direct,
  Icon,
  Page,
  PathLine,
  Problem,
  ServerPanel,
  SwapLabel,
  TechDetails,
  useCopyNote,
} from "../ui.tsx";

const caption = "text-[0.9rem] text-muted-foreground";

/** The offered file, with whatever belongs to it right now: the buttons, the progress or the check. */
function FileBox({
  offer,
  aside,
  children,
}: {
  offer: Offer;
  /** Beside the file on wider screens, under it on phones. */
  aside?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const { lang } = useI18n();
  return (
    <Card className="my-6">
      <CardContent className="flex flex-col gap-4">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {!offer.text && (
            <div class="flex min-w-0 items-center gap-3">
              <Icon name="file" class="size-8 text-muted-foreground" />
              <div class="min-w-0">
                <p class="m-0 font-semibold wrap-anywhere">{offer.name}</p>
                <p class="m-0 text-muted-foreground">{formatBytes(offer.size, lang)}</p>
              </div>
            </div>
          )}
          {aside}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** Which problem to show. Text comes from the dictionary at render time, so a language switch re-renders it. */
type ProblemKey = keyof Messages["receive"]["problems"];

type ProblemText = { title: string; body: string; detail?: string };

type Offer = FileOffer & { text: boolean };

type View =
  | { s: "connecting" }
  | { s: "verify"; to: string; asked: boolean; sending: boolean; result: CodeResult | undefined }
  | { s: "refused"; problem: ProblemKey; text?: boolean }
  | { s: "offer"; offer: Offer }
  | { s: "receiving"; offer: Offer; bytes: number; left?: number | undefined }
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

export function ReceivePage({
  onUnfinished,
}: {
  /** Told whether a file or text is offered or arriving, which leaving the tab would lose. */
  onUnfinished(unfinished: boolean): void;
}) {
  const { t, lang } = useI18n();
  const problemFor = (view: { problem: ProblemKey; text?: boolean }): ProblemText => {
    const problems: Record<ProblemKey, ProblemText> = view.text
      ? { ...t.receive.problems, ...t.secret.problems }
      : t.receive.problems;
    return problems[view.problem];
  };
  const link = useMemo(() => parseRecipientLocation(location), []);
  const [view, setView] = useState<View>({ s: "connecting" });
  const unfinished = view.s === "offer" || view.s === "receiving";
  useEffect(() => onUnfinished(unfinished), [onUnfinished, unfinished]);
  const downloading = view.s === "receiving";
  useEffect(() => {
    if (!downloading) {
      return;
    }
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", ask);
    return () => removeEventListener("beforeunload", ask);
  }, [downloading]);
  const [picking, setPicking] = useState(false);
  const [relayed, countRelay] = useReducer(addRelay, NO_RELAYS);
  const [reachedServer, setReachedServer] = useState(false);
  const [tie, setTie] = useState<Tie>("closed");
  const [viaRelay, setViaRelay] = useState(false);
  const [path, setPath] = useState<OpenPath | undefined>(undefined);
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const codeAsked = useRef<string | undefined>(undefined);

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
    const { linkId, secret, mark } = link;
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
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const armConnectTimeout = () => {
      clearTimeout(connectTimer);
      connectTimer = setTimeout(() => {
        if (!attempt.channelOpen) {
          finish({ s: "failed", problem: attempt.peer ? lostMessage() : "server" });
        }
      }, CONNECT_TIMEOUT_MS);
      attempt.timers.push(connectTimer);
    };
    armConnectTimeout();

    // Set before `join` is sent, so it is there when `joined` arrives.
    let signalKey: CryptoKey | undefined;
    let opened = false;
    /** A connection attempt failed, so the server may have restarted and lost the sender's link. */
    let failedBefore = false;
    let joinSent = false;
    const ask = () => {
      if (!opened || !signalKey || !current()) {
        return;
      }
      if (mark) {
        signaling.send({ t: "gate", link: linkId, mark });
      } else {
        join(undefined);
      }
    };
    const join = (token: string | undefined) => {
      joinSent = true;
      armConnectTimeout();
      signaling.send(
        token === undefined
          ? { t: "join", link: linkId, attempt: attemptId }
          : { t: "join", link: linkId, attempt: attemptId, token },
      );
    };
    void deriveSignalKey(secret, linkId).then(
      (key) => {
        signalKey = key;
        ask();
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
      ask();
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
        case "gate": {
          if (!current() || message.link !== linkId) {
            break;
          }
          if (joinSent) {
            joinSent = false;
            storeToken(linkId, undefined);
            if (mark) {
              ask();
            } else {
              finish({ s: "refused", problem: "unbound" });
            }
            break;
          }
          // Someone else may host this link ID now, without the code that guards the emailed one.
          if (!message.to) {
            storeToken(linkId, undefined);
            finish({ s: "refused", problem: "unbound" });
            break;
          }
          const token = readToken(linkId);
          if (token) {
            join(token);
            break;
          }
          // Time on the code step must not use up the attempts a dropped connection gets.
          rejoins = 0;
          // The code step has no deadline; `join` arms it again.
          clearTimeout(connectTimer);
          const to = message.to;
          setView((v) =>
            v.s === "verify"
              ? v
              : {
                  s: "verify",
                  to,
                  asked: codeAsked.current === linkId,
                  sending: false,
                  result: undefined,
                },
          );
          break;
        }
        case "code":
          if (current() && message.link === linkId) {
            const { result } = message;
            setView((v) => (v.s === "verify" ? { ...v, sending: false, result } : v));
            // The binding may be gone: the gate answers with no address if so.
            if (!joinSent && (result === "failed" || result === "expired")) {
              ask();
            }
          }
          break;
        case "token":
          if (!current() || message.link !== linkId || joinSent) {
            break;
          }
          storeToken(linkId, message.token);
          codeAsked.current = undefined;
          setView({ s: "connecting" });
          join(message.token);
          break;
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
      let timeLeft: ReturnType<typeof etaTracker> | undefined;
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
                timeLeft = etaTracker(offer.size);
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
          const left = timeLeft?.(performance.now(), bytes);
          setView((v) => (v.s === "receiving" ? { ...v, bytes, left } : v));
        },
      }).then(
        (result) => {
          if (result.type === "declined") {
            finish({ s: "declined", text: attempt.text }, true);
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

  const onSendCode = () => {
    const attempt = attemptRef.current;
    if (view.s !== "verify" || view.sending || !attempt || !link?.mark) {
      return;
    }
    codeAsked.current = link.linkId;
    setView({ ...view, asked: true, sending: true, result: undefined });
    attempt.signaling.send({ t: "send-code", link: link.linkId, mark: link.mark });
  };

  const onCode = (event: Event) => {
    event.preventDefault();
    const attempt = attemptRef.current;
    if (view.s !== "verify" || !attempt || !link?.mark) {
      return;
    }
    const input = (event.currentTarget as HTMLFormElement).elements.namedItem(
      "code",
    ) as HTMLInputElement;
    const code = input.value.replace(/\s/g, "");
    // The server drops the connection on a malformed code, so only six digits go out.
    if (!/^[0-9]{6}$/.test(code)) {
      setView({ ...view, result: "wrong" });
      input.focus();
      return;
    }
    setView({ ...view, result: undefined });
    attempt.signaling.send({ t: "code", link: link.linkId, code, mark: link.mark });
  };

  if (!link) {
    return (
      <Page tall>
        <Problem {...t.receive.problems.badLink} />
      </Page>
    );
  }

  const emailed = link?.mark !== undefined;
  const isText = "offer" in view ? view.offer.text : "text" in view ? view.text : undefined;
  const kind: Kind = isText === undefined ? "unknown" : isText ? "secret" : "file";
  const panel = reachedServer ? (
    <ServerPanel
      sees={t.server.seesRecipient}
      holds={t.server.recipientHolds(tie, emailed, kind)}
      relayed={relayed}
      afterwards={t.server.afterwardsRecipient(emailed)}
      viaRelay={viaRelay}
      emailed={emailed}
      kind={kind}
    />
  ) : null;

  let body: VNode;
  switch (view.s) {
    case "connecting":
      body = <h1>{t.receive.connecting}</h1>;
      break;
    case "verify": {
      const { verify } = t.receive;
      const isError = !view.sending && view.result !== undefined && view.result !== "sent";
      body = (
        <>
          <h1>{verify.title}</h1>
          <p>{verify.body(view.to)}</p>
          <Button type="button" variant={view.asked ? "outline" : "default"} onClick={onSendCode}>
            {verify.send}
          </Button>
          {view.asked && (
            <form class="mt-6 flex flex-wrap items-end gap-2" onSubmit={onCode} noValidate>
              <div class="flex flex-col gap-1">
                <Label htmlFor="code">{verify.codeLabel}</Label>
                <Input
                  id="code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  required
                  className="w-36"
                  aria-invalid={view.result === "wrong" ? "true" : "false"}
                  aria-describedby="code-note"
                />
              </div>
              <Button type="submit">{verify.submit}</Button>
            </form>
          )}
          <p
            id="code-note"
            class={isError ? "mt-3 text-destructive" : `mt-3 ${caption}`}
            aria-live="polite"
          >
            {view.sending ? verify.sending : view.result && verify.results[view.result]}
          </p>
        </>
      );
      break;
    }
    case "refused":
      body = <Problem {...problemFor(view)} />;
      break;
    case "offer": {
      const { offer } = view;
      body = (
        <>
          <h1 class="mb-1">
            {offer.text ? t.secret.offerTitle(offer.from) : t.receive.offerTitle(offer.from)}
          </h1>
          {offer.from && <p class="mt-0 text-muted-foreground">{t.receive.unverified}</p>}
          <FileBox
            offer={offer}
            aside={
              <div class="flex flex-none flex-col gap-2 sm:flex-row sm:items-center">
                {offer.text ? (
                  <Button type="button" size="lg" className="w-full sm:w-auto" onClick={onShow}>
                    <Icon name="eye" class="size-4" /> {t.secret.show}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="lg"
                    className="w-full sm:w-auto"
                    onClick={onAccept}
                    disabled={picking}
                  >
                    <Icon name="download" class="size-4" /> {t.receive.download}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={onDecline}
                  disabled={picking}
                >
                  {t.receive.decline}
                </Button>
              </div>
            }
          >
            {!offer.text && offer.size > BLOB_WARN_BYTES && !canPickSaveFile() && (
              <p class="m-0 text-muted-foreground">{t.receive.memoryWarning}</p>
            )}
          </FileBox>
          <p class={`-mt-2 ${caption}`}>{t.receive.onceNotice}</p>
          <Direct from={offer.from || t.common.sender} to={t.common.you} state="ready" />
          <p class={caption}>{t.receive.offerCaption(offer.from)}</p>
          {path && <PathLine path={path} />}
          <OfferDetails offer={offer} emailed={emailed} />
        </>
      );
      break;
    }
    case "receiving": {
      const { offer, bytes, left } = view;
      body = (
        <>
          <h1>{offer.text ? t.secret.receivingTitle : t.receive.receivingTitle}</h1>
          {!offer.text && (
            <FileBox offer={offer}>
              <div class="flex flex-col gap-1.5">
                <progress
                  class="w-full accent-primary"
                  aria-label={t.receive.progressLabel}
                  max={Math.max(offer.size, 1)}
                  value={offer.size === 0 ? 0 : bytes}
                />
                <div class="flex flex-wrap justify-between gap-x-4 text-[0.85rem] text-muted-foreground tabular-nums">
                  <span>{formatProgress(bytes, offer.size, lang)}</span>
                  {left !== undefined && <span>{formatTimeLeft(left, lang)}</span>}
                </div>
              </div>
            </FileBox>
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
      const textBlob = offer.text ? blob : undefined;
      body = (
        <>
          <div class="flex items-center gap-2.5 text-primary">
            <Icon name="check" class="size-8 stroke-[2.5]" />
            <h1 class="m-0">{textBlob ? t.secret.doneTitle : t.receive.doneTitle}</h1>
          </div>
          {textBlob ? (
            <>
              <ShownText
                blob={textBlob}
                // RECEIPT already went out, so the link is spent: no Try again.
                onUnreadable={() => setView({ s: "refused", problem: "save", text: true })}
              />
              <p class="text-muted-foreground">{t.secret.notSaved}</p>
            </>
          ) : (
            <FileBox
              offer={offer}
              aside={blob && <SaveLink blob={blob} name={offer.name} label={t.receive.saveFile} />}
            >
              <div class="border-t border-border pt-4">
                <p class="m-0 flex items-start gap-2 font-medium">
                  <Icon name="check" class="mt-0.5 size-5" />
                  {t.receive.verified}
                </p>
                <p class="mt-1 mb-0 pl-7 text-muted-foreground">
                  {blob ? t.receive.autoDownload : t.receive.savedWhereChosen}
                </p>
              </div>
            </FileBox>
          )}
          <Direct from={t.common.sender} to={t.common.you} state="done" />
          <p class={caption}>{t.receive.doneCaption}</p>
          {path && <PathLine path={path} />}
          <OfferDetails offer={offer} sha256={textBlob ? undefined : sha256} emailed={emailed} />
        </>
      );
      break;
    }
    case "declined":
      body = (
        <>
          <h1>{view.text ? t.secret.declinedTitle : t.receive.declinedTitle}</h1>
          <p>{t.receive.declinedBody}</p>
          <Button type="button" variant="outline" onClick={() => start()}>
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
    <Page tall>
      {/* A new key per step makes its heading a new node, so moving focus there is announced. */}
      <Fragment key={view.s}>{body}</Fragment>
      {panel}
    </Page>
  );
}

/** This tab's token for an emailed link. Storage that is blocked acts as empty. */
function readToken(linkId: string): string | undefined {
  try {
    const token = sessionStorage.getItem(`token:${linkId}`);
    return isLinkId(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

function storeToken(linkId: string, token: string | undefined): void {
  try {
    if (token === undefined) {
      sessionStorage.removeItem(`token:${linkId}`);
    } else {
      sessionStorage.setItem(`token:${linkId}`, token);
    }
  } catch {
    // Not kept: this attempt still joins, and a reload asks for a new code.
  }
}

function OfferDetails({
  offer,
  sha256,
  emailed,
}: {
  offer: Offer;
  sha256?: string | undefined;
  emailed: boolean;
}) {
  const { t } = useI18n();
  const rows: Array<readonly [string, ComponentChildren]> = offer.text
    ? []
    : [
        [t.common.size, t.format.bytes(offer.size)],
        [t.common.type, offer.type || t.common.typeMissing],
      ];
  rows.push([
    t.receive.encryptionLabel,
    emailed ? t.receive.encryptionEmailed : t.receive.encryption,
  ]);
  if (sha256) {
    rows.push([t.receive.sha256Checked, <code key="sha256">{sha256}</code>]);
  }
  return <TechDetails rows={rows} />;
}

/** A received text, as plain text outside any form field so session restore has none of it to save, with a button that copies it. */
function ShownText({ blob, onUnreadable }: { blob: Blob; onUnreadable(): void }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | undefined>(undefined);
  const { note, copy } = useCopyNote();

  useEffect(() => {
    void decodeText(blob).then(setText, onUnreadable);
  }, [blob]);

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
        <Button
          type="button"
          onClick={() => text !== undefined && copy(text)}
          disabled={text === undefined}
        >
          <SwapLabel
            idle={t.secret.copy}
            active={t.secret.copyNote.copied}
            on={note === "copied"}
          />
        </Button>
        <span
          class={`text-[0.85rem] text-muted-foreground ${note === "copied" ? "sr-only" : ""}`}
          role="status"
        >
          {note && t.secret.copyNote[note]}
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
