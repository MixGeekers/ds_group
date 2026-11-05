import { cloneElement, useCallback, useEffect, useId, useRef, useState } from "react";
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
} from "lucide-react";
import { useLocale, useTranslation } from "./locale";
import { Button, Input, NativeSelect, Textarea } from "../../ui/controls";
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
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
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
          <input
            type="checkbox"
            name="tools"
            value={tool}
            defaultChecked={current.includes(tool)}
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
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
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
  return (
    <>
      <p className="admin-hint">
        {t(
          section === "partners"
            ? "partnerHint"
            : section === "members"
              ? "memberHint"
              : section === "rooms"
                ? "roomHint"
                : "botHint",
        )}
      </p>
      <div className="admin-records">
        {records.length === 0 && <p>{t("none")}</p>}
        {records.map((row) => (
          <article className="admin-card" key={String(row[idKey])}>
            <div className="admin-record-title">
              <strong>{String(row.name || row[idKey])}</strong>
              <span className={`admin-badge ${row.enabled ? "good" : ""}`}>
                {row.enabled ? t("enabled") : t("closed")}
              </span>
            </div>
            <code>{String(row[idKey])}</code>
            {Object.entries(row)
              .filter(
                ([key]) =>
                  ![idKey, "enabled", "name", "canDelegate"].includes(key),
              )
              .map(([key, val]) => (
                <div className="admin-record-detail" key={key}>
                  <span>{key}</span>
                  <span>
                    {Array.isArray(val) ? val.join("\n") || "—" : String(val)}
                  </span>
                </div>
              ))}
            {!readOnly && (
              <div className="admin-actions">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditing(row);
                    setReset((value) => value + 1);
                  }}
                >
                  {t("edit")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    onChange({
                      ...policy,
                      [key]: records.filter(
                        (item) => item[idKey] !== row[idKey],
                      ),
                    });
                    if (editing?.[idKey] === row[idKey]) setEditing(null);
                  }}
                >
                  {t("remove")}
                </Button>
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
                      {(row.memberIds as string[]).map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Button
                    variant="secondary"
                    type="submit"
                    disabled={busy || !(row.memberIds as string[]).length}
                  >
                    {t("invite")}
                  </Button>
                </form>
              )}
          </article>
        ))}
      </div>
      {!readOnly && (
        <form
          className="admin-card admin-policy-form"
          key={reset}
          onSubmit={update}
        >
          <h2>{editing ? t("edit") : t("add")}</h2>
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
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={editing ? editing.enabled === true : true}
            />
            {t("enabled")}
          </label>
          <div className="admin-actions">
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
    </>
  );
}

