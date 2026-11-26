// The tab's icon follows the transfer: green while one is open, a green check once it is done.
//
// The status icons are data: URLs, not files, so a change of status asks the server for nothing
// and the server can't tell from a request that a transfer started or finished.

export type TransferStatus = "idle" | "active" | "done";

/** One status for the whole tab: an open transfer outranks a finished one. */
export function overallStatus(statuses: readonly TransferStatus[]): TransferStatus {
  return statuses.includes("active") ? "active" : statuses.includes("done") ? "done" : "idle";
}

// The mark is the same drawing as public/favicon.svg.
const GLYPH = {
  active:
    '<path d="M11.25 24.25V12.75a5 5 0 0 1 10 0v.5" stroke-width="3"/><circle cx="21.25" cy="19.75" r="2.5" fill="#fff" stroke="none"/>',
  done: '<path d="M9 16.5l5 5 9-10.5" stroke-width="3.5" stroke-linejoin="round"/>',
};

export function faviconHref(status: TransferStatus): string {
  if (status === "idle") {
    return "/favicon.svg";
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#059669"/><g fill="none" stroke="#fff" stroke-linecap="round">${GLYPH[status]}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
