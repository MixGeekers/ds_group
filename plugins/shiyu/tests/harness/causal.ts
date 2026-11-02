/**
 * Causal-alignment oracle: the core "independent evidence" judge.
 *
 * It answers three questions the handoff documents keep repeating:
 * 1. When the product claims success/unknown for an external effect, does an
 *    independent execution/receipt record exist, and does the claim match
 *    what the endpoint actually did (02 §3.1/§6.4)?
 * 2. Can the required causal chain `event → trigger → mandate → task →
 *    assignment → operation → effect → receipt → publication →
 *    context_load → draft → delivery` be followed without faked empty
 *    nodes (02 §4.3)?
 * 3. Are both sides aligned by runId/identity/causal key without silently
 *    dropping unmatched records?
 *
 * Boundary: it judges the supplied facts. If the observer itself missed an
 * event, the oracle reports an evidence gap rather than zero violations.
 * It cannot see provider-internal behaviour; a missing provider record stays
 * unknown.
 */
import type { CheckResult, JsonValue, OracleSelfProof, Violation } from './invariant.js';
import { finish, jsonPointerChild, violation } from './invariant.js';

const ORACLE = 'causal';
const VERSION = '1.1.0';
const BOUNDARY =
  '判定独立效果账本与产品知识的对齐、因果链完整性与 runId/身份/因果键一致性：产品成功必须有独立效果与回执，' +
  'unknown 可保留但不得冒充成功，非幂等效果不得多于一次，缺失节点/伪造空节点/断链/错 runId 均拒绝。' +
  '只判定给定事实；观察器自身漏采会报告证据缺口，不会变成零违规。';

export interface EffectObservation {
  readonly effectId: string;
  readonly operation: string;
  readonly idempotent: boolean;
  /** Inbound dispatch attempts recorded by the receiving side. */
  readonly attempts: number;
  /** Actual executions observed by the receiving side. */
  readonly executions: number;
  /** Independent receipts returned to the product. */
  readonly receipts: number;
  readonly productKnowledge: 'not_started' | 'unknown' | 'succeeded' | 'failed';
}

export function checkEffectAccounting(
  effects: readonly EffectObservation[],
  options: { requireReceiptForSuccess?: boolean } = {},
): CheckResult {
  const requireReceipt = options.requireReceiptForSuccess ?? true;
  const violations: Violation[] = [];
  let unknownWithObservedExecution = 0;
  effects.forEach((effect, index) => {
    const path = jsonPointerChild('$["effects"]', index);
    const identity = { effectId: effect.effectId, operation: effect.operation };
    if (effect.executions < 0 || effect.attempts < 0 || effect.receipts < 0) {
      violations.push(violation('negative_effect_count', path, 'effect counters must be non-negative'));
    }
    if (effect.attempts < effect.executions) {
      violations.push(violation('attempt_count_inconsistent', path, `attempts(${effect.attempts}) < executions(${effect.executions})`, identity));
    }
    if (effect.executions > 1 && !effect.idempotent) {
      violations.push(
        violation('duplicate_non_idempotent_execution', path, `non-idempotent effect executed ${effect.executions} times`, {
          ...identity,
          executions: effect.executions,
        }),
      );
    }
    if (effect.receipts > effect.executions) {
      violations.push(violation('orphan_receipt', path, `receipts(${effect.receipts}) > executions(${effect.executions})`, identity));
    }
    if (effect.productKnowledge === 'succeeded') {
      if (effect.executions === 0) {
        violations.push(violation('success_without_execution', path, 'product reports success but the receiving side observed no execution', identity));
      } else if (requireReceipt && effect.receipts === 0) {
        violations.push(
          violation('success_without_independent_receipt', path, 'product reports success without an independent receipt', identity),
        );
      }
    }
    if (effect.productKnowledge === 'failed' && effect.executions > 0) {
      violations.push(
        violation('failed_claim_contradicts_execution', path, 'product reports failure although the effect was observed executed; knowledge must stay unknown until reconciled', identity),
      );
    }
    if (effect.productKnowledge === 'not_started' && effect.executions > 0) {
      violations.push(violation('effect_executed_but_not_started', path, 'effect was executed while product records it as not started', identity));
    }
    if (effect.productKnowledge === 'unknown' && effect.executions > 0) {
      unknownWithObservedExecution++;
    }
  });
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'effect-accounting' }, effects.length, violations, {
    effects: effects.length,
    unknownWithObservedExecution,
  });
}

