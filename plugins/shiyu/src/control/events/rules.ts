import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EventTypeDefinition, JsonPrimitive } from '../../contracts/events.js';

/** Declaration-only conditions. No callbacks, JS, SQL or regular expressions. */
export type ConditionOperator = 'eq' | 'in' | 'changed' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';
export const CONDITION_OPERATORS: readonly ConditionOperator[] = Object.freeze(['eq', 'in', 'changed', 'gt', 'gte', 'lt', 'lte', 'exists']);
export interface ConditionPredicate { field: string; op: ConditionOperator; value?: JsonPrimitive | JsonPrimitive[] }
export interface DeclarativeCondition { schemaVersion: 1; predicates: ConditionPredicate[] }
export interface NotificationDestinationRule { kind: 'component' | 'agent' | 'channel'; ref: string; allowedFields?: string[] }
export interface NotificationRule { category: string; destinations: NotificationDestinationRule[]; quiet?: boolean }
export interface TimeRule {
  scheduleRef: string;
  kind: 'interval' | 'daily' | 'once';
  intervalMs?: number;
  dailyAt?: { hour: number; minute: number; zoneOffsetMinutes: number };
  atMs?: number;
  /** latest fires one merged occurrence; skip drops occurrences outside grace. */
  misfirePolicy: 'latest' | 'skip';
  graceMs?: number;
}
export interface ObservationRule { observationRef: string; minIntervalMs?: number; policy: 'changed' | 'version_greater' }
export interface OnceWaitRule { targetBindingId: string; expiresAt: string; assignmentId?: string; goalId?: string; once: true }
export interface SubscriptionRuleDocument {
  schemaVersion: 1;
  subscriptionId: string;
  conditionRevision: number;
  condition?: DeclarativeCondition;
  notification?: NotificationRule;
  time?: TimeRule;
  observation?: ObservationRule;
  onceWait?: OnceWaitRule;
  retiredAt?: string;
  /** Trusted creating principal; never model input. Used only for owner-scoped reads. */
  ownerPrincipal?: { principalId: string; kind: 'agent' | 'component' | 'user'; scopes: string[]; publishTypes: string[]; subscribeTypes: string[]; targetRefs: string[] };
  updatedAt: string;
}
export interface TimeSourceState {
  schemaVersion: 1;
  lastEvaluatedAt?: number;
  lastOccurrence?: string;
  lastOffsetMinutes?: number;
  lastObservationVersion?: number;
  lastObservationAt?: number;
  gaps: { at: string; reason: string }[];
}
export interface NotificationIntentState {
  schemaVersion: 1;
  intentRef: string;
  destinationRef: string;
  category: string;
  state: 'pending' | 'delivered' | 'unknown' | 'failed';
  receiptRef?: string;
  at: string;
  viewDigest: string;
}
export interface ConditionState { schemaVersion: 1; lastSeen: Record<string, JsonPrimitive>; at: string }
export interface RuleFileDocument {
  schemaVersion: 1;
  rules: Record<string, SubscriptionRuleDocument>;
  timeState: Record<string, TimeSourceState>;
  notificationIntents: Record<string, NotificationIntentState>;
  conditionState: Record<string, ConditionState>;
  waitOutcomes: Record<string, WaitOutcomeState>;
}
export interface WaitOutcomeState { schemaVersion: 1; subscriptionId: string; state: 'waiting' | 'matched' | 'background_only' | 'expired' | 'cancelled'; eventId?: string; deliveryId?: string; reason?: string; at: string }
export interface EventRuleStoreOptions { filename: string; now?: () => number }
const MAX_RULES = 200;
const MAX_INTENTS = 2000;
const MAX_STATE_GAPS = 32;
const MAX_CONDITION_PREDICATES = 8;
const MAX_IN_VALUES = 16;

