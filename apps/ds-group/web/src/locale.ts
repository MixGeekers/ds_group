import { useCallback, useSyncExternalStore } from "react";
import {
  getLocale,
  getLocalePreference,
  onLocaleChange,
  setLocalePreference,
} from "../i18n.js";
import type { LocalePreference } from "./types";

const subscribe = (listener: () => void) => onLocaleChange(listener);
const snapshot = () => `${getLocale()}|${getLocalePreference()}`;
export function useLocale() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    locale: getLocale(),
    preference: getLocalePreference(),
    setPreference: setLocalePreference as (value: LocalePreference) => void,
  };
}
export type Catalog<K extends string> = {
  en: Record<K, string>;
  "zh-CN": Record<K, string>;
};
export function useTranslation<K extends string>(catalog: Catalog<K>) {
  const { locale } = useLocale();
  return useCallback(
    (key: K, values: Record<string, string | number> = {}) =>
      catalog[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        values[name] === undefined ? match : String(values[name]),
      ),
    [catalog, locale],
  );
}
