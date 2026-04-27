import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

const STORAGE_KEY = "reunion:language";

function getInitialLanguage(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  const nav = navigator.language || "";
  return nav.startsWith("zh") ? "zh" : "en";
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: getInitialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lng) => {
  localStorage.setItem(STORAGE_KEY, lng);
  document.documentElement.lang = lng === "zh" ? "zh-CN" : "en";
});

export default i18n;
