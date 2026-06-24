import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import en from "./en.json";
import ms from "./ms.json";
import zh from "./zh.json";

// English, Bahasa Malaysia, and Simplified Chinese.
const resources = {
  en: { translation: en },
  ms: { translation: ms },
  zh: { translation: zh },
};

// Default to the device language if it's one we support, else English.
// expo-localization reports Chinese variants (zh-Hans, zh-CN, …) as "zh".
const deviceLang = getLocales()[0]?.languageCode ?? "en";
const initialLang = deviceLang === "ms" ? "ms" : deviceLang === "zh" ? "zh" : "en";

i18n.use(initReactI18next).init({
  resources,
  lng: initialLang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  compatibilityJSON: "v4",
});

export default i18n;
