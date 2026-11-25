import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useI18n } from "../i18n/I18n.tsx";
import { display, ICONS, Link, useCopyNote } from "../ui.tsx";

const run = "group-data-seen/art:[animation-play-state:running] print:animate-none";
const animate = {
  arrive: `motion-safe:animate-art-arrive ${run}`,
  draw: `motion-safe:animate-art-draw ${run}`,
  travel: `motion-safe:animate-art-travel ${run}`,
  relay: `motion-safe:animate-art-relay ${run}`,
};

/** A 24-unit icon centred on (x, y) at `s` times its size, its stroke still 2 units wide. */
function At({
  x,
  y,
  s,
  class: cls,
  children,
}: {
  x: number;
  y: number;
  s: number;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <g
      transform={`translate(${x - 12 * s} ${y - 12 * s}) scale(${s})`}
      stroke-width={2 / s}
      class={cls}
    >
      {children}
    </g>
  );
}

function LockedFile({ x, y }: { x: number; y: number }) {
  return (
    <g class="fill-background">
      <At x={x} y={y} s={1.75}>
        {ICONS.file}
      </At>
      <At x={x} y={y + 3.5} s={1.05}>
        {ICONS.lock}
      </At>
    </g>
  );
}

function Drawn({ d, class: cls = "" }: { d: string; class?: string }) {
  return <path d={d} pathLength={1} stroke-dasharray="1 2" class={`${animate.draw} ${cls}`} />;
}

/** A line struck through whatever is under it, with a gap cut on each side. */
function Strike({ d }: { d: string }) {
  return (
    <>
      <Drawn d={d} class="stroke-6 text-background" />
      <Drawn d={d} />
    </>
  );
}

function Computer({ x, y }: { x: number; y: number }) {
  return (
    <At x={x} y={y} s={4}>
      {ICONS.computer}
    </At>
  );
}

function Server({ x, y }: { x: number; y: number }) {
  return (
    <At x={x} y={y} s={2.5} class="text-muted-foreground">
      {ICONS.server}
    </At>
  );
}

