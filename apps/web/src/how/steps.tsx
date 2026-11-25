// The /how steps and their technical detail: the reader's version of docs/how-fidant-works.md,
// split over the pages at /how/<slug>.
// Keep every sentence true of what the code does today.

import type { Messages, Section } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { SectionLink } from "../ui.tsx";
import { type ArtId, Drawing, DrawnSection, Heading, Paragraphs, Terms } from "./Drawing.tsx";
import { TraceExplorer } from "./TraceExplorer.tsx";

type Technical = Messages["technical"];
type Modes = Technical["modes"];

/**
 * A piece of a step's detail: a text section, with a drawing unless the step's own drawing already
 * shows it; a group of mode cards (each drawn with the drawing of the same name); a table; or the
 * word list.
 */
type Block =
  | { section: keyof Technical["sections"]; art?: ArtId }
  | {
      [G in keyof Modes]: { modes: G; cards: ReadonlyArray<keyof Modes[G]["items"] & ArtId> };
    }[keyof Modes]
  | { table: "protect" | "data" | "linkRisks" }
  | { glossary: true }
  | { explorer: true };

/** The /how steps in order: their text on /how, their English URL slug (the Swedish one is in SWEDISH_PATHS), drawing and technical detail. */
export const STEPS = [
  {
    id: "stays",
    slug: "file",
    art: "stays",
    detail: [
      { section: "parts", art: "parts" },
      { modes: "send", cards: ["file", "secret"] },
      { section: "secret" },
    ],
  },
  {
    id: "encryption",
    slug: "encryption",
    art: "layers",
    detail: [{ section: "keys", art: "keys" }, { section: "layers" }],
  },
  {
    id: "link",
    slug: "link",
    art: "link",
    detail: [
      { modes: "link", cards: ["link", "emailed"] },
      { section: "link" },
      { table: "linkRisks" },
      { section: "recipients", art: "recipients" },
      { section: "email" },
    ],
  },
  { id: "open", slug: "connect", art: "open", detail: [{ section: "signal", art: "signal" }] },
  {
    id: "direct",
    slug: "direct",
    art: "direct",
    detail: [{ modes: "route", cards: ["local", "stun"] }, { section: "travel" }],
  },
  {
    id: "relay",
    slug: "relay",
    art: "relay",
    detail: [{ modes: "route", cards: ["relay", "norelay"] }, { section: "norelay" }],
  },
  { id: "transfer", slug: "transfer", art: "frames", detail: [{ section: "frames" }] },
  { id: "verification", slug: "verification", art: "check", detail: [{ section: "check" }] },
  { id: "masking", slug: "masking", art: "padding", detail: [{ section: "padding" }] },
  {
    id: "never",
    slug: "traces",
    art: "never",
    detail: [
      { explorer: true },
      { section: "seen" },
      { table: "data" },
      { section: "sender" },
      { section: "recipient" },
    ],
  },
  {
    id: "protection",
    slug: "protection",
    art: "site",
    detail: [
      { table: "protect" },
      { section: "site" },
      { section: "limits" },
      { section: "planned" },
    ],
  },
  { id: "tech", slug: "tech", art: "parts", detail: [{ glossary: true }] },
] as const satisfies ReadonlyArray<{
  id: keyof Messages["how"]["sections"];
  slug: string;
  art: ArtId;
  detail: ReadonlyArray<Block>;
}>;

export type Step = (typeof STEPS)[number];

/**
 * A table that never scrolls sideways: from md up its columns share the width, below md each row
 * becomes a card with the column's name above each value. The first column holds the row headers.
 */
