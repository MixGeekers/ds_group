import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { messageOf } from "../api";
import { useTranslation } from "../locale";
import { settingsMessages } from "../locales/settings";
import type { Api, NotificationPreferences, Room } from "../types";

interface NotificationDialogProps {
  room: Room | null;
  api: Api;
  onClose(): void;
  onSaved(): void | Promise<void>;
}

const initialPreferences: NotificationPreferences = {
  mode: "mentions",
  muted: false,
  suppressEveryone: false,
  suppressRoles: false,
};

export function NotificationDialog({
  room,
  api,
  onClose,
  onSaved,
}: NotificationDialogProps) {
  const t = useTranslation(settingsMessages);
  const dialog = useRef<HTMLDialogElement>(null);
  const [preferences, setPreferences] = useState(initialPreferences);
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (room && !element.open) element.showModal();
    if (!room && element.open) element.close();
  }, [room]);

  useEffect(() => {
    if (!room) return;
    let active = true;
    setLoading(true);
    setFeedback("");
    void api<NotificationPreferences>(
      `/api/rooms/${encodeURIComponent(room.roomId)}/notifications`,
    )
      .then((value) => {
        if (active) setPreferences(value);
      })
      .catch((error) => {
        if (active) setFeedback(messageOf(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [room?.roomId, api]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!room || saving || loading) return;
    setSaving(true);
    setFeedback("");
    try {
      await api(`/api/rooms/${encodeURIComponent(room.roomId)}/notifications`, {
        method: "PUT",
        body: preferences,
      });
      await onSaved();
      onClose();
    } catch (error) {
      setFeedback(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      id="notification-dialog"
      className="notification-dialog"
      aria-labelledby="notification-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form
        id="notification-form"
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <header className="dialog-heading">
          <h2 id="notification-title">
            {t("roomNotifications", { room: room?.name || t("conversation") })}
          </h2>
          <button
            id="close-notification"
            className="icon-button"
            type="button"
            aria-label={t("close")}
            onClick={onClose}
            disabled={saving}
          >
            ×
          </button>
        </header>
        <label className="check-label">
          <input
            id="notification-muted"
            type="checkbox"
            checked={preferences.muted}
            disabled={loading || saving}
            onChange={(event) =>
              setPreferences({ ...preferences, muted: event.target.checked })
            }
          />
          {t("muteRoom")}
        </label>
        <fieldset disabled={loading || saving}>
          <legend>{t("notificationSettings")}</legend>
          {(["all", "mentions", "nothing"] as const).map((mode) => (
            <label className="check-label" key={mode}>
              <input
                type="radio"
                name="notification-mode"
                value={mode}
                checked={preferences.mode === mode}
                onChange={() => setPreferences({ ...preferences, mode })}
              />
              {t(
                mode === "all"
                  ? "allMessages"
                  : mode === "mentions"
                    ? "onlyMentions"
                    : "nothing",
              )}
            </label>
          ))}
        </fieldset>
        <label className="check-label">
          <input
            id="notification-everyone"
            type="checkbox"
            checked={preferences.suppressEveryone}
            disabled={loading || saving}
            onChange={(event) =>
              setPreferences({
                ...preferences,
                suppressEveryone: event.target.checked,
              })
            }
          />
          {t("suppressEveryone")}
        </label>
        <label className="check-label">
          <input
            id="notification-roles"
            type="checkbox"
            checked={preferences.suppressRoles}
            disabled={loading || saving}
            onChange={(event) =>
              setPreferences({
                ...preferences,
                suppressRoles: event.target.checked,
              })
            }
          />
          {t("suppressRoles")}
        </label>
        <p
          id="notification-feedback"
          className="settings-feedback"
          role="status"
        >
          {loading ? t("loading") : feedback}
        </p>
        <button
          className="primary-button login-submit"
          type="submit"
          disabled={loading || saving}
        >
          {t(saving ? "saving" : "save")}
        </button>
      </form>
    </dialog>
  );
}
