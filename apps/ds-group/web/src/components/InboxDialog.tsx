import { Button, Checkbox } from "../../../ui/controls";
import { useEffect, useRef, useState } from "react";
import { formatTime } from "../../i18n.js";
import { parseMentionTokens } from "../../mention-tokens.js";
import { messageOf } from "../api";
import { useTranslation } from "../locale";
import { Icon } from "./Icons";
import { settingsMessages } from "../locales/settings";
import type { Api, ChatEvent, Participant, Room } from "../types";

type InboxEvent = ChatEvent & { read: boolean; mentionKinds: string[] };
interface InboxResponse {
  events: InboxEvent[];
  unreadCount: number;
  mentionCount: number;
}
interface InboxDialogProps {
  open: boolean;
  api: Api;
  rooms: Room[];
  participants: Participant[];
  onClose(): void;
  onJump(roomId: string, eventId: string): void | Promise<void>;
  onChanged(): void | Promise<void>;
}

function readableBody(
  event: ChatEvent,
  participants: Participant[],
  roleLabel: string,
) {
  const body = event.content.body;
  const roleLabels = event.content["org.ds_group"]?.mentions?.roleLabels ?? {};
  let text = "";
  let offset = 0;
  for (const token of parseMentionTokens(body).tokens) {
    const id = token.id ?? "";
    let label: string;
    if (token.kind === "everyone" || token.kind === "here")
      label = `@${token.kind}`;
    else if (token.kind === "role") label = `@${roleLabels[id] || roleLabel}`;
    else
      label = `@${participants.find((person) => person.id === id)?.name || id}`;
    text += body.slice(offset, token.start) + label;
    offset = token.end;
  }
  return text + body.slice(offset);
}

export function InboxDialog({
  open,
  api,
  rooms,
  participants,
  onClose,
  onJump,
  onChanged,
}: InboxDialogProps) {
  const t = useTranslation(settingsMessages);
  const dialog = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState<"mentions" | "unread">("mentions");
  const [includeEveryone, setIncludeEveryone] = useState(true);
  const [includeRoles, setIncludeRoles] = useState(true);
  const [events, setEvents] = useState<InboxEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let timer: number | undefined;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({
      filter,
      includeEveryone: String(includeEveryone),
      includeRoles: String(includeRoles),
      limit: "100",
    });
    async function load() {
      try {
        const result = await api<InboxResponse>(`/api/inbox?${query}`);
        if (active) {
          setEvents(result.events);
          setError("");
        }
      } catch (reason) {
        if (active) setError(messageOf(reason));
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => {
            void load();
          }, 2500);
        }
      }
    }
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, filter, includeEveryone, includeRoles, revision, api]);

  async function markAllRead() {
    if (markingRead) return;
    setMarkingRead(true);
    try {
      await Promise.all(
        rooms.map((room) =>
          api(`/api/rooms/${encodeURIComponent(room.roomId)}/read`, {
            method: "POST",
            body: {},
          }),
        ),
      );
      await onChanged();
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setMarkingRead(false);
    }
  }

  return (
    <dialog
      id="inbox-dialog"
      className="inbox-dialog"
      ref={dialog}
      aria-labelledby="inbox-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id="inbox-title">{t("inbox")}</h2>
        <Button
          variant="ghost"
          size="icon"
          id="close-inbox"
          className="icon-button"
          type="button"
          aria-label={t("close")}
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div
        className="settings-tabs"
        role="group"
        aria-label={t("inboxCategories")}
      >
        <Button
          variant="ghost"
          id="inbox-mentions"
          type="button"
          aria-pressed={filter === "mentions"}
          onClick={() => setFilter("mentions")}
        >
          {t("mentions")}
        </Button>
        <Button
          variant="ghost"
          id="inbox-unread"
          type="button"
          aria-pressed={filter === "unread"}
          onClick={() => setFilter("unread")}
        >
          {t("unread")}
        </Button>
      </div>
      <div className="inbox-filters">
        <label>
          <Checkbox
            id="inbox-everyone"
            checked={includeEveryone}
            disabled={filter === "unread"}
            onCheckedChange={setIncludeEveryone}
          />
          {t("everyone")}
        </label>
        <label>
          <Checkbox
            id="inbox-roles"
            checked={includeRoles}
            disabled={filter === "unread"}
            onCheckedChange={setIncludeRoles}
          />
          {t("roleMentions")}
        </label>
        <Button
          variant="ghost"
          id="mark-all-read"
          className="text-button"
          type="button"
          disabled={markingRead}
          onClick={() => {
            void markAllRead();
          }}
        >
          {t("markAllRead")}
        </Button>
      </div>
      <div id="inbox-list" className="inbox-list dialog-scroll-region" aria-live="polite">
        {loading ? (
          <p className="muted">{t("loading")}</p>
        ) : error ? (
          <p className="error-text">{error}</p>
        ) : events.length ? (
          events.map((event) => {
            const roomId = event.room_id;
            const room = rooms.find((item) => item.roomId === roomId);
            const sender =
              participants.find((person) => person.id === event.sender)?.name ||
              event.sender;
            return (
              <Button
                variant="ghost"
                key={event.event_id}
                className={`inbox-item${event.read ? " read" : ""}`}
                type="button"
                disabled={!roomId}
                onClick={() => {
                  if (roomId) {
                    onClose();
                    void onJump(roomId, event.event_id);
                  }
                }}
              >
                <div className="inbox-item-header">
                  <strong>{room?.name || t("conversation")}</strong>
                  <time>{formatTime(event.origin_server_ts)}</time>
                </div>
                <strong className="inbox-sender">{sender}</strong>
                <p>{readableBody(event, participants, t("roles"))}</p>
              </Button>
            );
          })
        ) : (
          <p className="inbox-empty">
            {t(filter === "mentions" ? "noMentions" : "noUnread")}
          </p>
        )}
      </div>
    </dialog>
  );
}