/** Hidden from screen readers: the section's text says the same. */
function Art({ view, children }: { view: string; children: ComponentChildren }) {
  return (
    <svg
      data-art=""
      class="group/art mb-6 w-full max-w-64 sm:col-start-2 sm:row-start-1 sm:mb-0"
      viewBox={view}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A file travelling straight from the left computer to the right one, both at height `y`. */
function DirectPath({ y }: { y: number }) {
  return (
    <>
      <path d={`M82 ${y - 8}h76`} class="text-muted-foreground" />
      <Computer x={44} y={y} />
      <Computer x={196} y={y} />
      <g class={`${animate.travel} [--art-from:-152px_0]`}>
        <LockedFile x={196} y={y - 8} />
      </g>
    </>
  );
}

const ART = {
  stays: (
    <Art view="0 -4 240 148">
      <At x={120} y={22} s={3.5} class="text-muted-foreground [stroke-dasharray:1.5_2]">
        {ICONS.cloud}
      </At>
      <path d="M120 70V52m-7 7 7-7 7 7" class="text-muted-foreground" />
      <Computer x={120} y={108} />
      <g class={`${animate.arrive} [--art-from:0_8px]`}>
        <LockedFile x={120} y={100} />
      </g>
      <Strike d="m100 2 42 42" />
    </Art>
  ),
  link: (
    <Art view="0 40 240 64">
      <rect x="6" y="44" width="228" height="56" rx="14" class="text-muted-foreground" />
      <path d="M24 72h14m8 0h22m8 0h10m8 0h14" class="text-muted-foreground" />
      <path d="m128 58-5 28m15-28-5 28m-14-20h24m-26 12h24" />
      <g class={`${animate.arrive} [--art-from:28px_0]`}>
        <At x={190} y={72} s={3.5}>
          {ICONS.key}
        </At>
      </g>
    </Art>
  ),
  open: (
    <Art view="0 0 240 144">
      <mask id="art-open" maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="144">
        <g stroke="white" class="stroke-4">
          <Drawn d="M94 50 72 72" />
          <Drawn d="m146 50 22 22" />
        </g>
      </mask>
      <path
        d="M94 50 72 72m74-22 22 22"
        stroke-dasharray="3 5"
        mask="url(#art-open)"
        class="text-muted-foreground"
      />
      <Server x={120} y={24} />
      <Computer x={44} y={108} />
      <Computer x={196} y={108} />
    </Art>
  ),
  direct: (
    <Art view="0 38 240 68">
      <DirectPath y={72} />
    </Art>
  ),
  relay: (
    <Art view="0 0 240 144">
      <path d="M94 50 72 72m74-22 22 22" class="text-muted-foreground" />
      <Server x={120} y={24} />
      <Computer x={44} y={108} />
      <Computer x={196} y={108} />
      <g class={`${animate.relay} [--art-from:-152px_0] [--art-via:-76px_-76px]`}>
        <LockedFile x={196} y={100} />
      </g>
    </Art>
  ),
  never: (
    <Art view="0 18 240 106">
      <Server x={42} y={72} />
      <At x={124} y={72} s={2.5}>
        {ICONS.eye}
      </At>
      <Strike d="m101.5 49.5 45 45" />
      <g class="text-muted-foreground">
        <At x={206} y={40} s={2}>
          {ICONS.file}
        </At>
        <At x={206} y={80} s={2}>
          {ICONS.tag}
        </At>
        <At x={206} y={112} s={2}>
          {ICONS.key}
        </At>
      </g>
    </Art>
  ),
  // The /how/<step> pages.
  parts: (
    <Art view="0 0 240 144">
      <path d="M94 50 72 72m74-22 22 22" stroke-dasharray="3 5" class="text-muted-foreground" />
      <Server x={120} y={24} />
      <Computer x={44} y={108} />
      <Computer x={196} y={108} />
      <Drawn d="M82 100h76" />
    </Art>
  ),
  keys: (
    <Art view="0 12 240 120">
      <At x={48} y={72} s={3}>
        {ICONS.key}
      </At>
      <Drawn d="M88 72c30 0 30-32 60-32M88 72c30 0 30 32 60 32" class="text-muted-foreground" />
      <g class={`${animate.arrive} [--art-from:-16px_0]`}>
        <At x={184} y={40} s={2}>
          {ICONS.key}
        </At>
        <At x={184} y={104} s={2}>
          {ICONS.key}
        </At>
      </g>
    </Art>
  ),
  signal: (
    <Art view="0 0 240 144">
      <path d="M94 50 72 72m74-22 22 22" class="text-muted-foreground" />
      <Server x={120} y={24} />
      <Computer x={44} y={108} />
      <Computer x={196} y={108} />
      <g class={`fill-background ${animate.arrive} [--art-from:0_-10px]`}>
        <At x={83} y={61} s={1.2}>
          {ICONS.lock}
        </At>
        <At x={157} y={61} s={1.2}>
          {ICONS.lock}
        </At>
      </g>
    </Art>
  ),
  layers: (
    <Art view="0 34 240 72">
      <rect x="80" y="40" width="80" height="48" rx="24" class="text-muted-foreground" />
      <Computer x={44} y={72} />
      <Computer x={196} y={72} />
      <g class={`${animate.arrive} [--art-from:0_8px]`}>
        <LockedFile x={120} y={64} />
      </g>
    </Art>
  ),
  frames: (
    <Art view="0 44 240 56">
      <g class={`${animate.arrive} [--art-from:-24px_0]`}>
        <rect x="8" y="50" width="30" height="44" rx="3" stroke-dasharray="3 4" />
        <path d="M8 60h30" stroke-dasharray="3 4" />
        {[46, 84, 122, 160, 198].map((x) => (
          <g key={x}>
            <rect x={x} y="50" width="30" height="44" rx="3" />
            <path d={`M${x} 60h30`} />
            <At x={x + 15} y={77} s={0.8}>
              {ICONS.lock}
            </At>
          </g>
        ))}
      </g>
    </Art>
  ),
  check: (
    <Art view="0 28 240 88">
      <At x={64} y={72} s={3}>
        {ICONS.file}
      </At>
      <path d="M104 72h36m-8-8 8 8-8 8" class="text-muted-foreground" />
      <circle cx="184" cy="72" r="28" />
      <Drawn d="M168.6 73.1l9.9 9.9 20.9-20.9" class="stroke-3" />
    </Art>
  ),
  padding: (
    <Art view="0 32 240 84">
      <rect
        x="10"
        y="38"
        width="220"
        height="24"
        rx="4"
        stroke-dasharray="4 5"
        class="text-muted-foreground"
      />
      <rect x="10" y="38" width="176" height="24" rx="4" />
      <g class={`${animate.arrive} [--art-from:0_-12px]`}>
        {[10, 55, 100, 145, 190].map((x) => (
          <rect key={x} x={x} y="86" width="40" height="24" rx="4" />
        ))}
      </g>
    </Art>
  ),
  recipients: (
    <Art view="0 0 240 144">
      <At x={52} y={72} s={3}>
        {ICONS.computer}
      </At>
      <Drawn d="M82 64 176 24M82 64h94M82 64l94 44" class="text-muted-foreground" />
      {[28, 72, 116].map((y) => (
        <At key={y} x={196} y={y} s={2}>
          {ICONS.computer}
        </At>
      ))}
    </Art>
  ),
  site: (
    <Art view="0 18 240 108">
      <rect x="30" y="22" width="180" height="100" rx="8" />
      <path d="M30 50h180" />
      <At x={50} y={36} s={1.2}>
        {ICONS.lock}
      </At>
      <path d="M68 36h120" class="text-muted-foreground" />
      <At x={120} y={86} s={2.2} class="text-muted-foreground">
        {ICONS.eye}
      </At>
      <Strike d="m100 66 40 40" />
    </Art>
  ),
  file: (
    <Art view="0 20 240 104">
      <g class="fill-background">
        <At x={120} y={72} s={3.5}>
          {ICONS.file}
        </At>
        <g class={`${animate.arrive} [--art-from:0_8px]`}>
          <At x={120} y={80} s={1.8}>
            {ICONS.lock}
          </At>
        </g>
      </g>
    </Art>
  ),
  secret: (
    <Art view="0 20 240 104">
      <rect x="30" y="40" width="180" height="64" rx="12" />
      <g class={`fill-current ${animate.arrive} [--art-from:-16px_0]`}>
        {[66, 93, 120, 147, 174].map((x) => (
          <circle key={x} cx={x} cy="72" r="6" stroke="none" />
        ))}
      </g>
    </Art>
  ),
  emailed: (
    <Art view="0 20 240 120">
      <rect x="40" y="30" width="140" height="88" rx="8" />
      <path d="m40 40 70 44 70-44" />
      <g class={`fill-background ${animate.arrive} [--art-from:-16px_0]`}>
        <At x={192} y={104} s={2.5}>
          {ICONS.key}
        </At>
      </g>
    </Art>
  ),
  // The connection modes, smaller in a grid of cards.
  local: (
    <Art view="0 12 240 104">
      <rect
        x="2"
        y="16"
        width="236"
        height="96"
        rx="16"
        stroke-dasharray="3 5"
        class="text-muted-foreground"
      />
      <DirectPath y={72} />
    </Art>
  ),
  stun: (
    <Art view="0 0 240 144">
      <path d="M104 40 72 64m64-24 32 24" stroke-dasharray="3 5" class="text-muted-foreground" />
      <At x={120} y={24} s={1.8} class="text-muted-foreground">
        {ICONS.server}
      </At>
      <DirectPath y={108} />
    </Art>
  ),
  norelay: (
    <Art view="0 0 240 144">
      <path d="M94 50 72 72m74-22 22 22" stroke-dasharray="3 5" class="text-muted-foreground" />
      <Server x={120} y={24} />
      <Strike d="m98 4 44 42" />
      <DirectPath y={108} />
    </Art>
  ),
};

export type ArtId = keyof typeof ART;

export function Drawing({ id }: { id: ArtId }) {
  return ART[id];
}

/** A ref for the page's <main>: each drawing in it starts its animation once half of it is in view. */
export function useRevealDrawings() {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio >= 0.5) {
            entry.target.setAttribute("data-seen", "");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.5 },
    );
    for (const drawing of main.current?.querySelectorAll("[data-art]") ?? []) {
      observer.observe(drawing);
    }
    return () => observer.disconnect();
  }, []);
  return main;
}

