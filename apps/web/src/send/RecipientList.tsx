// One card per recipient: status, email, connection path, progress, link, copy and remove.
//
// Only the status sentence and the email line sit in polite live regions, so
// screen readers hear "Sending through Anna's link", "Email sent to a***@example.se"
// and so on, not every progress tick. Each status names the link or the masked
// address, not the person, because whoever opens a link may not be the person
// it was made for.

import { maskAddress } from "@sigill/protocol";
import { Button } from "#components/ui/button";
import { Card, CardContent } from "#components/ui/card";
import type { Messages } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { formatProgress } from "../lib/format.ts";
import {
  type Recipient,
  type RecipientStatus,
  TOO_SMALL_FOR_TEXT,
  unmarked,
} from "../lib/sender-state.ts";
import { Direct, Icon, PathLine, SwapLabel, useCopyNote } from "../ui.tsx";

const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

const STATUS_COLOR: Partial<Record<RecipientStatus, string>> = {
  failed: "text-destructive",
  declined: "text-muted-foreground",
};

type StatusText = Messages["send"]["status"];

type Props = {
  recipients: readonly Recipient[];
  fileSize: number;
  statusText: StatusText;
  summary(done: number, total: number): string;
  onRemove(linkId: string): void;
};

export function RecipientList({ recipients, fileSize, statusText, summary, onRemove }: Props) {
  const { t } = useI18n();
  if (recipients.length === 0) {
    return null;
  }
  const done = recipients.filter((r) => r.status === "delivered");
  const ordered = [...recipients.filter((r) => r.status !== "delivered"), ...done];
  return (
    <>
      {recipients.length > 1 && (
        <p class="mt-6 mb-0 font-semibold">{summary(done.length, recipients.length)}</p>
      )}
      <ul class="mt-3 mb-4 grid gap-3" aria-label={t.send.recipients}>
        {ordered.map((recipient) => (
          <RecipientRow
            key={recipient.linkId}
            recipient={recipient}
            fileSize={fileSize}
            statusText={statusText}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </>
  );
}

type RowProps = {
  recipient: Recipient;
  fileSize: number;
  statusText: StatusText;
  onRemove(linkId: string): void;
};

function RecipientRow({ recipient, fileSize, statusText, onRemove }: RowProps) {
  const { name, url, status, bytesSent, linkId, path, noRelay, error, email, mail, unbound } =
    recipient;
  const { t, lang } = useI18n();
  const { note, copy } = useCopyNote();

  const open = status === "waiting" || status === "declined" || status === "failed";
  // A link the server may still email, or whose email binding died, is not to be shared.
  const shareable = open && !unmarked(recipient) && !unbound;
  const lost = open && unbound;
  const removeButton = (
    <Button
      type="button"
      variant="link"
      size={status === "delivered" ? "sm" : "default"}
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
  );

  if (status === "delivered") {
    return (
      <li class="min-w-0">
        <div class="flex items-center gap-2.5 rounded-xl border border-border px-4 py-1.5 text-[0.9rem] text-muted-foreground">
          <Icon name="check" class="size-4 text-foreground" />
          <span class="min-w-0 flex-1 truncate" aria-hidden="true">
            <span class="font-medium text-foreground">{name}</span> · {t.send.delivered}
            {path && ` · ${t.connection[path === "relay" ? "relay" : "direct"].label}`}
          </span>
          <span class="sr-only" aria-live="polite">
            {statusText.delivered(name)}
          </span>
          {removeButton}
        </div>
      </li>
    );
  }

  return (
    <li class="min-w-0">
      <Card>
        <CardContent>
          <p class="m-0 text-[1.05rem] font-semibold wrap-anywhere">{name}</p>
          <p
            class={`mt-1 mb-0 flex items-center gap-1.5 text-[0.9rem] wrap-anywhere ${noRelay ? "text-destructive" : (STATUS_COLOR[status] ?? "")}`}
            aria-live="polite"
          >
            {(status === "failed" || noRelay) && <Icon name="alert" />}
            {status === "declined" && !noRelay && <Icon name="declined" />}
            <span>
              {noRelay
                ? t.send.noRelay(name)
                : error === TOO_SMALL_FOR_TEXT
                  ? t.secret.unsendable(name)
                  : statusText[status](name)}
            </span>
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
              <Button type="button" aria-label={t.send.copyFor(name)} onClick={() => copy(url)}>
                <SwapLabel
                  idle={t.send.copy}
                  active={t.send.copyNote.copied}
                  on={note === "copied"}
                />
              </Button>
            )}
            {shareable && canShare && (
              <Button
                type="button"
                variant="outline"
                aria-label={t.send.shareFor(name)}
                onClick={() => navigator.share({ url }).catch(() => {})}
              >
                {t.send.share}
              </Button>
            )}
            {removeButton}
            <span
              class={`text-[0.85rem] text-muted-foreground ${note === "copied" ? "sr-only" : ""}`}
              role="status"
            >
              {note && t.send.copyNote[note]}
            </span>
          </div>
          {shareable && (
            <output
              class={`mt-2 block font-mono text-[0.8rem] text-muted-foreground select-all ${note === "failed" ? "wrap-anywhere" : "truncate"}`}
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
