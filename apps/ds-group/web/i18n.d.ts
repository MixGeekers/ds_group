import type { Locale, LocalePreference } from "./src/types";
export const LANGUAGE_STORAGE_KEY: string;
export const SUPPORTED_LOCALES: readonly Locale[];
export function getLocale(): Locale;
export function getLocalePreference(): LocalePreference;
export function setLocalePreference(value: LocalePreference): void;
export function onLocaleChange(
  listener: (value: { locale: Locale; preference: LocalePreference }) => void,
): () => void;
export function t(
  key: string,
  values?: Record<string, string | number>,
): string;
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string;
export function formatFileSize(value: number): string;
export function formatDateTime(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string;
export function formatTime(value: string | number | Date): string;
export function formatDate(value: string | number | Date): string;
