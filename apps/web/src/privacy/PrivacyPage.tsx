import { Card, CardContent } from "#components/ui/card";
import { useI18n } from "../i18n/I18n.tsx";
import { lede, Page, SectionLink } from "../ui.tsx";

const section = "mt-10";
const h2 = "mb-3 text-[1.25rem] font-bold";

// The privacy notice: short and plain, for people who aren't technical. The explaining lives on the
// /how pages. Keep every sentence true of what the code does today: `server` in the dictionaries
// and apps/server/src/signaling.ts are the source.
// The text lives in i18n/en.ts and i18n/sv.ts under `privacy`.

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <Card>
      <CardContent>
        <dl class="divide-y divide-border">
          {rows.map(([term, value]) => (
            <div key={term} class="py-3 first:pt-0 last:pb-0">
              <dt class="font-semibold">{term}</dt>
              <dd class="mt-0.5 text-muted-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function PrivacyPage() {
  const { t } = useI18n();
  const p = t.privacy;
  return (
    <Page>
      <h1>{p.title}</h1>
      <p class={lede}>{p.lede}</p>

      <section class={section} aria-labelledby="never-heading">
        <h2 class={h2} id="never-heading">
          {p.neverHeading}
        </h2>
        <Facts rows={p.never} />
      </section>

      <section class={section} aria-labelledby="sees-heading">
        <h2 class={h2} id="sees-heading">
          {p.seesHeading}
        </h2>
        <Facts rows={p.sees} />
      </section>

      <section class={section} aria-labelledby="keep-heading">
        <h2 class={h2} id="keep-heading">
          {p.keepHeading}
        </h2>
        <p>{p.keep}</p>
        <Facts
          rows={Object.values(p.logFields).map(([what, why]) => [
            what.charAt(0).toUpperCase() + what.slice(1),
            why,
          ])}
        />
        <p class="mt-4">{p.logRetention}</p>
        <p class="mt-4">{p.relayLog}</p>
      </section>

      <section class={section} aria-labelledby="limits-heading">
        <h2 class={h2} id="limits-heading">
          {p.limitsHeading}
        </h2>
        <ul class="list-disc pl-6 [&>li]:my-2.5">
          {p.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
        <SectionLink link={p.limitsLink} />
      </section>

      <section class={section} aria-labelledby="check-heading">
        <h2 class={h2} id="check-heading">
          {p.checkHeading}
        </h2>
        <p>{p.check}</p>
        {p.checkLinks.map((link) => (
          <SectionLink key={link[1]} link={link} />
        ))}
      </section>

      <section class={section} aria-labelledby="contact-heading">
        <h2 class={h2} id="contact-heading">
          {p.contactHeading}
        </h2>
        <p>
          {p.contact}{" "}
          <a href="mailto:privacy@fidant.se" class="font-medium underline underline-offset-4">
            privacy@fidant.se
          </a>
          .
        </p>
      </section>
    </Page>
  );
}