/* --------------------------- alignment --------------------------- */

export type FactSide = 'product' | 'observer';
export type FactStatus = 'success' | 'unknown' | 'failed' | 'skipped' | 'info';

export interface CausalFact {
  readonly side: FactSide;
  readonly runId: string;
  readonly kind: string;
  readonly id: string;
  readonly causalKey: string;
  readonly status?: FactStatus;
}

export interface AlignmentInput {
  readonly expectedRunId: string;
  readonly facts: readonly CausalFact[];
  readonly requiredKinds?: Readonly<Record<FactSide, readonly string[]>>;
}

export function checkCausalAlignment(input: AlignmentInput): CheckResult {
  const violations: Violation[] = [];
  const facts = input.facts;
  const seen = new Set<string>();
  const observerKeys = new Set<string>();
  const productKeys = new Set<string>();
  facts.forEach((fact, index) => {
    const path = jsonPointerChild('$["facts"]', index);
    if (fact.runId !== input.expectedRunId) {
      violations.push(
        violation('run_id_mismatch', path, `fact runId ${fact.runId} does not match expected ${input.expectedRunId}`, { fact: fact.id, kind: fact.kind }),
      );
    }
    const identity = `${fact.side}\u0000${fact.kind}\u0000${fact.id}`;
    if (seen.has(identity)) violations.push(violation('duplicate_fact_identity', path, `duplicate ${fact.side}/${fact.kind}/${fact.id}`));
    seen.add(identity);
    if (fact.side === 'observer') observerKeys.add(fact.causalKey);
    else productKeys.add(fact.causalKey);
  });
  for (let index = 0; index < facts.length; index++) {
    const fact = facts[index];
    const path = jsonPointerChild('$["facts"]', index);
    if (fact.side === 'product' && (fact.status === 'success' || fact.status === undefined) && !observerKeys.has(fact.causalKey)) {
      violations.push(
        violation('success_without_independent_fact', path, `product ${fact.kind} ${fact.id} has no observer fact for causalKey ${fact.causalKey}`, {
          fact: fact.id,
          kind: fact.kind,
          causalKey: fact.causalKey,
        }),
      );
    }
    if (fact.side === 'observer' && !productKeys.has(fact.causalKey)) {
      violations.push(
        violation('unpaired_observer_fact', path, `observer ${fact.kind} ${fact.id} for causalKey ${fact.causalKey} has no product record`, {
          fact: fact.id,
          kind: fact.kind,
          causalKey: fact.causalKey,
        }),
      );
    }
  }
  for (const [side, kinds] of Object.entries(input.requiredKinds ?? {}) as [FactSide, readonly string[]][]) {
    for (const kind of kinds) {
      if (!facts.some(fact => fact.side === side && fact.kind === kind)) {
        violations.push(violation('missing_required_fact', '$', `required ${side} fact kind ${kind} is absent`));
      }
    }
  }
  const matched = [...productKeys].filter(key => observerKeys.has(key)).length;
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'causal-alignment' }, facts.length, violations, {
    productFacts: facts.filter(fact => fact.side === 'product').length,
    observerFacts: facts.filter(fact => fact.side === 'observer').length,
    matchedCausalKeys: matched,
  });
}

/* --------------------------- trace chain --------------------------- */

export interface TraceNode {
  readonly node: string;
  readonly id: string;
  /** Identifier of the previous node this node claims to derive from. */
  readonly ref?: string | null;
  /** false = the node is a placeholder/empty object and must not count. */
  readonly present?: boolean;
  /** Optional observed order index, must be strictly increasing. */
  readonly order?: number;
  readonly runId?: string;
}

export interface TraceChainInput {
  readonly chain: readonly TraceNode[];
  readonly requiredNodes?: readonly string[];
  readonly expectedRunId?: string;
  readonly requireRefs?: boolean;
}

