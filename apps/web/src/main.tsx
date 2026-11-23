import { render } from "preact";
import { PrivacyPage } from "./privacy/PrivacyPage.tsx";
import { ReceivePage } from "./receive/ReceivePage.tsx";
import { SendPage } from "./send/SendPage.tsx";
import { Page, Problem } from "./ui.tsx";

/** Encryption needs Web Crypto, which browsers only offer on HTTPS or localhost. */
function hasSecureCrypto(): boolean {
  return window.isSecureContext && typeof crypto !== "undefined" && crypto.subtle !== undefined;
}

function InsecurePage() {
  return (
    <Page>
      <Problem
        title="This page needs a secure connection"
        body="Files are encrypted in your browser, which only works over a secure connection. Open this page with an address that starts with https://."
      />
    </Page>
  );
}

function App() {
  // The privacy page uses no crypto, so it opens even without a secure connection.
  if (/^\/privacy\/?$/.test(location.pathname)) {
    return <PrivacyPage />;
  }
  if (!hasSecureCrypto()) {
    return <InsecurePage />;
  }
  if (location.pathname.startsWith("/r/")) {
    return <ReceivePage />;
  }
  return <SendPage />;
}

/** The browser handles a drag only when an enabled input takes that kind (files into the file input, text into the others); anything else is cancelled so it cannot open the file and lose the page. */
function ignoreStrayDrop(event: DragEvent) {
  const target = event.target;
  const files = event.dataTransfer?.types.includes("Files") ?? false;
  if (
    target instanceof HTMLInputElement &&
    !target.disabled &&
    (target.type === "file") === files
  ) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "none";
  }
}
window.addEventListener("dragover", ignoreStrayDrop);
window.addEventListener("drop", ignoreStrayDrop);

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
