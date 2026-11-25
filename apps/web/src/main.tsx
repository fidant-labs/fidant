import { render } from "preact";
import { App, routeOf } from "./App.tsx";
import { I18nProvider } from "./i18n/I18n.tsx";
import { barePath, startLanguage } from "./i18n/language.ts";
import { applyTheme, initialTheme } from "./theme.ts";

/** Encryption needs Web Crypto, which browsers only offer on HTTPS or localhost. */
function hasSecureCrypto(): boolean {
  return window.isSecureContext && typeof crypto !== "undefined" && crypto.subtle !== undefined;
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
  const path = barePath(location.pathname);
  // Over the page the server sent, render reuses its elements and corrects any that differ.
  render(
    <I18nProvider initial={startLanguage(location.pathname)}>
      <App
        start={{ path, hash: routeOf(path) === "how" ? location.hash : "" }}
        secure={hasSecureCrypto()}
        theme={initialTheme()}
      />
    </I18nProvider>,
    root,
  );
}
