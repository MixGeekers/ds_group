import path from 'node:path';

// NativeConnections stores the real node under <bundle>/nodes/<localpart>/.
// Read only the normalized decision rows; never read provider configuration.
export async function readNaturalDecisions(nodes) {
  const { DatabaseSync } = await import('node:sqlite');
  const decisions = [], records = [], errors = [];
  for (const node of nodes) {
    let database;
    try {
      database = new DatabaseSync(path.join(node.directory, 'nodes', node.localpart, 'node.sqlite'), { readOnly: true });
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attention_decisions'").get()) {
        errors.push({ botId: node.id, error: 'attention_decisions table is absent' }); continue;
      }
      const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
      for (const row of database.prepare('SELECT * FROM attention_decisions ORDER BY rowid').all()) {
        const input = parse(row.input_json), result = parse(row.result_json);
        records.push({ botId: node.id, id: row.id, createdAt: row.created_at, completedAt: row.completed_at,
          status: row.status, outcome: row.outcome, errorCode: row.error_code, input, result });
        decisions.push({ botId: node.id, id: row.id, model: result?.model, action: result?.action,
          status: row.status, outcome: row.outcome, usage: result?.usage, createdAt: row.created_at, completedAt: row.completed_at,
          eventIds: input?.eventIds || [], watermark: input?.watermark, errorCode: row.error_code });
      }
    } catch (error) { errors.push({ botId: node.id, error: error.message }); }
    finally { database?.close(); }
  }
  return { decisions, records, errors };
}
