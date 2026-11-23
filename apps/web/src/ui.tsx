// Pieces shared by the send and receive pages.

import type { ComponentChildren } from "preact";

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

export function Page({ children }: { children: ComponentChildren }) {
  return (
    <main>
      <header>
        <p class="brand">
          <Icon name="lock" /> Sigill
        </p>
      </header>
      {children}
    </main>
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

export function TechDetails({
  rows,
}: {
  rows: ReadonlyArray<readonly [string, ComponentChildren]>;
}) {
  return (
    <details class="tech">
      <summary>Technical details</summary>
      <dl>
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
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
