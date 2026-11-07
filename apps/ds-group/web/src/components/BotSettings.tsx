import { Button, Radio, RadioGroup } from "../../../ui/controls";
import { useEffect, useRef, useState } from "react";
import { ApiError, messageOf } from "../api";
import { formatDateTime, formatNumber } from "../../i18n.js";
import { useTranslation } from "../locale";
import { kernelMessages } from "../locales/kernel";
import { sessionIdentity } from "../session";
import { connectionLabel, kernelActivity } from "../bot-kernel";
import type { AttentionReceipt, BotKernelView, ParticipationMode } from "../bot-kernel";
import type { Api, Participant, Room, ServerStatus, Session } from "../types";
import { BotMemory } from "./BotMemory";
import { BotWorkGrants } from "./BotWorkGrants";
import { Icon } from "./Icons";

type BotTab = "overview" | "participation" | "memory" | "workPermissions";
const modes: ParticipationMode[] = ["mention", "shadow", "natural"];

export function BotSettings({ bot, session, api, status, rooms, participants, initialTab = "overview", onBack, onDirect }: {
  bot: Participant; session: Session | null; api: Api; status: ServerStatus | null; rooms: Room[]; participants: Participant[];
  initialTab?: BotTab;
  onBack(): void; onDirect(id: string): void;
}) {
  const t = useTranslation(kernelMessages);
  const [tab, setTab] = useState<BotTab>(initialTab);
  const [view, setView] = useState<BotKernelView | null>(null);
  const [mode, setMode] = useState<ParticipationMode | "">("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ key: "unsupported" | "failed"; message: string } | null>(null);
  const [feedback, setFeedback] = useState<"saved" | "pending" | "saveUncertain" | "">("");
  const [locked, setLocked] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const context = `${sessionIdentity(session)}/${bot.id}`;
  const current = useRef(context); current.current = context;
  const route = `/api/bots/${encodeURIComponent(bot.id)}`;
  const owned = bot.ownerId === session?.user_id;

  useEffect(() => {
    if (!owned) { setLoading(false); return; }
    const abort = new AbortController();
    setLoading(true); setError(null); setFeedback("");
    void api<BotKernelView>(`${route}/kernel`, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted || current.current !== context) return;
      if (!result || typeof result !== "object" || !("runtime" in result)) throw new Error("Invalid Bot kernel receipt");
      setView(result); setUpdatedAt(Date.now()); setLocked(false);
      const selected = result.desiredAttention?.mode ?? result.attention?.mode;
      setMode(selected && modes.includes(selected) ? selected : "");
    }).catch(cause => {
      if (abort.signal.aborted || current.current !== context) return;
      setError({ key: cause instanceof ApiError && cause.status === 404 ? "unsupported" : "failed", message: messageOf(cause) });
      setView(null); setLocked(true);
    }).finally(() => { if (!abort.signal.aborted && current.current === context) setLoading(false); });
    return () => abort.abort();
  }, [api, route, context, owned, revision]);

  useEffect(() => {
    if (tab !== "overview" || !owned) return;
    const timer = setInterval(() => setRevision(value => value + 1), 15000);
    return () => clearInterval(timer);
  }, [tab, owned]);

  async function save() {
    if (!owned || !view || !mode || saving || loading || locked) return;
    const operation = context;
    setSaving(true); setFeedback("");
    try {
      const result = await api<AttentionReceipt>(`${route}/attention`, { method: "PATCH", body: { mode } });
      if (current.current !== operation) return;
      if (result.mode !== mode || !["pending", "applied"].includes(result.status)) throw new Error("Invalid participation receipt");
      setView(previous => previous && { ...previous, desiredAttention: result,
        attention: result.applied && previous.attention ? { ...previous.attention, mode: result.mode } : previous.attention });
      setUpdatedAt(Date.now()); setFeedback(result.status === "pending" ? "pending" : "saved");
    } catch {
      if (current.current === operation) { setFeedback("saveUncertain"); setLocked(true); }
    } finally { if (current.current === operation) setSaving(false); }
  }
  const owner = participants.find(person => person.id === bot.ownerId);
  const node = status?.nodes.find(node => node.botId === bot.id);
  const activity = kernelActivity(view);
  const provider = view?.attention?.provider;
  const health = provider?.available === true || provider?.health === "ok" ? "available"
    : provider?.available === false || provider?.health === "error" ? "unavailable" : "healthUnknown";
  const number = (value: number | null | undefined) => typeof value === "number" ? formatNumber(value) : t("unknown");
  if (!owned) return <p>{t("denied")}</p>;
  return <section className="bot-settings" data-bot-settings={bot.id}>
    <div className="bot-settings-toolbar">
      <Button variant="ghost" className="text-button" type="button" disabled={saving} onClick={onBack}><Icon name="back" />{t("back")}</Button>
      <Button variant="ghost" size="sm" type="button" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}><Icon name="refresh" />{t("refresh")}</Button>
    </div>
    <div className="bot-settings-identity"><span className="avatar avatar-bot" aria-hidden="true">{bot.name.slice(0, 1)}</span><div><h3>{bot.name}</h3><small className="member-full-id">{bot.id}</small></div></div>
    <nav className="settings-tabs bot-settings-tabs" aria-label={t("settings")}>
      {(["overview", "participation", "memory", ...(!bot.nativeBinding ? ["workPermissions"] as const : [])] as BotTab[]).map(value =>
        <Button key={value} variant="ghost" type="button" aria-current={tab === value ? "page" : undefined} disabled={saving} onClick={() => setTab(value)}>{t(value)}</Button>)}
    </nav>
    <div className="dialog-scroll-region bot-settings-content">
    {loading && <p role="status">{t("loading")}</p>}
    {error && <p className="bot-settings-error" role="alert">{t(error.key, { error: error.message })}</p>}
    {!loading && view?.runtime?.available === false && <p role="status">{t("unavailableHelp")}</p>}
    {tab === "overview" && <div data-bot-panel="overview">
      <div className="bot-activity-card" data-activity={activity}><Icon name={activity === "working" ? "work" : activity === "speaking" ? "message" : activity === "waiting" ? "clock" : "listen"} /><div>
        <strong>{t(activity)}</strong><p>{t(`${activity}Help`)}</p>
      </div></div>
      <dl className="bot-overview-grid">
        <div><dt>{t("owner")}</dt><dd>{owner?.name ?? bot.ownerId ?? t("unknown")}<small className="member-full-id">{owner?.name && bot.ownerId}</small></dd></div>
        <div><dt>{t("connection")}</dt><dd>{t(view?.online === true ? "online" : view?.online === false ? "offline" : connectionLabel(node?.status))}</dd></div>
        <div><dt>{t("tasks")}</dt><dd>{number(view?.work?.activeTasks)}</dd></div>
        <div><dt>{t("queue")}</dt><dd>{number(view?.attention?.queue?.pending)}</dd></div>
      </dl>
      <div className="bot-memory-summary"><h3>{t("memory")}</h3>{view?.memorySummary ? <dl>
        <div><dt>{t("people")}</dt><dd>{number(view.memorySummary.people)}</dd></div><div><dt>{t("projects")}</dt><dd>{number(view.memorySummary.projects)}</dd></div><div><dt>{t("pendingReview")}</dt><dd>{number(view.memorySummary.pendingReview)}</dd></div>
      </dl> : <p>{t("noSummary")}</p>}<Button variant="ghost" type="button" onClick={() => setTab("memory")}><Icon name="memory" />{t("memory")}</Button></div>
      {!!view?.runtime?.id && <details className="bot-runtime-details"><summary>{t("details")}</summary><p>{t("engine")} · {t("node")}</p><small>{view.runtime.id}{view.runtime.version ? ` · ${view.runtime.version}` : ""}</small></details>}
      {updatedAt && <p className="muted small">{t("updated", { time: formatDateTime(updatedAt) })}</p>}
    </div>}
    {tab === "participation" && <div data-bot-panel="participation">
      <h3>{t("mode")}</h3>
      <p>{t("currentMode")} · {t(view?.online !== false && view?.attention?.mode && modes.includes(view.attention.mode) ? view.attention.mode : "unknown")}</p>
      {view?.desiredAttention?.status === "pending" && <p role="status">{t("pending")}</p>}
      <RadioGroup className="bot-participation-modes" value={mode} onValueChange={value => { if (modes.includes(value as ParticipationMode)) { setMode(value as ParticipationMode); setFeedback(""); } }} aria-label={t("mode")} disabled={loading || saving || !view || locked}>
        {modes.map(value => <label className="bot-mode-option" data-selected={mode === value} key={value}>
          <Radio value={value} disabled={loading || saving || !view || locked} /><span><strong>{t(value)}</strong><small>{t(`${value}Help`)}</small></span>
        </label>)}
      </RadioGroup>
      <p>{t("naturalNote")}</p>
      <div className="bot-decision-status"><h3>{t("decisionModel")}</h3><p><span className="bot-state-pill">{typeof provider?.configured === "boolean" ? t(provider.configured ? "configured" : "notConfigured") : t("unknown")}</span>{provider?.configured && <span className="bot-state-pill">{t(health)}</span>}</p>
        {provider?.model && <small className="member-full-id">{provider.model}</small>}<p>{t("decisionPrivate")}</p>
        {mode === "natural" && (provider?.configured === false || health === "unavailable") && <p>{t("decisionRequired")}</p>}
      </div>
      <div className="settings-actions"><Button id="save-bot-participation" type="button" disabled={loading || saving || locked || !view || !mode || mode === (view.desiredAttention?.mode ?? view.attention?.mode)} onClick={() => void save()}>{t(saving ? "saving" : "save")}</Button></div>
      <p role="status" className="settings-feedback">{feedback && t(feedback)}</p>
    </div>}
    {tab === "memory" && <BotMemory bot={bot} api={api} rooms={rooms} participants={participants} />}
    {tab === "workPermissions" && <BotWorkGrants bot={bot} api={api} session={session} rooms={rooms} participants={participants} onBack={onBack} />}
    </div>
    <footer className="dialog-footer bot-settings-footer"><Button className="bot-settings-message" variant="secondary" type="button" disabled={saving} onClick={() => onDirect(bot.id)}><Icon name="message" />{t("message", { name: bot.name })}</Button></footer>
  </section>;
}
