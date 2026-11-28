// The tab's icon follows the transfer: a green dot while one is open, like the one beside Send in
// the header, and a green check once it is done.
//
// Every icon is a data: URL, the normal one too, so a change of status asks the server for
// nothing and the server can't tell from a request that a transfer started, finished or stopped.

export type TransferStatus = "idle" | "active" | "done";

/** One status for the whole tab: an open transfer outranks a finished one. */
export function overallStatus(statuses: readonly TransferStatus[]): TransferStatus {
  return statuses.includes("active") ? "active" : statuses.includes("done") ? "done" : "idle";
}

// The same drawing and colours as public/favicon.svg, which a test checks.
const MARK =
  '<path d="M11.25 24.25V12.75a5 5 0 0 1 10 0v.5" stroke-width="3"/><circle cx="21.25" cy="19.75" r="2.5" stroke="none"/>';
const CHECK = '<path d="M9 16.5l5 5 9-10.5" stroke-width="3.5" stroke-linejoin="round"/>';
const colours = (tile: string, ink: string) =>
  `rect{fill:${tile}}g{stroke:${ink}}circle{fill:${ink}}`;
const tile = (style: string, glyph: string) =>
  `<style>${style}</style><rect width="32" height="32" rx="7"/><g fill="none" stroke-linecap="round">${glyph}</g>`;

const ICON: Record<TransferStatus, string> = {
  idle: tile(
    `${colours("#111", "#fff")}@media (prefers-color-scheme:dark){${colours("#f5f5f5", "#111")}}`,
    MARK,
  ),
  // The header's live dot (emerald-500) with its ring held still: a browser draws only the first
  // frame of an SVG icon. No tile, so it reads on a light or a dark tab bar.
  active:
    '<circle cx="16" cy="16" r="15.5" fill="#10b981" fill-opacity=".3"/><circle cx="16" cy="16" r="10.5" fill="#10b981"/>',
  done: tile(colours("#059669", "#fff"), CHECK),
};

export function faviconHref(status: TransferStatus): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${ICON[status]}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
