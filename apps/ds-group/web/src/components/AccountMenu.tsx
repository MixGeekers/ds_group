import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "../locale";
import { settingsMessages } from "../locales/settings";
import { AppearanceControls } from "./AppearanceControls";
import { Icon } from "./Icons";

export function AccountMenu({
  name,
  userId,
  children,
  onSettings,
  onLogin,
}: {
  name?: string;
  userId?: string;
  children: ReactNode;
  onSettings(): void;
  onLogin(): void;
}) {
  const t = useTranslation(settingsMessages);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  function select(action: () => void) {
    panel.current?.hidePopover();
    action();
  }

  return (
    <div className="rail-account">
      <button
        id="identity-button"
        className="rail-account-button"
        type="button"
        popoverTarget="account-menu"
        aria-haspopup="dialog"
        aria-controls="account-menu"
        aria-expanded={open}
        aria-label={`${t("accountMenu")} · ${name ?? t("signIn")}`}
        title={name ?? t("signIn")}
      >
        {children}
      </button>
      <div
        id="account-menu"
        ref={panel}
        className="account-menu"
        popover="auto"
        role="dialog"
        aria-label={t("accountMenu")}
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        <header className="account-menu-identity">
          <strong id="current-name">{name ?? t("signIn")}</strong>
          <span id="current-id">{userId ?? t("signedOut")}</span>
        </header>
        <div className="account-menu-actions">
          <button
            id="settings-button"
            className="account-menu-action"
            type="button"
            onClick={() => select(onSettings)}
          >
            <Icon name="gear" />
            {t("personalSettings")}
          </button>
          <button
            id="account-switch-button"
            className="account-menu-action"
            type="button"
            onClick={() => select(onLogin)}
          >
            <Icon name="user" />
            {t(userId ? "switchAccount" : "signIn")}
          </button>
        </div>
        <AppearanceControls idPrefix="account-" />
      </div>
    </div>
  );
}
