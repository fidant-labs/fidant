import { Alert, AlertDescription } from "#components/ui/alert";
import { Card, CardContent } from "#components/ui/card";
import { useI18n } from "../i18n/I18n.tsx";
import { lede, Page } from "../ui.tsx";

const section = "mt-10";
const h2 = "mb-3 text-[1.25rem] font-bold";
const h3 = "mt-6 mb-2 font-bold";

// Written for people who aren't technical. Keep every sentence true of what the
// code does today: `server` in the dictionaries and apps/server/src/signaling.ts are the source.
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

      <section class={section} aria-labelledby="how-heading">
        <h2 class={h2} id="how-heading">
          {p.howHeading}
        </h2>
        <ol class="list-decimal pl-6 [&>li]:my-2.5">
          {p.steps.map(([bold, rest]) => (
            <li key={bold}>
              <strong>{bold}</strong>
              {rest && ` ${rest}`}
            </li>
          ))}
        </ol>
        <p>{p.keepOpen}</p>
      </section>

      <section class={section} aria-labelledby="travel-heading">
        <h2 class={h2} id="travel-heading">
          {p.travelHeading}
        </h2>
        <p>{p.lockedBox}</p>
        <p>
          {p.keyPart[0]}
          <strong>#</strong>
          {p.keyPart[1]}
        </p>
        <p>{p.direct}</p>
        <Alert role="note" className="my-4">
          <AlertDescription>{p.linkWarning}</AlertDescription>
        </Alert>
      </section>

      <section class={section} aria-labelledby="server-heading">
        <h2 class={h2} id="server-heading">
          {p.serverHeading}
        </h2>
        <h3 class={h3}>{p.neverHeading}</h3>
        <Facts rows={p.never} />
        <h3 class={h3}>{p.seesHeading}</h3>
        <Facts rows={p.sees} />
        <h3 class={h3}>{p.keepHeading}</h3>
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
    </Page>
  );
}
