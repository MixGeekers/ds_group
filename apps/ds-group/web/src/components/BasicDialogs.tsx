import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  FormEvent,
  MouseEvent,
  SyntheticEvent,
} from "react";
import { messageOf, readStored } from "../api";
import { useTranslation } from "../locale";
import { Icon } from "./Icons";
import { dialogMessages } from "../locales/dialogs";
import { botMessages } from "../locales/bots";
import type { Api, Participant, Role, Room, Session } from "../types";

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

function cancelDialog(
  event: SyntheticEvent<HTMLDialogElement>,
  canClose: boolean,
  onClose: () => void,
) {
  event.preventDefault();
  if (canClose) onClose();
}

function dismissBackdrop(
  event: MouseEvent<HTMLDialogElement>,
  canClose: boolean,
  onClose: () => void,
) {
  if (!canClose || event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  const outside =
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom;
  if (outside) onClose();
}

interface PendingGroup {
  requestId: string;
  name: string;
  inviteIds: string[];
}

interface RoomDialogProps {
  mode: "create" | "invite" | null;
  session: Session | null;
  room: Room | null;
  participants: Participant[];
  ownedBots: Participant[];
  api: Api;
  onRoom(room: Room): void;
  onChanged(): void | Promise<void>;
  onClose(): void;
  onError(message: string): void;
}

export function RoomDialog({
  mode,
  session,
  room,
  participants,
  ownedBots,
  api,
  onRoom,
  onChanged,
  onClose,
  onError,
}: RoomDialogProps) {
  const t = useTranslation(dialogMessages);
  const dialog = useDialog(mode !== null);
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  const isInvite = mode === "invite";
  const choices = isInvite
    ? ownedBots.filter((bot) => !room?.participantIds.includes(bot.id))
    : participants.filter(
        (person) =>
          person.id !== session?.user_id &&
          (person.kind === "human" || person.ownerId === session?.user_id),
      );

  useEffect(() => {
    setError("");
    if (mode === null) return;
    const saved =
      mode === "create" && session
        ? readStored<PendingGroup>(`ds-group.pending-room.${session.user_id}`)
        : null;
    setName(saved?.name ?? "");
    setSelectedIds(saved?.inviteIds ?? []);
    setRestored(Boolean(saved));
  }, [mode, session?.user_id]);

  function toggleMember(id: string, selected: boolean) {
    setSelectedIds((current) =>
      selected
        ? [...new Set([...current, id])]
        : current.filter((value) => value !== id),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !mode || busy) return;
    const eligible = new Set(choices.map((person) => person.id));
    const inviteIds = selectedIds.filter((id) => eligible.has(id)).sort();
    if (isInvite && !inviteIds.length) {
      setError(t("chooseBot"));
      return;
    }
    if (!isInvite && !name.trim()) {
      setError(t("chooseName"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "create") {
        const key = `ds-group.pending-room.${session.user_id}`;
        const saved = readStored<PendingGroup>(key);
        const cleanName = name.trim();
        const sameRequest =
          saved?.name === cleanName &&
          JSON.stringify(saved.inviteIds) === JSON.stringify(inviteIds);
        const request: PendingGroup = {
          name: cleanName,
          inviteIds,
          requestId: sameRequest ? saved.requestId : crypto.randomUUID(),
        };
        sessionStorage.setItem(key, JSON.stringify(request));
        const result = await api<Room>("/api/rooms", {
          method: "POST",
          body: request,
        });
        if (!result.roomId) throw new Error(t("groupReceiptMissing"));
        sessionStorage.removeItem(key);
        onRoom(result);
        if (result.status === "partially_joined") onError(t("partialJoin"));
        try {
          await onChanged();
        } catch (cause) {
          onError(messageOf(cause));
        }
      } else if (room) {
        for (const participantId of inviteIds) {
          await api(`/api/rooms/${encodeURIComponent(room.roomId)}/invite`, {
            method: "POST",
            body: { participantId },
          });
        }
        await onChanged();
      }
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const title = t(isInvite ? "inviteBots" : "createGroup");
  return (
    <dialog
      ref={dialog}
      id="room-dialog"
      className="room-dialog"
      aria-labelledby="room-dialog-title"
      onCancel={(event) => cancelDialog(event, !busy, onClose)}
      onClick={(event) => dismissBackdrop(event, !busy, onClose)}
    >
      <form id="room-form" onSubmit={(event) => void submit(event)}>
        <div className="dialog-heading">
          <h2 id="room-dialog-title">{title}</h2>
          <button
            id="close-room-dialog"
            className="icon-button"
            type="button"
            aria-label={t("close")}
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div id="room-name-field" hidden={isInvite}>
          <label htmlFor="new-room-name">{t("groupName")}</label>
          <input
            id="new-room-name"
            maxLength={80}
            autoComplete="off"
            required={!isInvite}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <label id="room-choice-label">
          {t(isInvite ? "selectBot" : "inviteMembers")}
        </label>
        <div id="room-choices" className="room-choices">
          {choices.map((person) => (
            <label key={person.id} className="room-choice">
              <input
                type="checkbox"
                value={person.id}
                checked={selectedIds.includes(person.id)}
                disabled={busy}
                onChange={(event) =>
                  toggleMember(person.id, event.target.checked)
                }
              />
              <span
                className={`avatar avatar-${person.kind}`}
                aria-hidden="true"
              >
                {person.name.slice(0, 1)}
              </span>
              <span>{person.name}</span>
              {person.kind === "bot" && (
                <span className="member-kind">BOT</span>
              )}
            </label>
          ))}
          {!choices.length && (
            <p className="muted small">
              {t(isInvite ? "noBots" : "noMembers")}
            </p>
          )}
        </div>
        <p id="room-form-error" className="settings-feedback" role="alert">
          {error || (restored ? t("pendingGroup") : "")}
        </p>
        <button
          id="room-submit"
          className="primary-button login-submit"
          type="submit"
          disabled={busy || (isInvite && !choices.length)}
        >
          {t(
            isInvite
              ? busy
                ? "inviting"
                : "invite"
              : busy
                ? "creating"
                : "create",
          )}
        </button>
      </form>
    </dialog>
  );
}

interface MemberDialogProps {
  member: Participant | null;
  session: Session | null;
  room: Room | null;
  roles: Role[];
  botStatus?: string;
  onDirect(id: string): void;
  onMention(member: Participant): void;
  onClose(): void;
}

export function MemberDialog({
  member,
  session,
  room,
  roles,
  botStatus = "offline",
  onDirect,
  onMention,
  onClose,
}: MemberDialogProps) {
  const t = useTranslation(dialogMessages);
  const botText = useTranslation(botMessages);
  const dialog = useDialog(member !== null);
  const membership = member
    ? roles.filter((role) => role.memberIds.includes(member.id))
    : [];
  return (
    <dialog
      ref={dialog}
      id="member-dialog"
      className="member-dialog"
      aria-labelledby="member-dialog-name"
      onCancel={(event) => cancelDialog(event, true, onClose)}
      onClick={(event) => dismissBackdrop(event, true, onClose)}
    >
      <button
        id="close-member"
        className="icon-button dialog-close"
        type="button"
        aria-label={t("closeProfile")}
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      <div id="member-dialog-avatar">
        <span
          className={`avatar avatar-${member?.kind ?? "human"}`}
          aria-hidden="true"
        >
          {member?.name.slice(0, 1)}
        </span>
      </div>
      <h2 id="member-dialog-name">{member?.name}</h2>
      <p id="member-dialog-id">
        {member?.kind === "bot" ? member.id : (member?.localpart ?? member?.id)}
      </p>
      {member?.kind === "bot" && (
        <p className="bot-connection-status">
          {botText(
            ["online", "idle", "ready", "connected"].includes(botStatus)
              ? "online"
              : [
                    "running",
                    "thinking",
                    "busy",
                    "processing",
                    "starting",
                  ].includes(botStatus)
                ? "busy"
                : ["error", "failed", "unavailable"].includes(botStatus)
                  ? "unavailable"
                  : "offline",
          )}
        </p>
      )}
      {member?.kind === "bot" && member.ownerId === session?.user_id && (
        <p className="bot-connection-help">{botText("connectInDsh")}</p>
      )}
      <div id="member-dialog-roles" className="member-role-list">
        {membership.map((role) => (
          <span
            key={role.id}
            className="role-badge"
            style={{ "--role-color": role.color } as CSSProperties}
          >
            {role.name}
          </span>
        ))}
      </div>
      <div className="settings-actions">
        <button
          id="member-dm"
          className="primary-button"
          type="button"
          hidden={!member || member.id === session?.user_id}
          onClick={() => {
            if (member) {
              onClose();
              onDirect(member.id);
            }
          }}
        >
          {t("sendMessage")}
        </button>
        <button
          id="member-mention"
          className="secondary-button"
          type="button"
          disabled={
            !session || !member || !room?.participantIds.includes(member.id)
          }
          onClick={() => {
            if (member) {
              onClose();
              onMention(member);
            }
          }}
        >
          {t("mention")}
        </button>
      </div>
    </dialog>
  );
}
