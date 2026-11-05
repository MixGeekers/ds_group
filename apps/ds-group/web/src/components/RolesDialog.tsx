import { useCallback, useEffect, useRef, useState } from "react";
import { formatNumber } from "../../i18n.js";
import { messageOf } from "../api";
import { useTranslation } from "../locale";
import { settingsMessages } from "../locales/settings";
import { Icon } from "./Icons";
import type { Api, Participant, Role, Session } from "../types";

interface RoleDraft {
  id?: string;
  name: string;
  color: string;
  mentionable: boolean;
  memberIds: string[];
}
export function RolesDialog({
  open,
  participants,
  session,
  api,
  onChanged,
  onClose,
}: {
  open: boolean;
  participants: Participant[];
  session: Session | null;
  api: Api;
  onChanged(): void;
  onClose(): void;
}) {
  const t = useTranslation(settingsMessages);
  const dialog = useRef<HTMLDialogElement>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api<{ roles: Role[]; canManage: boolean }>(
        "/api/roles",
        { signal },
      );
      if (!signal?.aborted) {
        setRoles(result.roles);
        setCanManage(result.canManage);
      }
    },
    [api],
  );
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) dialog.current?.close();
    setDraft(null);
    setFeedback("");
    setCanManage(false);
    if (!open || !session) return;
    const controller = new AbortController();
    void load(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setFeedback(messageOf(reason));
    });
    return () => controller.abort();
  }, [open, session, load]);
  async function save(remove = false) {
    if (!draft || !canManage || busy) return;
    setBusy(true);
    setFeedback("");
    try {
      const { id, ...body } = draft;
      await api(id ? `/api/roles/${encodeURIComponent(id)}` : "/api/roles", {
        method: remove ? "DELETE" : id ? "PUT" : "POST",
        body: remove ? undefined : body,
      });
      await load();
      onChanged();
      setDraft(null);
      setFeedback(t(remove ? "roleDeleted" : "roleSaved"));
    } catch (reason) {
      setFeedback(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }
  function newRole() {
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-accent")
      .trim();
    setDraft({
      name: "",
      color: /^#[a-f\d]{6}$/i.test(token) ? token : "#000000",
      memberIds: [],
      mentionable: true,
    });
  }
  return (
    <dialog
      id="roles-dialog"
      className="settings-dialog"
      ref={dialog}
      aria-labelledby="roles-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id="roles-title">{t("roles")}</h2>
        <button
          className="icon-button"
          type="button"
          aria-label={t("close")}
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <section>
        <div className="settings-section-heading">
          <h3>{t("roles")}</h3>
          <button
            id="new-role"
            className="secondary-button"
            type="button"
            hidden={!canManage || !!draft}
            onClick={newRole}
          >
            {t("createRole")}
          </button>
        </div>
        <div id="role-list" className="role-list" hidden={!!draft}>
          {roles.map((role) => (
            <button
              key={role.id}
              className="role-row"
              type="button"
              disabled={!canManage}
              onClick={() => setDraft({ ...role })}
            >
              <span
                className="role-color"
                style={{ backgroundColor: role.color }}
              />
              <strong>{role.name}</strong>
              <small>
                {t("memberCount", {
                  count: formatNumber(role.memberIds.length),
                })}
              </small>
            </button>
          ))}
          {!roles.length && <p className="muted small">{t("noRoles")}</p>}
        </div>
        <p id="role-feedback" className="settings-feedback" role="status">
          {feedback}
        </p>
        {draft && (
          <form
            id="role-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label htmlFor="role-name">{t("roleName")}</label>
            <input
              id="role-name"
              maxLength={40}
              required
              autoFocus
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
            <label htmlFor="role-color">{t("roleColor")}</label>
            <input
              id="role-color"
              type="color"
              value={draft.color}
              onChange={(event) =>
                setDraft({ ...draft, color: event.target.value })
              }
            />
            <label className="check-label">
              <input
                id="role-mentionable"
                type="checkbox"
                checked={draft.mentionable}
                onChange={(event) =>
                  setDraft({ ...draft, mentionable: event.target.checked })
                }
              />
              {t("mentionable")}
            </label>
            <h3>{t("members")}</h3>
            <div id="role-members" className="room-choices">
              {participants.map((person) => (
                <label className="room-choice" key={person.id}>
                  <input
                    type="checkbox"
                    value={person.id}
                    checked={draft.memberIds.includes(person.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        memberIds: event.target.checked
                          ? [...draft.memberIds, person.id]
                          : draft.memberIds.filter((id) => id !== person.id),
                      })
                    }
                  />
                  <span className={`avatar avatar-${person.kind}`}>
                    {person.name.slice(0, 1)}
                  </span>
                  <span>
                    {person.name}
                    <small className="member-full-id">{person.id}</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="settings-actions">
              <button className="primary-button" type="submit" disabled={busy}>
                {t(busy ? "saving" : "save")}
              </button>
              <button
                id="cancel-role"
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                {t("cancel")}
              </button>
              <button
                id="delete-role"
                className="danger-button"
                type="button"
                hidden={!draft.id}
                disabled={busy}
                onClick={() => void save(true)}
              >
                {t("delete")}
              </button>
            </div>
          </form>
        )}
      </section>
    </dialog>
  );
}
