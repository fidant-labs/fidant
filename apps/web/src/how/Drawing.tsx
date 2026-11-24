import type { ComponentChildren } from "preact";
import { ICONS } from "../ui.tsx";

const run = "group-data-seen/art:[animation-play-state:running]";
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

function Server({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <At x={x} y={y} s={s} class="text-muted-foreground">
      {ICONS.server}
    </At>
  );
}

/** Hidden from screen readers: the section's text says the same. */
function Art({ view, children }: { view: string; children: ComponentChildren }) {
  return (
    <svg
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
      <Server x={120} y={24} s={2.5} />
      <Computer x={44} y={108} />
      <Computer x={196} y={108} />
    </Art>
  ),
  direct: (
    <Art view="0 38 240 68">
      <path d="M82 64h76" class="text-muted-foreground" />
      <Computer x={44} y={72} />
      <Computer x={196} y={72} />
      <g class={`${animate.travel} [--art-from:-152px_0]`}>
        <LockedFile x={196} y={64} />
      </g>
    </Art>
  ),
  relay: (
    <Art view="0 0 240 144">
      <path d="M94 50 72 72m74-22 22 22" class="text-muted-foreground" />
      <Server x={120} y={24} s={2.5} />
      <Computer x={44} y={108} />
      <Computer x={196} y={108} />
      <g class={`${animate.relay} [--art-from:-152px_0] [--art-via:-76px_-76px]`}>
        <LockedFile x={196} y={100} />
      </g>
    </Art>
  ),
  never: (
    <Art view="0 18 240 106">
      <Server x={42} y={72} s={2.5} />
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
};

export function Drawing({ id }: { id: keyof typeof ART }) {
  return ART[id];
}
