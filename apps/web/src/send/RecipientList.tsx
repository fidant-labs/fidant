// One card per recipient: status, email, connection path, progress, link, copy and remove.
//
// Only the status sentence and the email line sit in polite live regions, so
// screen readers hear "Sending through Anna's link", "Email sent to a***@example.se"
// and so on, not every progress tick. Each status names the link or the masked
// address, not the person, because whoever opens a link may not be the person
// it was made for.

import { maskAddress } from "@sigill/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "#components/ui/button";
import { Card, CardContent } from "#components/ui/card";
import type { Messages } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { formatProgress } from "../lib/format.ts";
import { type Recipient, type RecipientStatus, unmarked } from "../lib/sender-state.ts";
import { Direct, Icon, PathLine } from "../ui.tsx";

const STATUS_COLOR: Partial<Record<RecipientStatus, string>> = {
  failed: "text-destructive",
  declined: "text-muted-foreground",
};

type StatusText = Messages["send"]["status"];

type Props = {
  recipients: readonly Recipient[];
  fileSize: number;
  statusText: StatusText;
  onRemove(linkId: string): void;
};

export function RecipientList({ recipients, fileSize, statusText, onRemove }: Props) {
  const { t } = useI18n();
  if (recipients.length === 0) {
    return null;
  }
  return (
    <ul class="mt-6 mb-4 grid gap-3" aria-label={t.send.recipients}>
      {recipients.map((recipient) => (
        <RecipientRow
          key={recipient.linkId}
          recipient={recipient}
          fileSize={fileSize}
          statusText={statusText}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

type CopyNote = keyof Messages["send"]["copyNote"];

type RowProps = {
  recipient: Recipient;
  fileSize: number;
  statusText: StatusText;
  onRemove(linkId: string): void;
};

function RecipientRow({ recipient, fileSize, statusText, onRemove }: RowProps) {
  const { name, url, status, bytesSent, linkId, path, noRelay, email, mail, unbound } = recipient;
  const { t, lang } = useI18n();
  const [copyNote, setCopyNote] = useState<CopyNote | "">("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const showNote = (note: CopyNote) => {
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
      showNote("copied");
    } catch {
      showNote("failed");
    }
  };

  const open = status === "waiting" || status === "declined" || status === "failed";
  // A link the server may still email, or whose email binding died, is not to be shared.
  const shareable = open && !unmarked(recipient) && !unbound;
  const lost = open && unbound;

  return (
    <li>
      <Card>
        <CardContent>
          <p
            class={`m-0 flex items-center gap-1.5 font-semibold wrap-anywhere ${noRelay ? "text-destructive" : (STATUS_COLOR[status] ?? "")}`}
            aria-live="polite"
          >
            {status === "delivered" && <Icon name="check" />}
            {(status === "failed" || noRelay) && <Icon name="alert" />}
            {status === "declined" && !noRelay && <Icon name="declined" />}
            <span>{noRelay ? t.send.noRelay(name) : statusText[status](name)}</span>
          </p>
          {email && mail && (
            <p
              class={`mt-1 mb-0 text-[0.9rem] wrap-anywhere ${lost || mail === "failed" || mail === "limit" ? "text-destructive" : "text-muted-foreground"}`}
              aria-live="polite"
            >
              {t.send.mail[lost ? "lost" : mail](maskAddress(email))}
            </p>
          )}
          {path && <PathLine path={path} />}
          {status === "receiving" && (
            <>
              <Direct from={t.common.you} to={name} state="active" class="mt-3" />
              <div class="my-3 flex flex-wrap items-center gap-3">
                <progress
                  class="min-w-40 flex-1 accent-primary"
                  aria-label={t.send.progressFor(name)}
                  max={Math.max(fileSize, 1)}
                  value={fileSize > 0 ? bytesSent : 0}
                />
                <span class="text-[0.85rem] text-muted-foreground tabular-nums">
                  {formatProgress(bytesSent, fileSize, lang)}
                </span>
              </div>
            </>
          )}
          <div class="mt-3 flex flex-wrap items-center gap-3">
            {shareable && (
              <Button type="button" aria-label={t.send.copyFor(name)} onClick={copy}>
                {t.send.copy}
              </Button>
            )}
            <Button
              type="button"
              variant="link"
              aria-label={t.send.removeFor(name)}
              data-remove={linkId}
              // Focus moves to the next Remove button, so a held Enter would remove it too.
              onKeyDown={(event) => {
                if (event.repeat) {
                  event.preventDefault();
                }
              }}
              onClick={() => onRemove(linkId)}
            >
              {t.send.remove}
            </Button>
            <span class="text-[0.85rem] text-muted-foreground" role="status">
              {copyNote && t.send.copyNote[copyNote]}
            </span>
          </div>
          {shareable && (
            <output
              class="mt-2 block font-mono text-[0.8rem] text-muted-foreground wrap-anywhere select-all"
              aria-label={t.send.linkFor(name)}
            >
              {url}
            </output>
          )}
        </CardContent>
      </Card>
    </li>
  );
}
