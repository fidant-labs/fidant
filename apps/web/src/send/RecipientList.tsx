// One card per recipient (status, email, connection path, progress, link, copy and remove), and one
// dialog for the safety number, which names its recipient so the number is never read off the wrong card.
//
// Only the status sentence, the email line, the safety number and the check's
// confirmation sit in live regions, so screen readers hear "Sending through
// Anna's link", "Email sent to a***@example.se" and so on, not every progress tick. Each status names the link or the masked
// address, not the person, because whoever opens a link may not be the person
// it was made for.

import { maskAddress } from "@sigill/protocol";
import { useEffect, useId, useRef } from "preact/hooks";
import { Button } from "#components/ui/button";
import { Card, CardContent } from "#components/ui/card";
import type { Messages } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { formatProgress } from "../lib/format.ts";
import {
  CHECK_ATTEMPTS,
  CHECK_DIFFERS,
  CHECK_EXPIRED,
  CHECK_LIMIT,
  CHECKSUM_MISMATCH,
  INTERRUPTED,
  RECIPIENT_OUTDATED,
  type Recipient,
  type RecipientStatus,
  SENDER_OUTDATED,
  TOO_SMALL_FOR_TEXT,
  unmarked,
} from "../lib/sender-state.ts";
import { CheckNumber, Icon, PathLine, SwapLabel, useCopyNote } from "../ui.tsx";

const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

const STATUS_COLOR: Partial<Record<RecipientStatus, string>> = {
  failed: "text-destructive",
  declined: "text-muted-foreground",
};

// ponytail: fixed heights, measured at 390 px and 360 px in both languages; a status longer than three lines outgrows them
const MIN_HEIGHT = { plain: "min-h-55", email: "min-h-61" };

const STEPS = ["waiting", "checking", "opened", "receiving", "delivered"] as const;
type Step = (typeof STEPS)[number];

/**
 * Where a link is on its way to delivered: finished steps green, the current one dark, and the
 * receiving step filling up as the file goes. Opened covers connecting and the offer, which follow
 * each other within seconds; with a safety number the check comes first, so connecting counts as
 * checking there. A link that stopped on the way is red up to where it stopped; any other failed
 * link can be opened again, so it is back at waiting. Hidden from screen readers: the status sentence and the progress element
 * under it say the same. On a phone only the current step's name fits.
 */
function Steps({
  status,
  check,
  sent,
  stopped,
}: {
  status: RecipientStatus;
  check: boolean;
  /** The step a declined, interrupted or damaged transfer stopped at. */
  stopped: Step | undefined;
  /** How much of the file has gone, from 0 to 1. */
  sent: number;
}) {
  const { t } = useI18n();
  const steps = STEPS.filter((step) => check || step !== "checking");
  // Green as the bottom bar is once every link has delivered.
  const green = "bg-emerald-600";
  const done = status === "delivered";
  const now: Step =
    stopped ??
    (status === "connecting"
      ? check
        ? "checking"
        : "opened"
      : status === "offered"
        ? "opened"
        : status === "declined" || status === "failed"
          ? "waiting"
          : status);
  const at = steps.indexOf(now);
  return (
    <ol class="mt-2 mb-0 flex list-none gap-1 p-0 text-[0.75rem]" aria-hidden="true">
      {steps.map((step, i) => (
        <li key={step} class="min-w-0 flex-1">
          <span
            class={`block h-1 overflow-hidden rounded-full transition-colors ${stopped && i <= at ? "bg-destructive" : i < at || done ? green : i === at && step !== "receiving" ? "bg-primary" : "bg-border"}`}
          >
            {i === at && step === "receiving" && !stopped && (
              <span class={`block h-full ${green}`} style={{ width: `${sent * 100}%` }} />
            )}
          </span>
          <span
            class={`mt-1 flex whitespace-nowrap ${i === 0 ? "" : i === steps.length - 1 ? "justify-end" : "justify-center"} ${i === at ? "font-medium" : "text-muted-foreground max-sm:invisible"}`}
          >
            {t.send.steps[step]}
          </span>
        </li>
      ))}
    </ol>
  );
}

type StatusText = Messages["send"]["status"];

/** An open check: its number, the sender's own answer once given, and whether they put the dialog off with "Not now". */
export type CheckView = { number: string; said?: boolean; later?: boolean };

