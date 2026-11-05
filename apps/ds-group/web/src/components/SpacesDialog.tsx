import { Button, Input } from "../../../ui/controls";
import { useEffect, useRef, useState } from "react";
import { ApiError, messageOf } from "../api";
import { discoverServer } from "../spaces";
import type { CollaborationSpace } from "../spaces";
import { useTranslation } from "../locale";
import { spaceMessages } from "../locales/spaces";
import { Icon } from "./Icons";
import type { Api, Session } from "../types";

export function SpacesDialog(props: {
  open: boolean;
  spaces: CollaborationSpace[];
  selectedServer: string | null;
  api: Api;
  session: Session | null;
  onClose(): void;
  onServer(name: string): void;
  onChanged(): void;
  onJoined(roomId: string): void;
  onRoles?(): void;
}) {
  const t = useTranslation(spaceMessages);
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const discovery = useRef<AbortController | null>(null);
  const [address, setAddress] = useState("");
  const [roomId, setRoomId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [found, setFound] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.open && !dialog.current?.open) dialog.current?.showModal();
    if (!props.open) {
      dialog.current?.close();
      discovery.current?.abort();
    }
    setFeedback("");
    setFound("");
  }, [props.open, props.session]);
  useEffect(() => () => discovery.current?.abort(), []);
  async function check() {
    discovery.current?.abort();
    const controller = new AbortController();
    discovery.current = controller;
    setChecking(true);
    setFound("");
    try {
      const server = await discoverServer(address, controller.signal);
      if (!controller.signal.aborted)
        setFound(t("found", { name: server.name, origin: server.origin }));
    } catch (reason) {
      if (!controller.signal.aborted) setFound(messageOf(reason));
    } finally {
      if (discovery.current === controller) setChecking(false);
    }
  }
  async function act(id: string, action: "join" | "leave") {
    if (busy || !props.session) return;
    const account = props.session;
    setBusy(true);
    setFeedback(t("pending"));
    try {
      const result = await props.api<{ roomId: string; status: string }>(
        `/api/rooms/${encodeURIComponent(id)}/${action}`,
        { method: "POST", body: {} },
      );
      if (latest.current.session !== account) return;
      props.onChanged();
      if (
        result.roomId !== id ||
        result.status !== (action === "join" ? "joined" : "left")
      ) {
        setFeedback(t("uncertain"));
        return;
      }
      setFeedback(
        t(action === "join" ? "joinedResult" : "leftResult", { room: id }),
      );
      if (action === "join" && latest.current.open) props.onJoined(id);
    } catch (reason) {
      if (latest.current.session !== account) return;
      props.onChanged();
      setFeedback(
        reason instanceof ApiError &&
          reason.status >= 400 &&
          reason.status < 500
          ? t("rejected", { error: messageOf(reason) })
          : `${t("uncertain")} ${messageOf(reason)}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      id="spaces-dialog"
      className="settings-dialog spaces-dialog"
      ref={dialog}
      aria-labelledby="spaces-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id="spaces-title">{t("spaces")}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="icon-button"
          type="button"
          disabled={busy}
          aria-label={t("close")}
          onClick={props.onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className="space-list">
        {!props.spaces.length && <p className="muted">{t("noSpaces")}</p>}
        {props.spaces.map((space) => (
          <section
            className="space-card"
            key={space.serverName}
            data-space={space.serverName}
          >
            <header>
              <div>
                <strong>{space.name}</strong>
                <small className="member-full-id">{space.serverName}</small>
              </div>
              <span className={`space-state space-${space.status}`}>
                {t(space.status === "connected" ? "accessible" : space.status)}
              </span>
              <Button
                variant="secondary"
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => props.onServer(space.serverName)}
              >
                {t(
                  space.serverName === props.selectedServer
                    ? "current"
                    : "open",
                )}
              </Button>
            </header>
            {space.home && <span className="muted small">{t("home")}</span>}
            {space.home && props.onRoles && (
              <Button
                variant="ghost"
                id="home-roles-button"
                className="text-button"
                type="button"
                onClick={props.onRoles}
              >
                {t("homeRoles")}
              </Button>
            )}
            {!space.rooms.length && !space.invitations.length && (
              <p className="muted small">{t("noRooms")}</p>
            )}
            {space.rooms.map((room) => (
              <div className="space-room" key={room.roomId}>
                <span>
                  <strong>{room.name}</strong>
                  <small className="member-full-id">{room.roomId}</small>
                </span>
                <span className={`space-state space-${room.status}`}>
                  {t(room.status)}
                </span>
                <Button
                  variant="ghost"
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void act(room.roomId, "leave")}
                >
                  {t("leave")}
                </Button>
              </div>
            ))}
            {!!space.invitations.length && <h3>{t("invitations")}</h3>}
            {space.invitations.map((invite) => (
              <div
                className="space-invitation"
                data-invitation={invite.roomId}
                key={invite.roomId}
              >
                <span>
                  <strong>{invite.name}</strong>
                  <small className="member-full-id">{invite.roomId}</small>
                  <small className="member-full-id">{invite.inviterId}</small>
                </span>
                <span className="space-state">{t(invite.status)}</span>
                <div className="settings-actions">
                  <Button
                    variant="default"
                    className="primary-button"
                    type="button"
                    disabled={busy || !invite.canJoin}
                    onClick={() => void act(invite.roomId, "join")}
                  >
                    {t("join")}
                  </Button>
                  <Button
                    variant="secondary"
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void act(invite.roomId, "leave")}
                  >
                    {t("decline")}
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
      <p className="muted small">{t("connectionNote")}</p>
      <Button
        variant="secondary"
        id="refresh-spaces"
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={props.onChanged}
      >
        {t("refresh")}
      </Button>
      <section>
        <h3>{t("join")}</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(roomId.trim(), "join");
          }}
        >
          <label htmlFor="join-room-id">{t("roomId")}</label>
          <Input
            id="join-room-id"
            autoComplete="off"
            required
            pattern="!\S+"
            value={roomId}
            disabled={busy}
            onChange={(event) => setRoomId(event.target.value)}
            placeholder="!room:server.example"
          />
          <p className="muted small">{t("joinHelp")}</p>
          <Button
            variant="default"
            id="join-room"
            className="primary-button"
            type="submit"
            disabled={busy || !props.session}
          >
            {t(busy ? "joining" : "join")}
          </Button>
        </form>
      </section>
      <p id="space-feedback" className="settings-feedback" role="status">
        {feedback}
      </p>
      <section>
        <h3>{t("discover")}</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void check();
          }}
        >
          <label htmlFor="server-url">{t("address")}</label>
          <Input
            id="server-url"
            type="url"
            required
            autoComplete="off"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://chat.example.com"
          />
          <Button
            variant="secondary"
            id="check-server"
            className="secondary-button"
            type="submit"
            disabled={checking}
          >
            {t(checking ? "checking" : "check")}
          </Button>
        </form>
        <p id="server-feedback" className="settings-feedback" role="status">
          {found}
        </p>
        <p className="muted small">{t("discoveryHelp")}</p>
      </section>
    </dialog>
  );
}
