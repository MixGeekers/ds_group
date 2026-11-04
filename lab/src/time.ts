import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const MAX_STORY_MS = 90 * 24 * 60 * 60 * 1000;
export interface TimeSource { wallNow(): number; monotonicNow(): number; }
export const systemTime: TimeSource = { wallNow: () => Date.now(), monotonicNow: () => performance.now() };
export interface TimeConfig { mode: 'story' | 'load'; startAt: string; timeZone: string; }
export type MissedPolicy = 'each' | 'latest' | 'coalesce' | 'skip';
export interface ScheduleRule {
  id: string; revision: number; source: 'external' | 'target' | 'deadline' | 'end' | 'actor';
  kind: string; nextAtMs: number; everyMs?: number; untilMs?: number; missed: MissedPolicy;
  payload: Record<string, unknown>; cancelled?: boolean;
}
export interface Occurrence {
  id: string; ruleId: string; revision: number; source: ScheduleRule['source']; kind: string;
  firstAtMs: number; scheduledAtMs: number; count: number; deliveredCount: number;
  missed: MissedPolicy; payload: Record<string, unknown>;
}
export interface TimelineState {
  version: 1; config: TimeConfig; businessMs: number; paused: boolean; stopped: boolean;
  rules: ScheduleRule[]; pending?: Occurrence;
}
const priority: Record<ScheduleRule['source'], number> = { external: 0, actor: 1, target: 2, deadline: 3, end: 4 };
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function parseStoryInstant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:[0-5]\d)$/.test(value)) throw new Error('故事日期必须是带明确时区的 ISO 时刻');
  const instant = Date.parse(value), date = value.slice(0, 10), midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(instant) || !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) throw new Error('故事日期无效');
  return instant;
}

export function validateTimeConfig(value: unknown): TimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('time 必须是对象');
  const config = value as TimeConfig;
  if (Object.keys(config).some(key => !['mode', 'startAt', 'timeZone'].includes(key))
    || !['story', 'load'].includes(config.mode)) throw new Error('time.mode 应为 story 或 load');
  parseStoryInstant(config.startAt);
  if (typeof config.timeZone !== 'string' || config.timeZone.length > 100) throw new Error('故事时区无效');
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format(0);
  return { mode: config.mode, startAt: new Date(config.startAt).toISOString(), timeZone: config.timeZone };
}

/** Serializable agenda. Runtime timers and real authorization never use its date. */
export class Timeline {
  private anchorMono: number;
  private anchorBusiness: number;
  constructor(readonly scope: string, readonly state: TimelineState, readonly speed: number, private readonly source: TimeSource = systemTime) {
    this.anchorMono = source.monotonicNow();
    this.anchorBusiness = state.businessMs;
  }

  now(): number {
    if (!this.state.paused && !this.state.stopped && this.state.config.mode === 'load') {
      this.state.businessMs = Math.max(this.state.businessMs, Math.min(MAX_STORY_MS,
        this.anchorBusiness + Math.max(0, this.source.monotonicNow() - this.anchorMono) * this.speed));
    }
    return this.state.businessMs;
  }

  pause(): void { this.now(); this.state.paused = true; }
  resume(): void {
    if (this.state.stopped || this.state.pending) throw new Error('时间线已停止或有 unknown occurrence');
    this.anchorBusiness = this.state.businessMs; this.anchorMono = this.source.monotonicNow();
    this.state.paused = false;
  }
  stop(): void { this.pause(); this.state.stopped = true; }

