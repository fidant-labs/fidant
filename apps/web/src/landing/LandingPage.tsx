// The front page: what Fidant does, in plain words, and the way in to sending.
// Every claim here must stay true of what the code does today (see PrivacyPage).

import { buttonVariants } from "#components/ui/button";
import { useI18n } from "../i18n/I18n.tsx";
import { Icon, Link } from "../ui.tsx";

const FEATURE_ICONS = ["lock", "send", "check"] as const;
const gradientText =
  "bg-gradient-to-r from-indigo-600 to-emerald-600 dark:from-indigo-400 dark:to-emerald-400 bg-clip-text text-transparent";

/** Decorative: a laptop sending an encrypted file to a phone. The hero text says the same. */
function HeroArt() {
  const { t } = useI18n();
  const a = t.landing.art;
  return (
    <div aria-hidden="true" class="relative mx-auto aspect-[6/5] w-full max-w-lg select-none">
      <div class="absolute inset-[10%] rounded-full bg-gradient-to-br from-indigo-500/30 to-emerald-400/30 blur-3xl" />

      <svg class="absolute inset-0 size-full" viewBox="0 0 600 500" fill="none" aria-hidden="true">
        <path
          d="M170 240 C 170 370, 280 385, 372 385"
          class="stroke-indigo-400 animate-dash motion-reduce:animate-none"
          stroke-width="3"
          stroke-dasharray="8 16"
          stroke-linecap="round"
        />
      </svg>

      {/* Sender: a browser window with the file on its way. */}
      <div class="absolute top-[8%] left-0 w-[62%] overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-indigo-500/10">
        <div class="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <span class="size-2.5 rounded-full bg-red-400" />
          <span class="size-2.5 rounded-full bg-amber-400" />
          <span class="size-2.5 rounded-full bg-emerald-400" />
          <span class="ml-2 h-4 flex-1 rounded bg-muted" />
        </div>
        <div class="grid gap-3 p-4">
          <p class="m-0 text-[0.75rem] font-semibold text-muted-foreground">{a.you}</p>
          <div class="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
            <span class="inline-flex size-9 items-center justify-center rounded-md bg-indigo-500/15 text-indigo-500">
              <Icon name="file" class="size-5" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="m-0 truncate text-[0.85rem] font-semibold">{a.file}</p>
              <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div class="h-full w-2/3 rounded-full bg-gradient-to-r from-indigo-500 to-emerald-400" />
              </div>
            </div>
          </div>
          <div class="h-2 w-3/4 rounded bg-muted" />
          <div class="h-2 w-1/2 rounded bg-muted" />
        </div>
      </div>

      {/* Recipient: a phone with the file arrived. */}
      <div class="absolute right-[2%] bottom-0 w-[38%] rounded-[1.6rem] border-[5px] border-foreground/85 bg-card p-3 pt-5 shadow-2xl shadow-emerald-500/10">
        <div class="mx-auto mb-3 h-1.5 w-10 rounded-full bg-foreground/20" />
        <div class="flex items-center gap-2">
          <span class="inline-flex size-7 items-center justify-center rounded-full bg-emerald-400/20 text-[0.75rem] font-bold text-emerald-600 dark:text-emerald-300">
            {a.them.slice(0, 1)}
          </span>
          <span class="text-[0.8rem] font-semibold">{a.them}</span>
        </div>
        <div class="mt-3 rounded-lg border border-border bg-background p-2.5">
          <p class="m-0 truncate text-[0.75rem] font-semibold">{a.file}</p>
          <p class="m-0 mt-1 flex items-center gap-1 text-[0.7rem] text-emerald-600 dark:text-emerald-300">
            <Icon name="check" class="size-3" /> {a.received}
          </p>
        </div>
        <div class="mt-3 h-1.5 w-3/4 rounded bg-muted" />
        <div class="mt-2 h-1.5 w-1/2 rounded bg-muted" />
      </div>

      {/* The lock in transit. */}
      <div class="absolute top-[46%] left-[44%] animate-float motion-reduce:animate-none">
        <span class="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-indigo-500 to-emerald-400 px-3 py-1.5 text-[0.8rem] font-semibold text-white shadow-lg shadow-indigo-500/30">
          <Icon name="lock" class="size-3.5" /> {a.encrypted}
        </span>
      </div>
    </div>
  );
}