/** Strict, bounded validator for white-listed declarative conditions. */
export function validateDeclarativeCondition(value: unknown, eventTypes: readonly EventTypeDefinition[]): DeclarativeCondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RULE_INVALID_CONDITION');
  const condition = value as Record<string, unknown>;
  if (condition.schemaVersion !== 1 || !Array.isArray(condition.predicates) || !condition.predicates.length
    || condition.predicates.length > MAX_CONDITION_PREDICATES || Object.keys(condition).some(key => !['schemaVersion', 'predicates'].includes(key))) {
    throw new Error('RULE_INVALID_CONDITION');
  }
  const filterable = new Set<string>();
  for (const definition of eventTypes) for (const field of definition.filterableFields) filterable.add(field);
  const predicates: ConditionPredicate[] = [];
  for (const raw of condition.predicates as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('RULE_INVALID_CONDITION');
    const predicate = raw as Record<string, unknown>;
    if (Object.keys(predicate).some(key => !['field', 'op', 'value'].includes(key))) throw new Error('RULE_INVALID_CONDITION');
    if (typeof predicate.field !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(predicate.field) || !filterable.has(predicate.field)) throw new Error('RULE_UNKNOWN_FIELD');
    if (typeof predicate.op !== 'string' || !CONDITION_OPERATORS.includes(predicate.op as ConditionOperator)) throw new Error('RULE_INVALID_OPERATOR');
    const op = predicate.op as ConditionOperator;
    if (op === 'exists' || op === 'changed') {
      if (predicate.value !== undefined) throw new Error('RULE_INVALID_CONDITION');
      predicates.push({ field: predicate.field, op });
      continue;
    }
    if (!Object.hasOwn(predicate, 'value')) throw new Error('RULE_INVALID_CONDITION');
    if (op === 'in') {
      if (!Array.isArray(predicate.value) || !predicate.value.length || predicate.value.length > MAX_IN_VALUES
        || predicate.value.some(item => item !== null && typeof item !== 'boolean' && typeof item !== 'number' && typeof item !== 'string')) throw new Error('RULE_INVALID_CONDITION');
      predicates.push({ field: predicate.field, op, value: predicate.value.slice() as JsonPrimitive[] });
      continue;
    }
    const item = predicate.value;
    if (Array.isArray(item) || (item !== null && typeof item !== 'boolean' && typeof item !== 'number' && typeof item !== 'string')) throw new Error('RULE_INVALID_CONDITION');
    if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && typeof item !== 'number') throw new Error('RULE_INVALID_CONDITION');
    if (typeof item === 'string' && item.length > 256) throw new Error('RULE_INVALID_CONDITION');
    predicates.push({ field: predicate.field, op, value: item as JsonPrimitive });
  }
  return { schemaVersion: 1, predicates };
}
/** Pure deterministic evaluation. `changed` needs the previous observed value. */
export function evaluateCondition(condition: DeclarativeCondition | undefined, payload: Record<string, unknown>,
  previous: Readonly<Record<string, JsonPrimitive>> = {}): boolean {
  if (!condition) return true;
  for (const predicate of condition.predicates) {
    const present = Object.hasOwn(payload, predicate.field);
    const current = payload[predicate.field] as JsonPrimitive | undefined;
    switch (predicate.op) {
      case 'exists': if (!present) return false; break;
      case 'eq': if (!present || current !== predicate.value) return false; break;
      case 'in': if (!present || !(predicate.value as JsonPrimitive[]).includes(current as JsonPrimitive)) return false; break;
      case 'changed': if (!present || previous[predicate.field] === current) return false; break;
      case 'gt': if (!present || typeof current !== 'number' || !(current > (predicate.value as number))) return false; break;
      case 'gte': if (!present || typeof current !== 'number' || !(current >= (predicate.value as number))) return false; break;
      case 'lt': if (!present || typeof current !== 'number' || !(current < (predicate.value as number))) return false; break;
      case 'lte': if (!present || typeof current !== 'number' || !(current <= (predicate.value as number))) return false; break;
    }
  }
  return true;
}
function emptyDocument(): RuleFileDocument { return { schemaVersion: 1, rules: {}, timeState: {}, notificationIntents: {}, conditionState: {}, waitOutcomes: {} }; }
function validateTimeRule(value: unknown): TimeRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RULE_INVALID_TIME');
  const rule = value as Record<string, unknown>;
  if (typeof rule.scheduleRef !== 'string' || !rule.scheduleRef || rule.scheduleRef.length > 200) throw new Error('RULE_INVALID_TIME');
  if (!['interval', 'daily', 'once'].includes(String(rule.kind))) throw new Error('RULE_INVALID_TIME');
  if (!['latest', 'skip'].includes(String(rule.misfirePolicy))) throw new Error('RULE_INVALID_TIME');
  if (rule.graceMs !== undefined && (!Number.isSafeInteger(rule.graceMs) || Number(rule.graceMs) < 0 || Number(rule.graceMs) > 86400000)) throw new Error('RULE_INVALID_TIME');
  if (Object.keys(rule).some(key => !['scheduleRef', 'kind', 'intervalMs', 'dailyAt', 'atMs', 'misfirePolicy', 'graceMs'].includes(key))) throw new Error('RULE_INVALID_TIME');
  if (rule.kind === 'interval') {
    if (!Number.isSafeInteger(rule.intervalMs) || Number(rule.intervalMs) < 1000 || Number(rule.intervalMs) > 86400000) throw new Error('RULE_INVALID_TIME');
    return { scheduleRef: rule.scheduleRef, kind: 'interval', intervalMs: Number(rule.intervalMs), misfirePolicy: rule.misfirePolicy as TimeRule['misfirePolicy'], ...(rule.graceMs === undefined ? {} : { graceMs: Number(rule.graceMs) }) };
  }
  if (rule.kind === 'daily') {
    const daily = rule.dailyAt as Record<string, unknown> | undefined;
    if (!daily || !Number.isSafeInteger(daily.hour) || Number(daily.hour) < 0 || Number(daily.hour) > 23
      || !Number.isSafeInteger(daily.minute) || Number(daily.minute) < 0 || Number(daily.minute) > 59
      || !Number.isSafeInteger(daily.zoneOffsetMinutes) || Number(daily.zoneOffsetMinutes) < -840 || Number(daily.zoneOffsetMinutes) > 840) throw new Error('RULE_INVALID_TIME');
    return { scheduleRef: rule.scheduleRef, kind: 'daily', dailyAt: { hour: Number(daily.hour), minute: Number(daily.minute), zoneOffsetMinutes: Number(daily.zoneOffsetMinutes) },
      misfirePolicy: rule.misfirePolicy as TimeRule['misfirePolicy'], ...(rule.graceMs === undefined ? {} : { graceMs: Number(rule.graceMs) }) };
  }
  if (!Number.isSafeInteger(rule.atMs) || Number(rule.atMs) < 0) throw new Error('RULE_INVALID_TIME');
  return { scheduleRef: rule.scheduleRef, kind: 'once', atMs: Number(rule.atMs), misfirePolicy: rule.misfirePolicy as TimeRule['misfirePolicy'] };
}
function validateNotificationRule(value: unknown): NotificationRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RULE_INVALID_NOTIFICATION');
  const rule = value as Record<string, unknown>;
  if (typeof rule.category !== 'string' || !rule.category || rule.category.length > 100) throw new Error('RULE_INVALID_NOTIFICATION');
  if (rule.quiet !== undefined && typeof rule.quiet !== 'boolean') throw new Error('RULE_INVALID_NOTIFICATION');
  if (!Array.isArray(rule.destinations) || !rule.destinations.length || rule.destinations.length > 16) throw new Error('RULE_INVALID_NOTIFICATION');
  const destinations: NotificationDestinationRule[] = [];
  for (const raw of rule.destinations as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('RULE_INVALID_NOTIFICATION');
    const destination = raw as Record<string, unknown>;
    if (!['component', 'agent', 'channel'].includes(String(destination.kind))) throw new Error('RULE_INVALID_NOTIFICATION');
    if (typeof destination.ref !== 'string' || !destination.ref || destination.ref.length > 256) throw new Error('RULE_INVALID_NOTIFICATION');
    if (destination.allowedFields !== undefined && (!Array.isArray(destination.allowedFields) || destination.allowedFields.length > 32
      || destination.allowedFields.some(field => typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field)))) throw new Error('RULE_INVALID_NOTIFICATION');
    if (Object.keys(destination).some(key => !['kind', 'ref', 'allowedFields'].includes(key))) throw new Error('RULE_INVALID_NOTIFICATION');
    destinations.push({ kind: destination.kind as NotificationDestinationRule['kind'], ref: destination.ref,
      ...(destination.allowedFields ? { allowedFields: (destination.allowedFields as string[]).slice() } : {}) });
  }
  const unique = new Set(destinations.map(destination => `${destination.kind}:${destination.ref}`));
  if (unique.size !== destinations.length) throw new Error('RULE_INVALID_NOTIFICATION');
  if (Object.keys(rule).some(key => !['category', 'destinations', 'quiet'].includes(key))) throw new Error('RULE_INVALID_NOTIFICATION');
  return { category: rule.category, destinations, ...(rule.quiet !== undefined ? { quiet: rule.quiet } : {}) };
}
function validateObservationRule(value: unknown): ObservationRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RULE_INVALID_OBSERVATION');
  const rule = value as Record<string, unknown>;
  if (typeof rule.observationRef !== 'string' || !rule.observationRef || rule.observationRef.length > 256
    || !['changed', 'version_greater'].includes(String(rule.policy))) throw new Error('RULE_INVALID_OBSERVATION');
  if (rule.minIntervalMs !== undefined && (!Number.isSafeInteger(rule.minIntervalMs) || Number(rule.minIntervalMs) < 1000 || Number(rule.minIntervalMs) > 3600000)) throw new Error('RULE_INVALID_OBSERVATION');
  if (Object.keys(rule).some(key => !['observationRef', 'minIntervalMs', 'policy'].includes(key))) throw new Error('RULE_INVALID_OBSERVATION');
  return { observationRef: rule.observationRef, policy: rule.policy as ObservationRule['policy'], ...(rule.minIntervalMs === undefined ? {} : { minIntervalMs: Number(rule.minIntervalMs) }) };
}
function validateOnceWaitRule(value: unknown): OnceWaitRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RULE_INVALID_WAIT');
  const rule = value as Record<string, unknown>;
  if (rule.once !== true || typeof rule.targetBindingId !== 'string' || !rule.targetBindingId || rule.targetBindingId.length > 256
    || typeof rule.expiresAt !== 'string' || !Number.isFinite(Date.parse(rule.expiresAt))) throw new Error('RULE_INVALID_WAIT');
  if ((rule.assignmentId !== undefined && (typeof rule.assignmentId !== 'string' || rule.assignmentId.length > 128))
    || (rule.goalId !== undefined && (typeof rule.goalId !== 'string' || rule.goalId.length > 2048))) throw new Error('RULE_INVALID_WAIT');
  if (Object.keys(rule).some(key => !['targetBindingId', 'expiresAt', 'assignmentId', 'goalId', 'once'].includes(key))) throw new Error('RULE_INVALID_WAIT');
  return { targetBindingId: rule.targetBindingId, expiresAt: rule.expiresAt, once: true,
    ...(rule.assignmentId ? { assignmentId: rule.assignmentId } : {}), ...(rule.goalId ? { goalId: rule.goalId } : {}) };
}
/** Trusted, atomic, plugin-owned declarative rule/state ledger. It is derived
 * metadata only: the control store remains the sole authority for subscription
 * acceptance, deliveries and acknowledgements. */
