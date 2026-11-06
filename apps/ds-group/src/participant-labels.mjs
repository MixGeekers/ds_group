// Membership display names are labels, never identity, kind or ownership claims.
export function withRoomDisplayNames(participants, joined = {}) {
  return participants.map(person => {
    const name = joined[person.id]?.display_name;
    return typeof name === 'string' && name.trim()
      ? { ...person, name: name.trim() }
      : person;
  });
}
