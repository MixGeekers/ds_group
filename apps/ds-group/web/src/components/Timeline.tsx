import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { formatDate, formatDateTime, formatTime } from "../../i18n.js";
import {
  displayMentionText,
  mentionKindsFor,
  parseMentionTokens,
} from "../../mention-tokens.js";
import { useTranslation } from "../locale";
import { chatMessages } from "../locales/chat";
import type {
  ChatEvent,
  Mentionables,
  Participant,
  Role,
  RawRequest,
  Session,
} from "../types";
import { AttachmentView } from "./AttachmentView";
import { Icon } from "./Icons";

export interface TimelineProps {
  events: ChatEvent[];
  participants: Participant[];
  session: Session | null;
  request?: RawRequest;
  allowLegacyMedia?: boolean;
  mentionables: Mentionables;
  roles: Role[];
  onReply(event: ChatEvent): void;
  onMember(id: string): void;
  onRole?(): void;
  onJump(eventId: string): void;
  onRead(eventId: string): void;
}

function formattedText(text: string): ReactNode[] {
  const output: ReactNode[] = [];
  const expression =
    /```(?:[\w+-]*\n)?([\s\S]*?)```|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>]+)/g;
  let offset = 0;
  for (const match of text.matchAll(expression)) {
    output.push(text.slice(offset, match.index));
    if (match[1] !== undefined)
      output.push(
        <pre key={match.index} className="message-code">
          {match[1]}
        </pre>,
      );
    else if (match[2] !== undefined)
      output.push(
        <code key={match.index} className="inline-code">
          {match[2]}
        </code>,
      );
    else if (match[3] !== undefined)
      output.push(<strong key={match.index}>{match[3]}</strong>);
    else
      output.push(
        <a
          key={match.index}
          className="message-link"
          href={match[4]}
          target="_blank"
          rel="noopener noreferrer"
        >
          {match[4]}
        </a>,
      );
    offset = match.index + match[0].length;
  }
  output.push(text.slice(offset));
  return output;
}

