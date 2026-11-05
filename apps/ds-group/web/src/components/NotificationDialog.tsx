import { Button, Checkbox, Radio, RadioGroup } from "../../../ui/controls";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { messageOf } from "../api";
import { useTranslation } from "../locale";
import { Icon } from "./Icons";
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
          <Button
            id="close-notification"
            className="icon-button"
            variant="ghost"
            size="icon"
            type="button"
            aria-label={t("close")}
            onClick={onClose}
            disabled={saving}
          >
            <Icon name="close" />
          </Button>
        </header>
        <label className="check-label">
          <Checkbox
            id="notification-muted"
            checked={preferences.muted}
            disabled={loading || saving}
            onCheckedChange={(checked) =>
              setPreferences({ ...preferences, muted: checked })
            }
          />
          {t("muteRoom")}
        </label>
        <fieldset disabled={loading || saving}>
          <legend>{t("notificationSettings")}</legend>
          <RadioGroup
            name="notification-mode"
            value={preferences.mode}
            disabled={loading || saving}
            onValueChange={(mode) => setPreferences({ ...preferences, mode })}
          >
            {(["all", "mentions", "nothing"] as const).map((mode) => (
              <label className="check-label" key={mode}>
                <Radio value={mode} />
                {t(
                  mode === "all"
                    ? "allMessages"
                    : mode === "mentions"
                      ? "onlyMentions"
                      : "nothing",
                )}
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        <label className="check-label">
          <Checkbox
            id="notification-everyone"
            checked={preferences.suppressEveryone}
            disabled={loading || saving}
            onCheckedChange={(checked) =>
              setPreferences({
                ...preferences,
                suppressEveryone: checked,
              })
            }
          />
          {t("suppressEveryone")}
        </label>
        <label className="check-label">
          <Checkbox
            id="notification-roles"
            checked={preferences.suppressRoles}
            disabled={loading || saving}
            onCheckedChange={(checked) =>
              setPreferences({
                ...preferences,
                suppressRoles: checked,
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
        <Button
          className="primary-button login-submit"
          variant="default"
          type="submit"
          disabled={loading || saving}
        >
          {t(saving ? "saving" : "save")}
        </Button>
      </form>
    </dialog>
  );
}
