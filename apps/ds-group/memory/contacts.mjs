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
