import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import Backend from "i18next-http-backend";

i18n
  // load translation using http -> see /public/locales (i.e. https://github.com/i18next/react-i18next/tree/master/example/react/public/locales)
  // learn more: https://github.com/i18next/i18next-http-backend
  // want your translations to be loaded from a professional CDN? => https://github.com/locize/react-tutorial#step-2---use-the-locize-cdn
  .use(Backend)
  // pass the i18n instance to react-i18next.
  .use(initReactI18next)
  // init i18next
  // for all options read: https://www.i18next.com/overview/configuration-options
  .init({
    // i18n maintenance policy:
    // - en-US is the source of truth for all UI strings (keys are the English text).
    // - en-US and ru-RU are the fully-maintained locales; in particular, the
    //   AI-chat string set is kept complete in both so the UI never renders
    //   mixed-language (no per-key en-US fallback within a single widget).
    // - The other 10 locales (fr-FR, de-DE, es-ES, nl-NL, ja-JP, zh-CN, ko-KR,
    //   pt-BR, it-IT, uk-UA) are partial and intentionally rely on the
    //   `fallbackLng: "en-US"` fallback below until translations are
    //   contributed (e.g. via Crowdin).
    fallbackLng: "en-US",
    debug: false,
    showSupportNotice: false,
    load: 'currentOnly',

    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },
    react: {
      useSuspense: false,
    }
  });

export default i18n;
