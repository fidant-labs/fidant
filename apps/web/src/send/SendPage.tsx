// The sender page: choose a file, add named recipients, share each one's link,
// and send the file to every recipient who opens their link.
//
// Wiring (see lib/peer.ts and lib/sender-state.ts):
// - On mount, connect to the signaling server and host every link ID on the
//   list; re-host the full list after every add or remove.
// - Server `joined` → reducer `joined`, whose `start` effect derives the
//   link's signal key and creates a sender peer. `relay` goes to that peer.
//   `left` → `dropped`.
// - When the data channel opens, sendFile runs the transfer and reports
//   accepted, progress, declined and receipt back to the reducer.
// - Effects run outside render: `close` tears the peer down, `refuse` tells
//   the server to refuse the joiner.
//
// Names, the file and link secrets stay in this tab. The server only ever
// gets link IDs, opaque sealed signals and refusal reasons.

import { MAX_LINKS } from "@sigill/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { formatBytes, toHex } from "../lib/format.ts";
import { deriveSignalKey } from "../lib/keys.ts";
import { createLink } from "../lib/link.ts";
import { createSenderPeer, type Peer } from "../lib/peer.ts";
import { hashFile, sendFile } from "../lib/send-file.ts";
import {
  findRecipient,
  hostedLinks,
  initialSenderState,
  type SenderAction,
  type SenderEffect,
  type SenderState,
  update,
} from "../lib/sender-state.ts";
import { connectSignaling, type SignalingClient } from "../lib/signaling-client.ts";
import { RecipientList } from "./RecipientList.tsx";

type Hash =
  | { status: "none" }
  | { status: "preparing" }
  | { status: "ready"; hex: string }
  | { status: "failed" };

