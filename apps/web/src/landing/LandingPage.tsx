// The front page: what Fidant does, in plain words, and the way in to sending.
// Every claim here must stay true of what the code does today (see PrivacyPage).

import { cn } from "cn";
import { buttonVariants } from "#components/ui/button";
import { useI18n } from "../i18n/I18n.tsx";
import { display, Icon, Link } from "../ui.tsx";

// Made-up, but the real shape: a 16-byte link ID and a 32-byte secret, both base64url (lib/link.ts).
const EXAMPLE_ID = "q7Hc2mXa9pLr0VbN3tYw8g";
const EXAMPLE_KEY = "Zt4kP0x9QmR2sV7bN1cL8hJ5wE3yA6uD0fG4iK2oT9c"; // gitleaks:allow (made up, see above)

/** A real-shaped recipient link, split into what the server sees and what it never gets. */
function LinkAnatomy() {
  const { t } = useI18n();
  const l = t.landing;
  const length = `https://${location.host}/r/${EXAMPLE_ID}#${EXAMPLE_KEY}`.length;
  return (
    <figure class="@container m-0">
      {/* Shrinks to keep the link on one line; below 0.7rem it wraps instead. 0.62em is a little over a monospace character's width. */}
      <p
        class="m-0 rounded-lg border border-border bg-muted/50 px-4 py-3 font-mono text-[length:clamp(0.7rem,calc((100cqi_-_2.2rem)/(var(--chars)*0.62)),0.95rem)] leading-relaxed wrap-anywhere"
        style={{ "--chars": length }}
      >
        <span class="text-muted-foreground">https://{location.host}/r/</span>
        <span class="underline decoration-muted-foreground decoration-2 underline-offset-4">
          {EXAMPLE_ID}
        </span>
        <span class="font-bold">#</span>
        <span class="underline decoration-foreground decoration-wavy decoration-1 underline-offset-4">
          {EXAMPLE_KEY}
        </span>
      </p>
      <figcaption class="mt-4 grid gap-3 text-[0.95rem] sm:grid-cols-2">
        <p class="m-0 border-l-2 border-muted-foreground pl-3 text-muted-foreground">{l.linkId}</p>
        <p class="m-0 border-l-2 border-foreground pl-3">{l.linkKey}</p>
      </figcaption>
    </figure>
  );
}

function Terms({
  heading,
  rows,
}: {
  heading: string;
  rows: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <div>
      <h3 class="m-0 mb-3 text-[0.85rem] font-semibold tracking-wide text-muted-foreground uppercase">
        {heading}
      </h3>
      <ul class="m-0 list-none p-0">
        {rows.map(([term]) => (
          <li key={term} class="border-t border-border py-2.5">
            {term}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandingPage() {
  const { t } = useI18n();
  const l = t.landing;
  const p = t.privacy;
  return (
    <main class="mx-auto max-w-4xl px-4 pt-32 pb-20 lg:pt-40">
      <h1 class={`${display} max-w-3xl text-[2.6rem] leading-[1.05] sm:text-[4rem]`}>{l.title}</h1>
      <p class="mt-6 max-w-2xl text-[1.15rem] text-muted-foreground">{l.lede}</p>
      <div class="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link href="/send" class={cn(buttonVariants({ size: "lg" }), "h-12 gap-2 px-6 text-base")}>
          {l.cta} <Icon name="arrow" class="size-4" />
        </Link>
        <Link
          href="/secret"
          class={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-12 px-6 text-base")}
        >
          {t.menu.secret}
        </Link>
        <Link href="/how" class="rounded-sm font-medium underline underline-offset-4">
          {l.how}
        </Link>
      </div>
      <p class="mt-4 text-[0.9rem] text-muted-foreground">{l.noAccount}</p>

      <section class="mt-24" aria-labelledby="link-heading">
        <h2 id="link-heading" class={`${display} m-0 mb-6 text-[1.75rem] sm:text-[2.1rem]`}>
          {l.linkHeading}
        </h2>
        <LinkAnatomy />
      </section>

      <section class="mt-24" aria-labelledby="steps-heading">
        <h2 id="steps-heading" class={`${display} m-0 mb-6 text-[1.75rem] sm:text-[2.1rem]`}>
          {l.stepsHeading}
        </h2>
        <ol class="m-0 list-none p-0">
          {l.steps.map(([title, body], i) => (
            <li key={title} class="grid grid-cols-[2.5rem_1fr] gap-x-2 border-t border-border py-5">
              <span class="font-mono text-muted-foreground tabular-nums">0{i + 1}</span>
              <div>
                <h3 class="m-0 text-[1.1rem] font-semibold">{title}</h3>
                <p class="mb-0 text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section class="mt-24 grid gap-10 sm:grid-cols-2" aria-label={l.serverHeading}>
        <Terms heading={l.neverHeading} rows={p.never} />
        <Terms heading={l.seesHeading} rows={p.sees} />
        <p class="text-muted-foreground sm:col-span-2 m-0">{l.relayNote}</p>
      </section>

      <p class="mt-16 max-w-2xl border-l-2 border-foreground pl-4 text-[1.05rem]">{l.caveat}</p>

      <section
        class="mt-20 rounded-3xl bg-foreground px-6 py-10 text-background sm:px-12 sm:py-14"
        aria-labelledby="try-heading"
      >
        <div class="flex items-center gap-3" aria-hidden="true">
          <Icon name="computer" class="size-9" />
          <span class="w-10 border-t-2 border-dashed border-background/40 sm:w-16" />
          <Icon name="lock" class="size-5 opacity-70" />
          <span class="w-10 border-t-2 border-dashed border-background/40 sm:w-16" />
          <Icon name="phone" class="size-9" />
        </div>
        <h2
          id="try-heading"
          class={`${display} mt-6 mb-0 text-[2rem] leading-tight sm:text-[2.6rem]`}
        >
          {l.tryHeading}
        </h2>
        <p class="mt-3 max-w-xl text-[1.1rem] opacity-80">{l.tryBody}</p>
        <div class="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
          <Link
            href="/send"
            class={cn(
              buttonVariants({ size: "lg" }),
              "h-12 gap-2 bg-background px-6 text-base text-foreground hover:bg-background/90",
            )}
          >
            {l.tryCta} <Icon name="arrow" class="size-4" />
          </Link>
          <Link href="/secret" class="rounded-sm font-medium underline underline-offset-4">
            {l.trySecret}
          </Link>
        </div>
        <p class="mt-6 mb-0 text-[0.9rem] opacity-70">{l.noAccount}</p>
      </section>
    </main>
  );
}
