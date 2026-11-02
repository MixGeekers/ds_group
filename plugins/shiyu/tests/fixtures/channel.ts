import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { IngressDomain, type IngressDomainOptions } from '../../src/adapters/control-store/ingress-domain.js';
import { SqliteTransactions } from '../../src/adapters/control-store/transaction.js';
import type { ChannelInvalidationSignal } from '../../src/contracts/channel.js';
import type { ChannelIngressLimits } from '../../src/control/ingress/index.js';

/**
 * Synthetic-only generic-channel fixture. Two accounts, short native ids and
 * DM/group audiences are intentionally collidable; every body is a digest so
 * the fixture never needs a real platform or a message body store.
 */
export const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
export const occurred = (seconds: number): string => new Date(Date.parse('2026-11-02T12:00:00.000Z') + seconds * 1000).toISOString();
export const SYNTHETIC_CAPABILITIES = { edit: true, retract: true, delete: true, receipts: true, idempotentSend: false };

export function registration(accountId = 'acct-alpha', overrides: Record<string, unknown> = {}) {
  return {
    sourceNamespace: 'synthetic.chat',
    platform: { provider: 'synthetic-chat', deployment: 'offline-lab' },
    account: { accountId, nativeAccountId: `native-${accountId}`, kind: 'bot' as const },
    capabilities: { ...SYNTHETIC_CAPABILITIES },
    ...overrides,
  };
}
export function conversation(nativeConversationId = 'short-group-1', mode: 'direct' | 'group' | 'channel' = 'group', threadId?: string) {
  return { nativeConversationId, mode, ...(threadId === undefined ? {} : { threadId }) };
}
export interface EventOptions {
  actor?: { nativeParticipantId: string; kind: 'human' | 'bot' | 'system' };
  sequence?: number;
  nativeEventId?: string;
  privacyClass?: 'public' | 'internal' | 'private';
}
function envelope(kind: 'message.create' | 'message.edit' | 'message.retract' | 'message.delete', nativeMessageId: string, revision: number, overrides: EventOptions, content: Record<string, unknown>) {
  return {
    kind,
    message: { nativeMessageId, revision, occurredAt: occurred(revision) },
    ...(overrides.nativeEventId === undefined ? {} : { nativeEventId: overrides.nativeEventId }),
    ...(overrides.sequence === undefined ? {} : { sequence: overrides.sequence }),
    actor: overrides.actor ?? { nativeParticipantId: 'u1', kind: 'human' as const },
    privacyClass: overrides.privacyClass ?? 'internal',
    content,
  };
}
export function createEvent(nativeMessageId: string, overrides: EventOptions = {}) {
  return envelope('message.create', nativeMessageId, 1, overrides, {
    contentHash: sha(`body:${nativeMessageId}`), bodyRef: `native-body:${nativeMessageId}`, summary: `summary ${nativeMessageId}`, attachments: [],
  });
}
export function editEvent(nativeMessageId: string, revision: number, overrides: EventOptions = {}) {
  return envelope('message.edit', nativeMessageId, revision, overrides, {
    contentHash: sha(`body:${nativeMessageId}:r${revision}`), bodyRef: `native-body:${nativeMessageId}:r${revision}`,
    summary: `summary ${nativeMessageId} r${revision}`, attachments: [],
  });
}
export function tombstoneEvent(nativeMessageId: string, revision: number, kind: 'message.retract' | 'message.delete', overrides: EventOptions & { reasonRef?: string } = {}) {
  const { reasonRef, ...rest } = overrides;
  return { ...envelope(kind, nativeMessageId, revision, rest, {}), ...(reasonRef === undefined ? {} : { reasonRef }) };
}

export interface ChannelFixture {
  path: string;
  sink: { calls: ChannelInvalidationSignal[]; fail: boolean };
  readonly domain: IngressDomain;
  readonly db: DatabaseSync;
  clock(iso: string): void;
  reopen(): void;
  totalChanges(): number;
  rows(table: string): Record<string, unknown>[];
  values(): string;
}

export function fixture(t: TestContext, options: { limits?: Partial<ChannelIngressLimits>; onInvalidation?: IngressDomainOptions['onInvalidation'] } = {}): ChannelFixture {
  const dir = mkdtempSync(join(tmpdir(), 'shiyu-channel-ingress-')), path = join(dir, 'control.sqlite');
  const databases: DatabaseSync[] = [];
  const sink = { calls: [] as ChannelInvalidationSignal[], fail: false };
  let nowMs = Date.parse('2026-11-02T12:00:00.000Z');
  const open = () => {
    const db = new DatabaseSync(path);
    databases.push(db);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;');
    const tx = new SqliteTransactions(db);
    const domain = new IngressDomain(db, tx, {
      now: () => new Date(nowMs),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      onInvalidation: signal => {
        if (sink.fail) throw new Error('synthetic_sink_failure');
        if (options.onInvalidation) options.onInvalidation(signal); else sink.calls.push(structuredClone(signal));
      },
    });
    return { db, domain };
  };
  let opened = open();
  t.after(() => {
    for (const db of databases) if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    path, sink,
    get domain() { return opened.domain; },
    get db() { return opened.db; },
    clock(iso: string) { nowMs = Date.parse(iso); },
    reopen() { opened.db.close(); opened = open(); },
    totalChanges() { return Number((opened.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n); },
    rows(table: string) { return opened.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]; },
    values() {
      return opened.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
        .map(row => JSON.stringify(opened.db.prepare(`SELECT * FROM "${String((row as { name: string }).name).replaceAll('"', '""')}"`).all())).join('\n');
    },
  };
}

/** Register one trusted synthetic connection and return its view. */
export function connect(domain: IngressDomain, accountId = 'acct-alpha') {
  return domain.registerConnection(registration(accountId));
}
/** Ensure the canonical conversation for a registered connection. */
export function ensure(domain: IngressDomain, connectionId: string, input = conversation()) {
  return domain.ensureConversation({ connectionId, conversation: input, reasonRef: 'synthetic:channel-discovered' });
}
/** Admit a synthetic batch through the public ingress command. */
export function ingest(domain: IngressDomain, connectionId: string, input: ReturnType<typeof conversation>, events: unknown[]) {
  return domain.ingest({ connectionId, conversation: input, events: events as never });
}
