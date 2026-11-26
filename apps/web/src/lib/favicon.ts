// The tab's icon follows the transfer: green while one is open, a green check once it is done.
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
const GREEN = colours("#059669", "#fff");

const ICON: Record<TransferStatus, { style: string; glyph: string }> = {
  idle: {
    style: `${colours("#111", "#fff")}@media (prefers-color-scheme:dark){${colours("#f5f5f5", "#111")}}`,
    glyph: MARK,
  },
  active: { style: GREEN, glyph: MARK },
  done: { style: GREEN, glyph: CHECK },
};

export function faviconHref(status: TransferStatus): string {
  const { style, glyph } = ICON[status];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>${style}</style><rect width="32" height="32" rx="7"/><g fill="none" stroke-linecap="round">${glyph}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