/** A section with its text on the left and, from small screens up, its drawing on the right. */
export function DrawnSection({
  id,
  art,
  heading,
  children,
}: {
  id: string;
  art?: ArtId | undefined;
  heading: string;
  children: ComponentChildren;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      class={`mt-12 scroll-mt-20 border-t border-border pt-12 ${art ? "sm:grid sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center sm:gap-x-8 md:grid-cols-[minmax(0,1fr)_15rem] md:gap-x-12" : ""}`}
    >
      {art && <Drawing id={art} />}
      <div>
        <Heading id={id} class={`${display} m-0 mb-4 text-[1.75rem] sm:text-[2.1rem]`}>
          {heading}
        </Heading>
        {children}
      </div>
    </section>
  );
}

/**
 * A section's h2 and, beside it so it stays out of the heading's name, a button shown on hover or
 * focus that copies a link to the section. The h2's id is `<id>-heading`, for aria-labelledby.
 */
export function Heading({
  id,
  class: cls,
  children,
}: {
  id: string;
  class: string;
  children: ComponentChildren;
}) {
  const { t } = useI18n();
  const { note, copy } = useCopyNote();
  return (
    <div class={`group/heading flex items-baseline ${cls}`}>
      <h2 id={`${id}-heading`} class="m-0 [font:inherit]">
        {children}
      </h2>
      <button
        type="button"
        onClick={() => copy(`${location.origin}${location.pathname}#${id}`)}
        aria-label={t.how.copyLink}
        class="ml-2 inline-flex size-[0.9em] translate-y-[0.1em] cursor-pointer items-center justify-center rounded-sm align-baseline text-muted-foreground opacity-0 group-hover/heading:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <svg
          viewBox="0 0 24 24"
          class="size-[0.6em]"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          {note === "copied" ? ICONS.check : ICONS.link}
        </svg>
      </button>
      <span class="sr-only" aria-live="polite">
        {note === "copied" ? t.how.copied : note === "failed" ? t.how.copyFailed : ""}
      </span>
    </div>
  );
}

