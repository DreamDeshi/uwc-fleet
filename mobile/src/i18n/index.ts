import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import en from "./en.json";
import ms from "./ms.json";

// English + Bahasa Malaysia only for now (Chinese comes after A4 — per brief).
const resources = {
  en: { translation: en },
  ms: { translation: ms },
};

// Default to the device language if it's one we support, else English.
const deviceLang = getLocales()[0]?.languageCode ?? "en";
const initialLang = deviceLang === "ms" ? "ms" : "en";

i18n.use(initReactI18next).init({
  resources,
  lng: initialLang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  compatibilityJSON: "v4",
});

export default i18n;
