import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  Bootstrap,
  Mentionables,
  Participant,
  Room,
  ServerStatus,
  Session,
  SettingsTab,
} from "../types";
import { useTranslation } from "../locale";
import { shellMessages } from "../locales/shell";
import { Icon } from "./Icons";
import { AccountMenu } from "./AccountMenu";
import { GlobalBotsNav, GlobalBotsSidebar } from "./GlobalBotsNav";
import type { CollaborationSpace } from "../spaces";

export interface ShellProps {
  bootstrap: Bootstrap | null;
  session: Session | null;
  rooms: Room[];
  allRooms?: Room[];
  room: Room | null;
  spaces?: CollaborationSpace[];
  selectedSpace?: CollaborationSpace | null;
  currentUser?: Participant | null;
  connection?: "connecting" | "connected" | "offline";
  canCreateRoom?: boolean;
  canInvite?: boolean;
  ownedBots: Participant[];
  mentionables: Mentionables;
  status: ServerStatus | null;
  view: "home" | "chat" | "bots";
  children: ReactNode;
  mentionCount: number;
  showTaskHistory: boolean;
  onRoom(room: Room): void;
  onDirect(id: string): void;
  onHome(): void;
  onBots(): void;
  onServer(serverName: string): void;
  onSpaces?(): void;
  onManageBots?(): void;
  onSettings(tab?: SettingsTab): void;
  onLogin(): void;
  onCreateRoom(): void;
  onCreateBot(): void;
  onInvite(): void;
  onInbox(): void;
  onNotifications(): void;
  onToggleTasks(): void;
  onMember(id: string): void;
}

export function Avatar({
  member,
  index = 0,
  id,
}: {
  member?: Participant;
  index?: number;
  id?: string;
}) {
  return (
    <span
      id={id}
      className={`avatar avatar-${member?.kind ?? "human"}${index % 2 ? " avatar-alternate" : ""}`}
      aria-hidden="true"
    >
      {(member?.name || "?").slice(0, 1)}
    </span>
  );
}

function presenceClass(status?: string) {
  if (["online", "idle", "ready", "connected"].includes(status ?? ""))
    return "online";
  if (
    ["running", "thinking", "busy", "processing", "starting"].includes(
      status ?? "",
    )
  )
    return "busy";
  if (["error", "failed", "unavailable"].includes(status ?? "")) return "error";
  return "";
}

