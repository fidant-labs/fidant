// The sender page: choose a file (or, on /secret, paste a text that goes as
// one), add named recipients, share each one's link, and send it to every
// recipient who opens their link.
//
// Wiring (see lib/peer.ts and lib/sender-state.ts):
// - On mount, connect to the signaling server and host every link ID on the
//   list, with whether recipients may use our TURN relay; re-host the full
//   list after every add or remove, every change of the relay checkbox and
//   every reconnect, and again REHOST_AFTER_MS after `already-hosted` while
//   the server still holds the old socket. When the socket drops, recipients
//   still connecting go back to waiting (reducer `server-lost`, which never
//   blames the relay); the page says the server is gone
//   only after LOST_AFTER_MS without it.
// - Server `joined` → reducer `joined`, whose `start` effect derives the
//   link's signal key and creates a sender peer with the ICE servers from
//   `joined`. `relay` goes to that peer.
//   `left` → reducer `left`, which only matters before the channel opens.
// - When the data channel opens, sendFile runs the transfer and reports
//   accepted, progress, declined and receipt back to the reducer.
// - On /secret, a connection whose max message size can't carry every text in
//   one chunk (textFitsOneChunk) gets nothing: reducer `unsendable` fails the
//   recipient's card and refuses the joiner.
// - A peer that closes or fails before delivery → `dropped`; a data channel
//   that has not opened SETUP_TIMEOUT_MS after the join → `timeout`. Both
//   refuse the joiner so the server unbinds it (see sender-state.ts).
// - Each connection reports its path to the server once: direct, stun or
//   relay when the channel opens, failed on an ICE failure or a timeout. A
//   relay path on an active attempt whose relay the sender refused
//   (refusesRelay) counts as failed too, and the reducer then ends the
//   attempt. An open channel's path also goes to the reducer, for the
//   recipient's card.
// - Effects run outside render: `close` tears the peer down, `refuse` tells
//   the server to refuse the joiner.
// - When the server's `hello` says it can send mail, the add form offers an
//   email address. Adding a recipient with one sends a single `email` message
//   after the `host` that includes its link; the server's `email` replies go
//   to the reducer. Its card offers no link until the server answers, then
//   the marked link the server emailed, or the plain one if it refused. A
//   reconnect never hosts an emailed link again (reducer `server-lost`).
//
// Names, the file or text and link secrets stay in this tab. The server only ever
// gets link IDs, attempt IDs, opaque sealed signals, refusal reasons,
// connection paths and the relay choice, except that an emailed link's one
// `email` message carries its address, its secret and the sender's typed
// name (decision 0012). Recipient names never leave this tab.

import {
  type ConnectionPath,
  type IceServer,
  isAddress,
  MAX_ADDRESS,
  MAX_LINKS,
} from "@sigill/protocol";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { Alert, AlertDescription } from "#components/ui/alert";
import { Button } from "#components/ui/button";
import { Input } from "#components/ui/input";
import { Label } from "#components/ui/label";
import type { Messages } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { formatBytes, toHex } from "../lib/format.ts";
import { hasForbiddenCharacters, MAX_FROM_LENGTH, metaFits } from "../lib/frames.ts";
import { deriveSignalKey } from "../lib/keys.ts";
import { createLink } from "../lib/link.ts";
import { createSenderPeer, type Peer } from "../lib/peer.ts";
import { hashFile, sendFile } from "../lib/send-file.ts";
import {
  emailBound,
  findRecipient,
  hostedLinks,
  initialSenderState,
  isActive,
  refusesRelay,
  SETUP_TIMEOUT_MS,
  type SenderAction,
  type SenderEffect,
  type SenderState,
  update,
} from "../lib/sender-state.ts";
import { addRelay, NO_RELAYS } from "../lib/server-facts.ts";
import { connectSignaling, type SignalingClient } from "../lib/signaling-client.ts";
import { MAX_TEXT_LENGTH, textFile, textFitsOneChunk } from "../lib/text-secret.ts";
import { FileCard, Icon, lede, Page, ServerPanel, TechDetails } from "../ui.tsx";
import { RecipientList } from "./RecipientList.tsx";

