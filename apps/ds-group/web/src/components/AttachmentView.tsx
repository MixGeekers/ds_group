import { useCallback, useEffect, useId, useRef, useState } from "react";
import { renderAttachmentCard } from "../../attachments.js";
import { useTranslation } from "../locale";
import { artifactMessages } from "../locales/artifacts";
import { Icon } from "./Icons";
import type { Attachment, RawRequest, Session } from "../types";

export interface AttachmentViewProps {
  attachment: Attachment;
  session: Session | null;
  request?: RawRequest;
  roomId?: string;
  eventId?: string;
  allowLegacy?: boolean;
  onError?: (message: string) => void;
}

interface Preview {
  url: string;
  attachment: Attachment;
  kind: "image" | "pdf" | "text" | null;
  dispose: () => void;
}

export function AttachmentView({
  attachment,
  session,
  request,
  roomId,
  eventId,
  allowLegacy,
  onError,
}: AttachmentViewProps) {
  const t = useTranslation(artifactMessages);
  const holder = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const sessionRef = useRef(session);
  const errorCallback = useRef(onError);
  const previewRef = useRef<Preview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  sessionRef.current = session;
  errorCallback.current = onError;

  const closePreview = useCallback(() => {
    previewRef.current?.dispose();
    previewRef.current = null;
    setPreview(null);
  }, []);

  const openPreview = useCallback((next: Preview) => {
    previewRef.current?.dispose();
    previewRef.current = next;
    setText(null);
    setPreviewFailed(false);
    setError(null);
    setPreview(next);
  }, []);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    setError(null);
    setPreview(null);
    const card = renderAttachmentCard(attachment, {
      getSession: () => sessionRef.current,
      request,
      roomId,
      eventId,
      allowLegacy,
      onPreview: openPreview,
      onError: (message) => {
        setError(message);
        errorCallback.current?.(message);
      },
    });
    element.replaceChildren(card);
    return () => {
      card.dispose();
      card.remove();
      previewRef.current?.dispose();
      previewRef.current = null;
    };
  }, [
    attachment.id,
    attachment.name,
    attachment.mimeType,
    attachment.size,
    attachment.sha256,
    session?.user_id,
    session?.access_token,
    request,
    roomId,
    eventId,
    allowLegacy,
    openPreview,
  ]);

  useEffect(() => {
    if (!preview) return;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    if (preview.kind !== "text") return;
    const controller = new AbortController();
    void fetch(preview.url, { signal: controller.signal })
      .then((response) => response.text())
      .then((value) => {
        if (!controller.signal.aborted) setText(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreviewFailed(true);
      });
    return () => controller.abort();
  }, [preview]);

  return (
    <>
      <div
        ref={holder}
        className="attachment-view"
        style={{ display: "contents" }}
        onClickCapture={() => setError(null)}
      />
      {error && (
        <p className="send-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <dialog
          ref={dialog}
          id="preview-dialog"
          className="preview-dialog"
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            closePreview();
          }}
          onClose={closePreview}
        >
          <header className="dialog-heading">
            <h2 id={titleId}>{preview.attachment.name || t("preview")}</h2>
            <button
              id="close-preview"
              className="icon-button"
              type="button"
              aria-label={t("closePreview")}
              onClick={closePreview}
            >
              <Icon name="close" />
            </button>
          </header>
          <div id="preview-content">
            {preview.kind === "image" && (
              <img
                className="preview-image"
                src={preview.url}
                alt={preview.attachment.name}
              />
            )}
            {preview.kind === "pdf" && (
              <iframe
                className="preview-frame"
                src={preview.url}
                title={preview.attachment.name}
              />
            )}
            {preview.kind === "text" && (
              <pre className="preview-text">
                {previewFailed ? t("previewFailed") : (text ?? t("loading"))}
              </pre>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