export function LandingPage() {
  const { t } = useI18n();
  const l = t.landing;
  const cta = `${buttonVariants({ size: "lg" })} h-12 gap-2 px-6 text-base shadow-lg shadow-indigo-500/20`;
  return (
    <main class="overflow-x-clip">
      <section class="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pt-28 pb-16 lg:grid-cols-2 lg:pt-36 lg:pb-24">
        <div class="pointer-events-none absolute -top-24 left-1/2 -z-10 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-indigo-500/10 blur-3xl" />
        <div>
          <p class="m-0 mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-[0.85rem] font-medium text-muted-foreground">
            <Icon name="lock" class="size-3.5 text-indigo-500" /> {l.eyebrow}
          </p>
          <h1 class="text-[2.5rem] leading-[1.1] font-extrabold tracking-tight sm:text-[3.25rem]">
            {l.title[0]}
            <span class={gradientText}>{l.title[1]}</span>
            {l.title[2]}
          </h1>
          <p class="mt-5 max-w-xl text-[1.15rem] text-muted-foreground">{l.lede}</p>
          <div class="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/send" class={cta}>
              <Icon name="send" class="size-5" /> {l.cta}
            </Link>
            <Link
              href="/privacy"
              class={`${buttonVariants({ variant: "ghost", size: "lg" })} h-12 gap-2 text-base`}
            >
              {l.how} <Icon name="arrow" class="size-4" />
            </Link>
          </div>
          <p class="mt-4 text-[0.9rem] text-muted-foreground">{l.noAccount}</p>
        </div>
        <HeroArt />
      </section>

      <section class="mx-auto max-w-6xl px-4 py-16" aria-labelledby="features-heading">
        <h2 id="features-heading" class="sr-only">
          {l.featuresHeading}
        </h2>
        <ul class="grid gap-4 md:grid-cols-3">
          {l.features.map(([title, body], i) => (
            <li
              key={title}
              class="rounded-2xl border border-border bg-card p-6 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-indigo-500/5"
            >
              <span class="mb-4 inline-flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-emerald-600 text-white">
                <Icon name={FEATURE_ICONS[i] ?? "lock"} class="size-5" />
              </span>
              <h3 class="m-0 text-[1.1rem] font-bold">{title}</h3>
              <p class="mb-0 text-muted-foreground">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section class="mx-auto max-w-6xl px-4 py-16" aria-labelledby="steps-heading">
        <h2
          id="steps-heading"
          class="m-0 mb-10 text-center text-[2rem] font-extrabold tracking-tight"
        >
          {l.stepsHeading}
        </h2>
        <ol class="grid gap-8 md:grid-cols-3">
          {l.steps.map(([title, body], i) => (
            <li key={title} class="text-center">
              <span class="mx-auto mb-4 flex size-12 items-center justify-center rounded-full border-2 border-indigo-500/40 text-[1.1rem] font-bold text-indigo-600 dark:text-indigo-400">
                {i + 1}
              </span>
              <h3 class="m-0 text-[1.1rem] font-bold">{title}</h3>
              <p class="mx-auto mb-0 max-w-xs text-muted-foreground">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section class="mx-auto max-w-6xl px-4 pt-8 pb-24">
        <div class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 to-emerald-700 px-6 py-14 text-center text-white">
          <div class="absolute -top-20 -right-20 size-64 rounded-full bg-white/10 blur-2xl" />
          <h2 class="m-0 text-[1.75rem] font-extrabold tracking-tight sm:text-[2.25rem]">
            {l.closingTitle}
          </h2>
          <p class="mx-auto mt-3 max-w-lg text-white">{l.closingBody}</p>
          <Link
            href="/send"
            class="mt-6 inline-flex h-12 items-center gap-2 rounded-lg bg-white px-6 text-base font-medium text-indigo-700 shadow-lg transition hover:bg-white/90"
          >
            <Icon name="send" class="size-5" /> {l.cta}
          </Link>
        </div>
      </section>
    </main>
  );
}