export default function AdminApp() {
  const t = useTranslation(adminMessages);
  const { locale, preference, setPreference } = useLocale();
  const [session, setSession] = useState(storedSession);
  const [section, setSection] = useState<Section>("overview");
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
  useEffect(() => {
    const element = navigation.current;
    if (!element) return;
    const revealCurrent = () => {
      const active = element.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active || element.scrollWidth <= element.clientWidth) return;
      const item = active.getBoundingClientRect();
      const frame = element.getBoundingClientRect();
      element.scrollLeft += item.left - frame.left - (frame.width - item.width) / 2;
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
        <div className="admin-card">
          <ShieldCheck aria-hidden="true" size={36} />
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
              {error}
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
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>DSCord</strong>
            <small>{t("title")}</small>
          </div>
        </div>
        <code>{policy?.serverName || overview?.serverName}</code>
        <nav ref={navigation} aria-label={t("title")}>
          {sections.map((name) => {
            const Icon = icons[name];
            return (
              <button
                key={name}
                aria-current={section === name ? "page" : undefined}
                onClick={() => {
                  setSection(name);
                  setNotice("");
                }}
              >
                <Icon size={19} aria-hidden="true" />
                {t(name)}
              </button>
            );
          })}
        </nav>
        <div className="admin-account">
          <span>
            {session.administrator.username} · {session.administrator.role}
          </span>
          <button
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
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-header">
          <div>
            <h1>{t(section)}</h1>
          </div>
          {preferences}
        </header>
        <div className="admin-toolbar">
          <div className="admin-badges">
            <span className={`admin-badge ${dirty ? "warn" : ""}`}>
              {dirty
                ? t("unsaved")
                : t("saved", { revision: policy?.revision || 0 })}
            </span>
            <span
              className={`admin-badge ${application?.livePolicyObserved ? "good" : "warn"}`}
            >
              {application?.livePolicyObserved
                ? t("observed")
                : t("unobserved")}
            </span>
            <span
              className={`admin-badge ${application?.restartRequired ? "warn" : "good"}`}
            >
              {application?.restartRequired ? t("restart") : t("ready")}
            </span>
          </div>
          <div className="admin-actions">
            <button disabled={busy} onClick={() => void action(load)}>
              <RefreshCw size={16} aria-hidden="true" />
              {dirty ? t("discardReload") : t("reload")}
            </button>
            {!readOnly && (
              <>
                <button
                  className="primary"
                  disabled={busy || !dirty}
                  onClick={() =>
                    void action(async () => {
                      const result = await api<{
                        policy: Policy;
                        application: Application;
                      }>("policy", "PUT", policy);
                      setPolicy(result.policy);
                      setSaved(JSON.stringify(result.policy));
                      setApplication(result.application);
                    })
                  }
                >
                  {t("save")}
                </button>
                <button
                  disabled={busy || dirty || !policy}
                  onClick={() =>
                    void action(async () =>
                      setApplication(
                        await api<Application>("apply", "POST", {
                          revision: policy?.revision,
                        }),
                      ),
                    )
                  }
                >
                  {busy ? t("busy") : t("apply")}
                </button>
              </>
            )}
          </div>
        </div>
        <p className="admin-hint">
          {readOnly ? t("readOnly") : t("savedHint")}
        </p>
        {error && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="admin-notice" role="status">
            {notice}
          </div>
        )}
        {section === "overview" && (
          <>
            <div className="admin-metrics">
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
                <article className="admin-card" key={label}>
                  <span>{t(label)}</span>
                  <strong>{value}</strong>
                </article>
              ))}
            </div>
            <article className="admin-card">
              <h2>{t("initialRoom")}</h2>
              <code>{overview?.initialRoomId}</code>
            </article>
            <article className="admin-card">
              <h2>{t("application")}</h2>
              {!application?.application ? (
                <p>{t("noApplication")}</p>
              ) : (
                <>
                  <p>
                    {t("revision")}: {application.application.revision} ·{" "}
                    {t("applicationStatus")}: {application.application.status}
                  </p>
                  {application.application.configuration?.error && (
                    <p className="admin-error">
                      {application.application.configuration.error}
                    </p>
                  )}
                  {application.application.rooms.map((room) => (
                    <div className="admin-application-row" key={room.roomId}>
                      <code>{room.roomId}</code>
                      <strong>{room.status}</strong>
                      {room.error && (
                        <span className="admin-error">{room.error}</span>
                      )}
                      {room.bans.map((ban) => (
                        <span key={ban.id}>
                          {t("ban")}: {ban.id} · {ban.status} {ban.error}
                        </span>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </article>
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
          <>
            <article className="admin-card">
              <h2>{t("backend")}</h2>
              <strong>{overview.storage.backend}</strong>
              {overview.storage.bucket && (
                <p>
                  {t("bucket")}: {overview.storage.bucket} · {t("prefix")}:{" "}
                  {overview.storage.prefix}
                </p>
              )}
              <p>{t("storageHint")}</p>
            </article>
            <article className="admin-card">
              <h2>{t("localFiles")}</h2>
              {overview.storage.files.map((file) => (
                <div className="admin-record-detail" key={file.filename}>
                  <code>{file.filename}</code>
                  <span>
                    {new Intl.NumberFormat(locale).format(file.bytes)} B
                  </span>
                </div>
              ))}
            </article>
            <article className="admin-card">
              <h2>{t("backup")}</h2>
              <p>{t("backupHint")}</p>
              <button onClick={exportPolicy}>{t("exportPolicy")}</button>
            </article>
          </>
        )}
        {section === "deployment" && policy && (
          <article className="admin-card">
            <p>{t("deploymentHint")}</p>
            <Field label={t("server")}>
              <input readOnly value={policy.serverName} />
            </Field>
            <Field label={t("publicUrl")}>
              <input readOnly value={overview?.publicUrl || ""} />
            </Field>
            <Field label={t("registration")}>
              <select
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
              </select>
            </Field>
            <Field label={t("upload")}>
              <input
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
          </article>
        )}
        {section === "administrators" && (
          <>
            <p>{t("adminHint")}</p>
            <div className="admin-records">
              {administrators.map((admin) => (
                <article className="admin-card" key={admin.username}>
                  <strong>{admin.username}</strong>
                  <p>
                    {admin.role} · {admin.enabled ? t("enabled") : t("closed")}
                  </p>
                  {session.administrator.role === "owner" && (
                    <button onClick={() => setAdminEdit(admin)}>
                      {t("edit")}
                    </button>
                  )}
                </article>
              ))}
            </div>
            {session.administrator.role === "owner" && (
              <form
                className="admin-card"
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
                <Field label={t("username")}>
                  <input
                    name="username"
                    required
                    pattern="[a-z][a-z0-9_.-]{2,63}"
                    defaultValue={adminEdit?.username || ""}
                  />
                </Field>
                <Field label={t("role")}>
                  <select
                    name="role"
                    defaultValue={adminEdit?.role || "operator"}
                  >
                    <option value="owner">owner</option>
                    <option value="operator">operator</option>
                    <option value="auditor">auditor</option>
                  </select>
                </Field>
                <Field label={t("newPassword")}>
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                    required={!adminEdit}
                  />
                </Field>
                <label className="admin-checkbox">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={adminEdit?.enabled ?? true}
                  />
                  {t("enabled")}
                </label>
                <div className="admin-actions">
                  <button className="primary" disabled={busy}>
                    {t("updateAdmin")}
                  </button>
                  <button type="button" onClick={() => setAdminEdit(null)}>
                    {t("reset")}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        {section === "audit" && (
          <>
            <div className="admin-audit">
              {events.map((event) => (
                <article className="admin-card" key={event.sequence}>
                  <div className="admin-record-title">
                    <strong>{event.action}</strong>
                    <time>{date(event.at)}</time>
                  </div>
                  <p>
                    {t("actor")}: {event.actor} · #{event.sequence}
                  </p>
                  <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                </article>
              ))}
            </div>
            <button
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
            </button>
          </>
        )}
      </main>
    </div>
  );
}