export function Shell(props: ShellProps) {
  const t = useTranslation(shellMessages);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [desktop, setDesktop] = useState(() => window.innerWidth > 1180);
  const [membersOpen, setMembersOpen] = useState(
    () => window.innerWidth > 1180,
  );
  const participants = props.bootstrap?.participants ?? [];
  const currentUser =
    props.currentUser ??
    participants.find((member) => member.id === props.session?.user_id) ??
    (props.session
      ? {
          id: props.session.user_id,
          name: props.session.user_id,
          kind: "human" as const,
        }
      : undefined);
  const ownedBots = props.ownedBots.filter(
    (bot) => bot.ownerId === props.session?.user_id,
  );
  const ownIds = new Set(ownedBots.map((bot) => bot.id));
  const selectedBot = ownedBots.find(
    (bot) => props.view === "chat" && props.room?.kind === "direct" &&
      props.room.participantIds.includes(bot.id),
  );
  const botContext = props.view === "bots" || !!selectedBot;
  const contacts = participants.filter(
    (member) => member.id !== props.session?.user_id && !ownIds.has(member.id),
  );
  const initialRoom = props.rooms.find(
    (room) => room.roomId === props.bootstrap?.roomId,
  );
  const otherRooms = props.rooms.filter(
    (room) => room.kind === "group" && room.roomId !== props.bootstrap?.roomId,
  );
  const roomMembers = props.view === "chat" ? participants.filter((member) =>
    props.room?.participantIds.includes(member.id),
  ) : [];

  useEffect(() => {
    const breakpoint = window.matchMedia("(min-width: 1181px)");
    const resize = (event: MediaQueryListEvent) => {
      setDesktop(event.matches);
      setMembersOpen(event.matches);
      setChannelsOpen(false);
    };
    breakpoint.addEventListener("change", resize);
    return () => breakpoint.removeEventListener("change", resize);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("channels-open", channelsOpen);
    document.body.classList.toggle("members-hidden", desktop && !membersOpen);
    return () => {
      document.body.classList.remove("channels-open", "members-hidden");
    };
  }, [channelsOpen, desktop, membersOpen]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector(
          'dialog[open], [popover]:popover-open, [data-slot="dialog-content"][data-open], [data-slot="popover-content"][data-open]',
        )
      )
        return;
      if (channelsOpen || (!desktop && membersOpen)) {
        setChannelsOpen(false);
        if (!desktop) setMembersOpen(false);
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [channelsOpen, desktop, membersOpen]);

  function closePanels() {
    setChannelsOpen(false);
    if (!desktop) setMembersOpen(false);
  }

  function selectRoom(room: Room) {
    closePanels();
    props.onRoom(room);
  }
  function openDirect(id: string) {
    closePanels();
    props.onDirect(id);
  }

  function unreadBadge(room?: Room, id?: string) {
    const count = room?.mentionCount ?? 0;
    return (
      <span
        id={id}
        className="unread-badge"
        hidden={!count}
        title={t("mentions", { count })}
      >
        {count > 99 ? "99+" : count}
      </span>
    );
  }

  function memberContents(member: Participant, index: number) {
    const status =
      props.mentionables.members.find((item) => item.id === member.id)
        ?.status ??
      (member.kind === "bot"
        ? props.status?.nodes.find((node) => node.botId === member.id)?.status
        : member.id === props.session?.user_id
          ? "online"
          : "offline");
    const color = presenceClass(status);
    const label =
      color === "online"
        ? t("online")
        : color === "busy"
          ? t("busy")
          : color === "error"
            ? t("error")
            : t("offline");
    return (
      <>
        <Avatar member={member} index={index} />
        <span className="member-info">
          <strong>{member.name}</strong>
          {participants.some(
            (other) => other.id !== member.id && other.name === member.name,
          ) && <small className="member-full-id">{member.id}</small>}
        </span>
        {member.kind === "bot" && <span className="member-kind">BOT</span>}
        <span className={`status-dot member-presence ${color}`} title={label} />
      </>
    );
  }

  function contact(member: Participant, index: number) {
    const directRoom = (props.allRooms ?? props.rooms).find(
      (room) =>
        room.kind === "direct" && room.participantIds.includes(member.id),
    );
    const selected =
      props.view === "chat" &&
      props.room?.kind === "direct" &&
      props.room.participantIds.includes(member.id);
    return (
      <button
        key={member.id}
        className={`member-row contact-row${selected ? " selected" : ""}`}
        type="button"
        aria-label={t("messageMember", { name: member.name })}
        title={member.id}
        onClick={() => openDirect(member.id)}
      >
        {memberContents(member, index)}
        {unreadBadge(directRoom)}
      </button>
    );
  }

  function roomButton(room: Room, initial = false) {
    const selected =
      props.view === "chat" && room.roomId === props.room?.roomId;
    return (
      <button
        key={room.roomId}
        id={initial ? "group-room-button" : undefined}
        className={`room-item${selected ? " selected" : ""}${room.unreadCount ? " has-unread" : ""}`}
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={() => selectRoom(room)}
      >
        <span className="room-symbol" aria-hidden="true">
          <Icon name="hash" />
        </span>
        <strong id={initial ? "sidebar-room-name" : undefined}>
          {room.name}
        </strong>
        {unreadBadge(room, initial ? "initial-room-unread" : undefined)}
      </button>
    );
  }

  return (
    <>
      <div className={`app-shell${props.view === "bots" ? " bots-view" : ""}`}>
        <nav className="server-rail" aria-label={t("servers")}>
          <button
            id="home-button"
            className={`server-icon server-home${props.view === "home" ? " active" : ""}`}
            type="button"
            aria-label={t("home")}
            title={t("home")}
            onClick={() => {
              closePanels();
              props.onHome();
            }}
          >
            <span className="brand-mark" aria-hidden="true" />
          </button>
          <div className="rail-divider" />
          <GlobalBotsNav
            bots={ownedBots}
            rooms={props.allRooms ?? props.rooms}
            active={botContext}
            onOpen={() => {
              if (!botContext) props.onBots();
              if (!desktop) setChannelsOpen(true);
            }}
          />
          <div className="rail-divider rail-divider-bots" />
          <div className="server-list">
            {(props.spaces ?? []).map((space) => (
              <button
                key={space.serverName}
                id={space.home ? "server-button" : undefined}
                data-server={space.serverName}
                className={`server-icon${props.view === "chat" && !botContext && props.selectedSpace?.serverName === space.serverName ? " active" : ""}${space.status === "revoked" ? " server-revoked" : ""}`}
                type="button"
                aria-label={`${space.name} · ${space.serverName} · ${t(space.status === "revoked" ? "revoked" : space.status === "offline" ? "offline" : "accessible")}`}
                aria-current={
                  props.view === "chat" && !botContext &&
                  props.selectedSpace?.serverName === space.serverName
                    ? "page"
                    : undefined
                }
                title={`${space.name} · ${space.serverName}`}
                onClick={() => {
                  closePanels();
                  props.onServer(space.serverName);
                }}
              >
                {(space.name.includes(" ")
                  ? space.name
                      .split(/\s+/)
                      .map((word) => word[0])
                      .join("")
                  : space.name
                )
                  .slice(0, 2)
                  .toUpperCase()}
                {!!space.invitations.length && (
                  <span className="server-invite-count">
                    {space.invitations.length}
                  </span>
                )}
              </button>
            ))}
            <button
              id="server-settings-button"
              className="server-icon server-add"
              type="button"
              aria-label={t("serverConnection")}
              title={t("serverConnection")}
              onClick={props.onSpaces}
            >
              <Icon name="plus" />
            </button>
          </div>
          <AccountMenu
            key={props.session?.user_id ?? "signed-out"}
            name={currentUser?.name}
            userId={props.session?.user_id}
            onSettings={() => props.onSettings()}
            onLogin={props.onLogin}
          >
            <Avatar member={currentUser} id="current-avatar" />
          </AccountMenu>
        </nav>
        <aside
          id="channel-panel"
          className={`sidebar${channelsOpen ? " open" : ""}`}
          aria-label={t("channelsAndMessages")}
        >
          <header className="brand">
            {botContext ? (
              <span className="workspace-brand">{t("myBots")}</span>
            ) : (
            <button
              className="workspace-switcher"
              type="button"
              onClick={props.onSpaces}
              aria-label={t("servers")}
            >
              <span
                className="workspace-brand"
                title={props.selectedSpace?.serverName}
              >
                {props.selectedSpace?.name ?? "DSCord"}
              </span>
              <span className="brand-chevron" aria-hidden="true">
                <Icon name="chevronDown" />
              </span>
            </button>
            )}
            <button
              id="close-channels"
              className="icon-button mobile-close"
              type="button"
              aria-label={t("closeChannels")}
              onClick={() => setChannelsOpen(false)}
            >
              <Icon name="close" />
            </button>
          </header>
          <div className="global-bots-view" hidden={!botContext}>
            <GlobalBotsSidebar
              bots={ownedBots}
              rooms={props.allRooms ?? props.rooms}
              selectedRoom={selectedBot ? props.room : null}
              onDirect={openDirect}
              onManage={props.onManageBots ?? (() => {})}
              onCreate={props.onCreateBot}
            />
          </div>
          <div className="server-sidebar-content" hidden={botContext}>
          <div className="section-heading">
            <span>{t("textChannels")}</span>
            <button
              id="create-room-button"
              className="section-action"
              type="button"
              aria-label={t("createGroup")}
              title={t("createGroup")}
              onClick={props.onCreateRoom}
              hidden={props.canCreateRoom === false}
            >
              <Icon name="plus" />
            </button>
          </div>
          <nav id="channel-list" aria-label={t("conversations")}>
            {initialRoom && roomButton(initialRoom, true)}
            <div id="additional-rooms">
              {otherRooms.map((room) => roomButton(room))}
            </div>
            {!props.rooms.some((room) => room.kind === "group") && (
              <p className="sidebar-empty">{t("noChannels")}</p>
            )}
          </nav>
          <div className="section-heading members-heading">
            <span>{t("directMessages")}</span>
            <span id="member-count">{contacts.length}</span>
          </div>
          <div
            id="sidebar-members"
            className="member-list"
            aria-label={t("contacts")}
          >
            {contacts.map(contact)}
          </div>
          </div>
        </aside>
        <main className="conversation">
          <header className="conversation-header">
            <div className="room-heading">
              <button
                id="channels-button"
                className="icon-button mobile-channels"
                type="button"
                aria-label={t("openChannels")}
                aria-expanded={channelsOpen}
                onClick={() => {
                  setChannelsOpen(!channelsOpen);
                  setMembersOpen(false);
                }}
              >
                <Icon name="menu" />
              </button>
              <span
                id="heading-symbol"
                className="heading-hash"
                aria-hidden="true"
              >
                <Icon
                  name={botContext ? "bot" : props.room?.kind === "direct" ? "atSign" : "hash"}
                />
              </span>
              <div>
                <h1 id="room-title">
                  {props.view === "home"
                    ? t("home")
                    : props.view === "bots"
                      ? t("myBots")
                    : (props.room?.name ??
                      props.selectedSpace?.name ??
                      t("collaboration"))}
                </h1>
                <p id="room-subtitle">
                  {props.view === "chat" ? (selectedBot?.id ?? props.room?.topic) : ""}
                </p>
              </div>
            </div>
            <div className="header-actions">
              <span className="connection-label" title={t("homeConnection")}>
                <span
                  id="connection-dot"
                  className={`status-dot${props.connection === "connected" ? " online" : ""}`}
                />
                <span id="connection-text">
                  {t(
                    props.connection === "connected"
                      ? "connected"
                      : props.connection === "offline"
                        ? "offline"
                        : "connecting",
                  )}
                </span>
              </span>
              <button
                id="tasks-button"
                className="icon-button"
                type="button"
                aria-label={t("taskHistory")}
                title={t("taskHistory")}
                aria-expanded={props.showTaskHistory}
                hidden={props.view !== "chat"}
                onClick={props.onToggleTasks}
              >
                <Icon name="history" />
              </button>
              <button
                id="inbox-button"
                className="icon-button badge-button"
                type="button"
                aria-label={
                  props.mentionCount
                    ? t("inboxCount", { count: props.mentionCount })
                    : t("inbox")
                }
                title={t("inbox")}
                onClick={props.onInbox}
              >
                <Icon name="inbox" />
                <span
                  id="inbox-badge"
                  className="unread-badge"
                  hidden={!props.mentionCount}
                >
                  {props.mentionCount > 99 ? "99+" : props.mentionCount}
                </span>
              </button>
              <button
                id="room-notifications-button"
                className="icon-button"
                type="button"
                aria-label={t("roomNotifications")}
                title={t("roomNotifications")}
                hidden={props.view !== "chat"}
                onClick={props.onNotifications}
              >
                <Icon name="bell" />
              </button>
              <button
                id="invite-bot-button"
                className="icon-button"
                type="button"
                aria-label={t("inviteBots")}
                title={t("inviteBots")}
                hidden={
                  props.view !== "chat" ||
                  props.room?.kind !== "group" ||
                  props.canInvite === false
                }
                onClick={props.onInvite}
              >
                <Icon name="plus" />
              </button>
              <button
                id="details-button"
                className="icon-button"
                type="button"
                aria-label={t("showMembers")}
                aria-expanded={props.view !== "bots" && membersOpen}
                hidden={props.view === "bots"}
                onClick={() => {
                  setMembersOpen(!membersOpen);
                  setChannelsOpen(false);
                }}
              >
                <Icon name="members" />
              </button>
            </div>
          </header>
          <section
            id="home-panel"
            className="home-panel"
            hidden={props.view !== "home"}
          >
            <h2>{t("directMessages")}</h2>
            <div id="home-contacts" className="home-contacts">
              {contacts.map(contact)}
            </div>
          </section>
          <section id="bots-panel" className="home-panel bots-panel" hidden={props.view !== "bots"}>
            <div className="bots-panel-empty">
              <Icon name="bot" />
              <h2>{t("myBots")}</h2>
              <p>{t("selectBot")}</p>
            </div>
          </section>
          <div hidden={props.view !== "chat"} style={{ display: "contents" }}>
            {props.children}
          </div>
        </main>
        <aside
          id="details-panel"
          className={`details-panel${!desktop && membersOpen ? " open" : ""}`}
          aria-label={t("members")}
        >
          <header className="details-heading">
            <h2>{t("members")}</h2>
            <button
              id="close-details"
              className="icon-button mobile-close"
              type="button"
              aria-label={t("closeMembers")}
              onClick={() => setMembersOpen(false)}
            >
              <Icon name="close" />
            </button>
          </header>
          <div id="room-members" className="room-members">
            {(["human", "bot"] as const).map((kind) => {
              const selected = roomMembers.filter(
                (member) => member.kind === kind,
              );
              return selected.length ? (
                <section className="member-group" key={kind}>
                  <div className="section-heading">
                    {kind === "human" ? t("humans") : "BOT"} — {selected.length}
                  </div>
                  {selected.map((member, index) => (
                    <button
                      key={member.id}
                      className="member-row member-profile-button"
                      type="button"
                      onClick={() => props.onMember(member.id)}
                    >
                      {memberContents(member, index)}
                    </button>
                  ))}
                </section>
              ) : null;
            })}
          </div>
        </aside>
      </div>
      <button
        id="panel-backdrop"
        className="panel-backdrop"
        style={{ border: 0, padding: 0 }}
        type="button"
        aria-label={t("closePanel")}
        hidden={!channelsOpen && (desktop || !membersOpen)}
        onClick={closePanels}
      />
    </>
  );
}