  add(rule: ScheduleRule): void {
    if (this.state.stopped) throw new Error('时间线已停止');
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(rule.id) || !Number.isSafeInteger(rule.revision) || rule.revision < 1) throw new Error('调度身份或修订无效');
    if (!(rule.source in priority) || !['each', 'latest', 'coalesce', 'skip'].includes(rule.missed)) throw new Error('调度来源或错过策略无效');
    if (!Number.isFinite(rule.nextAtMs) || rule.nextAtMs < this.state.businessMs || rule.nextAtMs > MAX_STORY_MS) throw new Error('调度时刻必须位于当前故事时间与90天范围之间');
    if (rule.everyMs !== undefined && (!Number.isSafeInteger(rule.everyMs) || rule.everyMs < 1000 || rule.everyMs > MAX_STORY_MS)) throw new Error('周期必须为1000毫秒至90天的整数');
    if (rule.untilMs !== undefined && (!Number.isFinite(rule.untilMs) || rule.untilMs < rule.nextAtMs || rule.untilMs > MAX_STORY_MS)) throw new Error('周期结束时刻无效');
    const old = this.state.rules.find(item => item.id === rule.id);
    if (old && rule.revision !== old.revision + 1) throw new Error('调度修订冲突');
    if (!old && rule.revision !== 1) throw new Error('首次调度修订应为1');
    if (this.state.pending?.ruleId === rule.id) throw new Error('调度 occurrence 尚未核对');
    if (!old && this.state.rules.length >= 10000) throw new Error('调度规则数达到上限');
    if (old) this.state.rules[this.state.rules.indexOf(old)] = structuredClone(rule);
    else this.state.rules.push(structuredClone(rule));
  }

  cancel(id: string, revision: number): void {
    const rule = this.state.rules.find(item => item.id === id);
    if (!rule || rule.revision !== revision) throw new Error('调度不存在或修订冲突');
    if (this.state.pending?.ruleId === id) throw new Error('调度 occurrence 尚未核对');
    rule.cancelled = true;
  }

  nextTime(): number | undefined {
    const times = this.state.rules.filter(rule => !rule.cancelled && rule.nextAtMs <= (rule.untilMs ?? MAX_STORY_MS)).map(rule => rule.nextAtMs);
    return times.length ? Math.max(this.state.businessMs, Math.min(...times)) : undefined;
  }

  next(horizon: number): Occurrence | undefined {
    if (this.state.pending) throw new Error('存在 unknown occurrence，需先核对');
    const candidates = this.state.rules.filter(rule => !rule.cancelled && rule.nextAtMs <= Math.min(horizon, rule.untilMs ?? MAX_STORY_MS)).map(rule => {
      const dueCount = rule.everyMs ? Math.floor((Math.min(horizon, rule.untilMs ?? MAX_STORY_MS) - rule.nextAtMs) / rule.everyMs) + 1 : 1;
      const count = rule.missed === 'each' ? 1 : dueCount;
      const scheduledAtMs = rule.nextAtMs + (count - 1) * (rule.everyMs ?? 0);
      const identity = JSON.stringify([this.scope, rule.id, rule.revision, Date.parse(this.state.config.startAt) + scheduledAtMs]);
      return { id: createHash('sha256').update(identity).digest('hex'), ruleId: rule.id, revision: rule.revision,
        source: rule.source, kind: rule.kind, firstAtMs: rule.nextAtMs, scheduledAtMs, count,
        deliveredCount: rule.missed === 'skip' && scheduledAtMs < horizon ? 0 : 1,
        missed: rule.missed, payload: structuredClone(rule.payload) };
    });
    return candidates.sort((a, b) => a.scheduledAtMs - b.scheduledAtMs || priority[a.source] - priority[b.source] || compareId(a.ruleId, b.ruleId))[0];
  }

  claim(occurrence: Occurrence): void {
    if (this.state.pending) throw new Error('存在 unknown occurrence');
    this.state.pending = occurrence;
  }
  settle(): void {
    const occurrence = this.state.pending;
    if (!occurrence) throw new Error('没有待确认 occurrence');
    const rule = this.state.rules.find(item => item.id === occurrence.ruleId)!;
    if (rule.everyMs) rule.nextAtMs = occurrence.scheduledAtMs + rule.everyMs;
    else rule.cancelled = true;
    delete this.state.pending;
  }

  view() {
    const businessMs = this.now();
    const storyAt = new Date(Date.parse(this.state.config.startAt) + businessMs).toISOString();
    return { ...this.state.config, businessMs, storyAt, paused: this.state.paused, stopped: this.state.stopped,
      localDateTime: new Intl.DateTimeFormat('sv-SE', { timeZone: this.state.config.timeZone, dateStyle: 'short', timeStyle: 'long', hourCycle: 'h23' }).format(new Date(storyAt)) };
  }
}
