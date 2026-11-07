import { Button } from "../../../ui/controls";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../locale";
import { spaceMessages } from "../locales/spaces";
import { Icon } from "./Icons";
import { BotSettings } from "./BotSettings";
import { botMessages } from "../locales/bots";
import { kernelMessages } from "../locales/kernel";
import { connectionLabel } from "../bot-kernel";
import { sessionIdentity } from "../session";
import type { Api, Participant, Room, ServerStatus, Session } from "../types";

export function MyBotsDialog({
  open,
  bots,
  status,
  session,
  api,
  rooms,
  participants,
  initialBotId,
  onClose,
  onCreate,
  onDirect,
}: {
  open: boolean;
  bots: Participant[];
  status: ServerStatus | null;
  session: Session | null;
  api: Api;
  rooms: Room[];
  participants: Participant[];
  initialBotId?: string | null;
  onClose(): void;
  onCreate(): void;
  onDirect(id: string): void;
}) {
  const t = useTranslation(spaceMessages);
  const kernelText = useTranslation(kernelMessages);
  const modelText = useTranslation(botMessages);
  const identity = sessionIdentity(session);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<"overview" | "workPermissions">("overview");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) dialog.current?.close();
    if (!open) setSelected(null);
    else { setSelected(initialBotId ?? null); setSelectedTab("overview"); }
  }, [open, initialBotId]);
  useEffect(() => setSelected(null), [identity]);
  const owned = bots.filter((bot) => bot.ownerId === session?.user_id);
  const detail = owned.find((bot) => bot.id === selected);
  return (
    <dialog
      id="my-bots-dialog"
      className="settings-dialog"
      ref={dialog}
      aria-labelledby="my-bots-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id="my-bots-title">{detail ? kernelText("settings") : t("myBots")}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="icon-button"
          type="button"
          aria-label={t("close")}
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className={detail ? "bot-settings-region" : "dialog-scroll-region"}>
      {detail ? (
        <BotSettings
          key={detail.id}
          bot={detail}
          session={session}
          api={api}
          rooms={rooms}
          participants={participants}
          status={status}
          initialTab={selectedTab}
          onBack={() => setSelected(null)}
          onDirect={onDirect}
        />
      ) : (
        <>
          <p className="muted">{t("botHelp")}</p>
          <div className="space-list">
            {owned.map((bot) => {
              const node = status?.nodes.find(
                (value) => value.botId === bot.id,
              );
              const label = connectionLabel(node?.status);
              return (
                <article
                  className="space-card"
                  data-owned-bot={bot.id}
                  key={bot.id}
                >
                  <header>
                    <span className="avatar avatar-bot">
                      {bot.name.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{bot.name}</strong>
                      <small className="member-full-id">{bot.id}</small>
                    </div>
                    <span className="space-state">{kernelText(label)}</span>
                    <Button
                      variant="secondary"
                      className="secondary-button"
                      type="button"
                      data-bot-settings-button={bot.id}
                      onClick={() => { setSelectedTab("overview"); setSelected(bot.id); }}
                    >
                      <Icon name="gear" />{kernelText("settings")}
                    </Button>
                    {!bot.nativeBinding && <Button variant="ghost" className="text-button" type="button" data-work-grants-button={bot.id} onClick={() => { setSelectedTab("workPermissions"); setSelected(bot.id); }}>{kernelText("workPermissions")}</Button>}
                    <Button
                      variant="secondary"
                      className="secondary-button"
                      type="button"
                      onClick={() => onDirect(bot.id)}
                    >
                      {t("message")}
                    </Button>
                  </header>
                  <details className="bot-model-settings">
                    <summary>{modelText("modelSettings")}</summary>
                    {node?.model && <p className="muted">{modelText("runtimeModel")} · {node.model}</p>}
                    <p className="muted">{modelText("modelHelp")}</p>
                  </details>
                  {node?.lastError && (
                    <p className="node-error">{node.lastError}</p>
                  )}
                </article>
              );
            })}
          </div>
          {!owned.length && <p className="muted">{t("noBots")}</p>}
        </>
      )}
      </div>
      {!detail && (
        <footer className="dialog-footer">
          <Button
            variant="default"
            id="manage-create-bot"
            className="primary-button"
            type="button"
            disabled={!session}
            onClick={onCreate}
          >
            {t("createBot")}
          </Button>
        </footer>
      )}
    </dialog>
  );
}
