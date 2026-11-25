// The /how/traces explorer: which traces a transfer leaves, for the path the reader picks.
// The text is in technical.explorer in en.ts and sv.ts; docs/how-fidant-works.md is its source.

/** The three choices that set a transfer's path. */
export type Choice = {
  what: "file" | "secret";
  link: "self" | "email";
  route: "direct" | "relay" | "norelay";
};

export const CHOICES = {
  what: ["file", "secret"],
  link: ["self", "email"],
  route: ["direct", "relay", "norelay"],
} as const satisfies { [K in keyof Choice]: readonly Choice[K][] };

/** A trace: `when` is "" for every path, or alternatives split by "," of options that must all be picked, split by " ". */
export type Line = readonly [when: string, text: string];

/** Whether a line's `when` holds for this choice. "email relay,email direct" = email and (relay or direct). */
export function holds(when: string, choice: Choice): boolean {
  if (when === "") {
    return true;
  }
  const picked = new Set<string>(Object.values(choice));
  return when.split(",").some((all) =>
    all
      .trim()
      .split(" ")
      .every((option) => picked.has(option)),
  );
}

/** The lines of a place that hold for this choice. A place with none is not on this path. */
export function tracesFor(lines: readonly Line[], choice: Choice): string[] {
  return lines.filter(([when]) => holds(when, choice)).map(([, text]) => text);
}
