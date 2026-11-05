import { useEffect, useRef, useState } from "react";
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
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef(props);
  current.current = props;
  const pwa = useRef<PwaHandle | null>(null);
  const [config] = useState(() => props.config ?? defaultClientConfig());
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (tab && !element.open) element.showModal();
    if (!tab && element.open) element.close();
  }, [tab]);
  useEffect(() => {
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
  }, []);
  useEffect(() => {
    void pwa.current?.refresh();
  }, [session, tab]);
  return (
    <dialog
      id="settings-dialog"
      className="settings-dialog"
      ref={dialog}
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id="settings-title">{t("settings")}</h2>
        <button
          id="close-settings"
          className="icon-button"
          type="button"
          aria-label={t("close")}
          onClick={props.onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <nav className="settings-tabs" aria-label={t("settingsCategories")}>
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            data-settings-tab={name}
            aria-selected={tab === name}
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
          <button
            id="switch-account"
            className="secondary-button"
            type="button"
            onClick={props.onSwitchAccount}
            disabled={props.logoutBusy}
          >
            {t("switchAccount")}
          </button>
          {session && (
            <button
              id="logout-button"
              className="danger-button"
              type="button"
              disabled={props.logoutBusy}
              onClick={props.onLogout}
            >
              {t(props.logoutBusy ? "signingOut" : "signOut")}
            </button>
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
        <input id="push-device-label" maxLength={80} autoComplete="off" />
        <div className="settings-actions">
          <button
            id="enable-push"
            className="primary-button"
            type="button"
            disabled
          >
            {t("enableNotifications")}
          </button>
          <button
            id="disable-push"
            className="secondary-button"
            type="button"
            hidden
          >
            {t("disableNotifications")}
          </button>
          <button
            id="test-push"
            className="secondary-button"
            type="button"
            disabled
          >
            {t("testNotification")}
          </button>
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
        <button id="install-app" className="primary-button" type="button">
          {t("install")}
        </button>
        <p id="install-help" className="settings-feedback" />
        <h3>{t("connection")}</h3>
        <p id="offline-status" />
        <button id="refresh-app" className="secondary-button" type="button">
          {t("reload")}
        </button>
      </section>
    </dialog>
  );
}
