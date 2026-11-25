// Runs in <head> before the page paints. The language rule is pickLanguage's in i18n/language.ts.
(() => {
  const html = document.documentElement;
  let theme = null;
  let lang = null;
  try {
    theme = localStorage.getItem("theme");
    lang = localStorage.getItem("lang");
  } catch {
    // Storage blocked: the system theme and the browser language apply.
  }
  if (theme === "light" || theme === "dark") {
    html.dataset.theme = theme;
  }
  const sv = document.currentScript?.dataset.sv;
  if (sv && (lang === "sv" || (lang !== "en" && /^sv\b/i.test(navigator.language)))) {
    html.hidden = true;
    location.replace(sv + location.search + location.hash);
  }
})();
