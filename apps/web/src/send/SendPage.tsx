// The sender page: choose a file, add named recipients, share each one's link,
// and send the file to every recipient who opens their link.
//
// Wiring (see lib/peer.ts and lib/sender-state.ts):
// - On mount, connect to the signaling server and host every link ID on the
//   list; re-host the full list after every add or remove.
// - Server `joined` → reducer `joined`, whose `start` effect derives the
//   link's signal key and creates a sender peer. `relay` goes to that peer.
//   `left` → reducer `left`, which only matters before the channel opens.
// - When the data channel opens, sendFile runs the transfer and reports
//   accepted, progress, declined and receipt back to the reducer.
// - A peer that closes or fails before delivery → `dropped`; a data channel
//   that has not opened SETUP_TIMEOUT_MS after the join → `timeout`. Both
//   refuse the joiner so the server unbinds it (see sender-state.ts).
// - Effects run outside render: `close` tears the peer down, `refuse` tells
//   the server to refuse the joiner.
//
// Names, the file and link secrets stay in this tab. The server only ever
// gets link IDs, opaque sealed signals and refusal reasons.

import { MAX_LINKS } from "@sigill/protocol";
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
  findRecipient,
  hostedLinks,
  initialSenderState,
  isActive,
  SETUP_TIMEOUT_MS,
  type SenderAction,
  type SenderEffect,
  type SenderState,
  update,
} from "../lib/sender-state.ts";
import { addRelay, NO_RELAYS } from "../lib/server-facts.ts";
import { connectSignaling, type SignalingClient } from "../lib/signaling-client.ts";
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
};

// Errors are kept as keys and turned into text in render, so they follow a language switch.
type ErrorOf<K extends "fromError" | "fileError" | "nameError"> = keyof Messages["send"][K] | "";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const field = "flex flex-1 flex-col gap-1";
const fieldError = "mt-1 mb-0 text-destructive";
const hint = "text-[0.9rem] text-muted-foreground";

