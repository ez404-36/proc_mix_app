import "react-i18next";
import type translation from "../locales/en/translation.json";

declare module "react-i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof translation };
  }
}
