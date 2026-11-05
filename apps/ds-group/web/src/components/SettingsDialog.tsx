import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { initializePwa } from "../../pwa.js";
import { formatNumber, getLocalePreference } from "../../i18n.js";
import { messageOf } from "../api";
import { useLocale, useTranslation } from "../locale";
import { Icon } from "./Icons";
import { settingsMessages } from "../locales/settings";
import type {
  Api,
  LocalePreference,
  Participant,
  PwaHandle,
  Role,
  ServerStatus,
  Session,
  SettingsTab,
  ThemePreference,
} from "../types";

export interface SettingsDialogProps {
  tab: SettingsTab | null;
  onClose(): void;
  onTab(tab: SettingsTab): void;
  session: Session | null;
  participants: Participant[];
  status: ServerStatus | null;
  api: Api;
  onSwitchAccount(): void;
  onLogout(): void;
  logoutBusy: boolean;
  onRolesChanged(): void | Promise<void>;
  onOpenRoom(roomId: string, eventId?: string): void | Promise<void>;
  onPwaReady(handle: PwaHandle): void;
}

interface RoleDraft {
  id?: string;
  name: string;
  color: string;
  mentionable: boolean;
  memberIds: string[];
}

const tabs: SettingsTab[] = [
  "account",
  "appearance",
  "notifications",
  "server",
  "roles",
  "runtime",
];
const statusKeys = {
  ready: "ready",
  idle: "idle",
  online: "online",
  connected: "online",
  offline: "offline",
  busy: "busy",
  running: "running",
  thinking: "thinking",
  processing: "running",
  starting: "starting",
  stopped: "stopped",
  failed: "failed",
  error: "error",
  unknown: "unknown",
} as const;

function presenceClass(status: string) {
  if (["ready", "idle", "online", "connected"].includes(status))
    return "online";
  if (
    ["busy", "running", "thinking", "processing", "starting"].includes(status)
  )
    return "busy";
  return status === "error" || status === "failed" ? "error" : "";
}

