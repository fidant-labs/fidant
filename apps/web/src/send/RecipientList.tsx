// One card per recipient: status, progress, link, copy and remove.
//
// Only the status sentence sits in the polite live region, so screen readers
// hear "Sending to Anna", "Delivered through Anna's link" and so on, not every progress
// tick.

import { useEffect, useRef, useState } from "preact/hooks";
import { formatProgress } from "../lib/format.ts";
import type { Recipient, RecipientStatus } from "../lib/sender-state.ts";
import { Direct, Icon } from "../ui.tsx";

const STATUS_TEXT: Record<RecipientStatus, (name: string) => string> = {
  waiting: (name) => `Waiting for ${name} to open the link`,
  connecting: (name) => `Connecting to ${name}…`,
  offered: (name) => `${name}'s link has been opened`,
  receiving: (name) => `Sending to ${name}`,
  delivered: (name) => `Delivered through ${name}'s link`,
  failed: (name) =>
    `The file didn't arrive intact for ${name}. They can open the link again to retry.`,
};

type Props = {
  recipients: readonly Recipient[];
  fileSize: number;
  onRemove(linkId: string): void;
};

export function RecipientList({ recipients, fileSize, onRemove }: Props) {
  if (recipients.length === 0) {
    return null;
  }
  return (
    <ul class="recipients" aria-label="Recipients">
      {recipients.map((recipient) => (
        <RecipientRow
          key={recipient.linkId}
          recipient={recipient}
          fileSize={fileSize}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

type RowProps = { recipient: Recipient; fileSize: number; onRemove(linkId: string): void };

function RecipientRow({ recipient, fileSize, onRemove }: RowProps) {
  const { name, url, status, bytesSent, linkId } = recipient;
  const [copyNote, setCopyNote] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const showNote = (note: string) => {
    clearTimeout(timer.current);
    setCopyNote(note);
    timer.current = setTimeout(() => setCopyNote(""), 4000);
  };

  const copy = async () => {
    try {
      if (!navigator.clipboard) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(url);
      showNote("Copied");
    } catch {
      showNote("Couldn't copy. Select the link below and copy it yourself.");
    }
  };

  const shareable = status === "waiting" || status === "failed";

  return (
    <li class={`recipient status-${status}`}>
      <p class="recipient-status" aria-live="polite">
        {status === "delivered" && <Icon name="check" />}
        {status === "failed" && <Icon name="alert" />}
        <span>{STATUS_TEXT[status](name)}</span>
      </p>
      {status === "receiving" && (
        <>
          <Direct from="You" to={name} state="active" class="mt-3" />
          <div class="progress-row">
            <progress
              aria-label={`Progress for ${name}`}
              max={Math.max(fileSize, 1)}
              value={fileSize > 0 ? bytesSent : 0}
            />
            <span class="progress-text">{formatProgress(bytesSent, fileSize)}</span>
          </div>
        </>
      )}
      <div class="recipient-actions">
        {shareable && (
          <button type="button" aria-label={`Copy link for ${name}`} onClick={copy}>
            Copy link
          </button>
        )}
        <button
          type="button"
          class="link"
          aria-label={`Remove ${name}`}
          data-remove={linkId}
          onClick={() => onRemove(linkId)}
        >
          Remove
        </button>
        <span class="copy-note" role="status">
          {copyNote}
        </span>
      </div>
      {shareable && (
        <output class="link-text" aria-label={`Link for ${name}`}>
          {url}
        </output>
      )}
    </li>
  );
}