export class EventRuleStore {
  private document?: RuleFileDocument;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly filename: string;
  private readonly now: () => number;
  constructor(options: EventRuleStoreOptions) {
    if (!options || typeof options.filename !== 'string' || !options.filename) throw new Error('Event rule store requires a filename');
    this.filename = options.filename; this.now = options.now ?? (() => Date.now());
  }
  private async load(): Promise<RuleFileDocument> {
    if (this.document) return this.document;
    try {
      const value = JSON.parse(await readFile(this.filename, 'utf8')) as RuleFileDocument;
      if (!value || value.schemaVersion !== 1 || typeof value.rules !== 'object' || typeof value.timeState !== 'object' || typeof value.notificationIntents !== 'object') throw new Error('bad document');
      this.document = { schemaVersion: 1, rules: value.rules, timeState: value.timeState, notificationIntents: value.notificationIntents,
        conditionState: (value as Partial<RuleFileDocument>).conditionState ?? {},
        waitOutcomes: (value as Partial<RuleFileDocument>).waitOutcomes ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error('RULE_STORE_CORRUPT', { cause: error });
      this.document = emptyDocument();
    }
    return this.document;
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.document)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filename);
  }
  /** All mutations are serialized; every caller awaits both memory and file. */
  private mutate<T>(work: (document: RuleFileDocument) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const document = await this.load();
      const result = work(document);
      await this.persist();
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  }
  async ready(): Promise<void> { await this.load(); await this.queue; }
  async getRule(subscriptionId: string): Promise<SubscriptionRuleDocument | undefined> {
    await this.ready(); const rule = (await this.load()).rules[subscriptionId];
    return rule ? structuredClone(rule) : undefined;
  }
  async listRules(): Promise<SubscriptionRuleDocument[]> {
    await this.ready(); return Object.values((await this.load()).rules).map(rule => structuredClone(rule));
  }
  async putRule(input: Omit<SubscriptionRuleDocument, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string }): Promise<SubscriptionRuleDocument> {
    if (typeof input.subscriptionId !== 'string' || !input.subscriptionId) throw new Error('RULE_INVALID_SUBSCRIPTION');
    if (!Number.isSafeInteger(input.conditionRevision) || input.conditionRevision < 1) throw new Error('RULE_INVALID_REVISION');
    const owner = input.ownerPrincipal;
    if (owner !== undefined && (!owner || typeof owner.principalId !== 'string' || !['agent', 'component', 'user'].includes(owner.kind)
      || !Array.isArray(owner.scopes) || !Array.isArray(owner.publishTypes) || !Array.isArray(owner.subscribeTypes) || !Array.isArray(owner.targetRefs))) throw new Error('RULE_INVALID_OWNER');
    const rule: SubscriptionRuleDocument = { schemaVersion: 1, subscriptionId: input.subscriptionId, conditionRevision: input.conditionRevision,
      ...(owner ? { ownerPrincipal: structuredClone(owner) } : {}),
      ...(input.condition ? { condition: structuredClone(input.condition) } : {}),
      ...(input.notification ? { notification: structuredClone(input.notification) } : {}),
      ...(input.time ? { time: structuredClone(input.time) } : {}),
      ...(input.observation ? { observation: structuredClone(input.observation) } : {}),
      ...(input.onceWait ? { onceWait: structuredClone(input.onceWait) } : {}),
      ...(input.retiredAt ? { retiredAt: input.retiredAt } : {}),
      updatedAt: input.updatedAt ?? new Date(this.now()).toISOString() };
    return this.mutate(document => {
      if (!document.rules[rule.subscriptionId] && Object.keys(document.rules).length >= MAX_RULES) throw new Error('RULE_BACKPRESSURE');
      document.rules[rule.subscriptionId] = structuredClone(rule);
      return structuredClone(rule);
    });
  }
  async retireRule(subscriptionId: string): Promise<void> {
    await this.mutate(document => {
      const rule = document.rules[subscriptionId];
      if (rule) { rule.retiredAt = new Date(this.now()).toISOString(); rule.updatedAt = rule.retiredAt; }
    });
  }
  async getTimeState(subscriptionId: string): Promise<TimeSourceState> {
    await this.ready();
    return structuredClone((await this.load()).timeState[subscriptionId] ?? { schemaVersion: 1, gaps: [] });
  }
  async putTimeState(subscriptionId: string, state: TimeSourceState): Promise<void> {
    if (!state || state.schemaVersion !== 1 || !Array.isArray(state.gaps)) throw new Error('RULE_INVALID_STATE');
    const bounded: TimeSourceState = { ...structuredClone(state), gaps: state.gaps.slice(-MAX_STATE_GAPS) };
    await this.mutate(document => { document.timeState[subscriptionId] = bounded; });
  }
  async deleteRule(subscriptionId: string): Promise<boolean> {
    if (typeof subscriptionId !== 'string' || !subscriptionId) throw new Error('RULE_INVALID_SUBSCRIPTION');
    return this.mutate(document => {
      const had = Object.hasOwn(document.rules, subscriptionId);
      delete document.rules[subscriptionId];
      return had;
    });
  }
  async deleteTimeState(subscriptionId: string): Promise<boolean> {
    if (typeof subscriptionId !== 'string' || !subscriptionId) throw new Error('RULE_INVALID_SUBSCRIPTION');
    return this.mutate(document => {
      const had = Object.hasOwn(document.timeState, subscriptionId);
      delete document.timeState[subscriptionId];
      return had;
    });
  }
  async recordGap(subscriptionId: string, reason: string): Promise<void> {
    await this.mutate(document => {
      const state = document.timeState[subscriptionId] ?? { schemaVersion: 1, gaps: [] };
      state.gaps.push({ at: new Date(this.now()).toISOString(), reason: reason.slice(0, 200) });
      state.gaps = state.gaps.slice(-MAX_STATE_GAPS);
      document.timeState[subscriptionId] = state;
    });
  }
  async getConditionState(subscriptionId: string): Promise<ConditionState | undefined> {
    await this.ready(); const value = (await this.load()).conditionState[subscriptionId];
    return value ? structuredClone(value) : undefined;
  }
  async putConditionState(subscriptionId: string, state: ConditionState): Promise<void> {
    if (!state || state.schemaVersion !== 1 || typeof state.lastSeen !== 'object' || !state.lastSeen || typeof state.at !== 'string') throw new Error('RULE_INVALID_STATE');
    const bounded: ConditionState = { schemaVersion: 1, lastSeen: Object.fromEntries(Object.entries(state.lastSeen).slice(0, 32)), at: new Date(this.now()).toISOString() };
    await this.mutate(document => { document.conditionState[subscriptionId] = bounded; });
  }
  async getWaitOutcome(subscriptionId: string): Promise<WaitOutcomeState | undefined> {
    await this.ready(); const value = (await this.load()).waitOutcomes[subscriptionId];
    return value ? structuredClone(value) : undefined;
  }
  async putWaitOutcome(state: WaitOutcomeState): Promise<void> {
    if (!state || typeof state.subscriptionId !== 'string' || !state.subscriptionId
      || !['waiting', 'matched', 'background_only', 'expired', 'cancelled'].includes(state.state) || typeof state.at !== 'string') throw new Error('RULE_INVALID_STATE');
    await this.mutate(document => { document.waitOutcomes[state.subscriptionId] = structuredClone({ ...state, schemaVersion: 1 }); });
  }
  async getNotificationIntent(intentRef: string): Promise<NotificationIntentState | undefined> {
    await this.ready(); const value = (await this.load()).notificationIntents[intentRef];
    return value ? structuredClone(value) : undefined;
  }
  async listNotificationIntents(): Promise<NotificationIntentState[]> {
    await this.ready(); return Object.values((await this.load()).notificationIntents).map(value => structuredClone(value));
  }
  async putNotificationIntent(state: NotificationIntentState): Promise<void> {
    if (!state || typeof state.intentRef !== 'string' || !state.intentRef) throw new Error('RULE_INVALID_INTENT');
    await this.mutate(document => {
      const existing = document.notificationIntents[state.intentRef];
      if (!existing && Object.keys(document.notificationIntents).length >= MAX_INTENTS) {
        // Bounded retention: drop only the oldest settled intent, never an unknown one.
        const settled = Object.values(document.notificationIntents).filter(item => item.state === 'delivered' || item.state === 'failed');
        if (!settled.length) throw new Error('RULE_BACKPRESSURE');
        settled.sort((a, b) => a.at.localeCompare(b.at));
        delete document.notificationIntents[settled[0]!.intentRef];
      }
      document.notificationIntents[state.intentRef] = structuredClone(state);
    });
  }
}
export { validateTimeRule, validateNotificationRule, validateObservationRule, validateOnceWaitRule };
