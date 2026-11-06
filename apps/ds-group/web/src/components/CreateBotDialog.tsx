import { Button } from "../../../ui/controls";
import { useEffect, useRef, useState } from "react";
import { messageOf } from "../api";
import { useTranslation } from "../locale";
import { botMessages } from "../locales/bots";
import { sessionIdentity } from "../session";
import type { Api, Participant, ServerStatus, Session } from "../types";
import { Icon } from "./Icons";

type LocalBot = { id: string; hostId: string; hostName: string; name: string; role: string;
  model: string; main: boolean; available: boolean; botId: string | null };
export interface CreateBotDialogProps {
  open: boolean; api: Api; session: Session | null; status?: ServerStatus | null;
  pendingStorageKey?: string; onCreated(bot: Participant): void | Promise<void>; onClose(): void;
}

export function CreateBotDialog({ open, api, session, onCreated, onClose }: CreateBotDialogProps) {
  const t = useTranslation(botMessages);
  const dialog = useRef<HTMLDialogElement>(null);
  const [bots, setBots] = useState<LocalBot[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const identity = sessionIdentity(session);
  const current = useRef(identity); current.current = identity;
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open || !session) return;
    let cancelled = false;
    setError(""); setSelected(""); setBots([]);
    void api<{ bots: LocalBot[] }>("/api/bot-catalog").then(result => {
      if (!cancelled) setBots(result.bots);
    }).catch(cause => { if (!cancelled) setError(messageOf(cause)); });
    return () => { cancelled = true; };
  }, [open, identity, revision, api]);
  const choice = bots.find(bot => `${bot.hostId}/${bot.id}` === selected);
  async function attach() {
    if (!choice || busy || !session) return;
    const owner = identity;
    setBusy(true); setError("");
    try {
      const result = await api<{ bot: Participant }>("/api/bots/attach", {
        method: "POST", body: { hostId: choice.hostId, nativeBotId: choice.id },
      });
      if (current.current !== owner) return;
      if (!result.bot?.id) throw new Error(t("receiptMissing"));
      await onCreated(result.bot); onClose();
    } catch (cause) { if (current.current === owner) setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  return <dialog id="create-bot-dialog" className="settings-dialog" ref={dialog}
    aria-labelledby="create-bot-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="dialog-heading"><h2 id="create-bot-title">{t("createBot")}</h2>
      <Button id="close-create-bot" variant="ghost" size="icon" aria-label={t("close")} disabled={busy} onClick={onClose}><Icon name="close" /></Button>
    </header>
    <div className="dialog-scroll-region">
      <p className="muted">{t("nativeHelp")}</p>
      {error && <p role="alert" className="node-error">{error}</p>}
      {!bots.length && <p className="muted">{t("nativeEmpty")}</p>}
      <div className="space-list" role="radiogroup" aria-label={t("nativeBots")}>
        {bots.map(bot => <label className="space-card" key={`${bot.hostId}/${bot.id}`}>
          <input type="radio" name="native-bot" value={`${bot.hostId}/${bot.id}`} checked={selected === `${bot.hostId}/${bot.id}`}
            disabled={busy || !bot.available || !!bot.botId} onChange={event => setSelected(event.target.value)} />
          <strong> {bot.name}</strong>{bot.main && <span> · Main Bot</span>}
          <p className="muted">{bot.role} · {bot.hostName}</p>
          <small>{bot.model}</small>
          <p className="muted">{t(bot.botId ? "nativeAdded" : bot.available ? "nativeReady" : "nativeOffline")}</p>
        </label>)}
      </div>
      <p className="muted">{t("nativeLifecycle")}</p>
    </div>
    <footer className="dialog-footer">
      <Button variant="secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>{t("refresh")}</Button>
      <Button id="create-bot-submit" disabled={busy || !choice || !choice.available || !!choice.botId} onClick={() => void attach()}>{t(busy ? "creating" : "createBot")}</Button>
    </footer>
  </dialog>;
}
