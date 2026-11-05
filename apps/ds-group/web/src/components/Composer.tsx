import { Button, FileInput } from "../../../ui/controls";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createMentionEditor } from "../../mention-editor.js";
import type { MentionEditor } from "../../mention-editor.js";
import { createAttachmentManager } from "../../attachments.js";
import type { AttachmentManager, UploadState } from "../../attachments.js";
import { readStored } from "../api";
import { newRequestId } from "../identifiers";
import { useTranslation } from "../locale";
import { chatMessages } from "../locales/chat";
import { Icon } from "./Icons";
import type {
  Attachment,
  ComposerHandle,
  Mentionables,
  OutgoingMessage,
  ReplyTarget,
  Room,
  RawRequest,
  Session,
} from "../types";

interface InterruptedFile {
  name: string;
  size: number;
}
interface Draft {
  body: string;
  attachments: Attachment[];
  interrupted?: InterruptedFile[];
  reply?: ReplyTarget | null;
  replyTo?: string;
  replyMention?: boolean;
}

export interface ComposerProps {
  session: Session | null;
  request?: RawRequest;
  requestScope?: string;
  contextKey?: string;
  legacyDraftKey?: string;
  canSend?: boolean;
  room: Room | null;
  mentionables: Mentionables;
  reply: ReplyTarget | null;
  replyMention: boolean;
  onReplyMention(value: boolean): void;
  onClearReply(): void;
  onRestoreReply?(reply: ReplyTarget | null, mention: boolean): void;
  sending: boolean;
  isWorking?: boolean;
  pending: OutgoingMessage | null;
  onSend(message: OutgoingMessage): Promise<boolean>;
  limits?: { maxBytes: number; maxPerMessage: number };
  onError(message: string): void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(
  function Composer(props, ref) {
    const t = useTranslation(chatMessages);
    const propsRef = useRef(props);
    propsRef.current = props;
    const translateRef = useRef(t);
    translateRef.current = t;
    const inputRef = useRef<HTMLDivElement>(null);
    const popupRef = useRef<HTMLDivElement>(null);
    const uploadRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const formRef = useRef<HTMLFormElement>(null);
    const editorRef = useRef<MentionEditor | null>(null);
    const managerRef = useRef<AttachmentManager | null>(null);
    const contextRef = useRef("");
    const draftReplyRef = useRef({
      reply: props.reply,
      mention: props.replyMention,
    });
    const restoredContexts = useRef(new Set<string>());
    const restoringRef = useRef(false);
    const sendingRef = useRef(false);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    );
    const interruptedRef = useRef<InterruptedFile[]>([]);
    const [body, setBody] = useState("");
    const [uploads, setUploads] = useState<UploadState[]>([]);
    const [interrupted, setInterrupted] = useState<InterruptedFile[]>([]);
    const [dragging, setDragging] = useState(false);
    const contextKey =
      props.contextKey ??
      (props.session && props.room
        ? `ds-group.draft.${props.session.user_id}.${props.room.roomId}`
        : "");
    useEffect(() => {
      if (props.limits)
        managerRef.current?.setLimits({
          maxBytes: props.limits.maxBytes,
          maxFiles: props.limits.maxPerMessage,
        });
    }, [props.limits?.maxBytes, props.limits?.maxPerMessage]);
    // During a room switch the old editor still holds the old draft until effects run.
    if (contextRef.current === contextKey)
      draftReplyRef.current = {
        reply: props.reply,
        mention: props.replyMention,
      };

    function saveDraft() {
      clearTimeout(saveTimer.current);
      const key = contextRef.current;
      const manager = managerRef.current;
      const editor = editorRef.current;
      if (!key || !manager || !editor || restoringRef.current) return;
      const current = propsRef.current;
      const incomplete = manager
        .getState()
        .filter((file) => file.status !== "ready")
        .map(({ name, size }) => ({ name, size }));
      const draft: Draft = {
        body: editor.getValue().body,
        attachments: manager.getReady(),
        interrupted: [...interruptedRef.current, ...incomplete],
        reply: draftReplyRef.current.reply,
        replyTo: draftReplyRef.current.reply?.eventId,
        replyMention: draftReplyRef.current.mention,
      };
      try {
        sessionStorage.setItem(key, JSON.stringify(draft));
      } catch {
        current.onError(translateRef.current("draftStorage"));
      }
    }

    function scheduleDraft() {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(saveDraft, 180);
    }

    async function submit() {
      const current = propsRef.current;
      const manager = managerRef.current;
      const editor = editorRef.current;
      if (
        !current.session ||
        !current.room ||
        !manager ||
        !editor ||
        current.sending ||
        current.canSend === false ||
        sendingRef.current
      )
        return;
      const value = editor.getValue();
      const text = value.body.trim();
      const files = manager.getReady();
      if (
        !current.pending &&
        (text.length > 16000 ||
          (!text && !files.length) ||
          manager.hasPending() ||
          interruptedRef.current.length)
      )
        return;
      saveDraft();
      const submittedContext = contextRef.current;
      const message: OutgoingMessage = current.pending ?? {
        body: text,
        mentions: value.mentions,
        attachments: files.map((file) => file.id),
        transactionId: newRequestId(),
        ...(current.reply
          ? {
              replyTo: current.reply.eventId,
              replyMention: current.replyMention,
            }
          : {}),
      };
      sendingRef.current = true;
      try {
        const sent = await current.onSend(message);
        if (sent) {
          if (contextRef.current !== submittedContext) {
            manager.clear(submittedContext);
            sessionStorage.removeItem(submittedContext);
            return;
          }
          restoringRef.current = true;
          manager.clear(submittedContext);
          editor.clear();
          interruptedRef.current = [];
          setInterrupted([]);
          setBody("");
          current.onClearReply();
          sessionStorage.removeItem(submittedContext);
          restoringRef.current = false;
          editor.focus();
        }
      } catch (error) {
        current.onError(error instanceof Error ? error.message : String(error));
      } finally {
        sendingRef.current = false;
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        insertMention(member) {
          editorRef.current?.insertMention({
            ...member,
            kind: "member",
            memberKind: member.kind,
          });
          editorRef.current?.focus();
        },
        focus() {
          editorRef.current?.focus();
        },
      }),
      [],
    );