export function Timeline(props: TimelineProps) {
  const t = useTranslation(chatMessages);
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const latestProps = useRef(props);
  latestProps.current = props;
  const [showJump, setShowJump] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const roleList = [
    ...new Map(
      [...props.roles, ...props.mentionables.roles].map((role) => [
        role.id,
        role,
      ]),
    ).values(),
  ];

  function displayName(id: string) {
    return (
      props.participants.find((person) => person.id === id)?.name ??
      id.split(":")[0]?.replace(/^@/, "") ??
      id
    );
  }

  function readLatest() {
    const latest = latestProps.current.events.at(-1);
    if (
      latest &&
      nearBottom.current &&
      !document.hidden &&
      latestProps.current.session
    )
      latestProps.current.onRead(latest.event_id);
  }

  function onScroll() {
    const element = container.current;
    if (!element) return;
    nearBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    setShowJump(!nearBottom.current);
    readLatest();
  }

  function scrollToBottom() {
    const element = container.current;
    if (!element) return;
    nearBottom.current = true;
    element.scrollTop = element.scrollHeight;
    setShowJump(false);
    readLatest();
  }

  useLayoutEffect(() => {
    if (nearBottom.current) scrollToBottom();
  }, [props.events]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) scrollToBottom();
    });
    if (list.current) observer.observe(list.current);
    const visible = () => readLatest();
    document.addEventListener("visibilitychange", visible);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visible);
      clearTimeout(copyTimer.current);
    };
  }, []);

  async function copy(body: string) {
    try {
      await navigator.clipboard.writeText(
        displayMentionText(body, props.participants, roleList),
      );
      setCopyStatus(t("copied"));
    } catch {
      setCopyStatus(t("copyFailed"));
    }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyStatus(""), 3000);
  }

  function richText(
    body: string,
    roleLabels: Record<string, string> = {},
  ): ReactNode[] {
    const parts: ReactNode[] = [];
    let offset = 0;
    for (const token of parseMentionTokens(body).tokens) {
      parts.push(
        <Fragment key={`text-${token.start}`}>
          {formattedText(body.slice(offset, token.start))}
        </Fragment>,
      );
      const className = `mention-tag mention-${token.kind}`;
      if (token.kind === "user" && token.id) {
        const id = token.id;
        parts.push(
          <button
            key={`mention-${token.start}`}
            className={className}
            type="button"
            onClick={() => props.onMember(id)}
          >
            @{displayName(id)}
          </button>,
        );
      } else if (token.kind === "role" && token.id) {
        const label =
          roleList.find((role) => role.id === token.id)?.name ??
          roleLabels[token.id] ??
          t("role");
        parts.push(
          props.onRole ? (
            <button
              key={`mention-${token.start}`}
              className={className}
              type="button"
              onClick={props.onRole}
            >
              @{label}
            </button>
          ) : (
            <span key={`mention-${token.start}`} className={className}>
              @{label}
            </span>
          ),
        );
      } else
        parts.push(
          <span key={`mention-${token.start}`} className={className}>
            @{token.kind}
          </span>,
        );
      offset = token.end;
    }
    parts.push(
      <Fragment key="remaining">{formattedText(body.slice(offset))}</Fragment>,
    );
    return parts;
  }

  return (
    <>
      <div
        id="timeline"
        ref={container}
        className="timeline"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={onScroll}
      >
        {!props.events.length && (
          <div id="empty-state" className="empty-state">
            <h2>{t("empty")}</h2>
            {!props.session && <p id="empty-description">{t("signedOut")}</p>}
          </div>
        )}
        <div id="message-list" ref={list}>
          {props.events.map((event, index) => {
            const previous = props.events[index - 1];
            const day = formatDate(event.origin_server_ts);
            const sameDay =
              previous && formatDate(previous.origin_server_ts) === day;
            const metadata = event.content["org.ds_group"];
            const quoteId =
              metadata?.replyTo ??
              event.content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
            const grouped =
              sameDay &&
              previous.sender === event.sender &&
              !quoteId &&
              event.origin_server_ts - previous.origin_server_ts < 300000;
            const person = props.participants.find(
              (member) => member.id === event.sender,
            );
            const name = displayName(event.sender);
            const quote = props.events.find(
              (item) => item.event_id === quoteId,
            );
            const attachments = metadata?.attachments ?? [];
            const showBody =
              event.content.body &&
              !attachments.some((file) => file.name === event.content.body);
            const mentioned =
              event.sender !== props.session?.user_id &&
              mentionKindsFor(event, props.session?.user_id).length > 0;
            const className = `message ${person?.kind === "bot" ? "bot" : "human"}${grouped ? " grouped" : ""}${mentioned ? " mentioned" : ""}`;
            return (
              <Fragment key={event.event_id}>
                {!sameDay && <div className="date-separator">{day}</div>}
                <article className={className} data-event-id={event.event_id}>
                  <button
                    className="message-avatar-button"
                    type="button"
                    aria-label={t("profile", { name })}
                    onClick={() => props.onMember(event.sender)}
                  >
                    <span
                      className={`avatar avatar-${person?.kind === "bot" ? "bot" : "human"}${props.participants.findIndex((member) => member.id === event.sender) % 2 ? " avatar-alternate" : ""}`}
                    >
                      {[...name][0]}
                    </span>
                  </button>
                  <div className="message-content">
                    <div className="message-meta">
                      <button
                        className="message-name"
                        type="button"
                        onClick={() => props.onMember(event.sender)}
                      >
                        {name}
                      </button>
                      {person?.kind === "bot" && (
                        <span className="message-kind">BOT</span>
                      )}
                      <time
                        className="message-time"
                        title={formatDateTime(event.origin_server_ts)}
                      >
                        {formatTime(event.origin_server_ts)}
                      </time>
                    </div>
                    {quoteId && (
                      <button
                        className="message-quote"
                        type="button"
                        onClick={() => props.onJump(quoteId)}
                      >
                        <Icon name="reply" />
                        <span>
                          {quote
                            ? `${displayName(quote.sender)}　${displayMentionText(quote.content.body, props.participants, roleList)}`
                            : t("previous")}
                        </span>
                      </button>
                    )}
                    {showBody && (
                      <div className="message-bubble">
                        {richText(
                          event.content.body,
                          metadata?.mentions?.roleLabels,
                        )}
                      </div>
                    )}
                    {attachments.length > 0 && (
                      <div className="message-attachments">
                        {attachments.map((attachment) => (
                          <AttachmentView
                            key={attachment.id}
                            attachment={attachment}
                            session={props.session}
                            request={props.request}
                            roomId={event.room_id}
                            eventId={event.event_id}
                            allowLegacy={props.allowLegacyMedia}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="message-actions">
                    <button
                      className="message-action"
                      type="button"
                      title={t("reply")}
                      aria-label={t("replyNamed", { name })}
                      onClick={() => props.onReply(event)}
                    >
                      <Icon name="reply" />
                    </button>
                    <button
                      className="message-action"
                      type="button"
                      title={t("copy")}
                      aria-label={t("copy")}
                      onClick={() => void copy(event.content.body)}
                    >
                      <Icon name="copy" />
                    </button>
                  </div>
                </article>
              </Fragment>
            );
          })}
        </div>
      </div>
      <button
        id="jump-latest"
        className="jump-latest"
        type="button"
        hidden={!showJump}
        onClick={scrollToBottom}
      >
        {t("latest")} <Icon name="arrowDown" />
      </button>
      {copyStatus && (
        <div className="toast" role="status">
          {copyStatus}
        </div>
      )}
    </>
  );
}
