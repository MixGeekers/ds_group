import { randomUUID } from 'node:crypto';
import type { EvidencePacket, JudgeDimension, ReviewResult } from './types.ts';

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_DIMENSIONS = 32;
const VALID_STATUSES = new Set(['scored', 'not_applicable', 'insufficient_evidence']);

export interface JudgeOptions {
  url: string;
  token?: string;
  timeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(provider: string, error: string): ReviewResult {
  return {
    id: `review-${randomUUID()}`, at: new Date().toISOString(), provider,
    status: 'judge_error', dimensions: [], needsHumanReview: true,
    error: error.slice(0, 2000),
  };
}

function evidenceReferences(packet: EvidencePacket): Set<string> {
  return new Set([
    ...packet.evidence.map(item => item.ref),
    ...packet.events.map(event => event.id),
    ...packet.facts.assertions.map(assertion => assertion.id),
    ...packet.artifacts.map(artifact => `artifact:${artifact.path}`),
    ...packet.tasks.map(task => `task:${task.id}`),
  ]);
}

/** Import a new opinion; no caller-supplied ID, timestamp, provider or facts are authoritative. */
export function importReview(packet: EvidencePacket, input: unknown, provider = 'import'): ReviewResult {
  try {
    if (!record(input)) throw new Error('评分结果必须是 JSON 对象。');
    if (input.status !== undefined && input.status !== 'completed' && input.status !== 'judge_error') {
      throw new Error('评分结果 status 无效。');
    }
    if (input.status === 'judge_error') {
      throw new Error(`评分服务报告失败：${typeof input.error === 'string' ? input.error.slice(0, 1000) : '未提供错误详情'}`);
    }
    if (!Array.isArray(input.dimensions) || input.dimensions.length === 0 || input.dimensions.length > MAX_DIMENSIONS) {
      throw new Error(`评分须包含 1–${MAX_DIMENSIONS} 个维度。`);
    }
    if (input.needsHumanReview !== undefined && typeof input.needsHumanReview !== 'boolean') {
      throw new Error('needsHumanReview 必须是布尔值。');
    }

    const validRefs = evidenceReferences(packet);
    const names = new Set<string>();
    const dimensions: JudgeDimension[] = input.dimensions.map((item, index) => {
      const label = `第 ${index + 1} 个评分维度`;
      if (!record(item)) throw new Error(`${label}必须是对象。`);
      if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) {
        throw new Error(`${label}需要 1–100 字的名称。`);
      }
      const name = item.name.trim();
      if (names.has(name.toLocaleLowerCase())) throw new Error(`评分维度名称重复：${name}`);
      names.add(name.toLocaleLowerCase());
      if (typeof item.status !== 'string' || !VALID_STATUSES.has(item.status)) {
        throw new Error(`${label}的 status 无效。`);
      }
      if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 8000) {
        throw new Error(`${label}需要非空且不超过 8000 字的理由。`);
      }
      if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 100 ||
          item.evidenceRefs.some(ref => typeof ref !== 'string' || !validRefs.has(ref))) {
        throw new Error(`${label}包含不存在的证据引用，或 evidenceRefs 格式无效。`);
      }
      const evidenceRefs = [...new Set(item.evidenceRefs as string[])];
      if (item.status === 'scored') {
        if (!Number.isInteger(item.score) || (item.score as number) < 1 || (item.score as number) > 5) {
          throw new Error(`${label}的分数必须是 1–5 的整数。`);
        }
        if (evidenceRefs.length === 0) throw new Error(`${label}给出分数时必须引用证据。`);
      } else if (item.score !== undefined) {
        throw new Error(`${label}未评分时不能携带数值分数。`);
      }
      return {
        name, status: item.status as JudgeDimension['status'],
        ...(item.status === 'scored' ? { score: item.score as number } : {}),
        reason: item.reason.trim(), evidenceRefs,
      };
    });

    let usage: Record<string, unknown> | undefined;
    if (input.usage !== undefined) {
      if (!record(input.usage)) throw new Error('usage 必须是对象。');
      const serialized = JSON.stringify(input.usage);
      if (Buffer.byteLength(serialized) > 16 * 1024) throw new Error('usage 超过大小限制。');
      usage = JSON.parse(serialized) as Record<string, unknown>;
    }
    return {
      id: `review-${randomUUID()}`, at: new Date().toISOString(), provider,
      status: 'completed', dimensions,
      needsHumanReview: input.needsHumanReview !== false || dimensions.some(dimension => dimension.status === 'insufficient_evidence'),
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    return failure(provider, error instanceof Error ? error.message : '评分结果解析失败。');
  }
}

function validateEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) throw new Error('评分端点不能在 URL 中包含账号或密码。');
  if (url.hash) throw new Error('评分端点不能包含 URL fragment。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('评分端点须使用 HTTPS；本机 localhost/127.0.0.1/::1 可使用 HTTP。');
  }
  return url;
}

async function readLimitedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('评分响应超过 512 KiB 限制。');
  }
  if (!response.body) throw new Error('评分响应没有正文。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('评分响应超过 512 KiB 限制。');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Explicit, bounded request to a separately configured Judge Agent endpoint. */
export async function callJudge(packet: EvidencePacket, options: JudgeOptions): Promise<ReviewResult> {
  let provider = 'external-agent';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const url = validateEndpoint(options.url);
    provider = `endpoint:${url.origin}`;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new Error('评分超时须为 1–120000 毫秒的整数。');
    }
    if (options.token !== undefined && (typeof options.token !== 'string' || /[\r\n]/.test(options.token))) {
      throw new Error('评分凭据格式无效。');
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: {
        'content-type': 'application/json', 'accept': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(packet),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`评分服务 HTTP ${response.status}。`);
    }
    const body = await readLimitedResponse(response);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error('评分服务未返回有效 JSON。'); }
    return importReview(packet, parsed, provider);
  } catch (error) {
    if (controller.signal.aborted) return failure(provider, '评分调用超时；没有生成有效分数。');
    // Native network failures can contain request details. Preserve a useful category without credentials/URL query.
    if (error instanceof TypeError) return failure(provider, '评分端点地址无效、连接失败或发生了不允许的重定向。');
    return failure(provider, error instanceof Error ? error.message : '评分调用失败。');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
