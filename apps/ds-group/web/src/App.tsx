import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApi, messageOf, readStored } from "./api";
import { useTranslation } from "./locale";
import { appMessages } from "./locales/app";
import { Shell } from "./components/Shell";
import {
  LoginDialog,
  MemberDialog,
  RoomDialog,
} from "./components/BasicDialogs";
import { Composer } from "./components/Composer";
import { Timeline } from "./components/Timeline";
import { TaskHistoryDialog } from "./components/TaskTray";
import { SettingsDialog } from "./components/SettingsDialog";
import { InboxDialog } from "./components/InboxDialog";
import { NotificationDialog } from "./components/NotificationDialog";
import type {
  Bootstrap,
  ChatEvent,
  ComposerHandle,
  InboxResult,
  Mentionables,
  OutgoingMessage,
  Participant,
  PwaHandle,
  ReplyTarget,
  Role,
  Room,
  ServerStatus,
  Session,
  SettingsTab,
  WorkTask,
} from "./types";

const SESSION_KEY = "ds-group.session";
const WORKSPACE_KEY = "ds-group.workspace";
const emptyMentions: Mentionables = {
  members: [],
  roles: [],
  canMentionEveryone: false,
  canMentionHere: false,
};
const pendingKey = (userId: string, roomId: string) =>
  `ds-group.pending.${userId}.${roomId}`;

function savedSession(): Session | null {
  const value = readStored<Session>(SESSION_KEY);
  return value?.access_token && value?.user_id ? value : null;
}

function mergeEvents(
  previous: ChatEvent[],
  incoming: ChatEvent[],
): ChatEvent[] {
  const known = new Map(previous.map((event) => [event.event_id, event]));
  for (const event of incoming) {
    if (
      !event.event_id ||
      event.type !== "m.room.message" ||
      typeof event.content?.body !== "string"
    )
      continue;
    const current = known.get(event.event_id);
    if (!current || JSON.stringify(current) !== JSON.stringify(event))
      known.set(event.event_id, event);
  }
  const result = [...known.values()].sort(
    (left, right) => left.origin_server_ts - right.origin_server_ts,
  );
  return result.length === previous.length &&
    result.every((event, index) => event === previous[index])
    ? previous
    : result;
}