export function checkTraceChain(input: TraceChainInput): CheckResult {
  const violations: Violation[] = [];
  const ids = new Set<string>();
  let previousOrder: number | undefined;
  input.chain.forEach((node, index) => {
    const path = jsonPointerChild('$["chain"]', index);
    if (node.present === false) {
      violations.push(violation('faked_empty_node', path, `${node.node} node is a placeholder, not an observed fact`));
    }
    if (ids.has(node.id)) violations.push(violation('duplicate_node_identity', path, `duplicate node id ${node.id}`));
    ids.add(node.id);
    if (node.order !== undefined) {
      if (previousOrder !== undefined && node.order <= previousOrder) {
        violations.push(violation('trace_out_of_order', path, `order ${node.order} does not follow ${previousOrder}`));
      }
      previousOrder = node.order;
    }
    if (node.runId !== undefined && input.expectedRunId !== undefined && node.runId !== input.expectedRunId) {
      violations.push(violation('run_id_mismatch', path, `${node.node} runId ${node.runId} != ${input.expectedRunId}`));
    }
    const requireRefs = input.requireRefs ?? true;
    if (requireRefs) {
      if (index === 0) {
        if (node.ref !== undefined && node.ref !== null && !ids.has(node.ref)) {
          violations.push(violation('dangling_ref', path, `first node references unknown ${node.ref}`));
        }
      } else {
        const previous = input.chain[index - 1];
        if (node.ref === undefined || node.ref === null) {
          violations.push(violation('missing_ref', path, `${node.node} node does not declare the previous node`));
        } else if (node.ref !== previous.id) {
          violations.push(violation('ref_mismatch', path, `${node.node} references ${node.ref}, previous node is ${previous.id}`));
        }
      }
    } else if (node.ref !== undefined && node.ref !== null && !ids.has(node.ref)) {
      violations.push(violation('dangling_ref', path, `${node.node} references unknown ${node.ref}`));
    }
  });
  for (const required of input.requiredNodes ?? []) {
    if (!input.chain.some(node => node.node === required)) {
      violations.push(violation('missing_trace_node', '$', `required node ${required} is absent from the chain`));
    }
  }
  return finish({ oracle: ORACLE, version: VERSION, boundary: BOUNDARY, scope: 'trace-chain' }, input.chain.length, violations, {
    nodes: input.chain.map(node => node.node),
  });
}

/* --------------------------- self-proof --------------------------- */

const fullChain: TraceChainInput = {
  expectedRunId: 'run-h0',
  requiredNodes: ['event', 'trigger', 'mandate', 'task', 'assignment', 'operation', 'effect', 'receipt', 'publication', 'context_load', 'draft', 'delivery'],
  chain: [
    { node: 'event', id: 'evt-1', runId: 'run-h0' },
    { node: 'trigger', id: 'trg-1', ref: 'evt-1', runId: 'run-h0' },
    { node: 'mandate', id: 'mnd-1', ref: 'trg-1', runId: 'run-h0' },
    { node: 'task', id: 'tsk-1', ref: 'mnd-1', runId: 'run-h0' },
    { node: 'assignment', id: 'asg-1', ref: 'tsk-1', runId: 'run-h0' },
    { node: 'operation', id: 'op-1', ref: 'asg-1', runId: 'run-h0' },
    { node: 'effect', id: 'eff-1', ref: 'op-1', runId: 'run-h0' },
    { node: 'receipt', id: 'rcp-1', ref: 'eff-1', runId: 'run-h0' },
    { node: 'publication', id: 'pub-1', ref: 'rcp-1', runId: 'run-h0' },
    { node: 'context_load', id: 'ctx-1', ref: 'pub-1', runId: 'run-h0' },
    { node: 'draft', id: 'drf-1', ref: 'ctx-1', runId: 'run-h0' },
    { node: 'delivery', id: 'dlv-1', ref: 'drf-1', runId: 'run-h0' },
  ],
};