type Hash =
  | { status: "none" }
  | { status: "preparing" }
  | { status: "ready"; hex: string }
  | { status: "failed" };

type Connection = {
  abort: AbortController;
  peer?: Peer;
  /** Fires `timeout` if the data channel has not opened in time. */
  deadline?: ReturnType<typeof setTimeout>;
  /** Set once the connection's path went to the server. */
  pathSent?: boolean;
};

// Errors are kept as keys and turned into text in render, so they follow a language switch.
type ErrorOf<K extends "fromError" | "fileError" | "nameError"> = keyof Messages["send"][K] | "";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** How long the server may stay unreachable before the page says so. */
const LOST_AFTER_MS = 10_000;
/** How long to wait before hosting again when the server still holds a link for our old socket. */
const REHOST_AFTER_MS = 5000;

const field = "flex flex-1 flex-col gap-1";
const fieldError = "mt-1 mb-0 text-destructive";
const hint = "text-[0.9rem] text-muted-foreground";
const stepLabel = "m-0 mb-1 text-[0.85rem] font-medium text-muted-foreground";
const GLIDE_MS = 450;

/** Scrolls the window to `el` with an ease-in-out curve; stops if the user scrolls, jumps if they prefer less motion. */
function glideTo(el: HTMLElement) {
  const offset = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const goal = () => el.getBoundingClientRect().top + scrollY - offset;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    scrollTo({ top: goal(), behavior: "instant" });
    return;
  }
  const from = scrollY;
  const start = performance.now();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  const events = ["wheel", "touchstart", "keydown"] as const;
  for (const name of events) {
    addEventListener(name, stop, { once: true, passive: true });
  }
  const step = (now: number) => {
    const t = Math.min((now - start) / GLIDE_MS, 1);
    const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    if (!stopped) {
      scrollTo({ top: from + (goal() - from) * eased, behavior: "instant" });
    }
    if (t < 1 && !stopped) {
      requestAnimationFrame(step);
    } else {
      for (const name of events) {
        removeEventListener(name, stop);
      }
    }
  };
  requestAnimationFrame(step);
}

