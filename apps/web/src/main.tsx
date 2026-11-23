import { render } from "preact";
import { SendPage } from "./send/SendPage.tsx";

/** Encryption needs Web Crypto, which browsers only offer on HTTPS or localhost. */
function hasSecureCrypto(): boolean {
  return window.isSecureContext && typeof crypto !== "undefined" && crypto.subtle !== undefined;
}

function InsecurePage() {
  return (
    <main>
      <h1>Sigill</h1>
      <p class="notice error">
        Sigill needs a secure connection (HTTPS) to encrypt files in your browser. Open this page
        with an https:// address.
      </p>
    </main>
  );
}

function ReceivePlaceholder() {
  return (
    <main>
      <h1>Sigill</h1>
      <p>Receiving is not available yet.</p>
    </main>
  );
}

function App() {
  if (!hasSecureCrypto()) return <InsecurePage />;
  if (location.pathname.startsWith("/r/")) return <ReceivePlaceholder />;
  return <SendPage />;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
