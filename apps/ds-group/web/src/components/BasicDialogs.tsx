import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  FormEvent,
  MouseEvent,
  SyntheticEvent,
} from "react";
import { messageOf, readStored } from "../api";
import { useTranslation } from "../locale";
import { dialogMessages } from "../locales/dialogs";
import type {
  Api,
  Bootstrap,
  Participant,
  Role,
  Room,
  Session,
} from "../types";

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

interface LoginDialogProps {
  open: boolean;
  bootstrap: Bootstrap | null;
  session: Session | null;
  busy: boolean;
  error: string;
  onLogin(user: string, password: string): void | Promise<void>;
  onClose(): void;
}

export function LoginDialog({
  open,
  bootstrap,
  session,
  busy,
  error,
  onLogin,
  onClose,
}: LoginDialogProps) {
  const t = useTranslation(dialogMessages);
  const dialog = useDialog(open);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const humans =
    bootstrap?.participants.filter((person) => person.kind === "human") ?? [];
  const passwordRequired = bootstrap?.demoLogin === false;
  const canClose = Boolean(session) && !busy;

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setLocalError("");
    setUser((current) => {
      const members =
        bootstrap?.participants.filter((person) => person.kind === "human") ??
        [];
      if (members.some((person) => (person.localpart ?? person.id) === current))
        return current;
      const selected =
        members.find((person) => person.id === session?.user_id) ?? members[0];
      return selected?.localpart ?? selected?.id ?? "";
    });
  }, [open, bootstrap?.participants, session?.user_id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !user) return;
    setLocalError("");
    try {
      await onLogin(user, password);
    } catch (cause) {
      setLocalError(messageOf(cause));
    }
  }

  return (
    <dialog
      ref={dialog}
      id="login-dialog"
      className="login-dialog"
      aria-labelledby="login-title"
      onCancel={(event) => cancelDialog(event, canClose, onClose)}
      onClick={(event) => dismissBackdrop(event, canClose, onClose)}
    >
      <form id="login-form" onSubmit={(event) => void submit(event)}>
        <div className="dialog-heading">
          <h2 id="login-title">{t("signIn")}</h2>
          <button
            id="close-login"
            className="icon-button"
            type="button"
            aria-label={t("closeSignIn")}
            hidden={!session}
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <label htmlFor="login-user">{t("account")}</label>
        <select
          id="login-user"
          required
          value={user}
          disabled={busy}
          onChange={(event) => setUser(event.target.value)}
        >
          {!humans.length && <option value="">{t("loadingAccounts")}</option>}
          {humans.map((person) => (
            <option key={person.id} value={person.localpart ?? person.id}>
              {person.name} · {person.localpart ?? person.id}
            </option>
          ))}
        </select>
        <details id="password-options" open={passwordRequired || undefined}>
          <summary hidden={passwordRequired}>{t("usePassword")}</summary>
          <label htmlFor="login-password">{t("password")}</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required={passwordRequired}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </details>
        <div
          id="login-error"
          className="login-error"
          role="alert"
          hidden={!error && !localError}
        >
          {error || localError}
        </div>
        <button
          id="login-submit"
          className="primary-button login-submit"
          type="submit"
          disabled={busy || !user}
        >
          {t(busy ? "signingIn" : "signIn")}
        </button>
      </form>
    </dialog>
  );
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
            ×
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
  onDirect(id: string): void;
  onMention(member: Participant): void;
  onClose(): void;
}

export function MemberDialog({
  member,
  session,
  room,
  roles,
  onDirect,
  onMention,
  onClose,
}: MemberDialogProps) {
  const t = useTranslation(dialogMessages);
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
        ×
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
      <p id="member-dialog-id">{member?.localpart ?? member?.id}</p>
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
