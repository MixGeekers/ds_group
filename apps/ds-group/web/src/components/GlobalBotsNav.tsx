import { Button } from "../../../ui/controls";
import { useTranslation } from "../locale";
import { shellMessages } from "../locales/shell";
import type { Participant, Room } from "../types";
import { Icon } from "./Icons";

function directRoom(rooms: Room[], botId: string) {
  return rooms.find(
    (room) => room.kind === "direct" && room.participantIds.includes(botId),
  );
}

export function GlobalBotsNav({
  bots,
  rooms,
  active,
  onOpen,
}: {
  bots: Participant[];
  rooms: Room[];
  active: boolean;
  onOpen(): void;
}) {
  const t = useTranslation(shellMessages);
  const unread = bots.reduce(
    (sum, bot) => sum + (directRoom(rooms, bot.id)?.mentionCount ?? 0),
    0,
  );
  return (
    <div className="rail-bots">
      <button
        id="global-bots-button"
        className={`server-icon rail-bots-trigger${active ? " active" : ""}`}
        type="button"
        aria-label={`${t("myBots")} · ${bots.length}`}
        aria-current={active ? "page" : undefined}
        title={t("myBots")}
        onClick={onOpen}
      >
        <Icon name="bot" />
        <span id="owned-bot-count" className="rail-bots-count" aria-hidden="true">{bots.length}</span>
        {unread > 0 && (
          <span className="server-invite-count" title={t("mentions", { count: unread })}>
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </div>
  );
}

export function GlobalBotsSidebar({
  bots,
  rooms,
  selectedRoom,
  openingBotId,
  onDirect,
  onManage,
  onCreate,
}: {
  bots: Participant[];
  rooms: Room[];
  selectedRoom: Room | null;
  openingBotId: string | null;
  onDirect(id: string): Promise<void> | void;
  onManage(): void;
  onCreate(): void;
}) {
  const t = useTranslation(shellMessages);
  return (
    <div className="global-bots-sidebar">
      <nav id="owned-bots" className="global-bots-list" aria-label={t("myBots")}>
        {bots.length ? bots.map((bot, index) => {
          const direct = directRoom(rooms, bot.id);
          const selected = selectedRoom?.kind === "direct" &&
            selectedRoom.participantIds.includes(bot.id);
          return (
            <Button
              key={bot.id}
              variant="ghost"
              className={`global-bot-row${selected ? " selected" : ""}`}
              type="button"
              data-owned-bot-id={bot.id}
              title={bot.id}
              aria-current={selected ? "page" : undefined}
              aria-busy={openingBotId === bot.id}
              disabled={openingBotId === bot.id}
              onClick={() => onDirect(bot.id)}
            >
              <span className={`avatar avatar-bot${index % 2 ? " avatar-alternate" : ""}`} aria-hidden="true">
                {bot.name.slice(0, 1)}
              </span>
              <span className="global-bot-identity">
                <strong>{bot.name}</strong>
                <small>{bot.id}</small>
              </span>
              {openingBotId === bot.id && (
                <span className="global-bot-opening">{t("opening")}</span>
              )}
              {!!direct?.mentionCount && (
                <span className="unread-badge">
                  {direct.mentionCount > 99 ? "99+" : direct.mentionCount}
                </span>
              )}
            </Button>
          );
        }) : <p className="sidebar-empty">{t("noBots")}</p>}
      </nav>
      <div className="global-bots-actions">
        <Button id="manage-bots-button" variant="ghost" type="button" onClick={onManage}>
          <Icon name="gear" /> {t("manageBots")}
        </Button>
        <Button id="create-bot-button" variant="secondary" type="button" onClick={onCreate}>
          <Icon name="plus" /> {t("createBot")}
        </Button>
      </div>
    </div>
  );
}
