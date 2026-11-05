import { useCallback, useSyncExternalStore } from "react";
import {
  getLocale,
  getLocalePreference,
  onLocaleChange,
  setLocalePreference,
} from "../../web/i18n.js";
const subscribe = (listener: () => void) => onLocaleChange(listener);
const snapshot = () => `${getLocale()}|${getLocalePreference()}`;
export function useLocale() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    locale: getLocale(),
    preference: getLocalePreference(),
    setPreference: setLocalePreference as (
      value: "en" | "zh-CN" | "system",
    ) => void,
  };
}
export function useTranslation<K extends string>(catalog: {
  en: Record<K, string>;
  "zh-CN": Record<K, string>;
}) {
  const { locale } = useLocale();
  return useCallback(
    (key: K, values: Record<string, string | number> = {}) =>
      catalog[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        values[name] === undefined ? match : String(values[name]),
      ),
    [catalog, locale],
  );
}
