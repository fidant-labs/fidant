import { useI18n } from "../i18n/I18n.tsx";
import { display, Link } from "../ui.tsx";

const SECTIONS = ["stays", "link", "open", "direct", "relay", "never"] as const;

export function HowPage() {
  const { t } = useI18n();
  const h = t.how;
  return (
    <main class="mx-auto max-w-4xl px-4 pt-32 pb-20 lg:pt-40">
      <h1 class={`${display} max-w-3xl text-[2.6rem] leading-[1.05] sm:text-[4rem]`}>{h.title}</h1>
      <p class="mt-6 max-w-2xl text-[1.15rem] text-muted-foreground">{h.lede}</p>
      {SECTIONS.map((id) => {
        const { heading, body } = h.sections[id];
        return (
          <section
            key={id}
            id={id}
            aria-labelledby={`${id}-heading`}
            class="mt-12 scroll-mt-20 border-t border-border pt-12"
          >
            <h2 id={`${id}-heading`} class={`${display} m-0 mb-4 text-[1.75rem] sm:text-[2.1rem]`}>
              {heading}
            </h2>
            {body.map((paragraph) => (
              <p key={paragraph} class="max-w-2xl">
                {paragraph}
              </p>
            ))}
          </section>
        );
      })}
      <div class="mt-12 border-t border-border pt-12">
        <p class="mt-0 max-w-2xl text-muted-foreground">{h.more}</p>
        <p class="mb-0">
          <Link href="/privacy" class="rounded-sm font-medium underline underline-offset-4">
            {h.moreLink}
          </Link>
        </p>
      </div>
    </main>
  );
}
