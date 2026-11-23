import { render } from "preact";
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
  if (!hasSecureCrypto()) return <InsecurePage />;
  if (location.pathname.startsWith("/r/")) return <ReceivePage />;
  return <SendPage />;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
