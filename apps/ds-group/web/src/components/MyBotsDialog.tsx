import { Button } from "../../../ui/controls";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../locale";
import { spaceMessages } from "../locales/spaces";
import { Icon } from "./Icons";
import { BotWorkGrants } from "./BotWorkGrants";
import { botMessages } from "../locales/bots";
import { workGrantMessages } from "../locales/work-grants";
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
  onClose(): void;
  onCreate(): void;
  onDirect(id: string): void;
}) {
  const t = useTranslation(spaceMessages);
  const grantText = useTranslation(workGrantMessages);
  const modelText = useTranslation(botMessages);
  const identity = sessionIdentity(session);
  const [selected, setSelected] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) dialog.current?.close();
    if (!open) setSelected(null);
  }, [open]);
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
        <h2 id="my-bots-title">{t("myBots")}</h2>
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
      <div className="dialog-scroll-region">
      {detail ? (
        <BotWorkGrants
          key={detail.id}
          bot={detail}
          session={session}
          api={api}
          rooms={rooms}
          participants={participants}
          onBack={() => setSelected(null)}
        />
      ) : (
        <>
          <p className="muted">{t("botHelp")}</p>
          <div className="space-list">
            {owned.map((bot) => {
              const node = status?.nodes.find(
                (value) => value.botId === bot.id,
              );
              const state = node?.status ?? "offline";
              const label = ["online", "idle", "ready", "connected"].includes(
                state,
              )
                ? "online"
                : [
                      "running",
                      "thinking",
                      "busy",
                      "processing",
                      "starting",
                    ].includes(state)
                  ? "busy"
                  : ["failed", "error", "unavailable"].includes(state)
                    ? "unavailable"
                    : "botOffline";
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
                    <span className="space-state">{t(label)}</span>
                    <Button
                      variant="secondary"
                      className="secondary-button"
                      type="button"
                      data-work-grants-button={bot.id}
                      onClick={() => setSelected(bot.id)}
                    >
                      {grantText("title")}
                    </Button>
                    <Button
                      variant="secondary"
                      className="secondary-button"
                      type="button"
                      onClick={() => onDirect(bot.id)}
                    >
                      {t("message")}
                    </Button>
                  </header>
                  {node?.model && <p className="muted">{modelText("runtimeModel")} · {node.model}</p>}
                  <details className="bot-model-settings">
                    <summary>{modelText("modelSettings")}</summary>
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