export function SendPage() {
  const { t, lang } = useI18n();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [hash, setHash] = useState<Hash>({ status: "none" });
  const [sender, setSender] = useState<SenderState>(initialSenderState);
  const [lostServer, setLostServer] = useState(false);
  const [relayed, countRelay] = useReducer(addRelay, NO_RELAYS);
  const [nameError, setNameError] = useState<ErrorOf<"nameError">>("");
  const [fileError, setFileError] = useState<ErrorOf<"fileError">>("");
  const [from, setFrom] = useState("");
  const [fromError, setFromError] = useState<ErrorOf<"fromError">>("");

  // Mutable state used from network callbacks, outside render.
  const senderRef = useRef<SenderState>(initialSenderState);
  // Set when the first recipient is added; the name field stays locked while anyone is on the list.
  const fromRef = useRef("");
  const fileRef = useRef<{ file: File; sha256: Promise<Uint8Array> } | undefined>(undefined);
  const hashAbortRef = useRef<AbortController | undefined>(undefined);
  const signalingRef = useRef<SignalingClient | undefined>(undefined);
  const connectionsRef = useRef(new Map<string, Connection>());
  const dispatchRef = useRef<(action: SenderAction) => void>(() => {});

  const host = () => {
    signalingRef.current?.send({ t: "host", links: hostedLinks(senderRef.current) });
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

  const startConnection = async (linkId: string) => {
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
        dispatch({ type: "timeout", linkId });
      }
    }, SETUP_TIMEOUT_MS);

    let signalKey: CryptoKey;
    try {
      signalKey = await deriveSignalKey(recipient.secret, linkId);
    } catch {
      dispatch({ type: "dropped", linkId });
      return;
    }
    if (connection.abort.signal.aborted) {
      return;
    }

    connection.peer = createSenderPeer({
      signaling,
      linkId,
      signalKey,
      onOpen(channel, info) {
        clearTimeout(connection.deadline);
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
      onClose() {
        dispatch({ type: "dropped", linkId });
      },
    });
  };

  const runEffect = (effect: SenderEffect) => {
    switch (effect.type) {
      case "start":
        void startConnection(effect.linkId);
        break;
      case "close":
        closeConnection(effect.linkId);
        break;
      case "refuse":
        signalingRef.current?.send({ t: "refuse", link: effect.linkId, reason: effect.reason });
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

    signaling.ready.then(
      () => host(),
      () => {
        if (!disposed) {
          setLostServer(true);
        }
      },
    );
    signaling.onClose(({ byClient }) => {
      if (!byClient && !disposed) {
        setLostServer(true);
      }
    });
    signaling.subscribe((message) => {
      switch (message.t) {
        case "joined":
          dispatch({ type: "joined", linkId: message.link });
          break;
        case "left":
          dispatch({ type: "left", linkId: message.link });
          break;
        case "relay":
          void connectionsRef.current.get(message.link)?.peer?.handleRelay(message.data);
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

    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", onBeforeUnload);
      hashAbortRef.current?.abort();
      for (const linkId of [...connectionsRef.current.keys()]) {
        closeConnection(linkId);
      }
      signaling.close();
    };
  }, []);

  const onFileChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = input.files?.[0];
    hashAbortRef.current?.abort(new Error("a different file was chosen"));
    hashAbortRef.current = undefined;
    const unsafe =
      !!chosen && (hasForbiddenCharacters(chosen.name) || hasForbiddenCharacters(chosen.type));
    const fits = !chosen || (!unsafe && metaFits(chosen));
    setFileError(fits ? "" : unsafe ? "unsafe" : "tooLong");
    setFile(fits ? chosen : undefined);
    // Clear the input so it does not show a file that will not be sent.
    if (!fits) {
      input.value = "";
    }
    if (!chosen || !fits) {
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
    if (sender.recipients.length === 0) {
      const typed = from.trim();
      const problem = hasForbiddenCharacters(typed)
        ? "unsafe"
        : file && !metaFits(file, typed)
          ? "tooLong"
          : "";
      setFromError(problem);
      if (problem) {
        document.getElementById("from")?.focus();
        return;
      }
      fromRef.current = typed;
    }
    dispatchRef.current({ type: "add", link: createLink(location.origin), name });
    form.reset();
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
        : document.getElementById("recipient-name");
      target?.focus();
    });
  };

  const hasRecipients = sender.recipients.length > 0;
  const full = sender.recipients.length >= MAX_LINKS;
  const isLocalhost = LOCAL_HOSTS.has(location.hostname);
  // ponytail: counts by status, so it over-counts if a recipient's signaling drops mid-transfer; track joined/left if that matters
  const connected = sender.recipients.filter(isActive).length;
  const unfinished = sender.recipients.some((r) => r.status !== "delivered");

  return (
    <Page current="send">
      <h1>{t.send.title}</h1>
      <p class={lede}>{t.send.lede}</p>

      {isLocalhost && (
        <Alert role="note" className="my-4">
          <AlertDescription>{t.send.localhost}</AlertDescription>
        </Alert>
      )}
      {lostServer && (
        <Alert variant="destructive" className="my-4">
          <AlertDescription>{t.send.lostServer}</AlertDescription>
        </Alert>
      )}

      <div class={`${field} my-4`}>
        <Label htmlFor="from">
          {t.send.fromLabel}{" "}
          <span class="font-normal text-muted-foreground">{t.send.optional}</span>
        </Label>
        <Input
          id="from"
          type="text"
          autoComplete="name"
          maxLength={MAX_FROM_LENGTH}
          value={from}
          onInput={(event) => setFrom(event.currentTarget.value)}
          disabled={hasRecipients}
          aria-invalid={fromError ? "true" : "false"}
          aria-describedby={fromError ? "from-error from-hint" : "from-hint"}
        />
        {fromError && (
          <p id="from-error" class={fieldError}>
            {t.send.fromError[fromError]}
          </p>
        )}
        <p id="from-hint" class={`m-0 ${hint}`}>
          {t.send.fromHint}
        </p>
      </div>

      {!hasRecipients && (
        <div class="relative my-4 rounded-lg border-2 border-dashed border-border bg-card focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-primary hover:border-primary">
          <input
            id="file"
            type="file"
            class="absolute inset-0 size-full cursor-pointer opacity-0"
            onChange={onFileChange}
            aria-invalid={fileError ? "true" : "false"}
            aria-describedby={fileError ? "file-error" : undefined}
          />
          <label
            for="file"
            class="flex flex-col items-center gap-2 px-4 py-8 text-center text-muted-foreground"
          >
            <Icon name="file" class="size-8" />
            <span>
              <strong class="text-primary">{file ? t.send.chooseOther : t.send.chooseFile}</strong>{" "}
              {t.send.orDrop}
            </span>
          </label>
        </div>
      )}
      {fileError && (
        <p id="file-error" class={fieldError}>
          {t.send.fileError[fileError]}
        </p>
      )}
      {file && (
        <>
          <FileCard name={file.name} size={formatBytes(file.size, lang)} />
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
              ["SHA-256", hash.status === "ready" ? <code>{hash.hex}</code> : t.send.hashPending],
            ]}
          />
        </>
      )}
      {hasRecipients && <p class={hint}>{t.send.locked}</p>}

      <form class="mt-8 flex flex-wrap items-end gap-2" onSubmit={onAdd} noValidate>
        <div class={field}>
          <Label htmlFor="recipient-name">{t.send.recipientLabel}</Label>
          <Input
            id="recipient-name"
            name="name"
            type="text"
            placeholder={t.send.recipientPlaceholder}
            autoComplete="off"
            maxLength={100}
            disabled={!file || full}
            aria-invalid={nameError ? "true" : "false"}
            aria-describedby={nameError ? "name-error recipient-hint" : "recipient-hint"}
          />
        </div>
        <Button type="submit" disabled={!file || full}>
          {t.send.add}
        </Button>
      </form>
      {nameError && (
        <p id="name-error" class={fieldError}>
          {t.send.nameError[nameError]}
        </p>
      )}
      <p id="recipient-hint" class={hint}>
        {!file ? t.send.fileFirst : full ? t.send.full(MAX_LINKS) : t.send.oneLinkEach}
      </p>
      <RecipientList
        recipients={sender.recipients}
        fileSize={file?.size ?? 0}
        onRemove={onRemove}
      />
      {unfinished && <p class={hint}>{t.send.keepOpen}</p>}
      <ServerPanel
        sees={t.server.seesSender}
        holds={t.server.senderHolds({
          online: !lostServer,
          links: hostedLinks(sender).length,
          connected,
        })}
        relayed={relayed}
        afterwards={t.server.senderAfterwards(!lostServer)}
      />
    </Page>
  );
}
