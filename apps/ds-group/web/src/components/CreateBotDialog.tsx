import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, messageOf, readStored } from "../api";
import { useTranslation } from "../locale";
import { botMessages } from "../locales/bots";
import type { Api, Participant, ServerStatus, Session } from "../types";
import { Icon } from "./Icons";
import { sessionIdentity } from "../session";
import { newRequestId } from "../identifiers";

interface PendingBot {
  name: string;
  requestId: string;
}

export interface CreateBotDialogProps {
  open: boolean;
  api: Api;
  session: Session | null;
  status?: ServerStatus | null;
  pendingStorageKey?: string;
  onCreated(bot: Participant): void | Promise<void>;
  onClose(): void;
}

function requestKey(userId: string) {
  return `ds-group.pending-bot.${userId}`;
}

export function CreateBotDialog({
  open,
  api,
  session,
  status,
  pendingStorageKey,
  onCreated,
  onClose,
}: CreateBotDialogProps) {
  const t = useTranslation(botMessages);
  const identity = sessionIdentity(session);
  const dialog = useRef<HTMLDialogElement>(null);
  const currentUser = useRef(session?.user_id);
  currentUser.current = session?.user_id;
  const submitting = useRef(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingBot | null>(null);
  const [created, setCreated] = useState<Participant | null>(null);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<
    "copied" | "copyFailed" | null
  >(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const saved = session
      ? readStored<PendingBot>(pendingStorageKey ?? requestKey(session.user_id))
      : null;
    setName(saved?.name ?? "");
    setPending(saved);
    setCreated(null);
    setError("");
    setNameError(false);
    setCopyFeedback(null);
  }, [open, identity, pendingStorageKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || submitting.current || created) return;
    if (!name.trim()) {
      setNameError(true);
      return;
    }
    const ownerId = session.user_id;
    const key = pendingStorageKey ?? requestKey(ownerId);
    const request = readStored<PendingBot>(key) ?? {
      name: name.trim(),
      requestId: newRequestId(),
    };
    submitting.current = true;
    setBusy(true);
    setError("");
    setNameError(false);
    try {
      sessionStorage.setItem(key, JSON.stringify(request));
      setPending(request);
      const result = await api<{ bot: Participant }>("/api/bots", {
        method: "POST",
        body: request,
      });
      if (!result.bot?.id || result.bot.kind !== "bot")
        throw new Error(t("receiptMissing"));
      sessionStorage.removeItem(key);
      if (currentUser.current !== ownerId) return;
      setPending(null);
      setCreated(result.bot);
      try {
        await onCreated(result.bot);
      } catch (cause) {
        if (currentUser.current === ownerId)
          setError(t("refreshFailed", { error: messageOf(cause) }));
      }
    } catch (cause) {
      if (currentUser.current !== ownerId) return;
      if (cause instanceof ApiError && [400, 422].includes(cause.status)) {
        sessionStorage.removeItem(key);
        setPending(null);
      }
      setError(messageOf(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function copyId() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.id);
      setCopyFeedback("copied");
    } catch {
      setCopyFeedback("copyFailed");
    }
  }

  const nodeStatus =
    status?.nodes.find((node) => node.botId === created?.id)?.status ??
    created?.status ??
    "offline";
  const online = ["online", "idle", "ready", "connected"].includes(nodeStatus);
  const working = [
    "running",
    "thinking",
    "busy",
    "processing",
    "starting",
  ].includes(nodeStatus);
  const unavailable = ["error", "failed", "unavailable"].includes(nodeStatus);
  const connectionLabel = t(
    online
      ? "online"
      : working
        ? "busy"
        : unavailable
          ? "unavailable"
          : "offline",
  );

  return (
    <dialog
      ref={dialog}
      id="create-bot-dialog"
      className="create-bot-dialog"
      aria-labelledby="create-bot-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id="create-bot-title">{t(created ? "connection" : "createBot")}</h2>
        <button
          id="close-create-bot"
          className="icon-button"
          type="button"
          aria-label={t("close")}
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {created ? (
        <section className="bot-connection-details">
          <h3>{created.name}</h3>
          <p className="bot-connection-status" role="status">
            <span
              className={`status-dot${online ? " online" : working ? " busy" : unavailable ? " error" : ""}`}
              aria-hidden="true"
            />
            {connectionLabel}
          </p>
          <label htmlFor="bot-connection-id">{t("botId")}</label>
          <div className="bot-id-row">
            <input
              id="bot-connection-id"
              className="bot-id"
              value={created.id}
              readOnly
            />
            <button
              id="copy-bot-id"
              className="icon-button"
              type="button"
              aria-label={t("copyId")}
              title={t("copyId")}
              onClick={() => void copyId()}
            >
              <Icon name="copy" />
            </button>
          </div>
          <p className="small muted">{t("connectInDsh")}</p>
          <p className="settings-feedback" role="status" hidden={!copyFeedback}>
            {copyFeedback ? t(copyFeedback) : ""}
          </p>
        </section>
      ) : (
        <form
          id="create-bot-form"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <label htmlFor="bot-name">{t("botName")}</label>
          <input
            id="bot-name"
            value={name}
            maxLength={80}
            required
            autoComplete="off"
            disabled={busy || !session}
            readOnly={Boolean(pending)}
            aria-invalid={nameError || undefined}
            aria-describedby={nameError ? "bot-name-error" : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(false);
            }}
          />
          <p
            id="bot-name-error"
            className="field-error"
            role="alert"
            hidden={!nameError}
          >
            {t("chooseName")}
          </p>
          {pending && <p className="settings-feedback">{t("pending")}</p>}
          <button
            id="create-bot-submit"
            className="primary-button login-submit"
            type="submit"
            disabled={busy || !session}
          >
            {t(busy ? "creating" : pending ? "retry" : "createBot")}
          </button>
          {!session && <p className="settings-feedback">{t("signIn")}</p>}
        </form>
      )}
      <p
        id="create-bot-error"
        className="settings-feedback error-text"
        role="alert"
        hidden={!error}
      >
        {error}
      </p>
    </dialog>
  );
}
