import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type UiLanguage = "zh" | "en";

interface I18nValue {
  language: UiLanguage;
  setLanguage: (language: UiLanguage) => void;
  t: (zh: string, en: string) => string;
}

const STORAGE_KEY = "launchpad-ui-language";

const I18nContext = createContext<I18nValue | null>(null);

function initialLanguage(): UiLanguage {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "zh" || stored === "en") return stored;
  return "zh";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<UiLanguage>(initialLanguage);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  const value = useMemo<I18nValue>(() => ({
    language,
    setLanguage,
    t: (zh, en) => language === "zh" ? zh : en,
  }), [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

export function LanguageToggle({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <div className={`language-toggle ${compact ? "is-compact" : ""}`} aria-label={t("界面语言", "Interface language")}>
      <button
        type="button"
        className={language === "zh" ? "selected" : ""}
        onClick={() => setLanguage("zh")}
        aria-pressed={language === "zh"}
      >
        中文
      </button>
      <button
        type="button"
        className={language === "en" ? "selected" : ""}
        onClick={() => setLanguage("en")}
        aria-pressed={language === "en"}
      >
        EN
      </button>
    </div>
  );
}
