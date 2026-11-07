import { Button, Input, NativeSelect } from "../../../ui/controls";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { messageOf } from "../api";
import { formatDateTime } from "../../i18n.js";
import { useTranslation } from "../locale";
import { kernelMessages } from "../locales/kernel";
import type { MemoryClaim, MemoryProfile, MemoryProfileItem, MemoryProfileKind, MemorySource } from "../bot-kernel";
import type { Api, Participant, Room } from "../types";
import { Icon } from "./Icons";

export function BotMemory({ bot, api, rooms, participants }: {
  bot: Participant; api: Api; rooms: Room[]; participants: Participant[];
}) {
  const t = useTranslation(kernelMessages);
  const [kind, setKind] = useState<MemoryProfileKind>("person");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [roomId, setRoomId] = useState("");
  const [items, setItems] = useState<MemoryProfileItem[]>([]);
  const [profileId, setProfileId] = useState("");
  const [profile, setProfile] = useState<MemoryProfile | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const route = `/api/bots/${encodeURIComponent(bot.id)}/memory/profile`;
  const availableRooms = rooms.filter(room => room.participantIds.includes(bot.id));

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ kind });
    if (roomId) params.set("roomId", roomId);
    if (search) params.set("query", search);
    if (profileId) params.set("id", profileId);
    setLoading(true); setError(""); setProfile(null);
    if (!profileId) setItems([]);
    void api<MemoryProfile | { kind: MemoryProfileKind; items: MemoryProfileItem[]; more: boolean }>(`${route}?${params}`, { signal: controller.signal, timeout: 20000 }).then(result => {
      if (controller.signal.aborted) return;
      if ("items" in result) {
        if (!Array.isArray(result.items)) throw new Error("Invalid memory profile list");
        setItems(result.items); setMore(result.more === true);
      } else {
        if (!result.view || result.id !== profileId || result.kind !== kind) throw new Error("Invalid memory profile receipt");
        setProfile(result);
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(messageOf(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, route, kind, roomId, search, profileId, revision]);

  function submit(event: FormEvent) {
    event.preventDefault(); setProfileId(""); setSearch(query.trim()); setRevision(value => value + 1);
  }
  const person = (id: string) => participants.find(member => member.id === id)?.name ?? id;
  const scopeName = (scope?: string) => {
    if (scope === "own") return t("ownScope");
    if (scope === "team") return t("teamScope");
    if (scope?.startsWith("room:")) {
      const id = scope.slice(5);
      return rooms.find(room => room.roomId === id)?.name ?? t("roomScope", { id });
    }
    return scope ?? t("unknown");
  };
  function sources(list: MemorySource[]) {
    return list.map(source => <li key={`${source.id}/${source.revision ?? ""}`}>
      {source.authorId && <strong>{t("by", { name: person(source.authorId) })}</strong>}
      {source.timestamp != null && <time dateTime={new Date(source.timestamp).toISOString()}>{formatDateTime(source.timestamp)}</time>}
      {source.roomId && <span>{rooms.find(room => room.roomId === source.roomId)?.name ?? source.roomId}</span>}
      <small>{source.eventId ?? source.id}{source.revision != null ? ` · r${source.revision}` : ""}</small>
    </li>);
  }
  function claim(entry: MemoryClaim) {
    const state = entry.claimState;
    const origin = entry.kind;
    return <article className="bot-memory-claim" key={`${entry.id}/${entry.revision ?? ""}`} data-memory-record={entry.id}>
      <div className="bot-memory-labels">
        {state && ["statement", "proposal", "confirmed", "uncertain"].includes(state) && <span>{t(state)}</span>}
        {origin && ["stated", "reported", "observation", "inference", "legacy"].includes(origin) && <span>{t(origin)}</span>}
      </div>
      <p className="bot-memory-text">{entry.text}</p>
      {entry.saidBy && <p className="muted">{t("by", { name: person(entry.saidBy) })}</p>}
      <p className="muted">{t("scopeLabel", { scope: scopeName(entry.scope) })}</p>
      {!!entry.conflicts?.length && <p className="bot-memory-conflict"><Icon name="info" />{t("conflict", { count: entry.conflicts.length })}</p>}
      <details className="bot-memory-sources">
        <summary>{t("sources")} · {entry.sources?.length ?? entry.sourceRefs?.length ?? 0}</summary>
        {entry.sources?.length ? <ul>{sources(entry.sources)}</ul> : <>
          <p className="muted">{t("sourceMissing")}</p>
          {entry.sourceRefs?.map(ref => <small className="member-full-id" key={`${ref.id}/${ref.revision ?? ""}`}>{ref.id}{ref.revision != null ? ` · r${ref.revision}` : ""}</small>)}
        </>}
        {!!entry.conflicts?.length && <p className="muted">{entry.conflicts.join(" · ")}</p>}
        <small className="member-full-id">{t("record", { id: entry.id })}</small>
      </details>
    </article>;
  }
  const groups = profile ? [
    ["facts", profile.view.currentClaims], ["preferences", profile.view.preferences], ["projectFacts", profile.view.projectFacts], ["changes", profile.view.changes],
  ] as const : [];
  return <section className="bot-memory" data-bot-memory={bot.id}>
    <p>{t("memoryHelp", { name: bot.name })}</p>
    <form className="bot-memory-filter" onSubmit={submit}>
      <div><label htmlFor="bot-memory-kind">{t("kind")}</label><NativeSelect id="bot-memory-kind" value={kind} onChange={event => { setKind(event.target.value as MemoryProfileKind); setProfileId(""); }}>
        <option value="person">{t("people")}</option><option value="project">{t("projects")}</option>
      </NativeSelect></div>
      <div><label htmlFor="bot-memory-room">{t("scope")}</label><NativeSelect id="bot-memory-room" value={roomId} onChange={event => { setRoomId(event.target.value); setProfileId(""); }}>
        <option value="">{t("allScopes")}</option>{availableRooms.map(room => <option key={room.roomId} value={room.roomId}>{room.name}</option>)}
      </NativeSelect></div>
      <div className="bot-memory-search"><label htmlFor="bot-memory-query">{t("search")}</label><div><Input id="bot-memory-query" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("searchPlaceholder")} /><Button variant="secondary" type="submit" aria-label={t("search")}><Icon name="search" /></Button></div></div>
    </form>
    {loading && <p role="status">{t("loadingMemory")}</p>}
    {error && <p role="alert">{t("memoryFailed", { error })}</p>}
    {!!error && <Button variant="secondary" type="button" onClick={() => setRevision(value => value + 1)}>{t("refresh")}</Button>}
    {!loading && !error && !profileId && <div className="bot-memory-entities">
      {!items.length && <p>{t("noEntities")}</p>}
      {items.map(item => <Button key={item.id} variant="ghost" className="bot-memory-entity" type="button" data-memory-profile={item.id} onClick={() => setProfileId(item.id)}>
        <Icon name={kind === "person" ? "user" : "folder"} /><span><strong>{item.name || item.id}</strong><small>{item.id}</small></span>
        {typeof item.currentCount === "number" && <small>{t("currentRecords", { count: item.currentCount })}</small>}
      </Button>)}
      {more && <p className="muted">{t("more")}</p>}
    </div>}
    {!!profileId && <Button variant="ghost" type="button" className="text-button" onClick={() => setProfileId("")}><Icon name="back" />{t(kind === "person" ? "people" : "projects")}</Button>}
    {!loading && profile && <div className="bot-memory-profile">
      <h3>{profile.identity.name || profile.id}</h3><small className="member-full-id">{profile.id}</small>
      {groups.every(([, entries]) => !entries?.length) && <p>{t("noClaims")}</p>}
      {groups.map(([key, entries]) => !!entries?.length && <section key={key}>
        <h3>{t(key)}</h3>{key === "changes" && <p className="muted">{t("historicalHelp")}</p>}{entries.map(claim)}
      </section>)}
      {!!profile.view.recentSources?.length && <details className="bot-memory-sources"><summary>{t("sources")}</summary><ul>{sources(profile.view.recentSources)}</ul></details>}
      {!!profile.view.historyGaps?.length && <p className="bot-memory-conflict">{t("gaps")}</p>}
      {Object.values(profile.view.budget?.omitted ?? {}).some(count => count > 0) && <p className="muted">{t("shortened")}</p>}
    </div>}
    <p className="bot-memory-boundary"><Icon name="info" />{t("memoryBoundary")}</p>
  </section>;
}