export const causalSelfProof: OracleSelfProof = {
  name: ORACLE,
  version: VERSION,
  module: 'tests/harness/causal.ts',
  boundary: BOUNDARY,
  evaluate: input => {
    const candidate = input as {
      effects?: EffectObservation[];
      requireReceiptForSuccess?: boolean;
      alignment?: AlignmentInput;
      chain?: TraceChainInput;
    };
    if (candidate.alignment !== undefined) return checkCausalAlignment(candidate.alignment);
    if (candidate.chain !== undefined) return checkTraceChain(candidate.chain);
    return checkEffectAccounting(candidate.effects ?? [], { requireReceiptForSuccess: candidate.requireReceiptForSuccess });
  },
  samples: [
    {
      label: 'accept-effect-once-lost-receipt-product-unknown',
      input: {
        effects: [
          { effectId: 'eff-1', operation: 'message.send', idempotent: false, attempts: 1, executions: 1, receipts: 0, productKnowledge: 'unknown' },
        ],
      },
      expect: 'accept',
      why: '接收端实际执行一次但回执丢失，产品保持 unknown；独立效果数 1 且未冒充成功',
    },
    {
      label: 'accept-effect-once-receipt-delivered',
      input: {
        effects: [
          { effectId: 'eff-2', operation: 'note.write', idempotent: false, attempts: 1, executions: 1, receipts: 1, productKnowledge: 'succeeded' },
        ],
      },
      expect: 'accept',
      why: '执行一次并取得独立回执后本地才报告成功',
    },
    {
      label: 'accept-idempotent-multiple-attempts-one-effect',
      input: {
        effects: [
          { effectId: 'eff-3', operation: 'note.read', idempotent: true, attempts: 3, executions: 1, receipts: 1, productKnowledge: 'succeeded' },
        ],
      },
      expect: 'accept',
      why: '幂等操作多次尝试仅一次效果，取得回执后可成功',
    },
    {
      label: 'reject-duplicate-non-idempotent-effect',
      input: {
        effects: [
          { effectId: 'eff-4', operation: 'message.send', idempotent: false, attempts: 2, executions: 2, receipts: 2, productKnowledge: 'succeeded' },
        ],
      },
      expect: 'reject',
      expectCodes: ['duplicate_non_idempotent_execution'],
      why: '同一非幂等效果实际执行两次，第二发送必须是零容忍失败',
    },
    {
      label: 'reject-success-without-receipt',
      input: {
        effects: [
          { effectId: 'eff-5', operation: 'message.send', idempotent: false, attempts: 1, executions: 1, receipts: 0, productKnowledge: 'succeeded' },
        ],
      },
      expect: 'reject',
      expectCodes: ['success_without_independent_receipt'],
      why: '产品声称成功但没有独立回执',
    },
    {
      label: 'reject-success-without-execution',
      input: {
        effects: [
          { effectId: 'eff-6', operation: 'message.send', idempotent: false, attempts: 0, executions: 0, receipts: 0, productKnowledge: 'succeeded' },
        ],
      },
      expect: 'reject',
      expectCodes: ['success_without_execution'],
      why: '产品成功但接收端没有执行记录',
    },
    {
      label: 'reject-failed-claim-contradicts-execution',
      input: {
        effects: [
          { effectId: 'eff-7', operation: 'message.send', idempotent: false, attempts: 1, executions: 1, receipts: 0, productKnowledge: 'failed' },
        ],
      },
      expect: 'reject',
      expectCodes: ['failed_claim_contradicts_execution'],
      why: '端点已执行却报失败；知识应保持 unknown 待核对',
    },
    {
      label: 'reject-orphan-receipt',
      input: {
        effects: [
          { effectId: 'eff-8', operation: 'note.write', idempotent: false, attempts: 0, executions: 0, receipts: 1, productKnowledge: 'unknown' },
        ],
      },
      expect: 'reject',
      expectCodes: ['orphan_receipt'],
      why: '回执多于执行，账本不可能成立',
    },
    {
      label: 'accept-aligned-causal-facts',
      input: {
        alignment: {
          expectedRunId: 'run-h0',
          requiredKinds: { product: ['effect', 'receipt'], observer: ['execution', 'receipt'] },
          facts: [
            { side: 'product', runId: 'run-h0', kind: 'effect', id: 'eff-1', causalKey: 'msg-1', status: 'success' },
            { side: 'product', runId: 'run-h0', kind: 'receipt', id: 'rcp-1', causalKey: 'msg-1', status: 'success' },
            { side: 'observer', runId: 'run-h0', kind: 'execution', id: 'exec-1', causalKey: 'msg-1' },
            { side: 'observer', runId: 'run-h0', kind: 'receipt', id: 'orcp-1', causalKey: 'msg-1' },
          ],
        },
      },
      expect: 'accept',
      why: '两侧按 causalKey 对齐，runId 与必需 kind 齐全',
    },
    {
      label: 'reject-success-without-independent-fact',
      input: {
        alignment: {
          expectedRunId: 'run-h0',
          facts: [{ side: 'product', runId: 'run-h0', kind: 'effect', id: 'eff-1', causalKey: 'msg-1', status: 'success' }],
        },
      },
      expect: 'reject',
      expectCodes: ['success_without_independent_fact'],
      why: '产品成功没有任何独立观察事实',
    },
    {
      label: 'reject-unpaired-observer-fact',
      input: {
        alignment: {
          expectedRunId: 'run-h0',
          facts: [{ side: 'observer', runId: 'run-h0', kind: 'execution', id: 'exec-9', causalKey: 'msg-9' }],
        },
      },
      expect: 'reject',
      expectCodes: ['unpaired_observer_fact'],
      why: '观察器看到效果但产品侧没有任何记录，属于证据缺口',
    },
    {
      label: 'reject-wrong-run-id',
      input: {
        alignment: {
          expectedRunId: 'run-h0',
          facts: [{ side: 'observer', runId: 'run-old', kind: 'execution', id: 'exec-1', causalKey: 'msg-1' }],
        },
      },
      expect: 'reject',
      expectCodes: ['run_id_mismatch', 'unpaired_observer_fact'],
      why: '旧 run 的记录不得混入本次证据',
    },
    {
      label: 'accept-full-causal-chain',
      input: { chain: fullChain },
      expect: 'accept',
      why: 'event→…→delivery 12 个节点齐全、引用连续、runId 一致',
    },
    {
      label: 'reject-missing-trace-node',
      input: { chain: { ...fullChain, chain: fullChain.chain.filter(node => node.node !== 'receipt') } },
      expect: 'reject',
      expectCodes: ['missing_trace_node'],
      why: '缺少 receipt 节点却继续记录 publication/delivery',
    },
    {
      label: 'reject-faked-empty-node',
      input: {
        chain: {
          ...fullChain,
          chain: fullChain.chain.map(node => (node.node === 'receipt' ? { ...node, present: false } : node)),
        },
      },
      expect: 'reject',
      expectCodes: ['faked_empty_node'],
      why: '实际未发生的节点被伪造为空对象',
    },
    {
      label: 'reject-ref-mismatch',
      input: {
        chain: {
          ...fullChain,
          chain: fullChain.chain.map(node => (node.node === 'effect' ? { ...node, ref: 'op-999' } : node)),
        },
      },
      expect: 'reject',
      expectCodes: ['ref_mismatch'],
      why: 'effect 声称来自不存在的 operation',
    },
    {
      label: 'reject-trace-out-of-order',
      input: {
        chain: {
          ...fullChain,
          chain: fullChain.chain.map(node => (node.node === 'delivery' ? { ...node, order: 1 } : { ...node, order: 2 })),
        },
      },
      expect: 'reject',
      expectCodes: ['trace_out_of_order'],
      why: '纯数字 order 不满足严格递增',
    },
    {
      label: 'reject-wrong-chain-run-id',
      input: {
        chain: {
          ...fullChain,
          chain: fullChain.chain.map(node => (node.node === 'draft' ? { ...node, runId: 'run-other' } : node)),
        },
      },
      expect: 'reject',
      expectCodes: ['run_id_mismatch'],
      why: '草稿来自其它 run，不能作为本 run 的交付证据',
    },
  ],
};