type Props = {
  recipients: readonly Recipient[];
  fileSize: number;
  statusText: StatusText;
  summary(done: number, total: number): string;
  onRemove(linkId: string): void;
  /** Open checks by link ID. */
  checks: Readonly<Record<string, CheckView>>;
  /** The sender said the numbers match, or differ. */
  onCheck(linkId: string, matches: boolean): void;
  /** The sender put the check's dialog off, or asked for it again. */
  onLater(linkId: string, later: boolean): void;
};

export function RecipientList({
  recipients,
  fileSize,
  statusText,
  summary,
  onRemove,
  checks,
  onCheck,
  onLater,
}: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const unanswered = (r: Recipient) =>
    r.status === "checking" &&
    checks[r.linkId] !== undefined &&
    checks[r.linkId]?.said === undefined;
  // One at a time, in list order.
  const asking = recipients.find((r) => unanswered(r) && !checks[r.linkId]?.later);
  // The card whose status line takes focus when the dialog closes on an answer.
  const answered = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = dialog.current;
    if (asking && el && !el.open) {
      el.showModal();
    } else if (!asking && el?.open) {
      el.close();
      if (answered.current) {
        document.querySelector<HTMLElement>(`[data-status="${answered.current}"]`)?.focus();
      }
    }
    answered.current = undefined;
  }, [asking?.linkId]);
  const answer = (linkId: string, matches: boolean) => {
    answered.current = linkId;
    onCheck(linkId, matches);
  };
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
            // Names are unique (onAdd refuses a taken one) and survive a link swap, so the card keeps its live regions and focus.
            key={recipient.name}
            recipient={recipient}
            fileSize={fileSize}
            statusText={statusText}
            onRemove={onRemove}
            check={checks[recipient.linkId]}
            onCompare={
              unanswered(recipient) && checks[recipient.linkId]?.later
                ? () => onLater(recipient.linkId, false)
                : undefined
            }
          />
        ))}
      </ul>
      {/* A native dialog: it holds focus and dims the page without injecting a style, which the CSP blocks. */}
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        class="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-xl backdrop:bg-black/50"
        // Escape puts the check off; the card then offers it again.
        onCancel={(event) => {
          event.preventDefault();
          if (asking) {
            onLater(asking.linkId, true);
          }
        }}
      >
        {asking && (
          <>
            {/* Takes the focus, not a button: the dialog can open while the sender types a name, and
                their Enter must not answer the check. */}
            <h3
              id={titleId}
              tabIndex={-1}
              autofocus
              class="m-0 text-[1.25rem] font-bold wrap-anywhere outline-none"
            >
              {t.send.check.titleFor(asking.name)}
            </h3>
            <div class="mt-4">
              <CheckNumber number={checks[asking.linkId]?.number} />
            </div>
            <p class="mt-3 mb-0 text-[0.9rem]">{t.send.check.ask(asking.name)}</p>
            <div class="mt-6 flex flex-row-reverse flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                type="button"
                aria-label={t.send.check.matchesFor(asking.name)}
                onClick={() => answer(asking.linkId, true)}
              >
                {t.send.check.matches}
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label={t.send.check.differsFor(asking.name)}
                onClick={() => answer(asking.linkId, false)}
              >
                {t.send.check.differs}
              </Button>
              <Button type="button" variant="link" onClick={() => onLater(asking.linkId, true)}>
                {t.send.check.later}
              </Button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}

type RowProps = {
  recipient: Recipient;
  fileSize: number;
  statusText: StatusText;
  onRemove(linkId: string): void;
  check: CheckView | undefined;
  /** Opens the safety number's dialog again, while the sender has put it off. */
  onCompare: (() => void) | undefined;
};

function RecipientRow({ recipient, fileSize, statusText, onRemove, check, onCompare }: RowProps) {
  const {
    name,
    url,
    status,
    bytesSent,
    linkId,
    path,
    noRelay,
    noConnect,
    error,
    email,
    mail,
    unbound,
  } = recipient;
  const { t, lang } = useI18n();
  const { note, copy } = useCopyNote();

  const open = status === "waiting" || status === "declined" || status === "failed";
  // A link the server may still email, or whose email binding died, is not to be shared.
  const shareable = open && !unmarked(recipient) && !unbound && !recipient.locked;
  const checkFailed = error === CHECK_DIFFERS || error === CHECK_EXPIRED || error === CHECK_LIMIT;
  const blocked = noRelay || noConnect;
  const lost = open && unbound;
  const removeButton = (
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
  );

  return (
    <li class="min-w-0">
      <Card>
        {/* The least height fits every state a link passes through on its way to delivered, so the
            cards below never move. Only a
            long error or an opened "Why?" makes a card taller. */}
        <CardContent className={`flex flex-col ${MIN_HEIGHT[email ? "email" : "plain"]}`}>
          <p class="m-0 text-[1.05rem] font-semibold wrap-anywhere">{name}</p>
          {/* Always under the name, so the card keeps its shape. Not for a link that must not be
              passed on: one the server may still email, one whose email binding died, a locked one. */}
          {!unmarked(recipient) && !unbound && !recipient.locked && (
            <output
              class={`mt-0.5 block font-mono text-[0.7rem] text-muted-foreground ${shareable ? "select-all" : ""} ${note === "failed" ? "wrap-anywhere" : "truncate"}`}
              aria-label={t.send.linkFor(name)}
            >
              {url}
            </output>
          )}
          <Steps
            status={status}
            check={recipient.check === true}
            sent={fileSize > 0 ? bytesSent / fileSize : 0}
            stopped={
              status === "declined"
                ? "opened"
                : error === INTERRUPTED || error === CHECKSUM_MISMATCH
                  ? "receiving"
                  : undefined
            }
          />
          <p
            data-status={linkId}
            tabIndex={-1}
            class={`mt-2 mb-0 flex items-center gap-1.5 text-[0.9rem] wrap-anywhere outline-none ${blocked || checkFailed || error === INTERRUPTED ? "text-destructive" : (STATUS_COLOR[status] ?? "")}`}
            aria-live="polite"
          >
            {(status === "failed" || blocked || checkFailed || error === INTERRUPTED) && (
              <Icon name="alert" />
            )}
            {status === "declined" && !blocked && <Icon name="declined" />}
            <span>
              {noRelay
                ? t.send.noRelay(name)
                : noConnect
                  ? t.send.noConnect(name)
                  : error === INTERRUPTED
                    ? statusText.interrupted(name)
                    : error === TOO_SMALL_FOR_TEXT
                      ? t.secret.unsendable(name)
                      : error === CHECK_DIFFERS
                        ? t.send.check.differed
                        : error === CHECK_EXPIRED
                          ? t.send.check.expired
                          : error === CHECK_LIMIT
                            ? t.send.check.limit(CHECK_ATTEMPTS)
                            : error === SENDER_OUTDATED
                              ? statusText.senderOutdated(name)
                              : error === RECIPIENT_OUTDATED
                                ? statusText.recipientOutdated(name)
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
          {status === "checking" && (
            <p class="mt-2 mb-0 text-[0.9rem] text-muted-foreground empty:sr-only" role="status">
              {check?.said && t.send.check.waiting}
            </p>
          )}
          {status === "receiving" && (
            <p class="mt-3 mb-0 text-[0.85rem] text-muted-foreground tabular-nums">
              {/* The receiving step above draws this; screen readers get it here. */}
              <progress
                class="sr-only"
                aria-label={t.send.progressFor(name)}
                max={Math.max(fileSize, 1)}
                value={fileSize > 0 ? bytesSent : 0}
              />
              {formatProgress(bytesSent, fileSize, lang)}
            </p>
          )}
          {/* Every button in one row at the card's lower right. Reversed, so the main one
              stays first for the keyboard and sits outermost for the thumb. */}
          <div class="mt-auto flex flex-row-reverse flex-wrap items-center gap-x-3 gap-y-2 pt-3">
            {onCompare && (
              <Button type="button" aria-label={t.send.check.compareFor(name)} onClick={onCompare}>
                {t.send.check.compare}
              </Button>
            )}
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
            {/* A delivered link is used up, so there is nothing left to take back. */}
            {status !== "delivered" && removeButton}
            <span
              class={`text-[0.85rem] text-muted-foreground ${note === "copied" ? "sr-only" : ""}`}
              role="status"
            >
              {note && t.send.copyNote[note]}
            </span>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
