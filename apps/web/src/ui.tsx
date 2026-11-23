// Pieces shared by the pages.

import type { ComponentChildren } from "preact";
import { FILE_DATA, LOGS, passedOn, type Relayed } from "./lib/server-facts.ts";

const ICONS = {
  computer: (
    <>
      <rect x="4" y="4.5" width="16" height="11" rx="1.5" />
      <path d="M2 19.5h20" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  download: <path d="M12 4v11m-5-5 5 5 5-5M5 20h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13m0 3.5v.01" />
    </>
  ),
};

type IconName = keyof typeof ICONS;

/** Decorative: the text next to an icon always carries its meaning. */
export function Icon({ name, class: cls }: { name: IconName; class?: string }) {
  return (
    <svg
      class={`flex-none ${cls ?? "size-[1.25em]"}`}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

export const lede = "mt-2 mb-6 text-[1.05rem] text-muted-foreground";

/** Add the colors: `border-border bg-warning-bg` or `border-destructive bg-destructive-bg`. */
export const notice = "rounded-lg border px-4 py-3";

export const buttonBase =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg disabled:cursor-not-allowed disabled:opacity-50";

export const button = `${buttonBase} border border-primary bg-primary px-4 py-[0.55rem] text-primary-foreground`;

/** A button that looks like a link. */
export const linkButton = `${buttonBase} p-1 text-primary underline`;

type Section = "send" | "privacy";

const menuItem = "block rounded-lg px-[0.7rem] py-[0.35rem] text-foreground no-underline";

const MENU: ReadonlyArray<readonly [Section, string, string]> = [
  ["send", "/", "Send a file"],
  ["privacy", "/privacy", "Privacy"],
];

/**
 * The send and receive pages hold a transfer only in memory, so from them the
 * menu opens a new tab instead of leaving the page.
 */
function Menu({ current }: { current: Section | undefined }) {
  const newTab = current !== "privacy";
  return (
    <nav aria-label="Main">
      <ul class="flex gap-1">
        {MENU.map(([section, href, label]) => (
          <li key={section}>
            {section === current ? (
              // Not a link: following it would reload the page and drop a transfer in progress.
              <span
                aria-current="page"
                class={`${menuItem} bg-card font-semibold inset-ring inset-ring-border`}
              >
                {label}
              </span>
            ) : (
              <a
                href={href}
                target={newTab ? "_blank" : undefined}
                rel="noopener"
                class={`${menuItem} hover:bg-card hover:underline`}
              >
                {label}
                {newTab && <span class="sr-only"> (opens in a new tab)</span>}
              </a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Page({ children, current }: { children: ComponentChildren; current?: Section }) {
  return (
    <>
      <header class="mx-auto flex max-w-xl flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 pt-4 pb-3">
        <p class="m-0 flex items-center gap-[0.4rem] font-bold text-muted-foreground">
          <Icon name="lock" /> Sigill
        </p>
        <Menu current={current} />
      </header>
      <main class="mx-auto max-w-xl px-4 pt-8 pb-16">{children}</main>
    </>
  );
}

type DirectState = "ready" | "active" | "done";

const DIRECT_LINE: Record<DirectState, string> = {
  ready:
    "bg-[image:repeating-linear-gradient(90deg,var(--color-border)_0_6px,transparent_6px_12px)]",
  active:
    "bg-[image:repeating-linear-gradient(90deg,var(--color-primary)_0_6px,transparent_6px_12px)] bg-[length:12px_2px] animate-flow motion-reduce:animate-none",
  done: "bg-success",
};

/** Hidden from screen readers, so always pair it with a sentence that says the same. */
export function Direct({
  from,
  to,
  state,
  class: cls = "mt-6",
}: {
  from: string;
  to: string;
  state: DirectState;
  /** Top margin; the default suits a page, a card passes a smaller one. */
  class?: string;
}) {
  const done = state === "done";
  return (
    <div class={`mb-1 flex items-center gap-3 ${cls}`} aria-hidden="true">
      <span class="flex max-w-28 flex-col items-center text-muted-foreground">
        <Icon name="computer" class="size-9 text-foreground" />
        <span class="max-w-full truncate text-[0.85rem]">{from}</span>
      </span>
      <span class={`mb-5 flex h-0.5 flex-1 items-center justify-center ${DIRECT_LINE[state]}`}>
        <span
          class={`inline-flex rounded-[50%] border bg-background p-[0.35rem] ${done ? "border-success text-success" : "border-border text-primary"}`}
        >
          <Icon name={done ? "check" : "lock"} />
        </span>
      </span>
      <span class="flex max-w-28 flex-col items-center text-muted-foreground">
        <Icon name="computer" class="size-9 text-foreground" />
        <span class="max-w-full truncate text-[0.85rem]">{to}</span>
      </span>
    </div>
  );
}

export function FileCard({ name, size }: { name: string; size: string }) {
  return (
    <div class="my-4 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <Icon name="file" class="size-8 text-muted-foreground" />
      <div>
        <p class="m-0 font-semibold wrap-anywhere">{name}</p>
        <p class="m-0 text-muted-foreground">{size}</p>
      </div>
    </div>
  );
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ComponentChildren]> }) {
  return (
    <dl class="mt-3 grid gap-2">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt class="text-muted-foreground">{term}</dt>
          <dd class="m-0 wrap-anywhere">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TechDetails({
  rows,
}: {
  rows: ReadonlyArray<readonly [string, ComponentChildren]>;
}) {
  return (
    <details class="mt-8 text-[0.9rem] [&_code]:text-[0.85rem]">
      <summary class="cursor-pointer text-muted-foreground">Technical details</summary>
      <Facts rows={rows} />
    </details>
  );
}

export function ServerPanel({
  sees,
  holds,
  relayed,
  afterwards,
}: {
  sees: string;
  holds: string;
  relayed: Relayed;
  afterwards: string;
}) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Sees", sees],
    ["Holds", holds],
    ["Passed on", passedOn(relayed)],
    ["File data", FILE_DATA],
    ["Logs", LOGS],
    ["Afterwards", afterwards],
  ];
  return (
    <section class="mt-8 text-[0.9rem]" aria-labelledby="server-panel-heading">
      <h2 id="server-panel-heading" class="m-0 text-[1rem] font-bold">
        What our server has right now
      </h2>
      <Facts rows={rows} />
    </section>
  );
}

export function Problem({ title, body }: { title: string; body: string }) {
  return (
    <div
      class="mb-4 flex gap-3 rounded-lg border border-destructive bg-destructive-bg p-4"
      role="alert"
    >
      <Icon name="alert" class="size-7 text-destructive" />
      <div>
        <h1 class="mt-0 mb-1 text-[1.2rem]">{title}</h1>
        <p class="m-0">{body}</p>
      </div>
    </div>
  );
}
