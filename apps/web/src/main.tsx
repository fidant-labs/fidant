import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { I18nProvider, useI18n } from "./i18n/I18n.tsx";
import { LandingPage } from "./landing/LandingPage.tsx";
import { PrivacyPage } from "./privacy/PrivacyPage.tsx";
import { ReceivePage } from "./receive/ReceivePage.tsx";
import { SendPage } from "./send/SendPage.tsx";
import { applyTheme, initialTheme } from "./theme.ts";
import { Header, Page, Problem, type Route } from "./ui.tsx";

/** Encryption needs Web Crypto, which browsers only offer on HTTPS or localhost. */
function hasSecureCrypto(): boolean {
  return window.isSecureContext && typeof crypto !== "undefined" && crypto.subtle !== undefined;
}

function InsecurePage() {
  const { t } = useI18n();
  return (
    <Page>
      <Problem title={t.insecure.title} body={t.insecure.body} />
    </Page>
  );
}

function routeOf(path: string): Route {
  if (/^\/privacy\/?$/.test(path)) {
    return "privacy";
  }
  if (/^\/send\/?$/.test(path)) {
    return "send";
  }
  if (path.startsWith("/r/")) {
    return "receive";
  }
  return "landing";
}

/**
 * Navigation never reloads the page (see `navigate`). The send and receive pages
 * hold a transfer only in memory, so once opened they stay mounted, hidden while
 * another page shows.
 */
function App() {
  const [route, setRoute] = useState(() => routeOf(location.pathname));
  const kept = useRef(new Set<Route>());
  useEffect(() => {
    const onPop = () => setRoute(routeOf(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const secure = hasSecureCrypto();
  if (route === "send" || route === "receive") {
    kept.current.add(route);
  }
  return (
    <>
      <Header current={route} />
      {route === "landing" && <LandingPage />}
      {/* The privacy page uses no crypto, so it opens even without a secure connection. */}
      {route === "privacy" && <PrivacyPage />}
      {!secure && (route === "send" || route === "receive") && <InsecurePage />}
      {secure && kept.current.has("receive") && (
        <div id="receive" hidden={route !== "receive"}>
          <ReceivePage />
        </div>
      )}
      {secure && kept.current.has("send") && (
        <div hidden={route !== "send"}>
          <SendPage />
        </div>
      )}
    </>
  );
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

// A stored light or dark choice; with none, the CSS already follows the system.
applyTheme(initialTheme());

const root = document.getElementById("app");
if (root) {
  render(
    <I18nProvider>
      <App />
    </I18nProvider>,
    root,
  );
}
