// The technical description: the reader's version of docs/how-fidant-works.md. Each /how step has a
// page of it at /how/<slug>, and /technical shows all of them in one page.
// Keep every sentence true of what the code does today.

import {
  type ArtId,
  Drawing,
  DrawnSection,
  Paragraphs,
  useRevealDrawings,
} from "../how/Drawing.tsx";
import type { Messages, Section } from "../i18n/en.ts";
import { useI18n } from "../i18n/I18n.tsx";
import { display, SectionLink } from "../ui.tsx";

type Technical = Messages["technical"];
type Modes = Technical["modes"];

/**
 * A piece of a step's detail: a text section with its drawing, a group of mode cards (each card
 * drawn with the drawing of the same name), or the protection table.
 */
type Block =
  | { section: keyof Technical["sections"]; art?: ArtId }
  | {
      [G in keyof Modes]: { modes: G; cards: ReadonlyArray<keyof Modes[G]["items"] & ArtId> };
    }[keyof Modes]
  | { table: "protect" | "data" };

/** The /how steps in order, with their URL and the detail that goes with each. */
export const STEPS = [
  {
    id: "stays",
    slug: "file",
    detail: [
      { section: "parts", art: "parts" },
      { modes: "send", cards: ["file", "secret"] },
      { section: "layers", art: "layers" },
      { section: "frames", art: "frames" },
      { section: "check", art: "check" },
      { section: "padding", art: "padding" },
      { section: "secret" },
    ],
  },
  {
    id: "link",
    slug: "link",
    detail: [
      { modes: "link", cards: ["link", "emailed"] },
      { section: "link" },
      { section: "keys", art: "keys" },
      { section: "recipients", art: "recipients" },
      { section: "email" },
    ],
  },
  { id: "open", slug: "connect", detail: [{ section: "signal", art: "signal" }] },
  {
    id: "direct",
    slug: "direct",
    detail: [{ modes: "route", cards: ["local", "stun"] }, { section: "travel" }],
  },
  {
    id: "relay",
    slug: "relay",
    detail: [{ modes: "route", cards: ["relay", "norelay"] }, { section: "norelay" }],
  },
  {
    id: "never",
    slug: "never",
    detail: [
      { section: "seen", art: "never" },
      { table: "data" },
      { table: "protect" },
      { section: "site", art: "site" },
      { section: "limits" },
      { section: "planned" },
    ],
  },
] as const satisfies ReadonlyArray<{
  id: keyof Messages["how"]["sections"];
  slug: string;
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
                {cell}
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
            <p class="mb-0 text-[0.95rem]">{text[card]?.body}</p>
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
                  {(term[2] ?? "").charAt(0).toUpperCase() + (term[2] ?? "").slice(1)}
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
  const { sections, protect, data } = t.technical;
  return step.detail.map((block: Block) => {
    if ("modes" in block) {
      return <ModeCards key={`modes-${block.cards[0]}`} group={block.modes} cards={block.cards} />;
    }
    if ("table" in block) {
      const table = block.table === "data" ? data : protect;
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

export function TechnicalPage() {
  const { t } = useI18n();
  const main = useRevealDrawings();
  return (
    <main ref={main} class="mx-auto max-w-4xl px-4 pt-32 pb-20 lg:pt-40">
      <h1 class={`${display} max-w-3xl text-[2.6rem] leading-[1.05] sm:text-[4rem]`}>
        {t.technical.title}
      </h1>
      <p class="mt-6 max-w-2xl text-[1.15rem] text-muted-foreground">{t.technical.lede}</p>
      {STEPS.map((step) => (
        <Detail key={step.slug} step={step} />
      ))}
    </main>
  );
}