function roleColor() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-accent")
    .trim();
  return /^#[a-f\d]{6}$/i.test(value) ? value : "#000000";
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { tab, session, participants, status, api } = props;
  const t = useTranslation(settingsMessages);
  const locale = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef(props);
  current.current = props;
  const pwa = useRef<PwaHandle | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(
    () => window.DSGroupTheme?.getPreference() ?? "system",
  );
  const [language, setLanguage] = useState<LocalePreference>(locale.preference);
  const [serverUrl, setServerUrl] = useState(location.origin);
  const [serverFeedback, setServerFeedback] = useState("");
  const [checkingServer, setCheckingServer] = useState(false);
  const [roles, setRoles] = useState<Role[]>([]);
  const [canManageRoles, setCanManageRoles] = useState(false);
  const [roleDraft, setRoleDraft] = useState<RoleDraft | null>(null);
  const [roleFeedback, setRoleFeedback] = useState("");
  const [roleBusy, setRoleBusy] = useState(false);

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
        onOpenRoom: (navigation) =>
          current.current.onOpenRoom(navigation.roomId, navigation.eventId),
      });
      current.current.onPwaReady(pwa.current);
    }
    void pwa.current.refresh();
  }, []);

  useEffect(() => {
    void pwa.current?.refresh();
  }, [session?.user_id, tab]);
  useEffect(() => {
    const updateTheme = () => setTheme(window.DSGroupTheme.getPreference());
    const updateLanguage = () => setLanguage(getLocalePreference());
    window.addEventListener("ds-group:theme", updateTheme);
    window.addEventListener("ds-group:locale", updateLanguage);
    return () => {
      window.removeEventListener("ds-group:theme", updateTheme);
      window.removeEventListener("ds-group:locale", updateLanguage);
    };
  }, [locale.preference]);

  const loadRoles = useCallback(async () => {
    const result = await api<{ roles: Role[]; canManage: boolean }>(
      "/api/roles",
    );
    setRoles(result.roles);
    setCanManageRoles(result.canManage);
  }, [api]);

  useEffect(() => {
    setRoleDraft(null);
    setRoleFeedback("");
    setCanManageRoles(false);
    if (tab !== "roles" || !session) return;
    let active = true;
    void api<{ roles: Role[]; canManage: boolean }>("/api/roles")
      .then((result) => {
        if (active) {
          setRoles(result.roles);
          setCanManageRoles(result.canManage);
        }
      })
      .catch((error) => {
        if (active) setRoleFeedback(messageOf(error));
      });
    return () => {
      active = false;
    };
  }, [api, session?.user_id, tab]);

  async function checkServer(event: FormEvent) {
    event.preventDefault();
    setCheckingServer(true);
    setServerFeedback("");
    try {
      const url = new URL(serverUrl.trim());
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(t("invalidServer"));
      const response = await fetch(new URL("/api/bootstrap", url.origin), {
        credentials: "omit",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value: unknown = await response.json();
      const workspace = value as {
        name?: string;
        roomId?: string;
        participants?: unknown[];
      };
      if (!workspace.roomId || !Array.isArray(workspace.participants))
        throw new Error(t("notWorkspace"));
      setServerFeedback(
        t("serverFound", {
          name: workspace.name || "DSCord",
          origin: url.origin,
        }),
      );
    } catch (error) {
      setServerFeedback(t("serverFailed", { error: messageOf(error) }));
    } finally {
      setCheckingServer(false);
    }
  }

  async function saveRole(event: FormEvent) {
    event.preventDefault();
    if (!roleDraft || roleBusy) return;
    setRoleBusy(true);
    setRoleFeedback("");
    try {
      const { id, ...body } = roleDraft;
      await api(id ? `/api/roles/${encodeURIComponent(id)}` : "/api/roles", {
        method: id ? "PUT" : "POST",
        body,
      });
      await loadRoles();
      await props.onRolesChanged();
      setRoleDraft(null);
      setRoleFeedback(t("roleSaved"));
    } catch (error) {
      setRoleFeedback(messageOf(error));
    } finally {
      setRoleBusy(false);
    }
  }

  async function deleteRole() {
    if (!roleDraft?.id || roleBusy) return;
    setRoleBusy(true);
    try {
      await api(`/api/roles/${encodeURIComponent(roleDraft.id)}`, {
        method: "DELETE",
      });
      await loadRoles();
      await props.onRolesChanged();
      setRoleDraft(null);
      setRoleFeedback(t("roleDeleted"));
    } catch (error) {
      setRoleFeedback(messageOf(error));
    } finally {
      setRoleBusy(false);
    }
  }

  const budget = status?.budget;
  const used = budget?.used;
  const limit = budget?.limit;

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
        <p id="settings-account">{session?.user_id || t("signedOut")}</p>
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
        <label htmlFor="theme-select">{t("theme")}</label>
        <select
          id="theme-select"
          value={theme}
          onChange={(event) => {
            const value = event.target.value as ThemePreference;
            window.DSGroupTheme.setPreference(value);
            setTheme(value);
          }}
        >
          <option value="system">{t("system")}</option>
          <option value="dark">{t("dark")}</option>
          <option value="light">{t("light")}</option>
        </select>
        <label htmlFor="language-select">{t("language")}</label>
        <select
          id="language-select"
          value={language}
          onChange={(event) => {
            const value = event.target.value as LocalePreference;
            setLanguage(value);
            locale.setPreference(value);
          }}
        >
          <option value="system">{t("system")}</option>
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
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
      <section data-settings-panel="server" hidden={tab !== "server"}>
        <h3>{t("serverAddress")}</h3>
        <p>
          {t("activeServer")} · {location.origin}
        </p>
        <form
          id="server-form"
          onSubmit={(event) => {
            void checkServer(event);
          }}
        >
          <label className="sr-only" htmlFor="server-url">
            {t("serverAddress")}
          </label>
          <input
            id="server-url"
            type="url"
            placeholder="https://chat.example.com"
            required
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />
          <div className="settings-actions">
            <button
              id="check-server"
              className="secondary-button"
              type="submit"
              disabled={checkingServer}
            >
              {t(checkingServer ? "checking" : "checkAddress")}
            </button>
          </div>
        </form>
        <p id="server-feedback" className="settings-feedback" role="status">
          {serverFeedback}
        </p>
      </section>
      <section data-settings-panel="roles" hidden={tab !== "roles"}>
        <div className="settings-section-heading">
          <h3>{t("roles")}</h3>
          <button
            id="new-role"
            className="secondary-button"
            type="button"
            hidden={!canManageRoles || Boolean(roleDraft)}
            onClick={() =>
              setRoleDraft({
                name: "",
                color: roleColor(),
                mentionable: true,
                memberIds: [],
              })
            }
          >
            {t("createRole")}
          </button>
        </div>
        <div id="role-list" className="role-list" hidden={Boolean(roleDraft)}>
          {roles.map((role) => (
            <button
              key={role.id}
              className="role-row"
              type="button"
              disabled={!canManageRoles}
              onClick={() => setRoleDraft({ ...role })}
            >
              <span
                className="role-color"
                style={{ backgroundColor: role.color }}
              />
              <strong>{role.name}</strong>
              <small>
                {t("memberCount", {
                  count: formatNumber(role.memberIds.length),
                })}
              </small>
            </button>
          ))}
          {!roles.length && <p className="muted small">{t("noRoles")}</p>}
        </div>
        <p id="role-feedback" className="settings-feedback" role="status">
          {roleFeedback}
        </p>
        {roleDraft && (
          <form
            id="role-form"
            onSubmit={(event) => {
              void saveRole(event);
            }}
          >
            <input id="role-id" type="hidden" value={roleDraft.id || ""} />
            <label htmlFor="role-name">{t("roleName")}</label>
            <input
              id="role-name"
              maxLength={40}
              required
              autoFocus
              value={roleDraft.name}
              onChange={(event) =>
                setRoleDraft({ ...roleDraft, name: event.target.value })
              }
            />
            <label htmlFor="role-color">{t("roleColor")}</label>
            <input
              id="role-color"
              type="color"
              value={roleDraft.color}
              onChange={(event) =>
                setRoleDraft({ ...roleDraft, color: event.target.value })
              }
            />
            <label className="check-label">
              <input
                id="role-mentionable"
                type="checkbox"
                checked={roleDraft.mentionable}
                onChange={(event) =>
                  setRoleDraft({
                    ...roleDraft,
                    mentionable: event.target.checked,
                  })
                }
              />
              {t("mentionable")}
            </label>
            <h3>{t("members")}</h3>
            <div id="role-members" className="room-choices">
              {participants.map((person) => (
                <label className="room-choice" key={person.id}>
                  <input
                    type="checkbox"
                    value={person.id}
                    checked={roleDraft.memberIds.includes(person.id)}
                    onChange={(event) =>
                      setRoleDraft({
                        ...roleDraft,
                        memberIds: event.target.checked
                          ? [...roleDraft.memberIds, person.id]
                          : roleDraft.memberIds.filter(
                              (id) => id !== person.id,
                            ),
                      })
                    }
                  />
                  <span className={`avatar avatar-${person.kind}`}>
                    {person.name.slice(0, 1)}
                  </span>
                  <span>{person.name}</span>
                </label>
              ))}
            </div>
            <div className="settings-actions">
              <button
                className="primary-button"
                type="submit"
                disabled={roleBusy}
              >
                {t(roleBusy ? "saving" : "save")}
              </button>
              <button
                id="cancel-role"
                className="secondary-button"
                type="button"
                disabled={roleBusy}
                onClick={() => setRoleDraft(null)}
              >
                {t("cancel")}
              </button>
              <button
                id="delete-role"
                className="danger-button"
                type="button"
                hidden={!roleDraft.id}
                disabled={roleBusy}
                onClick={() => {
                  void deleteRole();
                }}
              >
                {t("delete")}
              </button>
            </div>
          </form>
        )}
      </section>
      <section data-settings-panel="runtime" hidden={tab !== "runtime"}>
        <div className="core-card">
          <span className="core-icon" aria-hidden="true">
            <Icon name="server" />
          </span>
          <div>
            <strong id="core-title">
              {t(status ? "coreConnected" : "core")}
            </strong>
            <p id="core-description">
              {status ? "DSCord / Matrix" : t("waitingStatus")}
            </p>
          </div>
          <span
            id="core-status-dot"
            className={`status-dot ${status ? "online" : ""}`}
          />
        </div>
        <div className="section-heading">
          {t("botNodes")}{" "}
          <span id="node-count">{formatNumber(status?.nodes.length ?? 0)}</span>
        </div>
        <div id="node-list" className="node-list">
          {status?.nodes.map((node) => {
            const key =
              statusKeys[node.status as keyof typeof statusKeys] ?? "unknown";
            return (
              <article className="node-card" key={node.botId}>
                <header className="node-header">
                  <span className="avatar avatar-bot">
                    {node.name.slice(0, 1)}
                  </span>
                  <div className="node-title">
                    <strong>{node.name}</strong>
                    <small>{node.id}</small>
                  </div>
                  <span className="node-state">
                    <span
                      className={`status-dot ${presenceClass(node.status)}`}
                    />
                    {t(key)}
                  </span>
                </header>
                <span className="node-engine">{node.engine || "DS-Bot"}</span>
                <div className="node-meta">
                  <span>
                    {t("processed", {
                      count: formatNumber(node.processed ?? 0),
                    })}
                  </span>
                  <span>{node.model || "dsv4.1f"}</span>
                </div>
                {node.lastError && (
                  <p className="node-error">{node.lastError}</p>
                )}
              </article>
            );
          })}
          {!status?.nodes.length && (
            <p className="muted small">{t("noNodes")}</p>
          )}
        </div>
        <section className="budget-section">
          <div className="section-heading">{t("calls")}</div>
          <div className="budget-values">
            <strong id="budget-used">
              {used === undefined ? "—" : formatNumber(used)}
            </strong>
            <span id="budget-limit">
              {limit == null
                ? t("callsUnlimited")
                : t("callsLimit", { limit: formatNumber(limit) })}
            </span>
          </div>
          <div className="budget-track">
            <div
              id="budget-fill"
              style={{
                width:
                  limit && used !== undefined
                    ? `${Math.min(100, (used / limit) * 100)}%`
                    : "0%",
              }}
            />
          </div>
          <p id="budget-description" className="small muted">
            {limit == null
              ? budget?.model || "opencode-go/deepseek-v4.1-flash"
              : t("callsRemaining", {
                  count: formatNumber(
                    budget?.remaining ?? Math.max(0, limit - (used ?? 0)),
                  ),
                })}
          </p>
        </section>
      </section>
    </dialog>
  );
}
