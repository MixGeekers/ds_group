import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input } from "../../../ui/controls";
import { Dialog, DialogContent, DialogTitle } from "../../../ui/overlays";
import { initializePwa } from "../../pwa.js";
import { defaultClientConfig } from "../client-config";
import type { ClientConfig } from "../client-config";
import { storageKey } from "../session";
import { useTranslation } from "../locale";
import { AppearanceControls } from "./AppearanceControls";
import { Icon } from "./Icons";
import { settingsMessages } from "../locales/settings";
import type {
  Api,
  PwaHandle,
  Session,
  SettingsTab,
} from "../types";

export interface SettingsDialogProps {
  tab: SettingsTab | null;
  onClose(): void;
  onTab(tab: SettingsTab): void;
  session: Session | null;
  api: Api;
  config?: ClientConfig;
  onSwitchAccount(): void;
  onLogout(): void;
  logoutBusy: boolean;
  onOpenRoom(
    roomId: string,
    eventId?: string,
    expectedUserId?: string,
  ): void | Promise<void>;
  onPwaReady(handle: PwaHandle): void;
}
const tabs: SettingsTab[] = ["account", "appearance", "notifications"];

export function SettingsDialog(props: SettingsDialogProps) {
  const { tab, session } = props;
  const t = useTranslation(settingsMessages);
  const current = useRef(props);
  current.current = props;
  const pwa = useRef<PwaHandle | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const portalRef = useCallback((element: HTMLDivElement | null) => {
    if (element) setPortalReady(true);
  }, []);
  const [config] = useState(() => props.config ?? defaultClientConfig());
  useEffect(() => {
    if (!portalReady) return;
    if (!pwa.current) {
      pwa.current = initializePwa({
        request: (route, options) => current.current.api(route, options),
        getSession: () => current.current.session,
        getOwnerScope: () =>
          current.current.session
            ? storageKey(config, "push", current.current.session)
            : "",
        homeCoreUrl: config.homeCoreUrl,
        onOpenRoom: (navigation) =>
          current.current.onOpenRoom(
            navigation.roomId,
            navigation.eventId,
            navigation.userId,
          ),
      });
      current.current.onPwaReady(pwa.current);
    }
    void pwa.current.refresh();
    return () => {
      pwa.current?.destroy?.();
      pwa.current = null;
    };
  }, [portalReady]);
  useEffect(() => {
    void pwa.current?.refresh();
  }, [session, tab]);
  return (
    <Dialog
      open={tab !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        id="settings-dialog"
        ref={portalRef}
        className="settings-dialog"
        aria-labelledby="settings-title"
        finalFocus={() => document.getElementById("identity-button")}
      >
        <header className="dialog-heading">
          <DialogTitle id="settings-title">{t("settings")}</DialogTitle>
          <Button
            id="close-settings"
            className="icon-button"
            variant="ghost"
            size="icon"
            type="button"
            aria-label={t("close")}
            onClick={props.onClose}
          >
            <Icon name="close" />
          </Button>
        </header>
        <nav className="settings-tabs" aria-label={t("settingsCategories")}>
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              data-settings-tab={name}
              aria-current={tab === name ? "page" : undefined}
              onClick={() => props.onTab(name)}
            >
              {t(name)}
            </button>
          ))}
        </nav>
        <section data-settings-panel="account" hidden={tab !== "account"}>
          <h3>{t("currentAccount")}</h3>
          <p id="settings-account" className="identity-value">
            {session?.user_id || t("signedOut")}
          </p>
          {session?.identity && (
            <p className="muted small identity-value">
              {session.identity.subjectId}
            </p>
          )}
          <dl className="account-origins">
            <dt>{t("homeCore")}</dt>
            <dd>{config.homeCoreUrl}</dd>
            <dt>{t("homeMatrix")}</dt>
            <dd>
              {session?.home?.matrixUrl ??
                config.homeMatrixUrl ??
                t("configuredByHome")}
            </dd>
          </dl>
          <div className="settings-actions">
            <Button
              id="switch-account"
              variant="secondary"
              type="button"
              onClick={props.onSwitchAccount}
              disabled={props.logoutBusy}
            >
              {t("switchAccount")}
            </Button>
            {session && (
              <Button
                id="logout-button"
                variant="destructive"
                type="button"
                disabled={props.logoutBusy}
                onClick={props.onLogout}
              >
                {t(props.logoutBusy ? "signingOut" : "signOut")}
              </Button>
            )}
          </div>
        </section>
        <section
          data-settings-panel="notifications"
          hidden={tab !== "notifications"}
        >
          <h3>{t("deviceNotifications")}</h3>
          <p id="push-status" role="status" />
          <label htmlFor="push-device-label">{t("deviceName")}</label>
          <Input id="push-device-label" maxLength={80} autoComplete="off" />
          <div className="settings-actions">
            <Button id="enable-push" type="button">
              {t("enableNotifications")}
            </Button>
            <Button id="disable-push" variant="secondary" type="button" hidden>
              {t("disableNotifications")}
            </Button>
            <Button id="test-push" variant="secondary" type="button">
              {t("testNotification")}
            </Button>
          </div>
          <p id="push-feedback" className="settings-feedback" role="status" />
          <details className="settings-help">
            <summary>{t("mobileNotifications")}</summary>
            <p>{t("mobileHelp")}</p>
          </details>
        </section>
        <section data-settings-panel="appearance" hidden={tab !== "appearance"}>
          <h3>{t("appearanceLanguage")}</h3>
          <AppearanceControls />
          <h3>{t("installApp")}</h3>
          <p id="install-status" role="status" />
          <Button id="install-app" type="button">
            {t("install")}
          </Button>
          <p id="install-help" className="settings-feedback" />
          <h3>{t("connection")}</h3>
          <p id="offline-status" />
          <Button id="refresh-app" variant="secondary" type="button">
            {t("reload")}
          </Button>
        </section>
      </DialogContent>
    </Dialog>
  );
}
