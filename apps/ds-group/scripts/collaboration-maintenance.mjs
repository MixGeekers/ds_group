// Resume only the last completed message's boundary. A later run cannot
// retroactively prove that an earlier checkpoint happened at the right time.
export function pendingMaintenance(round, { compactions, restarts }, records) {
  const tasks = [];
  if (compactions.includes(round) && !records.some(row => row.type === 'native-compaction' && row.round === round && row.result?.compacted))
    tasks.push({ type: 'compact', index: compactions.indexOf(round) % 3 });
  if (restarts.includes(round) && !records.some(row => row.type === 'planned-restart' && row.round === round && row.identitiesPreserved))
    tasks.push({ type: 'restart' });
  return tasks;
}
