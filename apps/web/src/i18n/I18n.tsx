import { type ComponentChildren, createContext } from "preact";
import { useContext, useLayoutEffect, useState } from "preact/hooks";
import type { Messages } from "./en.ts";
import { type Lang, localizedPath, MESSAGES, rememberLanguage } from "./language.ts";

type I18nValue = { lang: Lang; t: Messages; setLang: (lang: Lang) => void };

const I18nContext = createContext<I18nValue>({
  lang: "en",
  t: MESSAGES.en,
  setLang: () => {},
});

/** Switching re-renders in place and changes the address without loading it, so a transfer held in page memory survives it. */
export function I18nProvider({
  initial,
  children,
}: {
  initial: Lang;
  children: ComponentChildren;
}) {
  const [lang, setLangState] = useState(initial);
  useLayoutEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = (next: Lang) => {
    rememberLanguage(next);
    setLangState(next);
    const path = localizedPath(location.pathname, next);
    if (path !== location.pathname) {
      history.replaceState(history.state, "", path + location.search + location.hash);
    }
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