export function Paragraphs({ body }: { body: readonly string[] }) {
  return body.map((paragraph) => (
    <p key={paragraph} class="max-w-2xl">
      <Terms text={paragraph} />
    </p>
  ));
}

/** Technical words, longest first, and their entry on /how/tech. The same in every language. */
const TERMS: ReadonlyArray<readonly [string, string]> = [
  ["HKDF-SHA-256", "hkdf"],
  ["AES-256-GCM", "aes"],
  ["SHA-256", "sha"],
  ["WebRTC", "webrtc"],
  ["WebSocket", "websocket"],
  ["STUN", "stun"],
  ["TURN", "turn"],
  ["DTLS", "dtls"],
  ["Padmé", "padme"],
  ["HMAC", "hmac"],
  ["nonce", "nonce"],
];
// The words hold no regex characters. A word on its own or starting a compound ("STUN-tjänst").
const TERM = new RegExp(`(?<![\\w-])(${TERMS.map(([word]) => word).join("|")})(?!\\w)`, "g");

/** Text with the first mention of each technical word linked to its entry on /how/tech, except `skip`. */
export function Terms({ text, skip }: { text: string; skip?: string }) {
  const seen = new Set<string>();
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(TERM)) {
    const [word = ""] = match.slice(1);
    const id = TERMS.find(([term]) => term === word)?.[1];
    if (!id || id === skip || seen.has(id)) {
      continue;
    }
    seen.add(id);
    parts.push(
      text.slice(last, match.index),
      <Link
        key={match.index}
        href={`/how/tech#${id}`}
        class="underline decoration-dotted underline-offset-4"
      >
        {word}
      </Link>,
    );
    last = match.index + word.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
