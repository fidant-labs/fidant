import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { HowPage } from "./how/HowPage.tsx";
import { I18nProvider, useI18n } from "./i18n/I18n.tsx";
import { InfoPage } from "./info/InfoPage.tsx";
import { LandingPage } from "./landing/LandingPage.tsx";
import { PrivacyPage } from "./privacy/PrivacyPage.tsx";
import { ReceivePage } from "./receive/ReceivePage.tsx";
import { SendPage } from "./send/SendPage.tsx";
import { applyTheme, initialTheme } from "./theme.ts";
import { Footer, Header, Page, Problem, type Route } from "./ui.tsx";

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

const NAMED: ReadonlyArray<Route> = ["privacy", "how", "send", "about", "terms", "security"];

function routeOf(path: string): Route {
  const named = NAMED.find((name) => new RegExp(`^/${name}/?$`).test(path));
  if (named) {
    return named;
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
  const { t } = useI18n();
  const [route, setRoute] = useState(() => routeOf(location.pathname));
  const kept = useRef(new Set<Route>());
  useEffect(() => {
    const onPop = () => setRoute(routeOf(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = t.tabTitles[route];
  }, [route, t]);

  // A page change hides the focused link, so focus moves to the new page's or section's heading.
  const firstRoute = useRef(true);
  useEffect(() => {
    // On a receive link the fragment is the decryption key, so it is never read there.
    const named =
      routeOf(location.pathname) === "receive"
        ? null
        : document.getElementById(location.hash.slice(1));
    const target = named?.closest("main:not([hidden] *)") ? named : null;
    target?.scrollIntoView();
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    const heading =
      target?.querySelector<HTMLElement>("h2") ??
      document.querySelector<HTMLElement>("main:not([hidden] *) h1");
    if (!heading) {
      return;
    }
    heading.tabIndex = -1;
    heading.focus({ preventScroll: target !== null });
  }, [route]);

  const secure = hasSecureCrypto();
  if (route === "send" || route === "receive") {
    kept.current.add(route);
  }
  return (
    <div class="flex min-h-dvh flex-col">
      <Header current={route} />
      <div class="flex-1">
        {route === "landing" && <LandingPage />}
        {/* The privacy page uses no crypto, so it opens even without a secure connection. */}
        {route === "privacy" && <PrivacyPage />}
        {route === "how" && <HowPage />}
        {(route === "about" || route === "terms" || route === "security") && (
          <InfoPage page={route} />
        )}
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
      </div>
      <Footer />
    </div>
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
