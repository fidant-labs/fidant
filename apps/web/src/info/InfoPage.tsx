// About, Terms and Security: plain text pages whose content lives in i18n under the same key.
// Keep every sentence true of what the code does today, like the privacy page.

import { useI18n } from "../i18n/I18n.tsx";
import { Link, lede, Page } from "../ui.tsx";

export function InfoPage({ page }: { page: "about" | "terms" | "security" }) {
  const { t } = useI18n();
  const { title, lede: intro, sections } = t[page];
  return (
    <Page>
      <h1>{title}</h1>
      <p class={lede}>{intro}</p>
      {sections.map(({ heading, body, link }) => (
        <section key={heading} class="mt-10">
          <h2 class="mb-3 text-[1.25rem] font-bold">{heading}</h2>
          {body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {link && <SectionLink link={link} />}
        </section>
      ))}
    </Page>
  );
}

export function SectionLink({ link: [text, href] }: { link: readonly [string, string] }) {
  return (
    <p>
      {/* Same-site links navigate in place, so a send open in another page survives. */}
      {href.startsWith("/") ? (
        <Link href={href} class="font-medium underline underline-offset-4">
          {text}
        </Link>
      ) : (
        <a href={href} class="font-medium underline underline-offset-4">
          {text}
        </a>
      )}
    </p>
  );
}
