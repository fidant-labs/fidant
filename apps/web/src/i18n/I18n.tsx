import { type ComponentChildren, createContext } from "preact";
import { useContext, useLayoutEffect, useState } from "preact/hooks";
import type { Messages } from "./en.ts";
import { initialLanguage, type Lang, MESSAGES, rememberLanguage } from "./language.ts";

type I18nValue = { lang: Lang; t: Messages; setLang: (lang: Lang) => void };

const I18nContext = createContext<I18nValue>({
  lang: "en",
  t: MESSAGES.en,
  setLang: () => {},
});

/** Switching re-renders in place, so a transfer held in page memory survives it. */
export function I18nProvider({ children }: { children: ComponentChildren }) {
  const [lang, setLangState] = useState(initialLanguage);
  useLayoutEffect(() => {
    document.documentElement.lang = lang;
    // The meta description is the footer tagline; index.html carries the English one for crawlers.
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", MESSAGES[lang].footer.tagline);
  }, [lang]);
  const setLang = (next: Lang) => {
    rememberLanguage(next);
    setLangState(next);
  };
  return (
    <I18nContext.Provider value={{ lang, t: MESSAGES[lang], setLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
