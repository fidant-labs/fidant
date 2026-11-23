// One row per recipient: name, link, copy button, status and progress.
//
// Only the status text sits in the polite live region, so screen readers hear
// "Receiving", "Delivered, checksum verified" and so on, not every progress
// tick.

import { useEffect, useRef, useState } from "preact/hooks";
import { formatBytes } from "../lib/format.ts";
import type { Recipient, RecipientStatus } from "../lib/sender-state.ts";

const STATUS_TEXT: Record<RecipientStatus, string> = {
  waiting: "Waiting",
  connecting: "Connecting",
  offered: "Waiting for accept",
  receiving: "Receiving",
  delivered: "Delivered, checksum verified",
  failed: "Failed: checksum mismatch",
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
      showNote("Could not copy. Select the link and copy it yourself.");
    }
  };

  const percent = fileSize > 0 ? Math.min(100, Math.floor((bytesSent / fileSize) * 100)) : 100;

  return (
    <li class={`recipient status-${status}`}>
      <div class="recipient-head">
        <span class="recipient-name">{name}</span>
        <span class="recipient-status" aria-live="polite">
          {STATUS_TEXT[status]}
        </span>
      </div>
      <output class="link" aria-label={`Link for ${name}`}>
        {url}
      </output>
      {status === "receiving" && (
        <div class="progress-row">
          <progress
            aria-label={`Progress for ${name}`}
            max={Math.max(fileSize, 1)}
            value={fileSize > 0 ? bytesSent : 0}
          />
          <span class="progress-text">
            {percent}% · {formatBytes(bytesSent)} of {formatBytes(fileSize)}
          </span>
        </div>
      )}
      <div class="recipient-actions">
        <button type="button" onClick={copy}>
          Copy link
        </button>
        <button
          type="button"
          class="secondary"
          aria-label={`Remove ${name}`}
          onClick={() => onRemove(linkId)}
        >
          Remove
        </button>
        <span class="copy-note" role="status">
          {copyNote}
        </span>
      </div>
    </li>
  );
}
