import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { buttonVariants } from "#components/ui/button";
import { HowPage } from "./how/HowPage.tsx";
import { I18nProvider, useI18n } from "./i18n/I18n.tsx";
import { InfoPage } from "./info/InfoPage.tsx";
import { LandingPage } from "./landing/LandingPage.tsx";
import { PrivacyPage } from "./privacy/PrivacyPage.tsx";
import { ReceivePage } from "./receive/ReceivePage.tsx";
import { SendPage } from "./send/SendPage.tsx";
import { applyTheme, initialTheme, type Theme } from "./theme.ts";
import { Footer, Header, Link, LiveDot, Page, Problem, type Route } from "./ui.tsx";

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
  const [route, setRoute] = useState(() => routeOf(location.pathname));
  const [theme, setTheme] = useState(initialTheme);
  const chooseTheme = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };
  const kept = useRef(new Set<Route>());
  const [sendOpen, setSendOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  // Holds the key, so it stays out of the DOM: the link back shows only the path.
  const receiveUrl = useRef("");
  const away =
    sendOpen && route !== "send"
      ? "send"
      : secretOpen && route !== "secret"
        ? "secret"
        : receiveOpen && route !== "receive"
          ? "receive"
          : undefined;
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
  }, [route]);

  const secure = hasSecureCrypto();
  const holdsTransfer = route === "send" || route === "secret" || route === "receive";
  if (holdsTransfer) {
    kept.current.add(route);
  }
  if (route === "receive" && !receiveUrl.current) {
    receiveUrl.current = location.pathname + location.hash;
  }
  return (
    <div class="flex min-h-dvh flex-col has-[[data-bottom-bar]:not([hidden]_*)]:pb-24">
      <Header current={route} open={{ send: sendOpen, secret: secretOpen }} />
      <div class="flex-1">
        {route === "landing" && <LandingPage />}
        {/* The privacy page uses no crypto, so it opens even without a secure connection. */}
        {route === "privacy" && <PrivacyPage />}
        {route === "how" && <HowPage />}
        {(route === "about" ||
          route === "terms" ||
          route === "security" ||
          route === "technical") && <InfoPage page={route} />}
        {!secure && holdsTransfer && <InsecurePage />}
        {secure && kept.current.has("receive") && (
          <div id="receive" hidden={route !== "receive"}>
            <ReceivePage onUnfinished={setReceiveOpen} />
          </div>
        )}
        {secure && kept.current.has("send") && (
          <div hidden={route !== "send"}>
            <SendPage kind="file" onUnfinished={setSendOpen} />
          </div>
        )}
        {secure && kept.current.has("secret") && (
          <div hidden={route !== "secret"}>
            <SendPage kind="text" onUnfinished={setSecretOpen} />
          </div>
        )}
      </div>
      <Footer theme={theme} onTheme={chooseTheme} />
      <div
        role="status"
        class="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
      >
        {away && (
          <div
            data-bottom-bar
            class="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-popover/90 py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4"
          >
            <LiveDot />
            <span>{t.openTransfer[away]}</span>
            <Link
              href={away === "receive" ? (receiveUrl.current.split("#")[0] ?? "") : `/${away}`}
              to={away === "receive" ? receiveUrl.current : undefined}
              class={`${buttonVariants({ size: "sm" })} rounded-full`}
            >
              {t.openTransfer.back}
            </Link>
          </div>
        )}
      </div>
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
