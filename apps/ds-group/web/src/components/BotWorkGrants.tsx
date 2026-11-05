import { useEffect, useRef, useState } from "react";
import { ApiError, messageOf } from "../api";
import {
  equalWorkGrants,
  fileTools,
  parseWorkGrants,
} from "../bot-work-grants";
import type { BotWorkGrant, BotWorkGrantDocument } from "../bot-work-grants";
import { sessionIdentity } from "../session";
import { useTranslation } from "../locale";
import { workGrantMessages } from "../locales/work-grants";
import type { Api, Participant, Room, Session } from "../types";

export function BotWorkGrants({
  bot,
  session,
  api,
  rooms,
  participants,
  onBack,
}: {
  bot: Participant;
  session: Session | null;
  api: Api;
  rooms: Room[];
  participants: Participant[];
  onBack(): void;
}) {
  const t = useTranslation(workGrantMessages);
  const owned = bot.kind === "bot" && bot.ownerId === session?.user_id;
  const context = `${sessionIdentity(session)}/${bot.id}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [document, setDocument] = useState<BotWorkGrantDocument | null>(null);
  const [grants, setGrants] = useState<BotWorkGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(false);
  const [feedback, setFeedback] = useState("");
  const route = `/api/bots/${encodeURIComponent(bot.id)}/work-grants`;
  async function load() {
    controller.current?.abort();
    const operation = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setFeedback("");
    try {
      const next = parseWorkGrants(await api(route, { signal: abort.signal }));
      if (
        contextRef.current !== context ||
        generation.current !== operation ||
        abort.signal.aborted
      )
        return;
      setDocument(next);
      setGrants(next.grants);
      setLocked(false);
    } catch (reason) {
      if (
        contextRef.current !== context ||
        generation.current !== operation ||
        abort.signal.aborted
      )
        return;
      setLocked(true);
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) {
        setDocument(null);
        setGrants([]);
        setFeedback(t("denied", { error: messageOf(reason) }));
      } else
        setFeedback(
          reason instanceof ApiError && reason.status === 404
            ? t("unsupported")
            : t("failed", { error: messageOf(reason) }),
        );
    } finally {
      if (contextRef.current === context && generation.current === operation)
        setLoading(false);
    }
  }
  useEffect(() => {
    setDocument(null);
    setGrants([]);
    setFeedback("");
    setLocked(false);
    if (owned) void load();
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [context, owned, api]);
  async function save() {
    if (!owned || !document || loading || saving || locked) return;
    const known = new Set(rooms.map((room) => room.roomId));
    const old = new Map(document.grants.map((grant) => [grant.roomId, grant]));
    let next: BotWorkGrantDocument;
    try {
      if (
        grants.some(
          (grant) => !known.has(grant.roomId) && !old.has(grant.roomId),
        )
      )
        throw new Error(t("invalid"));
      if (
        grants.some(
          (grant) =>
            grant.enabled &&
            (!grant.requesterIds.length || !grant.tools.length),
        )
      )
        throw new Error(t("emptyPermission"));
      next = parseWorkGrants({ revision: document.revision, grants });
    } catch (reason) {
      setFeedback(messageOf(reason));
      return;
    }
    const operation = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setSaving(true);
    setFeedback("");
    try {
      const receipt = parseWorkGrants(
        await api(route, { method: "PUT", body: next, signal: abort.signal }),
      );
      if (
        contextRef.current !== context ||
        generation.current !== operation ||
        abort.signal.aborted
      )
        return;
      if (
        receipt.revision !== next.revision + 1 ||
        !equalWorkGrants(receipt, next)
      )
        throw new Error(t("uncertain"));
      setDocument(receipt);
      setGrants(receipt.grants);
      setFeedback(t("saved"));
    } catch (reason) {
      if (
        contextRef.current !== context ||
        generation.current !== operation ||
        abort.signal.aborted
      )
        return;
      setLocked(true);
      setFeedback(
        reason instanceof ApiError && reason.status === 409
          ? t("conflict")
          : reason instanceof ApiError && [401, 403].includes(reason.status)
            ? t("denied", { error: messageOf(reason) })
            : t("uncertain"),
      );
    } finally {
      if (contextRef.current === context && generation.current === operation)
        setSaving(false);
    }
  }
  function update(index: number, change: Partial<BotWorkGrant>) {
    setGrants((previous) =>
      previous.map((grant, current) =>
        current === index ? { ...grant, ...change } : grant,
      ),
    );
    setFeedback("");
  }
  if (!owned) return null;
  const busy = loading || saving;
  const dirty =
    document && JSON.stringify(grants) !== JSON.stringify(document.grants);
  const editable = !busy && !!document && !locked;
  return (
    <section className="bot-work-grants" data-bot-work-grants={bot.id}>
      <button
        className="text-button"
        type="button"
        disabled={saving}
        onClick={onBack}
      >
        {t("back")}
      </button>
      <h3>
        {bot.name} · {t("title")}
      </h3>
      <p className="identity-value">{bot.id}</p>
      <p className="muted">{t("help")}</p>
      <p className="muted small">
        {document && t("revision", { revision: document.revision })}
        {dirty ? ` · ${t("dirty")}` : ""}
      </p>
      {loading && <p role="status">{t("loading")}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="work-grant-list">
          {grants.map((grant, index) => {
            const room = rooms.find((room) => room.roomId === grant.roomId);
            const currentIds = new Set(
              room?.participantIds.filter((id) =>
                participants.some(
                  (person) => person.id === id && person.kind === "human",
                ),
              ) ?? [],
            );
            const requesters = [
              ...new Set([...currentIds, ...grant.requesterIds]),
            ];
            return (
              <fieldset
                className="work-grant-row"
                key={index}
                disabled={!editable}
                data-grant-room={grant.roomId}
              >
                <legend>{room?.name ?? (grant.roomId || t("choose"))}</legend>
                <label htmlFor={`work-grant-room-${index}`}>{t("room")}</label>
                <select
                  id={`work-grant-room-${index}`}
                  value={grant.roomId}
                  disabled={!editable || (!!grant.roomId && !room)}
                  onChange={(event) =>
                    update(index, {
                      roomId: event.target.value,
                      requesterIds: [],
                      tools: [],
                      enabled: false,
                    })
                  }
                >
                  <option value="">{t("choose")}</option>
                  {!!grant.roomId && !room && (
                    <option value={grant.roomId}>{grant.roomId}</option>
                  )}
                  {rooms
                    .filter(
                      (room) =>
                        room.roomId === grant.roomId ||
                        !grants.some((other) => other.roomId === room.roomId),
                    )
                    .map((room) => (
                      <option value={room.roomId} key={room.roomId}>
                        {room.serverId ? `${room.serverId} · ` : ""}
                        {room.name} · {room.roomId}
                      </option>
                    ))}
                </select>
                {!!grant.roomId && !room && (
                  <p className="muted small">{t("unavailableRoom")}</p>
                )}
                <label className="check-label">
                  <input
                    type="checkbox"
                    data-grant-enabled
                    checked={grant.enabled}
                    disabled={!editable || (!room && !grant.enabled)}
                    onChange={(event) =>
                      update(index, { enabled: event.target.checked })
                    }
                  />
                  {t("enabled")}
                </label>
                <h4>{t("requesters")}</h4>
                {!requesters.length && (
                  <p className="muted small">{t("noPeople")}</p>
                )}
                <div className="work-grant-people">
                  {requesters.map((id) => (
                    <label className="check-label" key={id}>
                      <input
                        type="checkbox"
                        data-grant-requester={id}
                        checked={grant.requesterIds.includes(id)}
                        disabled={
                          !editable ||
                          (!currentIds.has(id) &&
                            !grant.requesterIds.includes(id))
                        }
                        onChange={(event) =>
                          update(index, {
                            requesterIds: event.target.checked
                              ? [...grant.requesterIds, id]
                              : grant.requesterIds.filter(
                                  (value) => value !== id,
                                ),
                          })
                        }
                      />
                      <span>
                        {participants.find((person) => person.id === id)
                          ?.name ?? id}
                        <small className="member-full-id">{id}</small>
                        {!currentIds.has(id) && (
                          <small className="member-full-id">
                            {t("unavailableMember")}
                          </small>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
                <h4>{t("tools")}</h4>
                <div className="work-grant-tools">
                  {fileTools.map((tool) => (
                    <label className="check-label" key={tool}>
                      <input
                        type="checkbox"
                        data-grant-tool={tool}
                        checked={grant.tools.includes(tool)}
                        disabled={!editable || !room}
                        onChange={(event) =>
                          update(index, {
                            tools: event.target.checked
                              ? [...grant.tools, tool]
                              : grant.tools.filter((value) => value !== tool),
                          })
                        }
                      />
                      {t(tool)}
                    </label>
                  ))}
                </div>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setGrants((previous) =>
                      previous.filter((_, current) => current !== index),
                    );
                    setFeedback("");
                  }}
                >
                  {t("remove")}
                </button>
              </fieldset>
            );
          })}
        </div>
        <div className="settings-actions">
          <button
            id="add-work-grant"
            className="secondary-button"
            type="button"
            disabled={
              !editable ||
              rooms.every((room) =>
                grants.some((grant) => grant.roomId === room.roomId),
              )
            }
            onClick={() =>
              setGrants((previous) => [
                ...previous,
                { roomId: "", requesterIds: [], tools: [], enabled: false },
              ])
            }
          >
            {t("add")}
          </button>
          <button
            id="save-work-grants"
            className="primary-button"
            type="submit"
            disabled={!editable || !dirty}
          >
            {t(saving ? "saving" : "save")}
          </button>
          <button
            id="reload-work-grants"
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => void load()}
          >
            {t("reload")}
          </button>
        </div>
        {!rooms.length && <p className="muted small">{t("noRooms")}</p>}
      </form>
      <p id="work-grant-feedback" className="settings-feedback" role="status">
        {feedback}
      </p>
    </section>
  );
}
