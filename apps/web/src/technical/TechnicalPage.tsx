// The technical description: the reader's version of docs/how-fidant-works.md, drawn like /how.
// Keep every sentence true of what the code does today.

import { type ArtId, Drawing } from "../how/Drawing.tsx";
import { DrawnSection, useRevealDrawings } from "../how/HowPage.tsx";
import type { Section } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { SectionLink } from "../info/InfoPage.tsx";
import { display } from "../ui.tsx";

type SectionId = keyof ReturnType<typeof useI18n>["t"]["technical"]["sections"];

// Each section in page order, with its drawing.
const BEFORE_MODES: ReadonlyArray<readonly [SectionId, ArtId?]> = [["parts", "parts"]];
const AFTER_MODES: ReadonlyArray<readonly [SectionId, ArtId?]> = [
  ["link", "link"],
  ["keys", "keys"],
  ["signal", "signal"],
  ["layers", "layers"],
  ["frames", "frames"],
  ["check", "check"],
  ["padding", "padding"],
  ["travel", "turn"],
  ["norelay", "norelay"],
  ["recipients", "recipients"],
  ["secret", "secret"],
  ["email", "emailed"],
  ["site", "site"],
];

// The cards in each group of modes, with their drawings.
const MODE_ART = {
  send: { file: "file", secret: "secret" },
  link: { own: "link", emailed: "emailed" },
  route: { local: "local", stun: "stun", turn: "turn", norelay: "norelay" },
} as const satisfies Record<string, Record<string, ArtId>>;

function Paragraphs({ body }: { body: readonly string[] }) {
  return body.map((paragraph) => (
    <p key={paragraph} class="max-w-2xl">
      {paragraph}
    </p>
  ));
}

/** A table that scrolls sideways on its own on narrow screens, never the page. Row headers in the first column. */
function Table({
  caption,
  columns,
  rows,
  wide,
}: {
  caption: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  /** Many columns: keep them readable and let the table scroll on narrow screens. */
  wide?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard.
    <div class="mt-6 overflow-x-auto rounded-lg border border-border" tabIndex={0}>
      <table
        class={`w-full border-collapse ${wide ? "min-w-[44rem]" : ""} text-left text-[0.95rem]`}
      >
        <caption class="sr-only">{caption}</caption>
        <thead class="bg-muted">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" class="px-3 py-2 align-bottom font-semibold">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([head, ...cells]) => (
            <tr key={head} class="border-t border-border align-top">
              <th scope="row" class="px-3 py-2 font-semibold">
                {head}
              </th>
              {cells.map((cell, i) => (
                <td key={i} class="px-3 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TechnicalPage() {
  const { t } = useI18n();
  const { title, lede, sections, modes, protect, data } = t.technical;
  const main = useRevealDrawings();

  const section = ([id, art]: readonly [SectionId, ArtId?]) => {
    const { heading, body, link }: Section = sections[id];
    return (
      <DrawnSection key={id} id={id} art={art} heading={heading}>
        <Paragraphs body={body} />
        {link && <SectionLink link={link} />}
      </DrawnSection>
    );
  };

  return (
    <main ref={main} class="mx-auto max-w-4xl px-4 pt-32 pb-20 lg:pt-40">
      <h1 class={`${display} max-w-3xl text-[2.6rem] leading-[1.05] sm:text-[4rem]`}>{title}</h1>
      <p class="mt-6 max-w-2xl text-[1.15rem] text-muted-foreground">{lede}</p>

      {BEFORE_MODES.map(section)}

      <DrawnSection id="modes" heading={modes.heading}>
        <Paragraphs body={modes.body} />
        {(Object.keys(MODE_ART) as Array<keyof typeof MODE_ART>).map((group) => {
          const items: Record<string, { heading: string; body: string }> =
            modes.groups[group].items;
          return (
            <div key={group}>
              <h3 class="mt-8 mb-0 text-[1.2rem] font-bold">{modes.groups[group].heading}</h3>
              <div class="mt-4 grid gap-6 sm:grid-cols-2">
                {Object.entries(MODE_ART[group]).map(([id, art]) => (
                  <div key={id} class="rounded-lg border border-border p-5">
                    <div class="mb-4 flex h-40 items-center justify-center [&>svg]:mb-0">
                      <Drawing id={art} />
                    </div>
                    <h4 class="m-0 mb-2 text-[1.05rem] font-bold">{items[id]?.heading}</h4>
                    <p class="mb-0 text-[0.95rem]">{items[id]?.body}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </DrawnSection>

      {AFTER_MODES.map(section)}

      <DrawnSection id="protect" heading={protect.heading}>
        <Paragraphs body={protect.body} />
        <Table caption={protect.heading} columns={protect.columns} rows={protect.rows} />
      </DrawnSection>

      <DrawnSection id="seen" heading={sections.seen.heading}>
        <Paragraphs body={sections.seen.body} />
        <h3 class="mt-8 mb-0 text-[1.2rem] font-bold">{data.heading}</h3>
        <Paragraphs body={data.body} />
        <Table wide caption={data.heading} columns={data.columns} rows={data.rows} />
        <SectionLink link={sections.seen.link} />
      </DrawnSection>

      {section(["limits"])}
      {section(["planned"])}
    </main>
  );
}