type Connection = { abort: AbortController; peer?: Peer };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function SendPage() {
  const [file, setFile] = useState<File | undefined>(undefined);
  const [hash, setHash] = useState<Hash>({ status: "none" });
  const [sender, setSender] = useState<SenderState>(initialSenderState);
  const [lostServer, setLostServer] = useState(false);
  const [nameError, setNameError] = useState("");

  // Mutable state used from network callbacks, outside render.
  const senderRef = useRef<SenderState>(initialSenderState);
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
    if (!connection) return;
    connectionsRef.current.delete(linkId);
    connection.abort.abort(new Error("connection closed"));
    connection.peer?.close();
  };

  const startConnection = async (linkId: string) => {
    const recipient = findRecipient(senderRef.current, linkId);
    const signaling = signalingRef.current;
    if (!recipient || !signaling) return;
    closeConnection(linkId);
    const connection: Connection = { abort: new AbortController() };
    connectionsRef.current.set(linkId, connection);
    const dispatch = (action: SenderAction) => dispatchRef.current(action);

    let signalKey: CryptoKey;
    try {
      signalKey = await deriveSignalKey(recipient.secret, linkId);
    } catch {
      dispatch({ type: "dropped", linkId });
      return;
    }
    if (connection.abort.signal.aborted) return;

    connection.peer = createSenderPeer({
      signaling,
      linkId,
      signalKey,
      onOpen(channel, info) {
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
          secret: recipient.secret,
          sha256: chosen.sha256,
          signal: connection.abort.signal,
          onAccepted: () => dispatch({ type: "accepted", linkId }),
          onProgress: (bytesSent) => dispatch({ type: "progress", linkId, bytesSent }),
        }).then(
          (result) => {
            if (result.type === "declined") dispatch({ type: "declined", linkId });
            else dispatch({ type: "receipt", linkId, match: result.match });
          },
          () => {
            if (!connection.abort.signal.aborted) dispatch({ type: "dropped", linkId });
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
    for (const effect of next.effects) runEffect(effect);
    if (action.type === "add" || action.type === "remove") host();
  };

  // Runs once on mount: everything it uses is read through refs.
  useEffect(() => {
    const signaling = connectSignaling();
    signalingRef.current = signaling;
    let disposed = false;
    const dispatch = (action: SenderAction) => dispatchRef.current(action);

    signaling.ready.then(
      () => host(),
      () => {
        if (!disposed) setLostServer(true);
      },
    );
    signaling.onClose(({ byClient }) => {
      if (!byClient && !disposed) setLostServer(true);
    });
    signaling.subscribe((message) => {
      switch (message.t) {
        case "joined":
          dispatch({ type: "joined", linkId: message.link });
          break;
        case "left":
          dispatch({ type: "dropped", linkId: message.link });
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
      for (const linkId of [...connectionsRef.current.keys()]) closeConnection(linkId);
      signaling.close();
    };
  }, []);

  const onFileChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = input.files?.[0];
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
        if (!controller.signal.aborted) setHash({ status: "ready", hex: toHex(digest) });
      },
      () => {
        if (!controller.signal.aborted) setHash({ status: "failed" });
      },
    );
  };

  const onAdd = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("name") as HTMLInputElement;
    const name = input.value.trim();
    if (!name) {
      setNameError("Enter a name.");
      input.focus();
      return;
    }
    if (sender.recipients.some((r) => r.name === name)) {
      setNameError("That name is already on the list.");
      input.focus();
      return;
    }
    setNameError("");
    dispatchRef.current({ type: "add", link: createLink(location.origin), name });
    form.reset();
    input.focus();
  };

  const onRemove = (linkId: string) => dispatchRef.current({ type: "remove", linkId });

  const hasRecipients = sender.recipients.length > 0;
  const full = sender.recipients.length >= MAX_LINKS;
  const isLocalhost = LOCAL_HOSTS.has(location.hostname);

  return (
    <main>
      <header>
        <h1>Sigill</h1>
        <p class="lede">
          Send a file straight from this browser. It is encrypted here and only the people you add
          can open it.
        </p>
      </header>

      {isLocalhost && (
        <p class="notice warning">
          You opened this page on localhost, so the links won't work on other devices. Open it at
          the network address the server printed instead.
        </p>
      )}
      {lostServer && (
        <p class="notice error" role="alert">
          Lost connection to the server. Transfers already under way can finish, but nobody new can
          connect. Reload the page to start over.
        </p>
      )}

      <section>
        <h2>1. Choose a file</h2>
        <div class="field">
          <label for="file">File</label>
          <input
            id="file"
            type="file"
            onChange={onFileChange}
            disabled={hasRecipients}
            aria-describedby="file-hint"
          />
        </div>
        <p id="file-hint" class="hint">
          {hasRecipients
            ? "Remove all recipients to choose a different file."
            : "The file never leaves this browser unencrypted, and nothing about it is sent to the server."}
        </p>
        {file && (
          <div class="file-info">
            <p>
              <strong class="file-name">{file.name}</strong>{" "}
              <span title={`${file.size} bytes`}>{formatBytes(file.size)}</span>
            </p>
            <p class="hash">
              {hash.status === "preparing" && "Preparing…"}
              {hash.status === "ready" && (
                <>
                  SHA-256: <code>{hash.hex}</code>
                </>
              )}
              {hash.status === "failed" && "Could not read the file. Choose it again."}
            </p>
          </div>
        )}
      </section>

      <section>
        <h2>2. Add recipients</h2>
        <form class="add-recipient" onSubmit={onAdd} noValidate>
          <div class="field">
            <label for="recipient-name">Recipient name</label>
            <input
              id="recipient-name"
              name="name"
              type="text"
              autocomplete="off"
              maxLength={100}
              disabled={!file || full}
              aria-invalid={nameError ? "true" : "false"}
              aria-describedby={nameError ? "name-error recipient-hint" : "recipient-hint"}
            />
          </div>
          <button type="submit" disabled={!file || full}>
            Add recipient
          </button>
        </form>
        {nameError && (
          <p id="name-error" class="field-error">
            {nameError}
          </p>
        )}
        <p id="recipient-hint" class="hint">
          {file
            ? "Each recipient gets their own link, which works once. Names stay in this browser."
            : "Choose a file first."}
        </p>
        <RecipientList
          recipients={sender.recipients}
          fileSize={file?.size ?? 0}
          onRemove={onRemove}
        />
        {hasRecipients && (
          <p class="hint">Keep this tab open until every recipient has their file.</p>
        )}
      </section>
    </main>
  );
}
