// Light, dark or the system's choice. Stored in this browser only; "system" stores nothing.
// The CSS does the work: no `data-theme` on <html> means follow the system.

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "theme";

export function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  try {
    if (theme === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, theme);
    }
  } catch {
    // Not remembered, but the switch still applies to this page.
  }
}
