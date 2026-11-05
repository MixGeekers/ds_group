import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactElement } from "react";
import {
  Gauge,
  Network,
  Users,
  DoorOpen,
  Bot,
  HardDrive,
  Settings,
  ShieldCheck,
  ScrollText,
  LogOut,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Plus,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslation } from "./locale";
import {
  Button,
  Checkbox,
  Input,
  NativeSelect,
  Textarea,
} from "../../ui/controls";
import { adminMessages } from "./messages";
import type {
  Administrator,
  Application,
  ManagementSession,
  Overview,
  Policy,
} from "./types";

const sections = [
  "overview",
  "partners",
  "members",
  "rooms",
  "bots",
  "storage",
  "deployment",
  "administrators",
  "audit",
] as const;
type Section = (typeof sections)[number];
type Collection = "partners" | "members" | "rooms" | "bots";
const icons = {
  overview: Gauge,
  partners: Network,
  members: Users,
  rooms: DoorOpen,
  bots: Bot,
  storage: HardDrive,
  deployment: Settings,
  administrators: ShieldCheck,
  audit: ScrollText,
};
const SESSION_KEY = `dscord.management.${location.origin}`;
const fileTools = ["read", "write", "edit", "read_image"];
const policySections: Section[] = [
  "overview", "partners", "members", "rooms", "bots", "deployment",
];
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const knownErrorKeys = {
  "Administrator sign-in failed": "signInFailed",
  "An instance administrator session is required": "sessionRequired",
  "Administrator session expired": "sessionExpired",
  "Your administrator role cannot perform this operation": "roleForbidden",
  "Too many administrator login attempts; try again in 15 minutes": "signInLimited",
  "Invalid management origin": "invalidManagementOrigin",
  "Use this instance’s management origin": "wrongManagementOrigin",
  "Keep at least one active owner": "keepOwner",
} as const;
const lines = (value: FormDataEntryValue | null) => [
  ...new Set(
    String(value || "")
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];
const storedSession = () => {
  try {
    return JSON.parse(
      sessionStorage.getItem(SESSION_KEY) || "null",
    ) as ManagementSession | null;
  } catch {
    return null;
  }
};
function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="admin-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
function ToolFields({
  current = [],
  disabled = false,
}: {
  current?: string[];
  disabled?: boolean;
}) {
  const t = useTranslation(adminMessages);
  return (
    <fieldset className="admin-tools" disabled={disabled}>
      <legend>{t("tools")}</legend>
      {fileTools.map((tool) => (
        <label key={tool}>
          <Checkbox
            name="tools"
            value={tool}
            defaultChecked={current.includes(tool)}
            disabled={disabled}
          />
          {tool}
        </label>
      ))}
    </fieldset>
  );
}

function PolicyCollection({
  section,
  policy,
  onChange,
  readOnly,
  invite,
  busy,
}: {
  section: Collection;
  policy: Policy;
  onChange(policy: Policy): void;
  readOnly: boolean;
  invite(roomId: string, memberId: string): void;
  busy: boolean;
}) {
  const t = useTranslation(adminMessages);
  const { locale } = useLocale();
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const key =
    section === "partners"
      ? "partners"
      : section === "members"
        ? "members"
        : section === "rooms"
          ? "rooms"
          : "botPolicies";
  const idKey =
    section === "partners"
      ? "serverName"
      : section === "members"
        ? "id"
        : section === "rooms"
          ? "roomId"
          : "botId";
  const records = policy[key] as unknown as Record<string, unknown>[];
  function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const str = (key: string) => String(data.get(key) || "").trim();
    const common = { enabled: data.get("enabled") === "on" };
    let row: Record<string, unknown>;
    if (section === "partners")
      row = {
        ...common,
        serverName: str("serverName"),
        name: str("name"),
        ...(str("publicUrl") ? { publicUrl: str("publicUrl") } : {}),
      };
    else if (section === "members")
      row = {
        ...common,
        id: str("id"),
        name: str("name"),
        kind: str("kind"),
        ...(str("ownerId") ? { ownerId: str("ownerId") } : {}),
      };
    else if (section === "rooms")
      row = {
        ...common,
        roomId: str("roomId"),
        authority: str("authority"),
        name: str("name"),
        memberIds: lines(data.get("memberIds")),
        botIds: lines(data.get("botIds")),
        tools: data.getAll("tools"),
      };
    else
      row = {
        ...common,
        botId: str("botId"),
        roomIds: lines(data.get("roomIds")),
        requesterIds: lines(data.get("requesterIds")),
        tools: data.getAll("tools"),
        canDelegate: false,
      };
    onChange({
      ...policy,
      [key]: [
        ...records.filter(
          (record) =>
            record[idKey] !== (editing?.[idKey] || row[idKey]) &&
            record[idKey] !== row[idKey],
        ),
        row,
      ],
    });
    setEditing(null);
    setReset((value) => value + 1);
  }
  const value = (field: string, fallback = "") =>
    String(editing?.[field] ?? fallback);
  const many = (field: string) =>
    (editing?.[field] as string[] | undefined)?.join("\n") || "";
  const detailName = (field: string) => {
    const names: Record<string, string> = {
      publicUrl: t("publicUrl"),
      kind: t("kind"),
      ownerId: t("owner"),
      authority: t("authority"),
      memberIds: t("roomMembers"),
      botIds: t("botIds"),
      roomIds: t("roomIds"),
      requesterIds: t("requesterIds"),
      tools: t("tools"),
    };
    return names[field] || field;
  };
  const hint = t(
    section === "partners"
      ? "partnerHint"
      : section === "members"
        ? "memberHint"
        : section === "rooms"
          ? "roomHint"
          : "botHint",
  );
  return (
    <div className={`admin-section-layout ${readOnly ? "is-single" : ""}`}>
      <section className="admin-panel admin-list-panel" aria-label={t("entries")}>
        <div className="admin-panel-heading">
          <div>
            <h2>{t("entries")}</h2>
            <p>{hint}</p>
          </div>
          <span
            className="admin-count"
            aria-label={t("entryCount", { count: records.length })}
          >
            {new Intl.NumberFormat(locale).format(records.length)}
          </span>
        </div>
        {records.length === 0 && <p className="admin-empty">{t("none")}</p>}
        <div className="admin-list">
          {records.map((row) => {
            const id = String(row[idKey]);
            return (
              <article className="admin-list-row" key={id}>
                <div className="admin-row-top">
                  <div className="admin-row-identity">
                    <strong>{String(row.name || id)}</strong>
                    {Boolean(row.name) && <code>{id}</code>}
                  </div>
                  <span
                    className={`admin-state ${row.enabled ? "is-good" : "is-muted"}`}
                  >
                    {row.enabled ? t("enabled") : t("closed")}
                  </span>
                </div>
                <dl className="admin-detail-list">
                  {Object.entries(row)
                    .filter(
                      ([field, val]) =>
                        ![idKey, "enabled", "name", "canDelegate"].includes(field) &&
                        val !== undefined &&
                        val !== "" &&
                        (!Array.isArray(val) || val.length > 0),
                    )
                    .map(([field, val]) => (
                      <div key={field}>
                        <dt>{detailName(field)}</dt>
                        <dd>
                          {Array.isArray(val)
                            ? val.join(", ")
                            : field === "kind"
                              ? val === "bot"
                                ? t("bot")
                                : val === "human"
                                  ? t("human")
                                  : String(val)
                              : String(val)}
                        </dd>
                      </div>
                    ))}
                </dl>
                {!readOnly && (
                  <div className="admin-row-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditing(row);
                        setPendingRemoval(null);
                        setReset((value) => value + 1);
                      }}
                    >
                      {t("edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="admin-remove-trigger"
                      onClick={() =>
                        setPendingRemoval(pendingRemoval === id ? null : id)
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      {t("remove")}
                    </Button>
                  </div>
                )}
                {pendingRemoval === id && (
                  <div
                    className="admin-confirm"
                    role="group"
                    aria-label={t("confirmRemove")}
                  >
                    <p>{t("confirmRemove")} <code>{id}</code></p>
                    <div className="admin-actions">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          onChange({
                            ...policy,
                            [key]: records.filter(
                              (item) => item[idKey] !== row[idKey],
                            ),
                          });
                          if (editing?.[idKey] === row[idKey]) {
                            setEditing(null);
                            setReset((value) => value + 1);
                          }
                          setPendingRemoval(null);
                        }}
                      >
                        {t("confirm")}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPendingRemoval(null)}
                      >
                        {t("cancel")}
                      </Button>
                    </div>
                  </div>
                )}
                {section === "rooms" &&
                  row.authority === policy.serverName &&
                  !readOnly && (
                  <form
                    className="admin-invite"
                    onSubmit={(event) => {
                      event.preventDefault();
                      invite(
                        String(row.roomId),
                        String(new FormData(event.currentTarget).get("memberId")),
                      );
                    }}
                  >
                    <Field label={t("inviteMember")}>
                      <NativeSelect name="memberId" required>
                        {(row.memberIds as string[]).map((memberId) => (
                          <option key={memberId} value={memberId}>
                            {memberId}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="submit"
                      disabled={busy || !(row.memberIds as string[]).length}
                    >
                      {t("invite")}
                    </Button>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      </section>
      {!readOnly && (
        <form
          className="admin-panel admin-editor"
          key={reset}
          onSubmit={update}
        >
          <div className="admin-panel-heading">
            <div>
              <h2>{editing ? t("editEntry") : t("addEntry")}</h2>
              <p>{t("entryFormHint")}</p>
            </div>
            {!editing && <Plus size={18} aria-hidden="true" />}
          </div>
          <div className="admin-form-fields">
            {section !== "bots" && (
              <Field label={t("name")}>
                <Input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={value("name")}
                />
              </Field>
            )}
            {section === "partners" && (
              <>
                <Field label={t("server")}>
                  <Input
                    name="serverName"
                    required
                    placeholder="partner.example.org"
                    defaultValue={value("serverName")}
                  />
                </Field>
                <Field label={t("publicUrl")}>
                  <Input
                    name="publicUrl"
                    type="url"
                    defaultValue={value("publicUrl")}
                  />
                </Field>
              </>
            )}
            {section === "members" && (
              <>
                <Field label={t("identity")}>
                  <Input
                    name="id"
                    required
                    placeholder="@member:partner.example.org"
                    defaultValue={value("id")}
                  />
                </Field>
                <Field label={t("kind")}>
                  <NativeSelect name="kind" defaultValue={value("kind", "human")}>
                    <option value="human">{t("human")}</option>
                    <option value="bot">{t("bot")}</option>
                  </NativeSelect>
                </Field>
                <Field label={t("owner")}>
                  <Input name="ownerId" defaultValue={value("ownerId")} />
                </Field>
              </>
            )}
            {section === "rooms" && (
              <>
                <Field label={t("roomId")}>
                  <Input name="roomId" required defaultValue={value("roomId")} />
                </Field>
                <Field label={t("authority")}>
                  <Input
                    name="authority"
                    required
                    defaultValue={value("authority", policy.serverName)}
                  />
                </Field>
                <Field label={t("roomMembers")}>
                  <Textarea name="memberIds" defaultValue={many("memberIds")} />
                </Field>
                <Field label={t("botIds")}>
                  <Textarea name="botIds" defaultValue={many("botIds")} />
                </Field>
                <ToolFields current={editing?.tools as string[]} />
              </>
            )}
            {section === "bots" && (
              <>
                <Field label={t("identity")}>
                  <Input
                    name="botId"
                    required
                    placeholder={`@bot:${policy.serverName}`}
                    pattern={`@[^:\\s]+:${policy.serverName.replaceAll(".", "\\.")}`}
                    defaultValue={value("botId")}
                  />
                </Field>
                <Field label={t("roomIds")}>
                  <Textarea
                    name="roomIds"
                    required
                    defaultValue={many("roomIds")}
                  />
                </Field>
                <Field label={t("requesterIds")}>
                  <Textarea
                    name="requesterIds"
                    required
                    defaultValue={many("requesterIds")}
                  />
                </Field>
                <ToolFields current={editing?.tools as string[]} />
                <p className="admin-hint">{t("botScope")}</p>
              </>
            )}
            <label className="admin-checkbox">
              <Checkbox
                name="enabled"
                defaultChecked={editing ? editing.enabled === true : true}
              />
              {t("enabled")}
            </label>
          </div>
          <div className="admin-form-actions">
            <Button variant="default" type="submit">
              {editing ? t("edit") : t("add")}
            </Button>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setEditing(null);
                setReset((value) => value + 1);
              }}
            >
              {t("reset")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function AdminApp() {
  const t = useTranslation(adminMessages);
  const { locale, preference, setPreference } = useLocale();
  const [session, setSession] = useState(storedSession);
  const [section, setSection] = useState<Section>("overview");
  const [lastPolicySection, setLastPolicySection] = useState<Section>("overview");
  const navigation = useRef<HTMLElement>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [saved, setSaved] = useState("");
  const [application, setApplication] = useState<Application | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [administrators, setAdministrators] = useState<Administrator[]>([]);
  const [adminEdit, setAdminEdit] = useState<Administrator | null>(null);
  const [events, setEvents] = useState<
    {
      sequence: number;
      at: number;
      actor: string;
      action: string;
      detail: Record<string, unknown>;
    }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState(
    () => window.DSGroupTheme?.getPreference() || "system",
  );
  const dirty = !!policy && JSON.stringify(policy) !== saved;
  const readOnly = session?.administrator.role === "auditor";
  const showPolicyActions = policySections.includes(section);
  const policyNeedsAttention = !!policy && (
    dirty || application?.restartRequired || !application?.livePolicyObserved ||
    (application?.application != null && application.application.status !== "applied")
  );
  const applicationStatus = (status: string) => {
    const labels: Record<string, string> = {
      pending: t("pending"),
      applied: t("applied"),
      partial: t("partial"),
      failed: t("failed"),
      prepared: t("prepared"),
      applying: t("applying"),
    };
    return labels[status] || status;
  };
  const roleLabel = (role: string) => {
    if (role === "owner") return t("ownerRole");
    if (role === "operator") return t("operatorRole");
    if (role === "auditor") return t("auditorRole");
    return role;
  };
  const localizedError = (message: string) => {
    const key = knownErrorKeys[message as keyof typeof knownErrorKeys];
    return key ? t(key) : message;
  };
  useEffect(() => {
    const element = navigation.current;
    if (!element) return;
    const revealCurrent = () => {
      const active = element.querySelector<HTMLElement>(
        '[aria-current="page"]',
      );
      if (!active || element.scrollWidth <= element.clientWidth) return;
      const item = active.getBoundingClientRect();
      const frame = element.getBoundingClientRect();
      element.scrollLeft +=
        item.left - frame.left - (frame.width - item.width) / 2;
    };
    revealCurrent();
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(element);
    return () => observer.disconnect();
  }, [section, session]);
  function remember(value: ManagementSession | null) {
    setSession(value);
    setSection("overview");
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else {
      sessionStorage.removeItem(SESSION_KEY);
      setPolicy(null);
      setSaved("");
      setApplication(null);
      setOverview(null);
      setAdministrators([]);
      setEvents([]);
      setAdminEdit(null);
    }
  }
  const api = useCallback(
    async <T,>(route: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(`/admin-api/${route}`, {
        method,
        credentials: "omit",
        headers: {
          ...(session
            ? { authorization: `Bearer ${session.access_token}` }
            : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const data = (await response.json()) as T & { error?: string };
      if (!response.ok) {
        if (response.status === 401 && route !== "login") remember(null);
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return data;
    },
    [session],
  );
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const load = useCallback(async () => {
    const [data, overview, admins, audit] = await Promise.all([
      api<{ policy: Policy; application: Application }>("policy"),
      api<Overview>("overview"),
      api<{ administrators: Administrator[] }>("administrators"),
      api<{ events: typeof events }>("audit"),
    ]);
    setPolicy(data.policy);
    setSaved(JSON.stringify(data.policy));
    setApplication(data.application);
    setOverview(overview);
    setAdministrators(admins.administrators);
    setEvents(audit.events);
  }, [api]);
  useEffect(() => {
    if (session) void load().catch((error) => setError(errorText(error)));
  }, [session, load]);
  const date = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(at);
  function exportPolicy() {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(policy, null, 2)], { type: "application/json" }),
    );
    link.download = `dscord-policy-${policy?.revision}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  const preferences = (
    <div className="admin-preferences">
      <Field label={t("theme")}>
        <NativeSelect
          value={theme}
          onChange={(event) => {
            const value = event.target.value as "dark" | "light" | "system";
            setTheme(value);
            window.DSGroupTheme?.setPreference(value);
          }}
        >
          <option value="system">{t("system")}</option>
          <option value="light">{t("light")}</option>
          <option value="dark">{t("dark")}</option>
        </NativeSelect>
      </Field>
      <Field label={t("language")}>
        <NativeSelect
          value={preference}
          onChange={(event) =>
            setPreference(event.target.value as "en" | "zh-CN" | "system")
          }
        >
          <option value="system">{t("system")}</option>
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </NativeSelect>
      </Field>
    </div>
  );
  if (!session)
    return (
      <main className="admin-login">
        <div className="admin-login-panel">
          <span className="admin-login-mark" aria-hidden="true" />
          <h1>{t("signIn")}</h1>
          <p>{t("credentialHint")}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input = new FormData(event.currentTarget);
              void action(async () => {
                const result = await api<ManagementSession>("login", "POST", {
                  username: input.get("username"),
                  password: input.get("password"),
                });
                remember(result);
              });
            }}
          >
            <Field label={t("username")}>
              <Input name="username" autoComplete="username" required />
            </Field>
            <Field label={t("password")}>
              <Input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Button variant="default" type="submit" disabled={busy}>
              {busy ? t("busy") : t("login")}
            </Button>
          </form>
          {error && (
            <p className="admin-error" role="alert">
              {localizedError(error)}
            </p>
          )}
          {preferences}
        </div>
      </main>
    );
  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <span className="admin-brand-icon" aria-hidden="true" />
          <div>
            <strong>DSCord</strong>
            <small>{t("title")}</small>
          </div>
        </div>
        <code className="admin-server-name">{policy?.serverName || overview?.serverName}</code>
        <nav ref={navigation} aria-label={t("title")}>
          {sections.map((name) => {
            const Icon = icons[name];
            return (
              <button
                type="button"
                className="admin-nav-button"
                key={name}
                aria-current={section === name ? "page" : undefined}
                onClick={() => {
                  setSection(name);
                  if (policySections.includes(name)) setLastPolicySection(name);
                  setNotice("");
                }}
              >
                <Icon size={18} aria-hidden="true" />
                {t(name)}
              </button>
            );
          })}
        </nav>
        <div className="admin-account">
          <span>
            {session.administrator.username} · {roleLabel(session.administrator.role)}
          </span>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api("logout", "POST");
                remember(null);
              })
            }
          >
            <LogOut size={17} aria-hidden="true" />
            {t("logout")}
          </Button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-header">
          <div className="admin-page-title">
            <h1>{t(section)}</h1>
          </div>
          {preferences}
        </header>
        {showPolicyActions ? (
          <section className="admin-policy-bar" aria-label={t("policyStatus")}>
            <div className="admin-policy-summary">
              <strong className={dirty ? "admin-state is-warning" : "admin-state"}>
                {dirty ? t("unsaved") : t("saved", { revision: policy?.revision || 0 })}
              </strong>
              <span className={`admin-status-note ${application?.livePolicyObserved ? "is-good" : "is-warning"}`}>
                {application?.livePolicyObserved ? t("observed") : t("unobserved")}
              </span>
              {application?.restartRequired && <span className="admin-status-note is-warning">{t("restart")}</span>}
            </div>
            <div className="admin-actions">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void action(load)}>
                <RefreshCw size={16} aria-hidden="true" />
                {dirty ? t("discardReload") : t("reload")}
              </Button>
              {!readOnly && (
                <>
                  <Button variant="default" size="sm" disabled={busy || !dirty} onClick={() => void action(async () => {
                    const result = await api<{ policy: Policy; application: Application }>("policy", "PUT", policy);
                    setPolicy(result.policy);
                    setSaved(JSON.stringify(result.policy));
                    setApplication(result.application);
                  })}>{t("save")}</Button>
                  <Button variant="secondary" size="sm" disabled={busy || dirty || !policy} onClick={() => void action(async () =>
                    setApplication(await api<Application>("apply", "POST", { revision: policy?.revision })),
                  )}>{busy ? t("busy") : t("apply")}</Button>
                </>
              )}
            </div>
          </section>
        ) : policyNeedsAttention && (
          <div className="admin-pending-bar" role="status">
            <span><AlertCircle size={16} aria-hidden="true" />{
              dirty ? t("unsaved") : application?.restartRequired ? t("restart") :
              !application?.livePolicyObserved ? t("unobserved") : t("applicationNeedsAttention")
            }</span>
            <Button variant="secondary" size="sm" onClick={() => setSection(lastPolicySection)}>{t("reviewPolicy")}</Button>
          </div>
        )}
        {readOnly && showPolicyActions && <p className="admin-readonly-note">{t("readOnly")}</p>}
        {error && (
          <div className="admin-error" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <span><strong>{t("error")}</strong><span>{localizedError(error)}</span></span>
          </div>
        )}
        {notice && (
          <div className="admin-notice" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />{notice}
          </div>
        )}
        {!policy && !error && <div className="admin-loading" role="status">{t("busy")}</div>}
        {section === "overview" && (
          <>
            <section className="admin-panel admin-metrics" aria-label={t("overview")}>
              {(
                [
                  ["revision", policy?.revision || 0],
                  [
                    "activePartners",
                    policy?.partners.filter((row) => row.enabled).length || 0,
                  ],
                  [
                    "activeMembers",
                    policy?.members.filter((row) => row.enabled).length || 0,
                  ],
                  ["managedRooms", policy?.rooms.length || 0],
                ] as const
              ).map(([label, value]) => (
                <div className="admin-metric" key={label}>
                  <span>{t(label)}</span>
                  <strong>{new Intl.NumberFormat(locale).format(value)}</strong>
                </div>
              ))}
            </section>
            <div className="admin-overview-grid">
            <section className="admin-panel">
              <div className="admin-panel-heading"><h2>{t("initialRoom")}</h2></div>
              <code className="admin-primary-value">{overview?.initialRoomId || "—"}</code>
            </section>
            <section className="admin-panel">
              <div className="admin-panel-heading"><h2>{t("application")}</h2></div>
              {!application?.application ? (
                <p className="admin-empty">{t("noApplication")}</p>
              ) : (
                <>
                  <div className="admin-application-summary">
                    <span>{t("revision")} <strong>{application.application.revision}</strong></span>
                    <span className={`admin-state ${application.application.status === "applied" ? "is-good" : "is-warning"}`}>{applicationStatus(application.application.status)}</span>
                  </div>
                  {application.application.configuration?.error && (
                    <div className="admin-inline-error"><AlertCircle size={16} aria-hidden="true" />{application.application.configuration.error}</div>
                  )}
                  {application.application.rooms.map((room) => (
                    <div className="admin-application-row" key={room.roomId}>
                      <code>{room.roomId}</code>
                      <span className="admin-state">{applicationStatus(room.status)}</span>
                      {room.error && (
                        <span className="admin-inline-error">{room.error}</span>
                      )}
                      {room.bans.map((ban) => (
                        <span key={ban.id}>
                          {t("ban")}: {ban.id} · {applicationStatus(ban.status)} {ban.error}
                        </span>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </section>
            </div>
          </>
        )}
        {policy &&
          ["partners", "members", "rooms", "bots"].includes(section) && (
            <PolicyCollection
              key={section}
              section={section as Collection}
              policy={policy}
              onChange={setPolicy}
              readOnly={readOnly}
              busy={busy || dirty}
              invite={(roomId, memberId) =>
                void action(async () => {
                  await api("invite", "POST", {
                    roomId,
                    memberId,
                    revision: policy.revision,
                  });
                  setNotice(t("invited"));
                })
              }
            />
          )}
        {section === "storage" && overview && (
          <div className="admin-storage-grid">
            <section className="admin-panel">
              <div className="admin-panel-heading"><h2>{t("backend")}</h2></div>
              <strong className="admin-primary-value">{overview.storage.backend}</strong>
              {overview.storage.bucket && (
                <dl className="admin-detail-list admin-detail-list-wide">
                  <div><dt>{t("bucket")}</dt><dd>{overview.storage.bucket}</dd></div>
                  <div><dt>{t("prefix")}</dt><dd>{overview.storage.prefix || "—"}</dd></div>
                </dl>
              )}
              <p className="admin-supporting-text">{t("storageHint")}</p>
            </section>
            <section className="admin-panel">
              <div className="admin-panel-heading"><h2>{t("localFiles")}</h2></div>
              {overview.storage.files.map((file) => (
                <div className="admin-record-detail" key={file.filename}>
                  <code>{file.filename}</code>
                  <span>
                    {new Intl.NumberFormat(locale).format(file.bytes)} B
                  </span>
                </div>
              ))}
              {!overview.storage.files.length && <p className="admin-empty">{t("none")}</p>}
            </section>
            <section className="admin-panel admin-backup-panel">
              <div className="admin-panel-heading"><h2>{t("backup")}</h2></div>
              <p className="admin-supporting-text">{t("backupHint")}</p>
              <Button variant="secondary" onClick={exportPolicy}>
                {t("exportPolicy")}
              </Button>
            </section>
          </div>
        )}
        {section === "deployment" && policy && (
          <section className="admin-panel admin-deployment-panel">
            <div className="admin-panel-heading">
              <div><h2>{t("serverSettings")}</h2><p>{t("deploymentHint")}</p></div>
            </div>
            <div className="admin-settings-grid">
            <div className="admin-settings-group">
            <h3>{t("serverIdentity")}</h3>
            <Field label={t("server")}>
              <Input readOnly value={policy.serverName} />
            </Field>
            <Field label={t("publicUrl")}>
              <Input readOnly value={overview?.publicUrl || ""} />
            </Field>
            </div>
            <div className="admin-settings-group">
            <h3>{t("requestLimits")}</h3>
            <Field label={t("registration")}>
              <NativeSelect
                disabled={readOnly}
                value={policy.settings.registrationMode || ""}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    settings: {
                      ...policy.settings,
                      registrationMode: (event.target.value || null) as
                        | "open"
                        | "closed"
                        | null,
                    },
                  })
                }
              >
                <option value="">{t("inherited")}</option>
                <option value="open">{t("open")}</option>
                <option value="closed">{t("closed")}</option>
              </NativeSelect>
            </Field>
            <Field label={t("upload")}>
              <Input
                type="number"
                min="0.001"
                max="50"
                step="0.001"
                placeholder={t("existingLimit")}
                disabled={readOnly}
                value={
                  policy.settings.maxUploadBytes === null
                    ? ""
                    : policy.settings.maxUploadBytes / 1048576
                }
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    settings: {
                      ...policy.settings,
                      maxUploadBytes: event.target.value
                        ? Math.round(Number(event.target.value) * 1048576)
                        : null,
                    },
                  })
                }
              />
            </Field>
            </div>
            </div>
          </section>
        )}
        {section === "administrators" && (
          <div className={`admin-section-layout ${session.administrator.role === "owner" ? "" : "is-single"}`}>
            <section className="admin-panel admin-list-panel" aria-label={t("administrators")}>
              <div className="admin-panel-heading">
                <div><h2>{t("entries")}</h2><p>{t("adminHint")}</p></div>
                <span className="admin-count" aria-label={t("entryCount", { count: administrators.length })}>{new Intl.NumberFormat(locale).format(administrators.length)}</span>
              </div>
              <div className="admin-list">
              {administrators.map((admin) => (
                <article className="admin-list-row" key={admin.username}>
                  <div className="admin-row-top">
                    <div className="admin-row-identity"><strong>{admin.username}</strong><span>{t("role")}: {roleLabel(admin.role)}</span></div>
                    <span className={`admin-state ${admin.enabled ? "is-good" : "is-muted"}`}>{admin.enabled ? t("enabled") : t("closed")}</span>
                  </div>
                  {session.administrator.role === "owner" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setAdminEdit(admin)}
                    >
                      {t("edit")}
                    </Button>
                  )}
                </article>
              ))}
              </div>
            </section>
            {session.administrator.role === "owner" && (
              <form
                className="admin-panel admin-editor"
                key={adminEdit?.username || "new"}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  void action(async () => {
                    const password = String(data.get("password") || "");
                    const result = await api<{
                      administrators: Administrator[];
                    }>("administrators", "PUT", {
                      username: data.get("username"),
                      role: data.get("role"),
                      enabled: data.get("enabled") === "on",
                      ...(password ? { password } : {}),
                    });
                    setAdministrators(result.administrators);
                    if (data.get("username") === session.administrator.username)
                      remember(null);
                    setAdminEdit(null);
                    form.reset();
                  });
                }}
              >
                <div className="admin-panel-heading"><h2>{adminEdit ? t("editAdministrator") : t("addAdministrator")}</h2></div>
                <div className="admin-form-fields">
                <Field label={t("username")}>
                  <Input
                    name="username"
                    required
                    pattern="[a-z][a-z0-9_.-]{2,63}"
                    defaultValue={adminEdit?.username || ""}
                  />
                </Field>
                <Field label={t("role")}>
                  <NativeSelect
                    name="role"
                    defaultValue={adminEdit?.role || "operator"}
                  >
                    <option value="owner">{t("ownerRole")}</option>
                    <option value="operator">{t("operatorRole")}</option>
                    <option value="auditor">{t("auditorRole")}</option>
                  </NativeSelect>
                </Field>
                <Field label={t("newPassword")}>
                  <Input
                    name="password"
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                    required={!adminEdit}
                  />
                </Field>
                <label className="admin-checkbox">
                  <Checkbox
                    name="enabled"
                    defaultChecked={adminEdit?.enabled ?? true}
                  />
                  {t("enabled")}
                </label>
                </div>
                <div className="admin-form-actions">
                  <Button variant="default" type="submit" disabled={busy}>
                    {t("updateAdmin")}
                  </Button>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => setAdminEdit(null)}
                  >
                    {t("reset")}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
        {section === "audit" && (
          <section className="admin-panel admin-audit">
            <div className="admin-panel-heading"><h2>{t("events")}</h2></div>
            <div className="admin-list">
              {events.map((event) => (
                <article className="admin-list-row" key={event.sequence}>
                  <div className="admin-row-top">
                    <strong>{event.action}</strong>
                    <time>{date(event.at)}</time>
                  </div>
                  <p className="admin-audit-meta">{t("actor")}: {event.actor} · #{event.sequence}</p>
                  <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                </article>
              ))}
            </div>
            <Button
              variant="secondary"
              disabled={busy || !events.length}
              onClick={() =>
                void action(async () => {
                  const result = await api<{ events: typeof events }>(
                    `audit?before=${events.at(-1)?.sequence}`,
                  );
                  setEvents([...events, ...result.events]);
                })
              }
            >
              {t("more")}
            </Button>
          </section>
        )}
      </main>
    </div>
  );
}
