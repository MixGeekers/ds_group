/**
 * Explicit state-machine oracle for Task / Goal / lifecycle / pause states.
 *
 * Two entry points:
 * - `checkStateMachine(spec, events)` simulates events from the declared
 *   initial state against the frozen transition table.
 * - `checkObservedHistory(spec, steps)` judges a recorded `from/event/to`
 *   history for continuity and legality without replaying hidden state.
 *
 * Boundary: it judges the declared transition table and the recorded
 * history. A table that is wrong about the business still passes; illegal
 * *recorded* jumps, terminal advances, ambiguous tables and discontinuity
 * are rejected. Guards such as authority/budget are separate oracles.
 */
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, violation } from './invariant.js';

const ORACLE = 'state-machine';
const VERSION = '1.1.0';
const BOUNDARY =
  '按显式转移表判定状态机事件与已记录历史：拒绝未知状态/非法转移/被标记拒绝却发生的变化/终态推进/历史不连续/歧义转移表。' +
  '不判定业务语义、授权或资源条件；转移表本身错误仍可能通过。';

export interface TransitionRule {
  readonly from: string;
  readonly event: string;
  readonly to: string;
  /** The table explicitly says this transition is refused and must not change state. */
  readonly denied?: boolean;
}

export interface StateMachineSpec {
  readonly name?: string;
  readonly initial: string;
  readonly states: readonly string[];
  readonly terminal?: readonly string[];
  readonly transitions: readonly TransitionRule[];
}

export interface StateEvent {
  readonly event: string;
  readonly expectedState?: string;
}

export interface ObservedStep {
  readonly from: string;
  readonly event: string;
  readonly to: string;
}