    useEffect(() => {
      const element = inputRef.current;
      const popup = popupRef.current;
      const container = uploadRef.current;
      const input = fileInputRef.current;
      if (!element || !popup || !container || !input) return;
      const editor = createMentionEditor({
        element,
        popup,
        getMentionables: () => propsRef.current.mentionables,
        getLabels: () => ({
          suggestions: translateRef.current("mentionList"),
          mention: translateRef.current("mentionNamed", { name: "{name}" }),
          role: translateRef.current("role"),
          everyone: translateRef.current("everyone"),
          here: translateRef.current("here"),
          online: translateRef.current("online"),
          offline: translateRef.current("offline"),
        }),
        onChange(value) {
          setBody(value.body);
          if (!restoringRef.current) scheduleDraft();
        },
        onSubmit() {
          void submit();
        },
        onFiles(files) {
          managerRef.current?.addFiles(files);
        },
      });
      editorRef.current = editor;
      const manager = createAttachmentManager({
        container,
        input,
        getSession: () => propsRef.current.session,
        request: (route, init) =>
          propsRef.current.request
            ? propsRef.current.request(route, init)
            : fetch(route, {
                ...init,
                headers: {
                  ...init?.headers,
                  Authorization: `Bearer ${propsRef.current.session?.access_token}`,
                },
                credentials: "omit",
                redirect: "error",
                cache: "no-store",
              }),
        getScope: () =>
          propsRef.current.requestScope ??
          `${propsRef.current.session?.user_id}/${propsRef.current.session?.access_token}`,
        onChange(files) {
          setUploads(files);
          if (!restoringRef.current) scheduleDraft();
        },
        onError(message) {
          propsRef.current.onError(message);
        },
        maxBytes: propsRef.current.limits?.maxBytes,
        maxFiles: propsRef.current.limits?.maxPerMessage,
      });
      managerRef.current = manager;
      const beforeUnload = () => saveDraft();
      window.addEventListener("beforeunload", beforeUnload);
      return () => {
        saveDraft();
        window.removeEventListener("beforeunload", beforeUnload);
        clearTimeout(saveTimer.current);
        editor.destroy();
        manager.destroy();
        editorRef.current = null;
        managerRef.current = null;
      };
    }, []);

