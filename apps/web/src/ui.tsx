// Pieces shared by the pages.

import type { AnchorHTMLAttributes, ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { DropdownMenu } from "radix-ui";
import { Alert, AlertDescription, AlertTitle } from "#components/ui/alert";
import { buttonVariants } from "#components/ui/button";
import { Card, CardContent } from "#components/ui/card";
import { useI18n } from "./i18n/I18n.tsx";
import { LANGUAGE_NAMES, type Lang } from "./i18n/language.ts";
import { formatBytes } from "./lib/format.ts";
import type { Relayed } from "./lib/server-facts.ts";
import { applyTheme, initialTheme, type Theme } from "./theme.ts";

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
  send: <path d="M21 3 10 14M21 3l-6.5 18-4.5-7-7-4.5z" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  languages: <path d="m5 8 6 6m-7 0 6-6 2-3M2 5h12M7 2h1m14 20-5-10-5 10m2-4h6" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
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

export type Route = "landing" | "send" | "privacy" | "receive" | "about" | "terms" | "security";

/** Changes the page without reloading it, so a transfer held in memory survives. */
export function navigate(href: string) {
  history.pushState(null, "", href);
  dispatchEvent(new PopStateEvent("popstate"));
  scrollTo(0, 0);
}

/** A link that navigates inside the app; modified clicks (new tab, new window) keep the browser default. */
export function Link({
  href,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}

const MENU: ReadonlyArray<readonly ["send" | "privacy", string]> = [
  ["send", "/send"],
  ["privacy", "/privacy"],
];

const LANGS: readonly Lang[] = ["sv", "en"];
const THEME_ICONS: Record<Theme, IconName> = { system: "computer", light: "sun", dark: "moon" };

/** An icon button that opens a menu of choices, the current one checked. */
function Choice<T extends string>({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon: IconName;
  value: T;
  /** Value, text, and the text's language when it differs from the page's. */
  options: ReadonlyArray<readonly [T, string, string?]>;
  onChange(value: T): void;
}) {
  return (
    // Not modal: the modal version injects a <style> element, which the CSP blocks.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label={label}
        title={label}
        class={buttonVariants({ variant: "ghost", size: "icon" })}
      >
        <Icon name={icon} class="size-[1.15rem]" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          class="z-[60] min-w-40 rounded-xl border border-border bg-popover/90 p-1 text-popover-foreground shadow-xl backdrop-blur-xl animate-in fade-in zoom-in-95"
        >
          <DropdownMenu.Label class="px-2 py-1.5 text-xs text-muted-foreground">
            {label}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
            {options.map(([option, text, lang]) => (
              <DropdownMenu.RadioItem
                key={option}
                value={option}
                lang={lang}
                class="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              >
                <span class="flex size-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Icon name="check" class="size-4" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {text}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ThemeMenu() {
  const { t } = useI18n();
  const [theme, setTheme] = useState(initialTheme);
  const choose = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };
  return (
    <Choice
      label={t.menu.theme}
      icon={THEME_ICONS[theme]}
      value={theme}
      options={(["system", "light", "dark"] as const).map((v) => [v, t.menu.themes[v]] as const)}
      onChange={choose}
    />
  );
}

export function Header({ current }: { current: Route }) {
  const { lang, t, setLang } = useI18n();
  return (
    <header class="fixed inset-x-0 top-0 z-50 border-b border-border/60 bg-background/70 backdrop-blur-xl backdrop-saturate-150">
      <div class="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-3 sm:gap-4 sm:px-4">
        <Link
          href="/"
          aria-current={current === "landing" ? "page" : undefined}
          class="flex items-center gap-2 rounded-md text-[1.05rem] font-bold tracking-tight no-underline"
        >
          {/* The mark: a shepherd's crook, upright and bent over what it looks after. Same drawing as public/favicon.svg. */}
          <svg
            class="size-8 flex-none rounded-md bg-foreground text-background"
            viewBox="0 0 32 32"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M11.25 24.25V12.75a5 5 0 0 1 10 0v.5" />
            <circle cx="21.25" cy="19.75" r="2.5" fill="currentColor" stroke="none" />
          </svg>
          <span class="max-sm:sr-only">{t.product}</span>
        </Link>
        <nav aria-label={t.menu.label}>
          <ul class="flex items-center gap-0.5 sm:gap-1">
            {MENU.map(([section, href]) => (
              <li key={section}>
                <Link
                  href={href}
                  aria-current={section === current ? "page" : undefined}
                  class={`${buttonVariants({ variant: section === current ? "secondary" : "ghost" })} max-sm:px-2`}
                >
                  {t.menu[section]}
                </Link>
              </li>
            ))}
            <li>
              <ThemeMenu />
            </li>
            <li>
              <Choice
                label={t.menu.language}
                icon="languages"
                value={lang}
                options={LANGS.map((code) => [code, LANGUAGE_NAMES[code], code] as const)}
                onChange={setLang}
              />
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}

const FOOTER_LINKS: ReadonlyArray<readonly ["privacy" | "about" | "terms" | "security", string]> = [
  ["about", "/about"],
  ["privacy", "/privacy"],
  ["terms", "/terms"],
  ["security", "/security"],
];

export function Footer() {
  const { t } = useI18n();
  const link =
    "rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";
  return (
    <footer class="border-t border-border text-[0.9rem]">
      <div class="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:justify-between">
        <div class="max-w-xs">
          <p class="m-0 font-bold">{t.product}</p>
          <p class="mb-0 text-muted-foreground">{t.footer.tagline}</p>
        </div>
        <nav aria-label={t.footer.label}>
          <ul class="m-0 grid list-none grid-cols-2 gap-x-10 gap-y-2 p-0">
            {FOOTER_LINKS.map(([page, href]) => (
              <li key={page}>
                <Link href={href} class={link}>
                  {page === "privacy" ? t.menu.privacy : t.footer[page]}
                </Link>
              </li>
            ))}
            <li>
              <a href="https://github.com/sigill-labs/sigill" class={link}>
                {t.footer.source}
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <p class="mx-auto mt-0 mb-0 max-w-6xl px-4 pb-8 text-[0.85rem] text-muted-foreground">
        {t.footer.license}
      </p>
    </footer>
  );
}

/** Page content under the fixed header; `wide` for layouts with side panels. */
export function Page({ children, wide }: { children: ComponentChildren; wide?: boolean }) {
  return (
    <main class={`mx-auto px-4 pt-24 pb-16 ${wide ? "max-w-6xl" : "max-w-xl"}`}>{children}</main>
  );
}

type DirectState = "ready" | "active" | "done";

const DIRECT_LINE: Record<DirectState, string> = {
  ready:
    "bg-[image:repeating-linear-gradient(90deg,var(--color-border)_0_6px,transparent_6px_12px)]",
  active:
    "bg-[image:repeating-linear-gradient(90deg,var(--color-primary)_0_6px,transparent_6px_12px)] bg-[length:12px_2px] animate-flow motion-reduce:animate-none",
  done: "bg-primary",
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
          class={`inline-flex rounded-[50%] border bg-background p-[0.35rem] ${done ? "border-primary" : "border-border"} text-primary`}
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
    <Card className="my-4">
      <CardContent className="flex items-center gap-3">
        <Icon name="file" class="size-8 text-muted-foreground" />
        <div>
          <p class="m-0 font-semibold wrap-anywhere">{name}</p>
          <p class="m-0 text-muted-foreground">{size}</p>
        </div>
      </CardContent>
    </Card>
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
  const { t } = useI18n();
  return (
    <details class="mt-8 text-[0.9rem] [&_code]:text-[0.85rem]">
      <summary class="cursor-pointer text-muted-foreground">{t.common.techDetails}</summary>
      <Facts rows={rows} />
    </details>
  );
}

export function ServerPanel({
  sees,
  holds,
  relayed,
  afterwards,
  viaRelay,
}: {
  sees: string;
  holds: string;
  relayed: Relayed;
  afterwards: string;
  /** A connection on this page went through our TURN relay. */
  viaRelay: boolean;
}) {
  const { t, lang } = useI18n();
  const rows: ReadonlyArray<readonly [string, string]> = [
    [t.server.seesLabel, sees],
    [t.server.holdsLabel, holds],
    [t.server.passedOnLabel, t.server.passedOn(relayed.messages, formatBytes(relayed.bytes, lang))],
    [t.server.fileDataLabel, viaRelay ? t.server.fileDataRelayed : t.server.fileData],
    [t.server.logsLabel, t.server.logs],
    [t.server.afterwardsLabel, afterwards],
    ...(viaRelay
      ? ([
          [t.server.relaySeesLabel, t.server.relaySees],
          [t.server.relayLogsLabel, t.server.relayLogs],
          [t.server.relayKeepsLabel, t.server.relayKeeps],
        ] as const)
      : []),
  ];
  return (
    <section class="mt-8 text-[0.9rem]" aria-labelledby="server-panel-heading">
      <h2 id="server-panel-heading" class="m-0 text-[1rem] font-bold">
        {t.server.heading}
      </h2>
      <Facts rows={rows} />
    </section>
  );
}

export function Problem({ title, body }: { title: string; body: string }) {
  return (
    <Alert variant="destructive" className="mb-4">
      <Icon name="alert" class="size-4" />
      <AlertTitle>
        {/* The page heading: the receive page moves focus to `main h1` after each step. */}
        <h1 class="m-0 text-[length:inherit] font-[weight:inherit] leading-[inherit]">{title}</h1>
      </AlertTitle>
      <AlertDescription>{body}</AlertDescription>
    </Alert>
  );
}
