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
import {
  addRelay,
  NO_RELAYS,
  SEES_SENDER,
  senderAfterwards,
  senderHolds,
} from "../lib/server-facts.ts";
import { connectSignaling, type SignalingClient } from "../lib/signaling-client.ts";
import { FileCard, Icon, Page, ServerPanel, TechDetails } from "../ui.tsx";
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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function SendPage() {
  const [file, setFile] = useState<File | undefined>(undefined);
  const [hash, setHash] = useState<Hash>({ status: "none" });
  const [sender, setSender] = useState<SenderState>(initialSenderState);
  const [lostServer, setLostServer] = useState(false);
  const [relayed, countRelay] = useReducer(addRelay, NO_RELAYS);
  const [nameError, setNameError] = useState("");
  const [fileError, setFileError] = useState("");
  const [from, setFrom] = useState("");
  const [fromError, setFromError] = useState("");

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
    setFileError(
      fits
        ? ""
        : unsafe
          ? "This file name contains characters that can't be sent. Rename the file and try again."
          : "This file name is too long to send. Rename the file and try again.",
    );
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
    if (sender.recipients.length === 0) {
      const typed = from.trim();
      const problem = hasForbiddenCharacters(typed)
        ? "Your name contains characters that can't be sent. Remove them and try again."
        : file && !metaFits(file, typed)
          ? "Your name and the file name are too long together. Shorten your name or rename the file."
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
    <Page>
      <h1>Send a file</h1>
      <p class="lede">
        Your file goes straight from this browser to the people you choose. It's encrypted on the
        way and never uploaded or stored.
      </p>

      {isLocalhost && (
        <p class="notice warning">
          This page is open on localhost, so the links won't work on other computers. Open the
          network address the server printed instead.
        </p>
      )}
      {lostServer && (
        <p class="notice error" role="alert">
          Lost the connection to the server. Files already on their way can finish, but nobody new
          can connect. Reload the page to start again.
        </p>
      )}

      <div class="field">
        <label for="from">
          Your name <span class="muted">(optional)</span>
        </label>
        <input
          id="from"
          type="text"
          autocomplete="name"
          maxLength={MAX_FROM_LENGTH}
          value={from}
          onInput={(event) => setFrom(event.currentTarget.value)}
          disabled={hasRecipients}
          aria-invalid={fromError ? "true" : "false"}
          aria-describedby={fromError ? "from-error from-hint" : "from-hint"}
        />
        {fromError && (
          <p id="from-error" class="field-error">
            {fromError}
          </p>
        )}
        <p id="from-hint" class="hint">
          Shown to the people you send to.
        </p>
      </div>

      {!hasRecipients && (
        <div class="drop">
          <input
            id="file"
            type="file"
            onChange={onFileChange}
            aria-invalid={fileError ? "true" : "false"}
            aria-describedby={fileError ? "file-error" : undefined}
          />
          <label for="file">
            <Icon name="file" />
            <span>
              <strong>{file ? "Choose a different file" : "Choose a file"}</strong> or drop it here
            </span>
          </label>
        </div>
      )}
      {fileError && (
        <p id="file-error" class="field-error">
          {fileError}
        </p>
      )}
      {file && (
        <>
          <FileCard name={file.name} size={formatBytes(file.size)} />
          {hash.status === "preparing" && (
            <p class="muted" role="status">
              Getting the file ready…
            </p>
          )}
          {hash.status === "failed" && (
            <p class="field-error" role="alert">
              Couldn't read the file. Choose it again.
            </p>
          )}
          <TechDetails
            rows={[
              ["Size", `${file.size.toLocaleString("en-US")} bytes`],
              ["Type", file.type || "Not given"],
              ["SHA-256", hash.status === "ready" ? <code>{hash.hex}</code> : "Not ready yet"],
            ]}
          />
        </>
      )}
      {hasRecipients && <p class="hint">Remove everyone to change your name or file.</p>}

      <form class="add-recipient" onSubmit={onAdd} noValidate>
        <div class="field">
          <label for="recipient-name">Who is it for?</label>
          <input
            id="recipient-name"
            name="name"
            type="text"
            placeholder="Their name"
            autocomplete="off"
            maxLength={100}
            disabled={!file || full}
            aria-invalid={nameError ? "true" : "false"}
            aria-describedby={nameError ? "name-error recipient-hint" : "recipient-hint"}
          />
        </div>
        <button type="submit" disabled={!file || full}>
          Add
        </button>
      </form>
      {nameError && (
        <p id="name-error" class="field-error">
          {nameError}
        </p>
      )}
      <p id="recipient-hint" class="hint">
        {!file
          ? "Choose a file first."
          : full
            ? `You can send to up to ${MAX_LINKS} people at a time.`
            : "Each person gets their own link, which works once."}
      </p>
      <RecipientList
        recipients={sender.recipients}
        fileSize={file?.size ?? 0}
        onRemove={onRemove}
      />
      {unfinished && (
        <p class="hint">
          Keep this tab open until everyone has the file. It's sent straight from here.
        </p>
      )}
      <ServerPanel
        sees={SEES_SENDER}
        holds={senderHolds({ online: !lostServer, links: hostedLinks(sender).length, connected })}
        relayed={relayed}
        afterwards={senderAfterwards(!lostServer)}
      />
    </Page>
  );
}