function Table({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
}) {
  return (
    <table class="mt-6 w-full border-collapse text-left text-[0.92rem] md:table-fixed">
      <caption class="sr-only">{caption}</caption>
      <thead class="max-md:sr-only">
        <tr class="border-b-2 border-foreground">
          {columns.map((column, i) => (
            <th
              key={column}
              scope="col"
              class={`py-2 pr-4 align-bottom font-semibold ${i === 0 && columns.length > 2 ? "md:w-[22%]" : ""}`}
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([head, ...cells]) => (
          <tr key={head} class="border-b border-border align-top max-md:block max-md:py-4">
            <th scope="row" class="py-3 pr-4 font-semibold max-md:block max-md:py-0">
              {head}
            </th>
            {cells.map((cell, i) => (
              <td
                key={i}
                data-label={columns[i + 1]}
                class="py-3 pr-4 max-md:block max-md:py-0 max-md:pt-2 max-md:before:block max-md:before:text-[0.8rem] max-md:before:font-semibold max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]"
              >
                <Terms text={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ModeCards({ group, cards }: { group: keyof Modes; cards: ReadonlyArray<ArtId> }) {
  const { t } = useI18n();
  const { heading, items } = t.technical.modes[group];
  // STEPS checks that every card names an item of its group.
  const text: Partial<Record<ArtId, { heading: string; body: string }>> = items;
  return (
    <DrawnSection id={`modes-${cards[0]}`} heading={heading}>
      <div class="mt-6 grid gap-6 sm:grid-cols-2">
        {cards.map((card) => (
          <div key={card} class="rounded-lg border border-border p-5">
            <div class="mb-4 flex h-40 items-center justify-center [&>svg]:mb-0">
              <Drawing id={card} />
            </div>
            <h3 class="m-0 mb-2 text-[1.05rem] font-bold">{text[card]?.heading}</h3>
            <p class="mb-0 text-[0.95rem]">
              <Terms text={text[card]?.body ?? ""} />
            </p>
          </div>
        ))}
      </div>
    </DrawnSection>
  );
}

/** Paragraphs where a frame's name ("INIT: ...") becomes a bold term above its explanation. */
function Frames({ body }: { body: readonly string[] }) {
  const terms = body.map((paragraph) => /^([A-Z]+(?: [a-z]+ [A-Z]+)?): (.+)$/.exec(paragraph));
  return (
    <>
      <Paragraphs body={body.filter((_, i) => !terms[i])} />
      <dl class="max-w-2xl">
        {terms.map(
          (term) =>
            term && (
              <div key={term[1]} class="mt-4">
                <dt class="font-bold">{term[1]}</dt>
                <dd class="m-0">
                  <Terms
                    text={(term[2] ?? "").charAt(0).toUpperCase() + (term[2] ?? "").slice(1)}
                  />
                </dd>
              </div>
            ),
        )}
      </dl>
    </>
  );
}

/** The technical sections that explain one /how step. */
export function Detail({ step }: { step: Step }) {
  const { t } = useI18n();
  const { sections } = t.technical;
  return step.detail.map((block: Block) => {
    if ("modes" in block) {
      return <ModeCards key={`modes-${block.cards[0]}`} group={block.modes} cards={block.cards} />;
    }
    if ("explorer" in block) {
      return <TraceExplorer key="explorer" />;
    }
    if ("glossary" in block) {
      return Object.entries(t.technical.glossary).map(([id, [term, body]]) => (
        <section key={id} id={id} aria-labelledby={`${id}-heading`} class="mt-8 scroll-mt-20">
          <Heading id={id} class="m-0 mb-1 text-[1.15rem] font-bold">
            {term}
          </Heading>
          <p class="mt-0 max-w-2xl">
            <Terms text={body ?? ""} skip={id} />
          </p>
        </section>
      ));
    }
    if ("table" in block) {
      const table = t.technical[block.table];
      return (
        <DrawnSection key={block.table} id={block.table} heading={table.heading}>
          <Paragraphs body={table.body} />
          <Table caption={table.heading} columns={table.columns} rows={table.rows} />
        </DrawnSection>
      );
    }
    const { heading, body, link }: Section = sections[block.section];
    return (
      <DrawnSection key={block.section} id={block.section} art={block.art} heading={heading}>
        {block.section === "frames" ? <Frames body={body} /> : <Paragraphs body={body} />}
        {link && <SectionLink link={link} />}
      </DrawnSection>
    );
  });
}
