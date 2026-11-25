import type { ComponentChildren } from "preact";
import { useI18n } from "../i18n/I18n.tsx";
import { display, Link } from "../ui.tsx";
import { Drawing, DrawnSection, Paragraphs, Terms, useRevealDrawings } from "./Drawing.tsx";
import { Detail, STEPS, type Step } from "./steps.tsx";

const link = "rounded-sm font-medium underline underline-offset-4";

/** The step a /how/<slug> path names, or undefined for /how itself and unknown slugs. */
export function howStep(path: string): Step | undefined {
  const slug = /^\/how\/([a-z]+)\/?$/.exec(path)?.[1];
  return STEPS.find((step) => step.slug === slug);
}

/** /how, or one step of it with its technical detail when the path names one. */
export function HowPage({ path }: { path: string }) {
  const step = howStep(path);
  return step ? <StepPage key={step.slug} step={step} /> : <Overview />;
}

/** The page frame for /how and its steps: the menu of steps on the left, the content on the right. */
function HowLayout({ current, children }: { current?: Step; children: ComponentChildren }) {
  const { t } = useI18n();
  const h = t.how;
  const main = useRevealDrawings();
  const item = (href: string, label: string, here: boolean) => (
    <li key={href}>
      <Link
        href={href}
        aria-current={here ? "page" : undefined}
        class={`-ml-px block border-l-2 py-1.5 pl-4 ${here ? "border-foreground font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
      >
        {label}
      </Link>
    </li>
  );

  return (
    <main
      ref={main}
      class="mx-auto max-w-6xl px-4 pt-28 pb-20 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-12 lg:pt-36"
    >
      <nav aria-label={h.steps} class="mb-10 lg:mb-0">
        <ol class="m-0 list-none border-l border-border p-0 text-[0.95rem] lg:sticky lg:top-28">
          {item("/how", h.overview, current === undefined)}
          {STEPS.map((step, i) =>
            item(`/how/${step.slug}`, `${i + 1}. ${h.nav[step.id]}`, step === current),
          )}
        </ol>
      </nav>
      <div>{children}</div>
    </main>
  );
}

function Overview() {
  const { t } = useI18n();
  const h = t.how;

  return (
    <HowLayout>
      <h1 class={`${display} max-w-3xl text-[2.6rem] leading-[1.05] sm:text-[4rem]`}>{h.title}</h1>
      <p class="mt-6 max-w-2xl text-[1.15rem] text-muted-foreground">{h.lede}</p>
      {STEPS.map(({ id, slug, art }) => {
        const { heading, body } = h.sections[id];
        return (
          <DrawnSection key={id} id={id} art={art} heading={heading}>
            <Paragraphs body={body} />
            <p class="mb-0">
              <Link href={`/how/${slug}`} class={link}>
                {h.readMore}
                <span class="sr-only">: {heading}</span>
              </Link>
            </p>
          </DrawnSection>
        );
      })}
      <div class="mt-12 border-t border-border pt-12">
        <p class="mt-0 max-w-2xl text-muted-foreground">{h.more}</p>
        <p class="mb-0">
          <Link href="/privacy" class={link}>
            {h.moreLink}
          </Link>
        </p>
      </div>
    </HowLayout>
  );
}

/** One step: the step from /how, then its technical detail. */
function StepPage({ step }: { step: Step }) {
  const { t } = useI18n();
  const h = t.how;
  const { heading, body } = h.sections[step.id];
  const next = STEPS[STEPS.indexOf(step) + 1];

  return (
    <HowLayout current={step}>
      <section
        aria-labelledby="step-heading"
        class="sm:grid sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center sm:gap-x-8 md:grid-cols-[minmax(0,1fr)_15rem] md:gap-x-12"
      >
        <Drawing id={step.art} />
        <div>
          <h1
            id="step-heading"
            class={`${display} max-w-3xl text-[2.4rem] leading-[1.05] sm:text-[3.2rem]`}
          >
            {heading}
          </h1>
          {body.map((paragraph) => (
            <p key={paragraph} class="max-w-2xl text-[1.1rem] text-muted-foreground">
              <Terms text={paragraph} />
            </p>
          ))}
        </div>
      </section>
      <Detail step={step} />
      {next && (
        <p class="mt-12 border-t border-border pt-12 text-[1.1rem]">
          {h.next}:{" "}
          <Link href={`/how/${next.slug}`} class={link}>
            {h.sections[next.id].heading}
          </Link>
        </p>
      )}
    </HowLayout>
  );
}
