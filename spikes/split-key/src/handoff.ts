// The handoff check page: plain DOM, no framework. It makes a probe link with
// a dummy F (see handoff-check.ts), and when it is opened from such a link it
// reports whether the fragment arrived intact. The landing report shows
// lengths and pass or fail only, never the fragment text, and nothing is sent
// or logged. Like the real receive page should, it removes the fragment from
// the address bar (history.replaceState) as soon as it has read it.
//
// body[data-mode] is make or landing, and #verdict[data-verdict] holds the
// verdict once checked, so a script driving the page can wait on them.

import {
  checkHandoffFragment,
  HANDOFF_QUERY,
  type HandoffCheck,
  inspectLocation,
  makeHandoffLink,
} from "./handoff-check.ts";
import { generateHalves } from "./keys.ts";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`missing #${id}`);
  }
  return found as T;
}

const landingSection = element<HTMLElement>("landing");
const verdictLine = element<HTMLParagraphElement>("verdict");
const landingRows = element<HTMLTableSectionElement>("landing-results");
const clearedLine = element<HTMLParagraphElement>("cleared");
const linkBlock = element<HTMLElement>("link");
const shareButton = element<HTMLButtonElement>("share");
const emailButton = element<HTMLButtonElement>("email");
const copyButton = element<HTMLButtonElement>("copy");
const newLinkButton = element<HTMLButtonElement>("new-link");
const makeStatus = element<HTMLParagraphElement>("make-status");
const pasteForm = element<HTMLFormElement>("paste-form");
const pasteInput = element<HTMLInputElement>("paste-input");

const VERDICT_TEXT: Record<HandoffCheck["verdict"], string> = {
  intact: "Intact",
  trailing: "Intact, with extra characters after it",
  truncated: "Truncated",
  altered: "Altered",
  missing: "Missing",
};

let link = "";

const passFail = (ok: boolean) => (ok ? "pass" : "fail");
const yesNo = (yes: boolean) => (yes ? "yes" : "no");

function addRow(name: string, value: string): void {
  const row = landingRows.insertRow();
  const header = document.createElement("th");
  header.scope = "row";
  header.textContent = name;
  row.append(header);
  row.insertCell().textContent = value;
}

type Arrived = { pathname: string; search: string; hash: string };

/** Fills the landing report. Shows lengths and pass or fail, never the fragment text. */
async function report(arrived: Arrived, source: string): Promise<void> {
  const check = await checkHandoffFragment(arrived.hash);
  const where = inspectLocation(arrived);
  landingRows.replaceChildren();
  landingSection.hidden = false;
  verdictLine.dataset.verdict = check.verdict;
  verdictLine.textContent = `${VERDICT_TEXT[check.verdict]}: ${check.reason}.`;

  addRow("Checked", source);
  addRow(
    "Fragment length",
    `${check.receivedLength} characters arrived, ${check.expectedLength} were sent`,
  );
  addRow("Percent-encoded", yesNo(check.percentDecoded));
  addRow("Prefix k=", passFail(check.parts.prefix));
  addRow("Length", passFail(check.parts.length));
  addRow("Charset (base64url F)", passFail(check.parts.charset));
  addRow("Check matches F", passFail(check.parts.check));
  if (check.extraLength > 0) {
    addRow("Extra characters", String(check.extraLength));
  }
  addRow(
    "Path",
    where.pathChanged ? `changed (${arrived.pathname.length} characters)` : "unchanged",
  );
  addRow(
    "Query",
    where.queryChanged
      ? `changed (${arrived.search.length} characters, ${HANDOFF_QUERY.length} sent)`
      : "unchanged",
  );
  addRow("Fragment moved into the query", yesNo(where.fragmentInQuery));
  if (where.fragmentInQuery) {
    // Check the copy in the query too, so a moved but intact fragment is visible.
    let search = arrived.search;
    try {
      search = decodeURIComponent(search);
    } catch {
      // Keep the raw query.
    }
    const moved = /k=[^&#\s]*/.exec(search)?.[0] ?? "";
    addRow(
      "Fragment found in the query",
      VERDICT_TEXT[(await checkHandoffFragment(moved)).verdict],
    );
  }
}

async function land(): Promise<void> {
  document.body.dataset.mode = "landing";
  const arrived = {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
  };
  // The real receive page should do this too: read the fragment once, then
  // drop it from the address bar so it is not left in history or screenshots.
  if (arrived.hash !== "") {
    history.replaceState(null, "", location.pathname + location.search);
    clearedLine.textContent =
      "The fragment was removed from the address bar after reading (history.replaceState).";
  } else {
    clearedLine.textContent = "No fragment was in the address bar.";
  }
  await report(arrived, "this page's address");
}

async function makeLink(): Promise<void> {
  // A dummy F, fresh per link. The server half is unused here.
  const { fragmentHalf } = generateHalves();
  link = await makeHandoffLink(location.origin, fragmentHalf);
  fragmentHalf.fill(0);
  linkBlock.textContent = link;
  makeStatus.textContent = "";
  copyButton.textContent = "Copy";
}

shareButton.disabled = typeof navigator.share !== "function";
if (shareButton.disabled) {
  shareButton.title = "This browser has no share sheet (navigator.share).";
}

shareButton.addEventListener("click", async () => {
  try {
    await navigator.share({ title: "Fidant handoff probe (dummy key)", url: link });
    makeStatus.textContent = "Shared.";
  } catch (error) {
    makeStatus.textContent =
      error instanceof DOMException && error.name === "AbortError"
        ? "Sharing was cancelled."
        : "Sharing failed.";
  }
});

emailButton.addEventListener("click", () => {
  const subject = "Fidant handoff probe (dummy key)";
  const body =
    "A link fragment test for FID-7. The key in it is a dummy, not a real key.\n\n" +
    `Open this link:\n\n${link}\n`;
  location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(link);
    copyButton.textContent = "Copied";
  } catch {
    // Clipboard access can be refused; selecting the text lets the user copy by hand.
    getSelection()?.selectAllChildren(linkBlock);
    copyButton.textContent = "Select and copy";
  }
});

newLinkButton.addEventListener("click", () => {
  void makeLink();
});

pasteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  let url: URL;
  try {
    url = new URL(pasteInput.value.trim());
  } catch {
    landingSection.hidden = false;
    landingRows.replaceChildren();
    verdictLine.dataset.verdict = "missing";
    verdictLine.textContent = "That is not a link.";
    clearedLine.textContent = "";
    return;
  }
  // The pasted text holds the dummy fragment; clear the field once read.
  pasteInput.value = "";
  clearedLine.textContent = "The pasted link was cleared from the field after reading.";
  void report(url, "a pasted link");
});

void makeLink();
// A probe link carries ?probe=1, so a lost fragment still lands here.
if (location.hash !== "" || location.search !== "") {
  void land();
}
// Opening a probe link from this same page changes only the fragment, which
// does not reload the page. replaceState does not fire this event.
addEventListener("hashchange", () => {
  void land();
});