function tableDefects(spec: StateMachineSpec): Violation[] {
  const out: Violation[] = [];
  const states = new Set(spec.states);
  if (!states.has(spec.initial)) out.push(violation('unknown_state', '$["initial"]', `initial state ${spec.initial} is not declared`));
  for (const terminal of spec.terminal ?? []) {
    if (!states.has(terminal)) out.push(violation('unknown_state', `${jsonPointerChild('$["terminal"]', spec.terminal!.indexOf(terminal))}`, `terminal state ${terminal} is not declared`));
  }
  const seen = new Map<string, number>();
  spec.transitions.forEach((rule, index) => {
    const path = jsonPointerChild('$["transitions"]', index);
    if (!states.has(rule.from)) out.push(violation('unknown_state', `${path}["from"]`, `transition source ${rule.from} is not declared`));
    if (!states.has(rule.to)) out.push(violation('unknown_state', `${path}["to"]`, `transition target ${rule.to} is not declared`));
    const key = `${rule.from}\u0000${rule.event}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      out.push(violation('ambiguous_transition', path, `duplicate transition for ${rule.from}/${rule.event} (first at index ${previous})`));
    } else {
      seen.set(key, index);
    }
    if (rule.denied && rule.to !== rule.from) {
      out.push(violation('denied_transition_changes_state', path, 'denied transition must stay in the same state'));
    }
  });
  return out;
}

function findRule(spec: StateMachineSpec, from: string, event: string): TransitionRule | undefined {
  return spec.transitions.find(rule => rule.from === from && rule.event === event);
}

/**
 * Simulate events from the initial state. A matching rule advances the
 * machine; a `denied` rule leaves the state unchanged. A missing rule is
 * an illegal transition (an explicitly ignored event must be declared).
 */
export function checkStateMachine(spec: StateMachineSpec, events: readonly StateEvent[]): CheckResult {
  const violations = tableDefects(spec);
  const terminal = new Set(spec.terminal ?? []);
  const states = new Set(spec.states);
  let current = spec.initial;
  events.forEach((item, index) => {
    const path = jsonPointerChild('$["events"]', index);
    if (terminal.has(current)) {
      violations.push(violation('terminal_advanced', path, `event ${item.event} arrived after terminal state ${current}`));
      return;
    }
    const rule = findRule(spec, current, item.event);
    if (rule === undefined) {
      violations.push(violation('illegal_transition', path, `no transition for ${current}/${item.event}`));
      return;
    }
    const next = rule.denied ? current : rule.to;
    if (!states.has(next)) {
      violations.push(violation('unknown_state', path, `transition target ${next} is not declared`));
      return;
    }
    if (rule.denied && item.expectedState !== undefined && item.expectedState !== current) {
      violations.push(violation('denied_transition_applied', path, `denied ${rule.from}/${rule.event} was applied (expected ${item.expectedState})`));
    } else if (item.expectedState !== undefined && item.expectedState !== next) {
      violations.push(violation('state_mismatch', path, `expected state ${item.expectedState}, reached ${next}`));
    }
    current = next;
  });
  const metrics: Record<string, JsonValue> = { finalState: current, events: events.length, transitions: spec.transitions.length };
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'simulation' }, events.length, violations, metrics);
}

/** Judge a recorded transition history without hidden simulation. */
export function checkObservedHistory(spec: StateMachineSpec, steps: readonly ObservedStep[], options: { requireInitial?: boolean } = {}): CheckResult {
  const violations = tableDefects(spec);
  const states = new Set(spec.states);
  const terminal = new Set(spec.terminal ?? []);
  let previous: string | undefined;
  steps.forEach((step, index) => {
    const path = jsonPointerChild('$["steps"]', index);
    if (!states.has(step.from) || !states.has(step.to)) {
      violations.push(violation('unknown_state', path, `unknown state in ${step.from}->${step.to}`));
      return;
    }
    if (previous !== undefined && step.from !== previous) {
      violations.push(violation('history_discontinuity', path, `step starts in ${step.from}, previous step ended in ${previous}`));
    }
    if (index === 0 && (options.requireInitial ?? true) && step.from !== spec.initial) {
      violations.push(violation('boundary_mismatch', path, `first step starts in ${step.from}, declared initial is ${spec.initial}`));
    }
    const rule = findRule(spec, step.from, step.event);
    if (rule === undefined) {
      violations.push(violation('illegal_recorded_transition', path, `no transition for ${step.from}/${step.event}`));
    } else if (rule.denied) {
      violations.push(violation('denied_recorded_transition', path, `recorded transition was declared denied: ${step.from}/${step.event}`));
    } else if (rule.to !== step.to) {
      violations.push(violation('illegal_recorded_transition', path, `${step.from}/${step.event} must lead to ${rule.to}, recorded ${step.to}`));
    }
    if (terminal.has(step.from)) {
      violations.push(violation('terminal_advanced', path, `recorded event ${step.event} leaves terminal state ${step.from}`));
    }
    previous = step.to;
  });
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'observed-history' }, steps.length, violations, {
    steps: steps.length,
  });
}

/* --------------------------- self-proof --------------------------- */

const goalSpec: StateMachineSpec = {
  name: 'synthetic-goal-lifecycle',
  initial: 'created',
  states: ['created', 'paused', 'running', 'completed', 'cancelled'],
  terminal: ['completed', 'cancelled'],
  transitions: [
    { from: 'created', event: 'disarm', to: 'paused' },
    { from: 'paused', event: 'resume', to: 'running' },
    { from: 'running', event: 'pause', to: 'paused' },
    { from: 'running', event: 'complete', to: 'completed' },
    { from: 'running', event: 'cancel', to: 'cancelled' },
    { from: 'paused', event: 'complete', to: 'paused', denied: true },
    { from: 'paused', event: 'cancel', to: 'cancelled' },
  ],
};

export const stateMachineSelfProof: OracleSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/state-machine.ts',
  boundary: BOUNDARY,
  evaluate: input => {
    const { spec, events, steps, requireInitial } = input as {
      spec: StateMachineSpec;
      events?: StateEvent[];
      steps?: ObservedStep[];
      requireInitial?: boolean;
    };
    if (steps !== undefined) return checkObservedHistory(spec, steps, { requireInitial });
    return checkStateMachine(spec, events ?? []);
  },
  samples: [
    {
      label: 'accept-legal-lifecycle',
      input: {
        spec: goalSpec,
        events: [
          { event: 'disarm', expectedState: 'paused' },
          { event: 'resume', expectedState: 'running' },
          { event: 'pause', expectedState: 'paused' },
          { event: 'resume', expectedState: 'running' },
          { event: 'complete', expectedState: 'completed' },
        ],
      },
      expect: 'accept',
      why: 'create/pause/resume/pause/resume/complete 均按冻结表合法',
    },
    {
      label: 'accept-denied-transition-keeps-state',
      input: { spec: goalSpec, events: [{ event: 'disarm', expectedState: 'paused' }, { event: 'complete', expectedState: 'paused' }] },
      expect: 'accept',
      why: '表中显式拒绝的 paused/complete 不改变状态且期望一致',
    },
    {
      label: 'accept-observed-history',
      input: {
        spec: goalSpec,
        steps: [
          { from: 'created', event: 'disarm', to: 'paused' },
          { from: 'paused', event: 'resume', to: 'running' },
          { from: 'running', event: 'complete', to: 'completed' },
        ],
      },
      expect: 'accept',
      why: '观测历史连续、合法并正确终止',
    },
    {
      label: 'reject-illegal-event',
      input: { spec: goalSpec, events: [{ event: 'resume', expectedState: 'running' }] },
      expect: 'reject',
      expectCodes: ['illegal_transition'],
      why: 'created 状态下不能直接 resume',
    },
    {
      label: 'reject-terminal-advance',
      input: {
        spec: goalSpec,
        events: [{ event: 'disarm' }, { event: 'resume' }, { event: 'complete' }, { event: 'pause' }],
      },
      expect: 'reject',
      expectCodes: ['terminal_advanced'],
      why: 'completed 终态后又出现事件',
    },
    {
      label: 'reject-denied-transition-applied',
      input: { spec: goalSpec, events: [{ event: 'disarm' }, { event: 'complete', expectedState: 'completed' }] },
      expect: 'reject',
      expectCodes: ['denied_transition_applied'],
      why: '表中拒绝的转移被当成完成应用',
    },
    {
      label: 'reject-state-mismatch',
      input: { spec: goalSpec, events: [{ event: 'disarm', expectedState: 'running' }] },
      expect: 'reject',
      expectCodes: ['state_mismatch'],
      why: '模拟到达状态与期望状态不符',
    },
    {
      label: 'reject-history-discontinuity',
      input: {
        spec: goalSpec,
        steps: [
          { from: 'created', event: 'disarm', to: 'paused' },
          { from: 'running', event: 'complete', to: 'completed' },
        ],
      },
      expect: 'reject',
      expectCodes: ['history_discontinuity'],
      why: '第二步从 running 开始，但上一步结束于 paused',
    },
    {
      label: 'reject-illegal-recorded-transition',
      input: { spec: goalSpec, steps: [{ from: 'created', event: 'resume', to: 'running' }] },
      expect: 'reject',
      expectCodes: ['illegal_recorded_transition'],
      why: 'created 状态下 resume 不在转移表内却出现在历史中',
    },
    {
      label: 'reject-ambiguous-table',
      input: {
        spec: {
          ...goalSpec,
          transitions: [...goalSpec.transitions, { from: 'paused', event: 'resume', to: 'paused' }],
        },
        events: [],
      },
      expect: 'reject',
      expectCodes: ['ambiguous_transition'],
      why: '同一 from/event 出现两条规则，状态机定义歧义',
    },
  ],
};
