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

export interface ShellProps {
  bootstrap: Bootstrap | null;
  session: Session | null;
  rooms: Room[];
  room: Room | null;
  ownedBots: Participant[];
  mentionables: Mentionables;
  status: ServerStatus | null;
  view: "home" | "chat";
  children: ReactNode;
  mentionCount: number;
  showTaskHistory: boolean;
  onRoom(room: Room): void;
  onDirect(id: string): void;
  onHome(): void;
  onServer(): void;
  onSettings(tab?: SettingsTab): void;
  onLogin(): void;
  onCreateRoom(): void;
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
  const currentUser = participants.find(
    (member) => member.id === props.session?.user_id,
  );
  const ownIds = new Set(props.ownedBots.map((bot) => bot.id));
  const contacts = participants.filter(
    (member) => member.id !== props.session?.user_id && !ownIds.has(member.id),
  );
  const initialRoom = props.rooms.find(
    (room) => room.roomId === props.bootstrap?.roomId,
  );
  const otherRooms = props.rooms.filter(
    (room) => room.kind === "group" && room.roomId !== props.bootstrap?.roomId,
  );
  const roomMembers = participants.filter(
    (member) =>
      !props.room?.participantIds.length ||
      props.room.participantIds.includes(member.id),
  );

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
        document.querySelector("dialog[open]")
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
        </span>
        {member.kind === "bot" && <span className="member-kind">BOT</span>}
        <span className={`status-dot member-presence ${color}`} title={label} />
      </>
    );
  }

  function contact(member: Participant, index: number) {
    const directRoom = props.rooms.find(
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
      <div className="app-shell">
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
            DS
          </button>
          <div className="rail-divider" />
          <button
            id="server-button"
            className={`server-icon${props.view === "chat" ? " active" : ""}`}
            type="button"
            aria-label={t("currentServer")}
            aria-current={props.view === "chat" ? "page" : undefined}
            title="DS-Group"
            onClick={() => {
              closePanels();
              props.onServer();
            }}
          >
            DG
          </button>
          <button
            id="server-settings-button"
            className="server-icon server-add"
            type="button"
            aria-label={t("serverConnection")}
            title={t("serverConnection")}
            onClick={() => props.onSettings("server")}
          >
            <Icon name="plus" />
          </button>
        </nav>
        <aside
          id="channel-panel"
          className={`sidebar${channelsOpen ? " open" : ""}`}
          aria-label={t("channelsAndMessages")}
        >
          <header className="brand">
            <span>DS-Group</span>
            <span className="brand-chevron" aria-hidden="true">
              <Icon name="chevronDown" />
            </span>
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
          <div className="section-heading">
            <span>{t("textChannels")}</span>
            <button
              id="create-room-button"
              className="section-action"
              type="button"
              aria-label={t("createGroup")}
              title={t("createGroup")}
              onClick={props.onCreateRoom}
            >
              <Icon name="plus" />
            </button>
          </div>
          <nav id="channel-list" aria-label={t("conversations")}>
            {initialRoom && roomButton(initialRoom, true)}
            <div id="additional-rooms">
              {otherRooms.map((room) => roomButton(room))}
            </div>
          </nav>
          <div className="section-heading members-heading">
            <span>{t("myBots")}</span>
            <span id="owned-bot-count">
              {props.session ? props.ownedBots.length : "—"}
            </span>
          </div>
          <div id="owned-bots" className="member-list owned-bots">
            {props.ownedBots.length ? (
              props.ownedBots.map(contact)
            ) : (
              <p className="sidebar-empty">
                {props.session ? t("noBots") : t("signInToView")}
              </p>
            )}
          </div>
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
          <div className="identity-bar">
            <button
              id="identity-button"
              className="identity-button"
              type="button"
              onClick={props.onLogin}
            >
              <Avatar member={currentUser} id="current-avatar" />
              <span>
                <strong id="current-name">
                  {currentUser?.name ?? t("signIn")}
                </strong>
                <small id="current-id">
                  {props.session?.user_id ?? t("chooseAccount")}
                </small>
              </span>
            </button>
            <button
              id="settings-button"
              className="icon-button"
              type="button"
              aria-label={t("settings")}
              title={t("settings")}
              onClick={() => props.onSettings()}
            >
              <Icon name="gear" />
            </button>
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
                  name={props.room?.kind === "direct" ? "atSign" : "hash"}
                />
              </span>
              <div>
                <h1 id="room-title">
                  {props.view === "home"
                    ? t("home")
                    : (props.room?.name ?? t("collaboration"))}
                </h1>
                <p id="room-subtitle">
                  {props.view === "chat" ? props.room?.topic : ""}
                </p>
              </div>
            </div>
            <div className="header-actions">
              <span className="connection-label">
                <span
                  id="connection-dot"
                  className={`status-dot${props.status ? " online" : ""}`}
                />
                <span id="connection-text">
                  {props.status ? t("connected") : t("connecting")}
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
                hidden={props.view !== "chat" || props.room?.kind !== "group"}
                onClick={props.onInvite}
              >
                <Icon name="plus" />
              </button>
              <button
                id="mobile-settings"
                className="icon-button mobile-identity"
                type="button"
                aria-label={t("settings")}
                onClick={() => props.onSettings()}
              >
                <Icon name="gear" />
              </button>
              <button
                id="details-button"
                className="icon-button"
                type="button"
                aria-label={t("showMembers")}
                aria-expanded={membersOpen}
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
            <h2>{t("myBots")}</h2>
            <div id="home-bots" className="home-bots">
              {props.ownedBots.length ? (
                props.ownedBots.map(contact)
              ) : (
                <p className="muted small">
                  {props.session ? t("noBots") : t("signInToView")}
                </p>
              )}
            </div>
            <h2>{t("directMessages")}</h2>
            <div id="home-contacts" className="home-contacts">
              {contacts.map(contact)}
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
