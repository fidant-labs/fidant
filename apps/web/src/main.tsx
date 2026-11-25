import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { HowPage, howStep } from "./how/HowPage.tsx";
import { I18nProvider, useI18n } from "./i18n/I18n.tsx";
import { InfoPage } from "./info/InfoPage.tsx";
import { LandingPage } from "./landing/LandingPage.tsx";
import { PrivacyPage } from "./privacy/PrivacyPage.tsx";
import { ReceivePage } from "./receive/ReceivePage.tsx";
import { SendPage } from "./send/SendPage.tsx";
import { TechnicalPage } from "./technical/TechnicalPage.tsx";
import { applyTheme, initialTheme, type Theme } from "./theme.ts";
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

const NAMED: ReadonlyArray<Route> = [
  "privacy",
  "how",
  "send",
  "secret",
  "about",
  "terms",
  "security",
  "technical",
];

function routeOf(path: string): Route {
  const named = NAMED.find((name) => new RegExp(`^/${name}/?$`).test(path));
  if (named) {
    return named;
  }
  if (howStep(path)) {
    return "how";
  }
  if (path.startsWith("/r/")) {
    return "receive";
  }
  return "landing";
}

/**
 * Navigation never reloads the page (see `navigate`). The send, secret and receive
 * pages hold a transfer only in memory, so once opened they stay mounted, hidden
 * while another page shows.
 */
function App() {
  const { t } = useI18n();
  // The path, not just the route, so moving between /how steps renders the new step. On /how pages
  // the fragment too, so a link to an entry on the same page scrolls to it; elsewhere the fragment
  // can be a decryption key, so it stays out.
  const where = () =>
    location.pathname + (location.pathname.startsWith("/how") ? location.hash : "");
  const [place, setPlace] = useState(where);
  const path = place.split("#")[0] ?? "";
  const route = routeOf(path);
  const [theme, setTheme] = useState(initialTheme);
  const chooseTheme = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };
  const kept = useRef(new Set<Route>());
  useEffect(() => {
    const onPop = () => setPlace(where());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const step = howStep(path);
    document.title = step ? `${t.how.sections[step.id].heading} – Fidant` : t.tabTitles[route];
  }, [route, path, t]);

  // A page change hides the focused link, so focus moves to the new page's or section's heading.
  const firstRoute = useRef(true);
  useEffect(() => {
    // Only /how has anchors; elsewhere the fragment can be a decryption key, so it is never read.
    const named =
      routeOf(location.pathname) === "how" && location.hash
        ? document.getElementById(location.hash.slice(1))
        : null;
    const target = named?.closest<HTMLElement>("main:not([hidden] *) section") ?? null;
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
  }, [place]);

  const secure = hasSecureCrypto();
  const holdsTransfer = route === "send" || route === "secret" || route === "receive";
  if (holdsTransfer) {
    kept.current.add(route);
  }
  return (
    <div class="flex min-h-dvh flex-col max-lg:has-[[data-bottom-bar]:not([hidden]_*)]:pb-24">
      <Header current={route} />
      <div class="flex-1">
        {route === "landing" && <LandingPage />}
        {/* The privacy page uses no crypto, so it opens even without a secure connection. */}
        {route === "privacy" && <PrivacyPage />}
        {route === "how" && <HowPage path={path} />}
        {route === "technical" && <TechnicalPage />}
        {(route === "about" || route === "terms" || route === "security") && (
          <InfoPage page={route} />
        )}
        {!secure && holdsTransfer && <InsecurePage />}
        {secure && kept.current.has("receive") && (
          <div id="receive" hidden={route !== "receive"}>
            <ReceivePage />
          </div>
        )}
        {secure && kept.current.has("send") && (
          <div hidden={route !== "send"}>
            <SendPage kind="file" />
          </div>
        )}
        {secure && kept.current.has("secret") && (
          <div hidden={route !== "secret"}>
            <SendPage kind="text" />
          </div>
        )}
      </div>
      <Footer theme={theme} onTheme={chooseTheme} />
    </div>
  );
}

/** The browser handles a drag only when an enabled field takes that kind (files into the file input, text into the other inputs and an editable textarea); anything else is cancelled so it cannot open the file and lose the page. */
function ignoreStrayDrop(event: DragEvent) {
  const target = event.target;
  const files = event.dataTransfer?.types.includes("Files") ?? false;
  if (
    (target instanceof HTMLInputElement &&
      !target.disabled &&
      (target.type === "file") === files) ||
    (target instanceof HTMLTextAreaElement && !target.disabled && !target.readOnly && !files)
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
