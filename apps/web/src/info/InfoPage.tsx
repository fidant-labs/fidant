// About, Terms, Security and Technical: plain text pages whose content lives in i18n under the same key.
// Keep every sentence true of what the code does today, like the privacy page.

import { useI18n } from "../i18n/I18n.tsx";
import { Link, lede, Page } from "../ui.tsx";

export function InfoPage({ page }: { page: "about" | "terms" | "security" | "technical" }) {
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
          {link && (
            <p>
              {/* Same-site links navigate in place, so a send open in another page survives. */}
              {link[1].startsWith("/") ? (
                <Link href={link[1]} class="font-medium underline underline-offset-4">
                  {link[0]}
                </Link>
              ) : (
                <a href={link[1]} class="font-medium underline underline-offset-4">
                  {link[0]}
                </a>
              )}
            </p>
          )}
        </section>
      ))}
    </Page>
  );
}
