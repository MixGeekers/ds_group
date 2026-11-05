import { useState } from "react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../ui/overlays";
import { Button } from "../../../ui/controls";
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
  const [open, setOpen] = useState(false);

  function select(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="rail-account">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id="identity-button"
          className="rail-account-button"
          type="button"
          aria-label={`${t("accountMenu")} · ${name ?? t("signIn")}`}
          title={name ?? t("signIn")}
        >
          {children}
        </PopoverTrigger>
        <PopoverContent
          id="account-menu"
          className="account-menu"
          aria-label={t("accountMenu")}
          side="right"
          sideOffset={16}
          align="end"
        >
          <header className="account-menu-identity">
            <strong id="current-name">{name ?? t("signIn")}</strong>
            <span id="current-id">{userId ?? t("signedOut")}</span>
          </header>
          <div className="account-menu-actions">
            <Button
              id="settings-button"
              className="account-menu-action"
              variant="ghost"
              type="button"
              onClick={() => select(onSettings)}
            >
              <Icon name="gear" />
              {t("personalSettings")}
            </Button>
            <Button
              id="account-switch-button"
              className="account-menu-action"
              variant="ghost"
              type="button"
              onClick={() => select(onLogin)}
            >
              <Icon name="user" />
              {t(userId ? "switchAccount" : "signIn")}
            </Button>
          </div>
          <AppearanceControls idPrefix="account-" />
        </PopoverContent>
      </Popover>
    </div>
  );
}
