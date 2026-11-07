import { canonicalIdentity } from './store.mjs';

const sourceKey = source => source?.eventId ? JSON.stringify([source.transport || 'matrix', source.roomId || null, source.eventId]) : undefined;

// The shared registry keeps stable IDs. Names/aliases in a Bot's input must
// come from that Bot's sightings or exact evidence its legal memories cite.
export function scopedContactRecords(contacts, { sources, knownIds, scoped }) {
  const keys = new Set(sources.map(sourceKey).filter(Boolean)), ids = new Set(knownIds.filter(Boolean).map(canonicalIdentity));
  const rows = new Map();
  for (const record of contacts) {
    const own = scoped(record.id);
    const observations = own?.observations || (record.observations || []).filter(row => keys.has(sourceKey(row.source)));
    if (!own && !observations.length && !ids.has(record.id)) continue;
    const latest = observations.reduce((current, row) => !current || row.at >= current.at ? row : current, undefined);
    const roomSources = sources.filter(source => canonicalIdentity(source.roomId) === record.id && source.roomName);
    const roomName = roomSources.sort((a,b) => (b.timestamp || 0) - (a.timestamp || 0))[0]?.roomName;
    const name = own?.name || latest?.name || roomName || record.id;
    rows.set(record.id, { id: record.id, kind: own?.kind || record.kind,
      ...(own?.ownerId || record.ownerId ? { ownerId: own?.ownerId || record.ownerId } : {}), name,
      nameAt: own?.nameAt ?? latest?.at ?? null,
      aliases: own?.aliases || [...new Set([...observations.map(row => row.name), ...(roomName ? [roomName] : [])])], observations });
  }
  for (const id of ids) if (!rows.has(id)) rows.set(id, { id, kind: id.startsWith('project:') ? 'project' : id.startsWith('matrix:!') ? 'group' : 'unknown', name: id, aliases: [], observations: [] });
  return [...rows.values()].sort((a,b) => a.id.localeCompare(b.id));
}

// Keep repeated identity sightings in storage, outside the default model input.
// Names, aliases and stable IDs are sufficient for routine disambiguation.
export function contactReadView(contacts, { history = false } = {}) {
  if (history) return contacts;
  return contacts.map(({ observations = [], ...identity }) => ({
    ...identity,
    retainedObservationCount: observations.length,
    latestObservation: observations.reduce((latest, row) => !latest || row.at >= latest.at ? row : latest, undefined),
  }));
}