export default function App() {
  const t = useTranslation(appMessages);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(() =>
    readStored<Bootstrap>(WORKSPACE_KEY),
  );
  const [session, setSession] = useState<Session | null>(savedSession);
  const [rooms, setRooms] = useState<Room[]>(() => {
    const account = savedSession();
    return account
      ? readStored<Room[]>(`ds-group.rooms.${account.user_id}`) || []
      : [];
  });
  const [roomId, setRoomId] = useState<string | null>(() => {
    const requested = new URL(location.href).searchParams.get("roomId");
    const account = savedSession();
    return (
      requested ||
      (account
        ? readStored<string>(`ds-group.room.${account.user_id}`)
        : null) ||
      readStored<Bootstrap>(WORKSPACE_KEY)?.roomId ||
      null
    );
  });
  const [ownedBots, setOwnedBots] = useState<Participant[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [mentionables, setMentionables] = useState<Mentionables>(emptyMentions);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [mentionCount, setMentionCount] = useState(0);
  const [view, setView] = useState<"home" | "chat">("chat");
  const [showTaskHistory, setShowTaskHistory] = useState(false);
  const [loginOpen, setLoginOpen] = useState(!session);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [roomDialog, setRoomDialog] = useState<"create" | "invite" | null>(
    null,
  );
  const [inboxOpen, setInboxOpen] = useState(false);
  const [notificationRoom, setNotificationRoom] = useState<Room | null>(null);
  const [member, setMember] = useState<Participant | null>(null);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [replyMention, setReplyMention] = useState(true);
  const currentPendingKey =
    session && roomId ? pendingKey(session.user_id, roomId) : "";
  const [pendingState, setPendingState] = useState(() => ({
    key: currentPendingKey,
    message: currentPendingKey
      ? readStored<OutgoingMessage>(currentPendingKey)
      : null,
  }));
  const pending =
    pendingState.key === currentPendingKey
      ? pendingState.message
      : currentPendingKey
        ? readStored<OutgoingMessage>(currentPendingKey)
        : null;
  const [sending, setSending] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [jump, setJump] = useState<{ roomId: string; eventId: string } | null>(
    null,
  );
  const composer = useRef<ComposerHandle>(null);
  const pwa = useRef<PwaHandle | null>(null);
  const sessionRef = useRef(session);
  const roomRef = useRef(roomId);
  const sendingRef = useRef(sending);
  const suppressReadUntil = useRef(0);
  const lastRead = useRef(new Map<string, string>());
  sessionRef.current = session;
  roomRef.current = roomId;
  sendingRef.current = sending;
  const api = useMemo(() => createApi(() => sessionRef.current), []);
  const participants = bootstrap?.participants ?? [];
  const room = rooms.find((value) => value.roomId === roomId) ?? null;

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), []);
  const notify = useCallback((message: string) => setToast(message), []);
  const openLogin = useCallback(() => {
    setLoginError("");
    setLoginOpen(true);
  }, []);
  const displayName = useCallback(
    (id: string) => participants.find((person) => person.id === id)?.name ?? id,
    [participants],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let stopped = false;
    void api<Bootstrap>("/api/bootstrap", { auth: false })
      .then((value) => {
        if (!value.roomId || !Array.isArray(value.participants))
          throw new Error(t("invalidWorkspace"));
        if (stopped) return;
        setBootstrap(value);
        sessionStorage.setItem(WORKSPACE_KEY, JSON.stringify(value));
        setRooms((previous) =>
          previous.length
            ? previous
            : [
                {
                  roomId: value.roomId,
                  name: value.roomName || t("initialRoom"),
                  kind: "group",
                  participantIds: value.participants.map((person) => person.id),
                },
              ],
        );
        const target = new URL(location.href).searchParams;
        setRoomId(
          (previous) => previous || target.get("roomId") || value.roomId,
        );
        const targetEvent = target.get("eventId");
        if (targetEvent)
          setJump({
            roomId: target.get("roomId") || value.roomId,
            eventId: targetEvent,
          });
        setError("");
      })
      .catch((reason) => {
        if (!stopped) setError(messageOf(reason));
      });
    return () => {
      stopped = true;
    };
  }, [api, bootstrapNonce]);

  useEffect(() => {
    setPendingState({
      key: currentPendingKey,
      message: currentPendingKey
        ? readStored<OutgoingMessage>(currentPendingKey)
        : null,
    });
  }, [currentPendingKey]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let cycle = 0;
    const currentSession = session;
    const currentRoomId = roomId;
    async function poll() {
      const jobs: Promise<void>[] = [
        api<ServerStatus>("/api/status", { auth: false }).then((value) => {
          if (!stopped) setStatus(value);
        }),
      ];
      if (currentSession) {
        jobs.push(
          api<{ rooms: Room[] }>("/api/rooms").then((value) => {
            if (stopped) return;
            setRooms(value.rooms);
            sessionStorage.setItem(
              `ds-group.rooms.${currentSession.user_id}`,
              JSON.stringify(value.rooms),
            );
            if (
              currentRoomId &&
              !value.rooms.some((item) => item.roomId === currentRoomId) &&
              value.rooms.length
            )
              setRoomId(value.rooms[0].roomId);
          }),
        );
        jobs.push(
          api<{ bots: Participant[] }>("/api/bots").then((value) => {
            if (!stopped) setOwnedBots(value.bots);
          }),
        );
        jobs.push(
          api<InboxResult>("/api/inbox?filter=mentions&limit=1").then(
            (value) => {
              if (!stopped) setMentionCount(value.mentionCount);
            },
          ),
        );
        if (currentRoomId) {
          const base = `/api/rooms/${encodeURIComponent(currentRoomId)}`;
          jobs.push(
            api<{ events: ChatEvent[] }>(`${base}/messages?limit=200`).then(
              (value) => {
                if (!stopped)
                  setEvents((previous) => mergeEvents(previous, value.events));
              },
            ),
          );
          jobs.push(
            api<{ tasks: WorkTask[] }>(`${base}/tasks`).then((value) => {
              if (!stopped) setTasks(value.tasks);
            }),
          );
          if (cycle % 4 === 0)
            jobs.push(
              api<Mentionables>(`${base}/mentionables`).then((value) => {
                if (!stopped) setMentionables(value);
              }),
            );
        }
        if (cycle % 4 === 0) {
          jobs.push(
            api<{ roles: Role[] }>("/api/roles").then((value) => {
              if (!stopped) setRoles(value.roles);
            }),
          );
          jobs.push(
            api("/api/presence", {
              method: "POST",
              body: { status: document.hidden ? "idle" : "online" },
            }).then(() => {}),
          );
        }
      }
      const results = await Promise.allSettled(jobs);
      if (stopped) return;
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        if (
          failure.reason instanceof ApiError &&
          failure.reason.status === 401 &&
          currentSession
        ) {
          sessionStorage.removeItem(SESSION_KEY);
          setSession(null);
          setLoginOpen(true);
        } else setError(messageOf(failure.reason));
      } else setError("");
      cycle++;
      timer = setTimeout(() => void poll(), document.hidden ? 12000 : 2500);
    }
    void poll();
    const resume = () => {
      clearTimeout(timer);
      if (!stopped) {
        stopped = true;
        refresh();
      }
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [api, session, roomId, refreshNonce, refresh]);

  const selectRoom = useCallback((next: Room) => {
    if (sendingRef.current) return;
    if (next.roomId !== roomRef.current) {
      setEvents([]);
      setTasks([]);
      setMentionables(emptyMentions);
      setReply(null);
      setReplyMention(true);
      setShowTaskHistory(false);
    }
    setRooms((previous) =>
      previous.some((item) => item.roomId === next.roomId)
        ? previous
        : [...previous, next],
    );
    roomRef.current = next.roomId;
    setRoomId(next.roomId);
    setView("chat");
    const url = new URL(location.href);
    url.searchParams.set("roomId", next.roomId);
    url.searchParams.delete("eventId");
    history.replaceState(null, "", url);
    if (sessionRef.current)
      sessionStorage.setItem(
        `ds-group.room.${sessionRef.current.user_id}`,
        JSON.stringify(next.roomId),
      );
  }, []);

  const openDirect = useCallback(
    async (participantId: string) => {
      if (!sessionRef.current) {
        openLogin();
        return;
      }
      if (sendingRef.current) return;
      try {
        const result = await api<Room>("/api/dm", {
          method: "POST",
          body: { participantId },
        });
        selectRoom({
          ...result,
          kind: "direct",
          name: result.name || displayName(participantId),
          participantIds: result.participantIds || [
            sessionRef.current.user_id,
            participantId,
          ],
        });
      } catch (reason) {
        notify(messageOf(reason));
      }
    },
    [api, displayName, notify, openLogin, selectRoom],
  );

  async function login(user: string, password: string) {
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      if (bootstrap?.demoLogin === false && !password)
        throw new Error(t("passwordRequired"));
      const next = password
        ? await api<Session>("/api/login", {
            method: "POST",
            body: { user, password },
            auth: false,
          })
        : await api<Session>(
            `/api/demo-login?user=${encodeURIComponent(user)}`,
            { auth: false },
          );
      if (!next.access_token || !next.user_id)
        throw new Error(t("invalidLogin"));
      await pwa.current?.beforeIdentityChange(next.user_id);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      sessionRef.current = next;
      setSession(next);
      setEvents([]);
      setTasks([]);
      setRooms(
        bootstrap
          ? [
              {
                roomId: bootstrap.roomId,
                name: bootstrap.roomName || t("initialRoom"),
                kind: "group",
                participantIds: bootstrap.participants.map(
                  (person) => person.id,
                ),
              },
            ]
          : [],
      );
      const navigation = new URL(location.href).searchParams;
      const navigationRoomId =
        navigation.get("roomId") || bootstrap?.roomId || null;
      setRoomId(navigationRoomId);
      const eventId = navigation.get("eventId");
      if (eventId && navigationRoomId)
        setJump({
          roomId: navigationRoomId,
          eventId,
        });
      setOwnedBots([]);
      setRoles([]);
      setMentionables(emptyMentions);
      setReply(null);
      lastRead.current.clear();
      setLoginOpen(false);
      setView("chat");
      void pwa.current?.refresh();
    } catch (reason) {
      setLoginError(messageOf(reason));
    } finally {
      setLoginBusy(false);
    }
  }

  const sendMessage = useCallback(
    async (message: OutgoingMessage): Promise<boolean> => {
      const account = sessionRef.current;
      const targetRoom = roomRef.current;
      if (!account || !targetRoom || sendingRef.current) return false;
      const key = pendingKey(account.user_id, targetRoom);
      const outgoing = readStored<OutgoingMessage>(key) || message;
      sessionStorage.setItem(key, JSON.stringify(outgoing));
      setPendingState({ key, message: outgoing });
      setSending(true);
      sendingRef.current = true;
      try {
        const receipt = await api<{ event_id: string }>(
          `/api/rooms/${encodeURIComponent(targetRoom)}/messages`,
          { method: "POST", body: outgoing, timeout: 30000 },
        );
        if (!receipt.event_id) throw new Error(t("receiptPending"));
        sessionStorage.removeItem(key);
        sessionStorage.removeItem(
          `ds-group.draft.${account.user_id}.${targetRoom}`,
        );
        setPendingState({ key, message: null });
        setReply(null);
        setReplyMention(true);
        refresh();
        return true;
      } catch (reason) {
        if (
          reason instanceof ApiError &&
          reason.status >= 400 &&
          reason.status < 500 &&
          reason.status !== 429
        ) {
          sessionStorage.removeItem(key);
          setPendingState({ key, message: null });
        }
        notify(messageOf(reason));
        return false;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [api, notify, refresh, t],
  );

  const markRead = useCallback(
    async (eventId: string) => {
      const id = roomRef.current;
      if (
        !id ||
        !sessionRef.current ||
        view !== "chat" ||
        document.hidden ||
        Date.now() < suppressReadUntil.current ||
        lastRead.current.get(id) === eventId
      )
        return;
      try {
        await api(`/api/rooms/${encodeURIComponent(id)}/read`, {
          method: "POST",
          body: { eventId },
        });
        lastRead.current.set(id, eventId);
        setRooms((previous) =>
          previous.map((value) =>
            value.roomId === id
              ? { ...value, unreadCount: 0, mentionCount: 0 }
              : value,
          ),
        );
      } catch {
        /* The next visible timeline update retries this read position. */
      }
    },
    [api, view],
  );

  const jumpToEvent = useCallback(
    async (targetRoomId: string, eventId: string) => {
      let targetRoom = rooms.find((item) => item.roomId === targetRoomId);
      if (!targetRoom && sessionRef.current) {
        try {
          const result = await api<{ rooms: Room[] }>("/api/rooms");
          setRooms(result.rooms);
          targetRoom = result.rooms.find(
            (item) => item.roomId === targetRoomId,
          );
        } catch (reason) {
          notify(messageOf(reason));
          return;
        }
      }
      if (!targetRoom) {
        notify(t("notJoined"));
        return;
      }
      suppressReadUntil.current = Date.now() + 1500;
      selectRoom(targetRoom);
      setJump({ roomId: targetRoomId, eventId });
    },
    [rooms, selectRoom, notify, t, api],
  );

  useEffect(() => {
    if (!jump || roomId !== jump.roomId || !session) return;
    let stopped = false;
    const existing = document.querySelector<HTMLElement>(
      `[data-event-id="${CSS.escape(jump.eventId)}"]`,
    );
    if (existing) {
      existing.classList.add("notification-target");
      existing.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => existing.classList.remove("notification-target"), 3500);
      setJump(null);
      return;
    }
    void api<{ events: ChatEvent[] }>(
      `/api/rooms/${encodeURIComponent(jump.roomId)}/context/${encodeURIComponent(jump.eventId)}`,
    )
      .then((result) => {
        if (!stopped)
          setEvents((previous) => mergeEvents(previous, result.events));
      })
      .catch((reason) => {
        if (!stopped) {
          notify(messageOf(reason));
          setJump(null);
        }
      });
    return () => {
      stopped = true;
    };
  }, [jump, roomId, session, events, api, notify]);

  const openRoomFromNotification = useCallback(
    (targetRoomId: string, eventId?: string) => {
      if (!sessionRef.current) {
        const url = new URL(location.href);
        url.searchParams.set("roomId", targetRoomId);
        if (eventId) url.searchParams.set("eventId", eventId);
        history.replaceState(null, "", url);
        openLogin();
        return;
      }
      if (eventId) void jumpToEvent(targetRoomId, eventId);
      else {
        const target = rooms.find((value) => value.roomId === targetRoomId);
        if (target) selectRoom(target);
        else
          void api<{ rooms: Room[] }>("/api/rooms")
            .then((result) => {
              setRooms(result.rooms);
              const found = result.rooms.find(
                (value) => value.roomId === targetRoomId,
              );
              if (found) selectRoom(found);
              else notify(t("notJoined"));
            })
            .catch((reason) => notify(messageOf(reason)));
      }
    },
    [rooms, openLogin, notify, t, jumpToEvent, selectRoom, api],
  );

  const cancelTask = useCallback(
    async (requestId: string) => {
      try {
        await api(`/api/tasks/${encodeURIComponent(requestId)}/cancel`, {
          method: "POST",
          body: {},
        });
        refresh();
        notify(t("cancelled"));
      } catch (reason) {
        notify(messageOf(reason));
        throw reason;
      }
    },
    [api, notify, refresh, t],
  );

  const joinedMentionables = useMemo(
    () =>
      mentionables.members.length
        ? mentionables
        : {
            ...mentionables,
            members: participants.filter(
              (person) => !room || room.participantIds.includes(person.id),
            ),
          },
    [mentionables, participants, room],
  );

  return (
    <>
      <Shell
        bootstrap={bootstrap}
        session={session}
        rooms={rooms}
        room={room}
        ownedBots={ownedBots}
        mentionables={joinedMentionables}
        status={status}
        view={view}
        mentionCount={mentionCount}
        showTaskHistory={showTaskHistory}
        onRoom={selectRoom}
        onDirect={(id) => void openDirect(id)}
        onHome={() => {
          if (!sending) setView("home");
        }}
        onServer={() => {
          const initial = rooms.find(
            (value) => value.roomId === bootstrap?.roomId,
          );
          if (initial) selectRoom(initial);
          else setView("chat");
        }}
        onSettings={(tab = "account") => setSettingsTab(tab)}
        onLogin={openLogin}
        onCreateRoom={() => (session ? setRoomDialog("create") : openLogin())}
        onInvite={() => (session ? setRoomDialog("invite") : openLogin())}
        onInbox={() => (session ? setInboxOpen(true) : openLogin())}
        onNotifications={() =>
          session ? setNotificationRoom(room) : openLogin()
        }
        onToggleTasks={() => setShowTaskHistory((value) => !value)}
        onMember={(id) =>
          setMember(participants.find((person) => person.id === id) ?? null)
        }
      >
        <div
          id="page-error"
          className="notice notice-error"
          role="alert"
          hidden={!error}
        >
          <span id="page-error-text">{error}</span>
          <button
            id="retry-connection"
            type="button"
            onClick={() => {
              setBootstrapNonce((value) => value + 1);
              refresh();
            }}
          >
            {t("retry")}
          </button>
        </div>
        <Timeline
          key={roomId ?? "signed-out"}
          events={events}
          participants={participants}
          session={session}
          mentionables={joinedMentionables}
          roles={roles}
          onReply={(event) => {
            if (!session) {
              openLogin();
              return;
            }
            setReply({
              eventId: event.event_id,
              senderName: displayName(event.sender),
              body: event.content.body,
            });
            setReplyMention(true);
            composer.current?.focus();
          }}
          onMember={(id) =>
            setMember(participants.find((person) => person.id === id) ?? null)
          }
          onJump={(id) => {
            if (roomId) void jumpToEvent(roomId, id);
          }}
          onRead={(id) => void markRead(id)}
          onRole={() => setSettingsTab("roles")}
        />
        <Composer
          ref={composer}
          session={session}
          room={room}
          mentionables={joinedMentionables}
          reply={reply}
          replyMention={replyMention}
          onReplyMention={setReplyMention}
          onClearReply={() => setReply(null)}
          onRestoreReply={(target, mention) => {
            setReply(target);
            setReplyMention(mention);
          }}
          sending={sending}
          isWorking={tasks.some(
            (task) => task.status === "queued" || task.status === "running",
          )}
          pending={pending}
          onSend={sendMessage}
          limits={bootstrap?.attachments}
          onError={notify}
        />
      </Shell>
      <TaskHistoryDialog
        tasks={tasks}
        participants={participants}
        open={showTaskHistory}
        onClose={() => setShowTaskHistory(false)}
        onCancel={cancelTask}
        onError={notify}
      />
      <LoginDialog
        open={loginOpen}
        bootstrap={bootstrap}
        session={session}
        busy={loginBusy}
        error={loginError}
        onLogin={(user, password) => void login(user, password)}
        onClose={() => {
          if (session) setLoginOpen(false);
        }}
      />
      <RoomDialog
        mode={roomDialog}
        session={session}
        room={room}
        participants={participants}
        ownedBots={ownedBots}
        api={api}
        onRoom={(next) => {
          selectRoom(next);
          if (next.status === "partially_joined") notify(t("joinPending"));
        }}
        onChanged={refresh}
        onClose={() => setRoomDialog(null)}
        onError={notify}
      />
      <MemberDialog
        member={member}
        session={session}
        room={room}
        roles={roles}
        onClose={() => setMember(null)}
        onDirect={(id) => {
          setMember(null);
          void openDirect(id);
        }}
        onMention={(person) => {
          setMember(null);
          requestAnimationFrame(() => composer.current?.insertMention(person));
        }}
      />
      <SettingsDialog
        tab={settingsTab}
        onTab={setSettingsTab}
        onClose={() => setSettingsTab(null)}
        session={session}
        participants={participants}
        status={status}
        api={api}
        onSwitchAccount={() => {
          setSettingsTab(null);
          openLogin();
        }}
        onRolesChanged={refresh}
        onOpenRoom={openRoomFromNotification}
        onPwaReady={(handle) => {
          pwa.current = handle;
        }}
      />
      <InboxDialog
        open={inboxOpen}
        api={api}
        rooms={rooms}
        participants={participants}
        onClose={() => setInboxOpen(false)}
        onJump={(id, eventId) => {
          setInboxOpen(false);
          void jumpToEvent(id, eventId);
        }}
        onChanged={refresh}
      />
      <NotificationDialog
        room={notificationRoom}
        api={api}
        onClose={() => setNotificationRoom(null)}
        onSaved={() => {
          setNotificationRoom(null);
          notify(t("notificationSaved"));
        }}
      />
      <div id="toast" className="toast" role="status" hidden={!toast}>
        {toast}
      </div>
    </>
  );
}
