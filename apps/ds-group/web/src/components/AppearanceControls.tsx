import { useSyncExternalStore } from "react";
import { useLocale, useTranslation } from "../locale";
import { settingsMessages } from "../locales/settings";
import type { LocalePreference, ThemeColor, ThemePreference } from "../types";
import { Icon } from "./Icons";

const colors: ThemeColor[] = ["indigo", "blue", "teal", "rose", "amber"];
const subscribe = (listener: () => void) => {
  window.addEventListener("ds-group:theme", listener);
  return () => window.removeEventListener("ds-group:theme", listener);
};
const snapshot = () =>
  `${window.DSGroupTheme.getPreference()}|${window.DSGroupTheme.getColor()}`;

export function AppearanceControls({ idPrefix = "" }: { idPrefix?: string }) {
  const t = useTranslation(settingsMessages);
  const locale = useLocale();
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const theme = window.DSGroupTheme;

  return (
    <div className="appearance-controls">
      <label htmlFor={`${idPrefix}language-select`}>{t("language")}</label>
      <select
        id={`${idPrefix}language-select`}
        value={locale.preference}
        onChange={(event) =>
          locale.setPreference(event.target.value as LocalePreference)
        }
      >
        <option value="system">{t("system")}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
      <label htmlFor={`${idPrefix}theme-select`}>{t("theme")}</label>
      <select
        id={`${idPrefix}theme-select`}
        value={theme.getPreference()}
        onChange={(event) =>
          theme.setPreference(event.target.value as ThemePreference)
        }
      >
        <option value="system">{t("system")}</option>
        <option value="light">{t("light")}</option>
        <option value="dark">{t("dark")}</option>
      </select>
      <fieldset className="theme-colors">
        <legend>{t("themeColor")}</legend>
        <div className="theme-swatches">
          {colors.map((color) => (
            <button
              key={color}
              type="button"
              className="theme-swatch"
              data-color={color}
              aria-label={t(color)}
              title={t(color)}
              aria-pressed={theme.getColor() === color}
              onClick={() => theme.setColor(color)}
            >
              {theme.getColor() === color && <Icon name="check" />}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
