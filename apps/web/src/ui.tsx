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
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      class="icon"
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

type Section = "send" | "privacy";

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
      <ul class="menu">
        {MENU.map(([section, href, label]) => (
          <li key={section}>
            {section === current ? (
              // Not a link: following it would reload the page and drop a transfer in progress.
              <span aria-current="page">{label}</span>
            ) : (
              <a href={href} target={newTab ? "_blank" : undefined} rel="noopener">
                {label}
                {newTab && <span class="visually-hidden"> (opens in a new tab)</span>}
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
      <header class="menu-bar">
        <p class="brand">
          <Icon name="lock" /> Sigill
        </p>
        <Menu current={current} />
      </header>
      <main>{children}</main>
    </>
  );
}

type DirectState = "ready" | "active" | "done";

/** Hidden from screen readers, so always pair it with a sentence that says the same. */
export function Direct({ from, to, state }: { from: string; to: string; state: DirectState }) {
  return (
    <div class={`direct direct-${state}`} aria-hidden="true">
      <span class="direct-end">
        <Icon name="computer" />
        <span class="direct-label">{from}</span>
      </span>
      <span class="direct-line">
        <span class="direct-badge">
          <Icon name={state === "done" ? "check" : "lock"} />
        </span>
      </span>
      <span class="direct-end">
        <Icon name="computer" />
        <span class="direct-label">{to}</span>
      </span>
    </div>
  );
}

export function FileCard({ name, size }: { name: string; size: string }) {
  return (
    <div class="file-card">
      <Icon name="file" />
      <div>
        <p class="file-name">{name}</p>
        <p class="muted">{size}</p>
      </div>
    </div>
  );
}

export function Facts({
  rows,
  class: className,
}: {
  rows: ReadonlyArray<readonly [string, ComponentChildren]>;
  class?: string;
}) {
  return (
    <dl class={className}>
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
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
    <details class="tech">
      <summary>Technical details</summary>
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
    <section class="server-panel" aria-labelledby="server-panel-heading">
      <h2 id="server-panel-heading">What our server has right now</h2>
      <Facts rows={rows} />
    </section>
  );
}

export function Problem({ title, body }: { title: string; body: string }) {
  return (
    <div class="problem" role="alert">
      <Icon name="alert" />
      <div>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
    </div>
  );
}
