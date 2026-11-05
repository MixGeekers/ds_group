import { useEffect, useRef } from "react";
import { useTranslation } from "../locale";
import { spaceMessages } from "../locales/spaces";
import { Icon } from "./Icons";
import type { Participant, ServerStatus, Session } from "../types";

export function MyBotsDialog({
  open,
  bots,
  status,
  session,
  onClose,
  onCreate,
  onDirect,
}: {
  open: boolean;
  bots: Participant[];
  status: ServerStatus | null;
  session: Session | null;
  onClose(): void;
  onCreate(): void;
  onDirect(id: string): void;
}) {
  const t = useTranslation(spaceMessages);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) dialog.current?.close();
  }, [open]);
  const owned = bots.filter((bot) => bot.ownerId === session?.user_id);
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
        <button
          className="icon-button"
          type="button"
          aria-label={t("close")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <p className="muted">{t("botHelp")}</p>
      <div className="space-list">
        {owned.map((bot) => {
          const node = status?.nodes.find((value) => value.botId === bot.id);
          const state = node?.status ?? "offline";
          const label = ["online", "idle", "ready", "connected"].includes(state)
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
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onDirect(bot.id)}
                >
                  {t("message")}
                </button>
              </header>
              {node?.lastError && (
                <p className="node-error">{node.lastError}</p>
              )}
            </article>
          );
        })}
      </div>
      {!owned.length && <p className="muted">{t("noBots")}</p>}
      <button
        id="manage-create-bot"
        className="primary-button"
        type="button"
        disabled={!session}
        onClick={onCreate}
      >
        {t("createBot")}
      </button>
    </dialog>
  );
}
