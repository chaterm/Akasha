import "dayjs/locale/de";
import "dayjs/locale/en";
import "dayjs/locale/es";
import "dayjs/locale/fr";
import "dayjs/locale/it";
import "dayjs/locale/ja";
import "dayjs/locale/ko";
import "dayjs/locale/nl";
import "dayjs/locale/pt-br";
import "dayjs/locale/ru";
import "dayjs/locale/uk";
import "dayjs/locale/zh-cn";
import i18n from "@/i18n.ts";

// Maps our i18n language codes to the locale names registered by dayjs.
const DAYJS_LOCALE_MAP: Record<string, string> = {
  "de-DE": "de",
  "en-US": "en",
  "es-ES": "es",
  "fr-FR": "fr",
  "it-IT": "it",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "nl-NL": "nl",
  "pt-BR": "pt-br",
  "ru-RU": "ru",
  "uk-UA": "uk",
  "zh-CN": "zh-cn",
};

export function getDayjsLocale(language?: string): string {
  const lang = language ?? i18n.language ?? "en-US";
  return DAYJS_LOCALE_MAP[lang] ?? DAYJS_LOCALE_MAP[lang.split("-")[0]] ?? "en";
}