export function SendPage({
  kind,
  onUnfinished,
}: {
  kind: "file" | "text";
  /** Told whether any recipient is still unfinished, the same test that guards closing the tab. */
  onUnfinished(unfinished: boolean): void;
}) {
  const { t, lang } = useI18n();
  const text = kind === "text";
  // Both kinds can be mounted at once, so the text page prefixes its element IDs.
  const id = (name: string) => (text ? `secret-${name}` : name);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [hash, setHash] = useState<Hash>({ status: "none" });
  const [sender, setSender] = useState<SenderState>(initialSenderState);
  const [lostServer, setLostServer] = useState(false);
  const [relayed, countRelay] = useReducer(addRelay, NO_RELAYS);
  const [viaRelay, setViaRelay] = useState(false);
  const [nameError, setNameError] = useState<ErrorOf<"nameError">>("");
  const [mail, setMail] = useState(false);
  const [emailFilled, setEmailFilled] = useState(false);
  const [emailError, setEmailError] = useState(false);
  // ponytail: sticky for the page, since the server saw the key and keeps email counts for an hour
  const [mailed, setMailed] = useState(false);
  const [fileError, setFileError] = useState<ErrorOf<"fileError">>("");
  const [from, setFrom] = useState("");
  const [fromError, setFromError] = useState<ErrorOf<"fromError">>("");
  const [allowRelay, setAllowRelay] = useState(true);
  const [textLength, setTextLength] = useState(0);
  const [more, setMore] = useState(false);

  // Mutable state used from network callbacks, outside render.
  const senderRef = useRef<SenderState>(initialSenderState);
  // Set when the first recipient is added; the name field stays locked while anyone is on the list.
  const fromRef = useRef("");
  const allowRelayRef = useRef(true);
  const fileRef = useRef<{ file: File; sha256: Promise<Uint8Array> } | undefined>(undefined);
  const hashAbortRef = useRef<AbortController | undefined>(undefined);
  const signalingRef = useRef<SignalingClient | undefined>(undefined);
  const connectionsRef = useRef(new Map<string, Connection>());
  const dispatchRef = useRef<(action: SenderAction) => void>(() => {});

  const host = () => {
    signalingRef.current?.send({
      t: "host",
      links: hostedLinks(senderRef.current),
      turn: allowRelayRef.current,
    });
  };

  const closeConnection = (linkId: string) => {
    const connection = connectionsRef.current.get(linkId);
    if (!connection) {
      return;
    }
    connectionsRef.current.delete(linkId);
    clearTimeout(connection.deadline);
    connection.abort.abort(new Error("connection closed"));
    connection.peer?.close();
  };

  const sendPath = (linkId: string, connection: Connection, path: ConnectionPath) => {
    if (!connection.pathSent) {
      connection.pathSent = true;
      signalingRef.current?.send({ t: "path", link: linkId, path });
    }
  };

  const startConnection = async (linkId: string, attempt: string, iceServers: IceServer[]) => {
    const recipient = findRecipient(senderRef.current, linkId);
    const signaling = signalingRef.current;
    if (!recipient || !signaling) {
      return;
    }
    closeConnection(linkId);
    const connection: Connection = { abort: new AbortController() };
    connectionsRef.current.set(linkId, connection);
    const dispatch = (action: SenderAction) => dispatchRef.current(action);
    // Someone who knows the link ID but not the secret can join and stay
    // silent; the reducer then refuses them so the link is free again.
    connection.deadline = setTimeout(() => {
      if (connectionsRef.current.get(linkId) === connection) {
        sendPath(linkId, connection, "failed");
        dispatch({ type: "timeout", linkId });
      }
    }, SETUP_TIMEOUT_MS);

    let signalKey: CryptoKey;
    try {
      signalKey = await deriveSignalKey(recipient.secret, linkId);
    } catch {
      console.warn("sigill: sender dropped a connection: signal-key");
      dispatch({ type: "dropped", linkId });
      return;
    }
    if (connection.abort.signal.aborted) {
      return;
    }

    connection.peer = createSenderPeer({
      signaling,
      linkId,
      attempt,
      signalKey,
      iceServers,
      onOpen(channel, info) {
        clearTimeout(connection.deadline);
        // The path may come after a short transfer already closed the
        // connection; send it while the link is still hosted.
        void info.path.then((path) => {
          const latest = findRecipient(senderRef.current, linkId);
          if (latest) {
            const refused = refusesRelay(latest, attempt, path);
            sendPath(linkId, connection, refused ? "failed" : path);
            dispatch({ type: "path", linkId, attempt, path });
            // ponytail: sticky for the page, since the relay's log lines stay after the transfer
            if (path === "relay" && !refused) {
              setViaRelay(true);
            }
          }
        });
        // Judged by the longest text, so a refusal says nothing about this text's length.
        if (text && !textFitsOneChunk(info.maxMessageSize)) {
          dispatch({ type: "unsendable", linkId });
          return;
        }
        dispatch({ type: "channel-open", linkId });
        const chosen = fileRef.current;
        if (!chosen) {
          dispatch({ type: "dropped", linkId });
          return;
        }
        sendFile({
          channel,
          maxMessageSize: info.maxMessageSize,
          file: chosen.file,
          from: fromRef.current,
          secret: recipient.secret,
          sha256: chosen.sha256,
          signal: connection.abort.signal,
          onAccepted: () => dispatch({ type: "accepted", linkId }),
          onProgress: (bytesSent) => dispatch({ type: "progress", linkId, bytesSent }),
        }).then(
          (result) => {
            if (result.type === "declined") {
              dispatch({ type: "declined", linkId });
            } else {
              dispatch({ type: "receipt", linkId, match: result.match });
            }
          },
          () => {
            if (!connection.abort.signal.aborted) {
              dispatch({ type: "dropped", linkId });
            }
          },
        );
      },
      onClose(reason, _detail, name) {
        console.warn(`sigill: sender dropped a connection: ${reason}${name ? ` (${name})` : ""}`);
        if (reason === "connection-failed") {
          sendPath(linkId, connection, "failed");
        }
        dispatch({ type: "dropped", linkId });
      },
    });
  };

  const runEffect = (effect: SenderEffect) => {
    switch (effect.type) {
      case "start":
        void startConnection(effect.linkId, effect.attempt, effect.iceServers);
        break;
      case "close":
        closeConnection(effect.linkId);
        break;
      case "refuse":
        signalingRef.current?.send({
          t: "refuse",
          link: effect.linkId,
          attempt: effect.attempt,
          reason: effect.reason,
        });
        break;
    }
  };

  // Applies an action, then carries out its effects. Never called during render.
  dispatchRef.current = (action: SenderAction) => {
    const next = update(senderRef.current, action);
    if (next.state !== senderRef.current) {
      senderRef.current = next.state;
      setSender(next.state);
    }
    for (const effect of next.effects) {
      runEffect(effect);
    }
    if (action.type === "add" || action.type === "remove") {
      host();
    }
  };

  // Runs once on mount: everything it uses is read through refs.
  useEffect(() => {
    const signaling = connectSignaling({ onRelay: countRelay });
    signalingRef.current = signaling;
    let disposed = false;
    const dispatch = (action: SenderAction) => dispatchRef.current(action);

    let lost: ReturnType<typeof setTimeout> | undefined;
    let rehost: ReturnType<typeof setTimeout> | undefined;

    signaling.onOpen(() => {
      clearTimeout(lost);
      lost = undefined;
      setLostServer(false);
      host();
    });
    signaling.onClose(({ byClient }) => {
      if (byClient || disposed) {
        return;
      }
      // The server forgot these joins with the socket; the recipients will join again.
      dispatch({ type: "server-lost" });
      // Short drops (a server restart) reconnect quietly.
      lost ??= setTimeout(() => setLostServer(true), LOST_AFTER_MS);
    });
    signaling.subscribe((message) => {
      switch (message.t) {
        case "joined":
          dispatch({
            type: "joined",
            linkId: message.link,
            attempt: message.attempt,
            iceServers: message.iceServers,
            turn: message.turn,
          });
          break;
        case "left":
          dispatch({ type: "left", linkId: message.link });
          break;
        case "hello":
          setMail(message.mail);
          break;
        case "email":
          dispatch({
            type: "email",
            linkId: message.link,
            status: message.status,
            mark: message.mark,
          });
          break;
        case "relay":
          void connectionsRef.current.get(message.link)?.peer?.handleRelay(message.data);
          break;
        case "error":
          // After a reconnect the server may not have noticed the old socket close yet.
          if (message.code === "already-hosted") {
            clearTimeout(rehost);
            rehost = setTimeout(host, REHOST_AFTER_MS);
          }
          break;
        default:
          break;
      }
    });

    // Closing the tab ends every transfer, so ask first while any is unfinished.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (senderRef.current.recipients.some((r) => r.status !== "delivered")) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    // Once the page is really going, close the peers so recipients hear it now, not when ICE
    // consent runs out about 15 s later.
    const onPageHide = () => {
      for (const linkId of [...connectionsRef.current.keys()]) {
        closeConnection(linkId);
      }
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      disposed = true;
      clearTimeout(lost);
      clearTimeout(rehost);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      hashAbortRef.current?.abort();
      for (const linkId of [...connectionsRef.current.keys()]) {
        closeConnection(linkId);
      }
      signaling.close();
    };
  }, []);

  const prepare = (chosen: File | undefined) => {
    hashAbortRef.current?.abort(new Error("a different file was chosen"));
    hashAbortRef.current = undefined;
    setFile(chosen);
    if (!chosen) {
      fileRef.current = undefined;
      setHash({ status: "none" });
      return;
    }
    const controller = new AbortController();
    hashAbortRef.current = controller;
    const sha256 = hashFile(chosen, controller.signal);
    // Hashed once; every recipient's transfer awaits the same promise.
    fileRef.current = { file: chosen, sha256 };
    setHash({ status: "preparing" });
    sha256.then(
      (digest) => {
        if (!controller.signal.aborted) {
          setHash({ status: "ready", hex: toHex(digest) });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setHash({ status: "failed" });
        }
      },
    );
  };

  const onFileChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = input.files?.[0];
    const unsafe =
      !!chosen && (hasForbiddenCharacters(chosen.name) || hasForbiddenCharacters(chosen.type));
    const fits = !chosen || (!unsafe && metaFits(chosen));
    setFileError(fits ? "" : unsafe ? "unsafe" : "tooLong");
    // Clear the input so it does not show a file that will not be sent.
    if (!fits) {
      input.value = "";
    }
    prepare(fits ? chosen : undefined);
    if (fits && chosen) {
      goToRecipients();
    }
  };

  const onAdd = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("name") as HTMLInputElement;
    const name = input.value.trim();
    if (!name) {
      setNameError("missing");
      input.focus();
      return;
    }
    if (sender.recipients.some((r) => r.name === name)) {
      setNameError("taken");
      input.focus();
      return;
    }
    setNameError("");
    const emailInput = form.elements.namedItem("email") as HTMLInputElement | null;
    const email = emailInput?.value.trim() ?? "";
    if (email && !isAddress(email)) {
      setEmailError(true);
      emailInput?.focus();
      return;
    }
    if (sender.recipients.length === 0) {
      const typed = from.trim();
      const problem = hasForbiddenCharacters(typed)
        ? "unsafe"
        : file && !metaFits(file, typed)
          ? "tooLong"
          : "";
      setFromError(problem);
      if (problem) {
        document.getElementById(id("from"))?.focus();
        return;
      }
      fromRef.current = typed;
    }
    const link = createLink(location.origin);
    dispatchRef.current(email ? { type: "add", link, name, email } : { type: "add", link, name });
    // After `add`, so the server already hosts the link this names.
    if (email && findRecipient(senderRef.current, link.linkId)) {
      const sent = signalingRef.current?.send({
        t: "email",
        link: link.linkId,
        to: email,
        secret: link.secret,
        from: fromRef.current,
        lang,
      });
      if (sent) {
        setMailed(true);
      } else {
        dispatchRef.current({ type: "email", linkId: link.linkId, status: "failed" });
      }
    }
    form.reset();
    setMore(false);
    setEmailFilled(false);
    input.focus();
  };

  const onRemove = (linkId: string) => {
    const list = senderRef.current.recipients;
    const index = list.findIndex((r) => r.linkId === linkId);
    const neighbour = list[index + 1] ?? list[index - 1];
    dispatchRef.current({ type: "remove", linkId });
    // The removed card held focus; keep the keyboard user in the list once it has re-rendered.
    requestAnimationFrame(() => {
      const target = neighbour
        ? document.querySelector<HTMLElement>(`[data-remove="${neighbour.linkId}"]`)
        : document.getElementById(id("recipient-name"));
      target?.focus();
    });
  };

  const hasRecipients = sender.recipients.length > 0;
  const tooLong = textLength > MAX_TEXT_LENGTH;
  const full = sender.recipients.length >= MAX_LINKS;
  const isLocalhost = LOCAL_HOSTS.has(location.hostname);
  // ponytail: counts by status, so it over-counts if a recipient's signaling drops mid-transfer; track joined/left if that matters
  const connected = sender.recipients.filter(isActive).length;
  const emailed = sender.recipients.filter(emailBound);
  const unfinished = sender.recipients.some((r) => r.status !== "delivered");
  useEffect(() => onUnfinished(unfinished), [onUnfinished, unfinished]);
  const delivered = sender.recipients.filter((r) => r.status === "delivered").length;
  const allDone = hasRecipients && !unfinished;
  const finished = allDone && !more;
  const recipientList = (
    <RecipientList
      recipients={sender.recipients}
      fileSize={file?.size ?? 0}
      statusText={text ? { ...t.send.status, ...t.secret.status } : t.send.status}
      summary={(text ? t.secret : t.send).summary}
      onRemove={onRemove}
    />
  );

  const goToRecipients = () =>
    requestAnimationFrame(() => {
      const target = document.getElementById(id("recipients"));
      if (target) {
        glideTo(target);
      }
      document.getElementById(id("from"))?.focus({ preventScroll: true });
    });

  return (
    <Page>
      <div>
        <section aria-labelledby={id("send-title")}>
          <p class={stepLabel}>{t.send.step(1)}</p>
          <h1 id={id("send-title")} class="mt-0">
            {text ? t.menu.secret : t.send.title}
          </h1>
          <p class={lede}>{text ? t.secret.lede : t.send.lede}</p>

          {isLocalhost && (
            <Alert role="note" className="my-4">
              <AlertDescription>{t.send.localhost}</AlertDescription>
            </Alert>
          )}
          {lostServer && (
            <Alert variant="destructive" className="my-4">
              <AlertDescription>{text ? t.secret.lostServer : t.send.lostServer}</AlertDescription>
            </Alert>
          )}

          {text && (
            <div class={`my-4 ${field}`}>
              <Label htmlFor="secret-text">{t.secret.label}</Label>
              <textarea
                id="secret-text"
                class="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-base transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
                rows={6}
                spellcheck={false}
                translate={false}
                autocomplete="off"
                writingsuggestions="false"
                // camelCase so Preact sets the attribute; the autocorrect property is a boolean in WebKit and Firefox.
                autoCorrect="off"
                autocapitalize="off"
                disabled={hasRecipients}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setTextLength(value.length);
                  prepare(textFile(value));
                }}
                aria-invalid={tooLong ? "true" : "false"}
                aria-describedby={
                  tooLong ? "secret-text-error secret-text-hint" : "secret-text-hint"
                }
              />
              <p id="secret-text-hint" class={`m-0 ${hint}`}>
                {t.secret.hint(MAX_TEXT_LENGTH)}
              </p>
              {/* Always rendered so the status is announced; the count stays outside it so each key isn't read out. */}
              <p id="secret-text-error" class={tooLong ? fieldError : "-mt-1 mb-0"}>
                {tooLong && `${t.secret.count(textLength, MAX_TEXT_LENGTH)} `}
                <span role="status">{tooLong && t.secret.tooLong}</span>
              </p>
              <Button
                type="button"
                className="mt-2 self-start"
                disabled={!file || tooLong}
                onClick={goToRecipients}
              >
                {t.send.continue}
              </Button>
            </div>
          )}
          {!text && !hasRecipients && (
            <div
              class={`group relative my-4 rounded-2xl border-2 ${file ? "border-solid" : "border-dashed"} border-border bg-card transition-colors focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-primary hover:border-foreground/40 hover:bg-muted/40`}
            >
              <input
                id="file"
                type="file"
                class="absolute inset-0 size-full cursor-pointer opacity-0"
                onChange={onFileChange}
                aria-invalid={fileError ? "true" : "false"}
                aria-describedby={fileError ? "file-error" : undefined}
              />
              {file ? (
                <label for="file" class="flex items-center gap-3 px-4 py-4">
                  <Icon name="file" class="size-8 flex-none text-muted-foreground" />
                  <span class="min-w-0 flex-1">
                    <span class="block font-semibold wrap-anywhere">{file.name}</span>
                    <span class="block text-muted-foreground">{formatBytes(file.size, lang)}</span>
                  </span>
                  <span class="font-medium underline underline-offset-4">{t.send.change}</span>
                </label>
              ) : (
                <label
                  for="file"
                  class="flex flex-col items-center gap-3 px-4 py-14 text-center text-muted-foreground lg:py-20"
                >
                  <span class="inline-flex size-14 items-center justify-center rounded-xl bg-muted text-foreground">
                    <Icon name="file" class="size-7" />
                  </span>
                  <span>
                    <strong class="text-foreground">{t.send.chooseFile}</strong> {t.send.orDrop}
                  </span>
                </label>
              )}
            </div>
          )}
          {fileError && (
            <p id="file-error" class={fieldError}>
              {t.send.fileError[fileError]}
            </p>
          )}
          {file && !text && (
            <>
              {hasRecipients && <FileCard name={file.name} size={formatBytes(file.size, lang)} />}
              {hash.status === "preparing" && (
                <p class="text-muted-foreground" role="status">
                  {t.send.preparing}
                </p>
              )}
              {hash.status === "failed" && (
                <p class={fieldError} role="alert">
                  {t.send.readFailed}
                </p>
              )}
              <TechDetails
                rows={[
                  [t.common.size, t.format.bytes(file.size)],
                  [t.common.type, file.type || t.common.typeMissing],
                  [
                    "SHA-256",
                    hash.status === "ready" ? <code>{hash.hex}</code> : t.send.hashPending,
                  ],
                ]}
              />
            </>
          )}
          {hasRecipients && <p class={hint}>{text ? t.secret.locked : t.send.locked}</p>}
        </section>

        <section
          id={id("recipients")}
          class={`mt-12 scroll-mt-24 border-t border-border pt-8 transition-opacity ${file ? "" : "opacity-50"}`}
          aria-labelledby={id("recipients-heading")}
        >
          <p class={stepLabel}>{t.send.step(2)}</p>
          <h2 id={id("recipients-heading")} tabIndex={-1} class="m-0 text-[1.75rem] font-bold">
            {t.send.peopleHeading}
          </h2>
          <p class="mt-1 mb-6 text-muted-foreground wrap-anywhere">
            {text ? t.secret.label : file && `${file.name} · ${formatBytes(file.size, lang)}`}
            {finished && from.trim() && ` · ${t.send.fromSummary(from.trim())}`}
          </p>
          {lostServer && (
            <Alert variant="destructive" className="my-4">
              <AlertDescription>{text ? t.secret.lostServer : t.send.lostServer}</AlertDescription>
            </Alert>
          )}

          {finished && (
            <div class="mb-6 rounded-2xl border-2 border-primary p-6">
              <div class="flex items-center gap-3">
                <span class="inline-flex size-10 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Icon name="check" class="size-6" />
                </span>
                <h3 class="m-0 text-[1.35rem] font-bold">{t.send.doneTitle}</h3>
              </div>
              <p class="mt-3 mb-0">
                {sender.recipients.length === 1
                  ? (text ? t.secret : t.send).doneOne(sender.recipients[0]?.name ?? "")
                  : (text ? t.secret : t.send).doneMany(sender.recipients.length)}{" "}
                {t.send.closeTab}
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setMore(true);
                  requestAnimationFrame(() =>
                    document.getElementById(id("recipient-name"))?.focus(),
                  );
                }}
              >
                {t.send.sendMore}
              </Button>
            </div>
          )}
          {!finished && (
            <>
              <div>
                <div class={field}>
                  <Label htmlFor={id("from")}>
                    {t.send.fromLabel}{" "}
                    <span class="font-normal text-muted-foreground">{t.send.optional}</span>
                  </Label>
                  <Input
                    id={id("from")}
                    type="text"
                    autoComplete="name"
                    maxLength={MAX_FROM_LENGTH}
                    value={from}
                    onInput={(event) => {
                      setFrom(event.currentTarget.value);
                      setFromError("");
                    }}
                    disabled={hasRecipients}
                    aria-invalid={fromError ? "true" : "false"}
                    aria-describedby={
                      fromError ? `${id("from-error")} ${id("from-hint")}` : id("from-hint")
                    }
                  />
                  {fromError && (
                    <p id={id("from-error")} class={fieldError}>
                      {t.send.fromError[fromError]}
                    </p>
                  )}
                  <p id={id("from-hint")} class={`m-0 ${hint}`}>
                    {t.send.fromHint}
                    {mail && ` ${t.send.fromHintEmail}`}
                  </p>
                </div>
              </div>
              <form
                class="mt-6 flex flex-wrap items-end gap-2"
                onSubmit={onAdd}
                // A held Enter that started on the last Remove button lands here and would submit an empty name.
                onKeyDown={(event) => {
                  if (event.repeat && event.key === "Enter") {
                    event.preventDefault();
                  }
                }}
                noValidate
              >
                <div class={field}>
                  <Label htmlFor={id("recipient-name")}>{t.send.recipientLabel}</Label>
                  <Input
                    id={id("recipient-name")}
                    name="name"
                    type="text"
                    placeholder={t.send.recipientPlaceholder}
                    autoComplete="off"
                    maxLength={100}
                    disabled={!file || full}
                    onInput={() => setNameError("")}
                    aria-invalid={nameError ? "true" : "false"}
                    aria-describedby={
                      nameError
                        ? `${id("name-error")} ${id("recipient-hint")}`
                        : id("recipient-hint")
                    }
                  />
                </div>
                {mail && (
                  <div class="flex basis-full flex-col gap-1">
                    <Label htmlFor={id("recipient-email")}>
                      {t.send.emailLabel}{" "}
                      <span class="font-normal text-muted-foreground">{t.send.optional}</span>
                    </Label>
                    <Input
                      id={id("recipient-email")}
                      name="email"
                      type="email"
                      autoComplete="off"
                      maxLength={MAX_ADDRESS}
                      disabled={!file || full}
                      onInput={(event) => {
                        setEmailFilled(event.currentTarget.value.trim() !== "");
                        setEmailError(false);
                      }}
                      aria-invalid={emailError ? "true" : "false"}
                      aria-describedby={
                        emailError
                          ? `${id("email-error")} ${id("email-notice")}`
                          : id("email-notice")
                      }
                    />
                    {emailError && (
                      <p id={id("email-error")} class={fieldError}>
                        {t.send.emailError}
                      </p>
                    )}
                    <p id={id("email-notice")} class={`m-0 ${hint}`} aria-live="polite">
                      {emailFilled && (text ? t.secret.emailNotice : t.send.emailNotice)}
                    </p>
                  </div>
                )}
                <Button type="submit" disabled={!file || full}>
                  {emailFilled ? t.send.addEmail : t.send.add}
                </Button>
              </form>
              {nameError && (
                <p id={id("name-error")} class={fieldError}>
                  {t.send.nameError[nameError]}
                </p>
              )}
              <p id={id("recipient-hint")} class={hint}>
                {!file
                  ? text
                    ? tooLong
                      ? t.secret.tooLong
                      : t.secret.first
                    : t.send.fileFirst
                  : full
                    ? t.send.full(MAX_LINKS)
                    : t.send.oneLinkEach}
              </p>
            </>
          )}
          {finished ? (
            <details class="mt-2">
              <summary class="cursor-pointer text-muted-foreground">{t.send.showDetails}</summary>
              {recipientList}
            </details>
          ) : (
            recipientList
          )}
          <details class="mt-6 text-[0.9rem]">
            <summary class="cursor-pointer text-muted-foreground">
              {t.send.connectionOptions}
            </summary>
            <Label className="mt-4 items-start leading-snug font-normal">
              <input
                type="checkbox"
                class="mt-0.5 size-4 flex-none accent-primary"
                checked={allowRelay}
                onChange={(event) => {
                  allowRelayRef.current = event.currentTarget.checked;
                  setAllowRelay(allowRelayRef.current);
                  host();
                }}
              />
              {t.send.allowRelay}
            </Label>
          </details>
        </section>

        <ServerPanel
          sees={t.server.seesSender}
          holds={t.server.senderHolds({
            online: !lostServer,
            links: hostedLinks(sender).length,
            connected,
            relay: allowRelay,
            emailed: emailed.length,
            sending: emailed.filter((r) => r.mail === "sending").length,
            mailed,
            kind: text ? "secret" : "file",
          })}
          relayed={relayed}
          afterwards={t.server.senderAfterwards(!lostServer, mailed)}
          viaRelay={viaRelay}
          emailed={mailed}
          kind={text ? "secret" : "file"}
        />
      </div>

      {hasRecipients && (
        <div
          data-bottom-bar
          class="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/80 p-4 backdrop-blur-xl"
        >
          <p
            class="m-0 mx-auto flex max-w-xl items-center gap-2 text-[0.9rem] font-medium"
            role="status"
          >
            {unfinished ? (
              <span
                class="size-2 flex-none animate-pulse rounded-full bg-primary"
                aria-hidden="true"
              />
            ) : (
              <Icon name="check" class="size-4 flex-none" />
            )}
            {unfinished
              ? t.send.sendingBar(delivered, sender.recipients.length)
              : text
                ? t.secret.allDone
                : t.send.allDone}
          </p>
        </div>
      )}
    </Page>
  );
}