    useEffect(() => {
      const manager = managerRef.current;
      const editor = editorRef.current;
      if (!manager || !editor) return;
      saveDraft();
      let draft = contextKey ? readStored<Draft>(contextKey) : null;
      if (!draft && contextKey && props.legacyDraftKey) {
        draft = readStored<Draft>(props.legacyDraftKey);
        if (draft) {
          sessionStorage.setItem(contextKey, JSON.stringify(draft));
          sessionStorage.removeItem(props.legacyDraftKey);
        }
      }
      contextRef.current = contextKey;
      restoringRef.current = true;
      manager.setContext(contextKey);
      if (!restoredContexts.current.has(contextKey)) {
        manager.restore(draft?.attachments ?? []);
        restoredContexts.current.add(contextKey);
      }
      editor.setValue(props.pending?.body ?? draft?.body ?? "");
      const incomplete = manager.getState().length
        ? []
        : (draft?.interrupted ?? []);
      interruptedRef.current = incomplete;
      setInterrupted(incomplete);
      const storedReply =
        props.pending?.replyTo ?? draft?.reply?.eventId ?? draft?.replyTo;
      const reply = storedReply
        ? draft?.reply?.eventId === storedReply
          ? draft.reply
          : {
              eventId: storedReply,
              senderName: translateRef.current("previous"),
              body: "",
            }
        : null;
      const mention =
        props.pending?.replyMention ?? draft?.replyMention ?? true;
      draftReplyRef.current = { reply, mention };
      propsRef.current.onRestoreReply?.(reply, mention);
      restoringRef.current = false;
      const controller = new AbortController();
      for (const id of props.pending?.attachments ?? []) {
        if (manager.getReady().some((file) => file.id === id) || !props.session)
          continue;
        void (props.request ?? fetch)(
          `/api/attachments/${encodeURIComponent(id)}/metadata`,
          {
            ...(!props.request
              ? {
                  headers: {
                    Authorization: `Bearer ${props.session.access_token}`,
                  },
                }
              : {}),
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
          },
        )
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json() as Promise<{ attachment: Attachment }>;
          })
          .then(({ attachment }) => {
            if (contextRef.current === contextKey)
              manager.restore([attachment]);
          })
          .catch((error) => {
            if (!controller.signal.aborted)
              propsRef.current.onError(String(error));
          });
      }
      return () => controller.abort();
    }, [contextKey]);

    useEffect(() => {
      const disabled =
        !props.session ||
        !props.room ||
        props.sending ||
        Boolean(props.pending);
      editorRef.current?.setDisabled(disabled);
      managerRef.current?.setDisabled(disabled);
      editorRef.current?.setPlaceholder(
        props.session
          ? t("message", {
              room: `${props.room?.kind === "direct" ? "@" : "#"}${props.room?.name ?? ""}`,
            })
          : t("signInMessage"),
      );
      popupRef.current?.setAttribute("aria-label", t("mentionList"));
      editorRef.current?.refresh();
    }, [
      props.session,
      props.sending,
      props.pending,
      props.room?.name,
      props.mentionables,
      t,
    ]);

    useEffect(() => {
      scheduleDraft();
    }, [props.reply, props.replyMention]);

    useEffect(() => {
      const target = formRef.current?.closest(".conversation");
      if (!target) return;
      let entered = 0;
      const hasFiles = (event: DragEvent) =>
        Array.from(event.dataTransfer?.types ?? []).includes("Files");
      const enter = (event: Event) => {
        const drag = event as DragEvent;
        if (!hasFiles(drag) || !propsRef.current.session) return;
        drag.preventDefault();
        entered++;
        setDragging(true);
      };
      const over = (event: Event) => {
        const drag = event as DragEvent;
        if (hasFiles(drag)) drag.preventDefault();
      };
      const leave = (event: Event) => {
        if (!hasFiles(event as DragEvent)) return;
        entered = Math.max(0, entered - 1);
        if (!entered) setDragging(false);
      };
      const drop = (event: Event) => {
        const drag = event as DragEvent;
        if (!hasFiles(drag)) return;
        drag.preventDefault();
        entered = 0;
        setDragging(false);
        if (drag.dataTransfer)
          managerRef.current?.addFiles(drag.dataTransfer.files);
      };
      const end = () => {
        entered = 0;
        setDragging(false);
      };
      target.addEventListener("dragenter", enter);
      target.addEventListener("dragover", over);
      target.addEventListener("dragleave", leave);
      target.addEventListener("drop", drop);
      window.addEventListener("dragend", end);
      return () => {
        target.removeEventListener("dragenter", enter);
        target.removeEventListener("dragover", over);
        target.removeEventListener("dragleave", leave);
        target.removeEventListener("drop", drop);
        window.removeEventListener("dragend", end);
      };
    }, []);

    const disabled =
      !props.session || !props.room || props.sending || Boolean(props.pending);
    const unready =
      uploads.some((file) => file.status !== "ready") || interrupted.length > 0;
    const hasReady = uploads.some((file) => file.status === "ready");
    const canSend =
      Boolean(props.session && props.room) &&
      props.canSend !== false &&
      !props.sending &&
      body.length <= 16000 &&
      (Boolean(props.pending) ||
        (!unready && (Boolean(body.trim()) || hasReady)));
    const sendLabel = props.sending
      ? t("sending")
      : props.pending
        ? t("retry")
        : t("send");

    return (
      <>
        <form
          id="composer-form"
          className="composer-area"
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div
            id="reply-preview"
            className="reply-preview"
            hidden={!props.reply}
          >
            <div className="reply-copy">
              <span>{t("replying", { name: "" })}</span>
              <strong id="reply-preview-name">{props.reply?.senderName}</strong>
              <span id="reply-preview-body">{props.reply?.body}</span>
            </div>
            <Button
              variant="ghost"
              id="reply-mention-toggle"
              className="reply-mention-toggle"
              type="button"
              aria-pressed={props.replyMention}
              disabled={disabled}
              onClick={() => props.onReplyMention(!props.replyMention)}
            >
              {props.replyMention ? t("replyOn") : t("replyOff")}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              id="clear-reply"
              className="icon-button"
              type="button"
              aria-label={t("clearReply")}
              disabled={disabled}
              onClick={props.onClearReply}
            >
              <Icon name="close" />
            </Button>
          </div>
          <div id="composer-box" className="composer-box">
            <div
              id="upload-list"
              className="upload-list"
              ref={uploadRef}
              aria-label={t("uploads")}
              hidden
            />
            <div
              id="interrupted-files"
              className="interrupted-files"
              hidden={!interrupted.length}
            >
              <span>
                {t("interrupted", {
                  files: interrupted.map((file) => file.name).join(", "),
                })}
              </span>
              <Button
                variant="ghost"
                className="text-button"
                type="button"
                onClick={() => {
                  interruptedRef.current = [];
                  setInterrupted([]);
                  scheduleDraft();
                }}
              >
                {t("remove")}
              </Button>
            </div>
            <div
              id="mention-popup"
              className="mention-popup"
              ref={popupRef}
              hidden
            />
            <div className="composer-input-row">
              <Button
                variant="ghost"
                size="icon"
                id="attach-button"
                className="attach-button"
                type="button"
                aria-label={t("attach")}
                title={t("attach")}
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="plus" />
              </Button>
              <FileInput
                id="attachment-input"
                ref={fileInputRef}
                multiple
                hidden
              />
              <div
                id="message-input"
                ref={inputRef}
                className="message-input"
                contentEditable={false}
                suppressContentEditableWarning
                spellCheck
                aria-label={t("message", { room: props.room?.name ?? "" })}
              />
              {props.isWorking && (
                <span
                  className="composer-activity"
                  role="status"
                  aria-label={t("working")}
                  title={t("working")}
                >
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                id="send-button"
                className="send-button"
                type="submit"
                title={sendLabel}
                aria-label={sendLabel}
                disabled={!canSend}
              >
                <span id="send-button-text" className="sr-only">
                  {sendLabel}
                </span>
                <Icon name="send" />
              </Button>
            </div>
          </div>
          <div className="composer-footer">
            <span id="composer-help">
              {props.pending ? t("pending") : t("help")}
            </span>
            <span
              id="composer-count"
              className={body.length > 16000 ? "error-text" : ""}
            >
              {body.length > 15000 ? `${body.length} / 16000` : ""}
            </span>
          </div>
        </form>
        <div id="drop-overlay" className="drop-overlay" hidden={!dragging}>
          <strong>{t("drop")}</strong>
        </div>
      </>
    );
  },
);
