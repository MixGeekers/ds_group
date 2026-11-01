import { createHash } from 'node:crypto';
import type { Assertion, LabEvent, RunDetail, TaskRecord } from './types.ts';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** This only rejects empty/acknowledgement-only submissions; it is NOT a semantic grader. */
export function isAcknowledgementOnly(text: string): boolean {
  const compact = text.trim().replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  return !compact || /^(?:收到|收到了|已收到|好的|好|明白|了解|谢谢|已接单|接单成功|我会处理|正在处理|稍后处理|稍后交付|已完成|已经完成|完成了|完成|任务已完成|已交付|已生成|搞定|ok|done|ack|acknowledged|received|completed)+$/.test(compact);
}

export interface OutcomeEvidenceReader {
  read: (relative: string) => Promise<Buffer>;
  text: (relative: string, bytes: Buffer) => Promise<{ text?: string; limitation?: string }>;
}

/** Facts bind an explicit submission to one actual delivery and to the latest real writes. */
async function inspectDelivery(detail: RunDetail, task: TaskRecord, reader: OutcomeEvidenceReader, refs: Set<string>) {
  const requests = detail.events.filter(event => event.type === 'input.request' && event.role === 'world' && event.taskId === task.id);
  requireThat(requests.length > 0, '没有任务实际引入的独立证据');
  requests.forEach(event => refs.add(event.id));
  const submissions = detail.events.filter(event => event.type === 'task.delivered' && event.role === 'world' && event.taskId === task.id);
  requireThat(submissions.length === 1, submissions.length ? '发现重复明确提交，不能把重复效果当作一次交付' : '没有 task.deliver 的明确提交证据；完成自述或普通消息不能替代');
  const submitted = submissions[0], data = submitted.data;
  refs.add(submitted.id);
  requireThat(data?.source === 'explicit_submission' && typeof data.operationId === 'string', '提交缺少可信来源或操作身份');
  requireThat(submitted.seq > requests[0].seq && submitted.channelId === task.channelId && data.toActorId === task.ownerId, '提交早于任务引入或交付对象不符');
  const paths = data.paths;
  requireThat(Array.isArray(paths) && paths.length <= 32 && paths.every(path => typeof path === 'string') && new Set(paths).size === paths.length, '提交文件引用无效或重复');
  const filenames = paths as string[];
  requireThat(typeof data.text === 'string' && data.text.length <= 10000, '提交正文无效');
  const body = data.text as string;
  requireThat(task.deliveryPolicy && filenames.length >= task.deliveryPolicy.minFiles, '提交未满足业务要求的文件数量');
  requireThat(filenames.length > 0 || (task.deliveryPolicy?.allowText && !isAcknowledgementOnly(body)), '仅接单确认或完成自述，不是实际正文成果');
  const snapshots = data.artifacts;
  requireThat(Array.isArray(snapshots) && snapshots.length === filenames.length, '提交缺少对应文件的摘要快照');
  const texts: string[] = body.trim() ? [body] : [];
  const limitations: string[] = [];
  for (const filename of filenames) {
    requireThat(filename.startsWith(`outputs/${task.id}/`), '提交文件不属于本任务');
    const registered = detail.artifacts.filter(artifact => artifact.path === filename && artifact.taskId === task.id);
    requireThat(registered.length === 1, `提交文件未实际注册或任务归属错误：${filename}`);
    const bytes = await reader.read(filename);
    refs.add(`artifact:${filename}`);
    requireThat(bytes.length > 0 && registered[0].bytes === bytes.length && registered[0].sha256 === digest(bytes), `文件在注册后发生变化或为空：${filename}`);
    const snapshot = (snapshots as Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>).filter(item => item && item.path === filename);
    requireThat(snapshot.length === 1 && snapshot[0].bytes === bytes.length && snapshot[0].sha256 === digest(bytes), `文件与明确提交时摘要不符：${filename}`);
    const write = detail.events.filter(event => event.type === 'file.written' && event.role === 'world' && event.data?.path === filename).at(-1);
    requireThat(write && write.taskId === task.id && write.seq > requests[0].seq && write.seq < submitted.seq && write.data?.bytes === bytes.length && write.data.sha256 === digest(bytes), `提交先后顺序或最后实际写入证据不符：${filename}`);
    refs.add(write!.id);
    const preview = await reader.text(filename, bytes);
    if (preview.text !== undefined) texts.push(preview.text);
    if (preview.limitation) limitations.push(`${filename}：${preview.limitation}`);
  }
  const deliveries = detail.events.filter(event => event.type === 'message.delivered' && event.role === 'world' && event.data?.operationId === data.operationId);
  requireThat(deliveries.length === 1, '提交缺少唯一真实送达记录或重复送达');
  const delivery = deliveries[0];
  requireThat(delivery.taskId === task.id && delivery.channelId === task.channelId && delivery.data?.toActorId === task.ownerId && delivery.seq > submitted.seq && delivery.causeId === submitted.id && delivery.data.deliveryEventId === submitted.id, '真实送达对象、提交关联或先后顺序不符');
  requireThat(same(delivery.data?.paths, filenames) && delivery.data?.text === body && same(delivery.data?.artifacts, snapshots) && delivery.text === submitted.text, '送达内容与明确提交的文件/正文不一致');
  refs.add(delivery.id);
  return { submitted, texts, limitations };
}

type Json = Record<string, unknown>;
function object(value: unknown): Json { requireThat(value && typeof value === 'object' && !Array.isArray(value), '业务来源不是对象'); return value as Json; }
function objects(value: unknown): Json[] { requireThat(Array.isArray(value), '业务来源不是数组'); return (value as unknown[]).map(object); }
function number(value: unknown): number { requireThat(typeof value === 'number' && Number.isFinite(value), '业务来源数值无效'); return value as number; }
const money = (value: number) => Math.round(value * 100) / 100;

function reportTotals(source: Json): Record<string, number> {
  const period = object(source.period), unique = new Map<string, Json>();
  for (const order of objects(source.orders)) {
    const id = String(order.id), previous = unique.get(id);
    requireThat(!previous || same(previous, order), '订单身份存在冲突，需人工明确来源版本');
    unique.set(id, order);
  }
  const orders = [...unique.values()].filter(order => String(order.date) >= String(period.start) && String(order.date) <= String(period.end) && order.status !== 'cancelled');
  let grossRevenue = 0, refundAmount = 0, netUnits = 0;
  for (const order of orders) { grossRevenue += number(order.quantity) * number(order.unitPrice); netUnits += number(order.quantity); }
  const returned = new Set<string>();
  for (const refund of objects(source.returns)) {
    if (returned.has(String(refund.id))) continue;
    returned.add(String(refund.id));
    const order = orders.find(order => order.id === refund.orderId);
    if (order) { refundAmount += number(refund.quantity) * number(order.unitPrice); netUnits -= number(refund.quantity); }
  }
  return { grossRevenue: money(grossRevenue), refundAmount: money(refundAmount), netRevenue: money(grossRevenue - refundAmount), orderCount: orders.length, netUnits };
}

const totalAliases: Record<string, string[]> = {
  grossRevenue: ['grossRevenue', '销售额', '订单总额'], refundAmount: ['refundAmount', '退款金额', '退款'],
  netRevenue: ['netRevenue', '净收入'], orderCount: ['orderCount', '有效订单数'], netUnits: ['netUnits', '净销售数量', '净销量'],
};
/** Narrow, unambiguous totals only; never guess a number's meaning from its mere presence. */
function explicitTotals(texts: string[]): Array<{ key: string; value: number }> {
  const values: Array<{ key: string; value: number }> = [];
  for (const text of texts) {
    let json: Json | undefined;
    try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) json = value; } catch { /* Natural text remains valid evidence. */ }
    if (json) {
      const summaries = [json, ...(json.totals && typeof json.totals === 'object' && !Array.isArray(json.totals) ? [json.totals as Json] : [])];
      for (const summary of summaries) for (const [key, names] of Object.entries(totalAliases)) for (const name of names) {
        if (typeof summary[name] === 'number' && Number.isFinite(summary[name])) values.push({ key, value: summary[name] as number });
      }
      continue;
    }
    // Whole-line key/value totals (Markdown, a vertical CSV, or simple prose).
    // Tables of product rows and ambiguous mentions remain for Judge.
    for (const line of text.split(/\r?\n/)) for (const [key, names] of Object.entries(totalAliases)) {
      const match = new RegExp(`^\\s*[-*|]?\\s*(?:总|合计)?(?:${names.join('|')})\\s*[:：=,，|\\t]\\s*(?:CNY\\s*|¥\\s*|￥\\s*)?(-?\\d+(?:\\.\\d+)?)\\s*(?:元|件|单)?\\s*[。.;；|]?\\s*$`, 'i').exec(line);
      if (match) values.push({ key, value: Number(match[1]) });
    }
  }
  return values;
}

function structuredNumericalFacts(task: TaskRecord, sources: Map<string, Json>, texts: string[]): { checked: number; detail: string } {
  const outputs: Json[] = [];
  for (const text of texts) {
    try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) outputs.push(value); } catch { /* Other delivery formats remain for Judge. */ }
  }
  let checked = 0;
  const equal = (actual: unknown, expected: number, label: string) => {
    requireThat(typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) < 0.000001, `${label} 数值错误：提交 ${String(actual)}，独立核对 ${expected}`); checked++;
  };
  if (task.subjectId === 'comparison') {
    const source = sources.get('inputs/suppliers.json')!;
    const quotes: Array<Json & { totalCost: number; eligible: boolean }> = objects(source.quotes).map(quote => ({ ...quote, totalCost: money(number(quote.unitPrice) * number(source.quantity) + number(quote.shipping)), eligible: String(quote.deliveryDate) <= String(source.deadline) && number(quote.quality) >= number(source.minQuality) }));
    for (const output of outputs) {
      if (Array.isArray(output.ranking)) for (const candidate of output.ranking) {
        if (!candidate || typeof candidate !== 'object' || !('supplierId' in candidate) || !('totalCost' in candidate)) continue;
        const row = candidate as Json, quote = quotes.find(quote => quote.supplierId === row.supplierId);
        requireThat(quote, '比较结果引用未知供应商'); equal(row.totalCost, quote.totalCost, `供应商 ${String(row.supplierId)} 总成本`);
        if (typeof row.eligible === 'boolean') { requireThat(row.eligible === quote.eligible, '供应商交期/质量适用性与来源不符'); checked++; }
      }
      if (typeof output.recommendedSupplierId === 'string') {
        requireThat(quotes.some(quote => quote.supplierId === output.recommendedSupplierId && quote.eligible), '推荐供应商未满足实际交期/质量约束'); checked++;
      }
    }
    return { checked, detail: `独立计算供应商事实（不强制唯一最低价推荐）：${JSON.stringify(quotes.map(quote => ({ supplierId: quote.supplierId, totalCost: quote.totalCost, eligible: quote.eligible })))}` };
  }
  if (task.subjectId === 'reconciliation') {
    const source = sources.get('inputs/reconciliation.json')!, orders = objects(source.purchaseOrders), receipts = objects(source.receipts), invoices = objects(source.invoices);
    const unique = [...new Map(invoices.map(invoice => [String(invoice.id), invoice])).values()];
    const expected: Json[] = [];
    for (const invoice of unique) {
      const count = invoices.filter(item => item.id === invoice.id).length;
      if (count > 1) expected.push({ kind: 'duplicate_invoice', purchaseOrderId: invoice.purchaseOrderId, invoiceId: invoice.id, expected: 1, actual: count });
      const order = orders.find(order => order.id === invoice.purchaseOrderId);
      if (order && number(invoice.amount) !== number(invoice.quantity) * number(order.unitPrice)) expected.push({ kind: 'amount_mismatch', purchaseOrderId: order.id, invoiceId: invoice.id, expected: money(number(invoice.quantity) * number(order.unitPrice)), actual: invoice.amount });
    }
    for (const order of orders) {
      const received = receipts.filter(receipt => receipt.purchaseOrderId === order.id).reduce((sum, receipt) => sum + number(receipt.quantity), 0);
      if (received < number(order.quantity)) expected.push({ kind: 'receipt_shortage', purchaseOrderId: order.id, expected: order.quantity, actual: received });
      if (!unique.some(invoice => invoice.purchaseOrderId === order.id)) expected.push({ kind: 'missing_invoice', purchaseOrderId: order.id, expected: order.quantity, actual: 0 });
    }
    for (const output of outputs) {
      if (Array.isArray(output.differences)) for (const item of output.differences) {
        if (!item || typeof item !== 'object' || !('kind' in item) || !('purchaseOrderId' in item)) continue;
        const row = item as Json;
        const matching = expected.filter(fact => fact.kind === row.kind && fact.purchaseOrderId === row.purchaseOrderId && (row.invoiceId === undefined || fact.invoiceId === row.invoiceId));
        requireThat(matching.length > 0, '对账结果声称的差异与原始单据不符');
        for (const key of ['expected', 'actual']) if (typeof row[key] === 'number') {
          requireThat(matching.some(fact => fact[key] === row[key]), `对账 ${key} 数值与原始单据不符`); checked++;
        }
      }
      if (Array.isArray(output.matchedPurchaseOrderIds)) for (const id of output.matchedPurchaseOrderIds) {
        requireThat(orders.some(order => order.id === id) && !expected.some(fact => fact.purchaseOrderId === id), '将存在差异或不存在的采购单声称为正常'); checked++;
      }
    }
    return { checked, detail: `独立重算对账事实：${JSON.stringify(expected)}` };
  }
  const source = sources.get('inputs/delivery.json')!, stock = number(source.stock), orders = objects(source.orders), inbound = objects(source.inbound);
  const totalNeed = orders.reduce((sum, order) => sum + number(order.quantity), 0), latestDue = orders.map(order => String(order.dueDate)).sort().at(-1)!;
  const inboundAvailable = inbound.filter(item => String(item.date) <= latestDue).reduce((sum, item) => sum + number(item.quantity), 0);
  for (const output of outputs) {
    let stockUsed = 0, inboundUsed = 0, recognizedRows = 0;
    const commitments: Array<{ date: string; quantity: number }> = [], seen = new Set<string>();
    if (Array.isArray(output.allocations)) for (const item of output.allocations) {
      if (!item || typeof item !== 'object' || !('orderId' in item) || !('fromStock' in item) || !('fromInbound' in item)) continue;
      const row = item as Json, order = orders.find(order => order.id === row.orderId);
      requireThat(order && !seen.has(String(row.orderId)), '交付数量引用未知或重复订单'); seen.add(String(row.orderId));
      const fromStock = number(row.fromStock), fromInbound = number(row.fromInbound);
      requireThat([fromStock, fromInbound].every(value => Number.isInteger(value) && value >= 0) && fromStock + fromInbound <= number(order.quantity), '分配数量无效或超过订单需求');
      if (row.shortage !== undefined) equal(row.shortage, number(order.quantity) - fromStock - fromInbound, '订单缺口');
      stockUsed += fromStock; inboundUsed += fromInbound; recognizedRows++; checked++;
      commitments.push({ date: typeof row.promisedDate === 'string' ? row.promisedDate : String(order.dueDate), quantity: fromInbound });
    }
    requireThat(stockUsed <= stock && inboundUsed <= inboundAvailable, '计划实际分配超过现货或可用在途数量');
    for (const commitment of commitments) requireThat(commitments.filter(item => item.date <= commitment.date).reduce((sum, item) => sum + item.quantity, 0) <= inbound.filter(item => String(item.date) <= commitment.date).reduce((sum, item) => sum + number(item.quantity), 0), '交付计划在实际到货前使用在途资源');
    if (typeof output.totalAllocated === 'number') {
      requireThat(output.totalAllocated >= 0 && output.totalAllocated <= Math.min(totalNeed, stock + inboundAvailable), '总分配数量超过真实可用资源或需求');
      if (recognizedRows && recognizedRows === (output.allocations as unknown[]).length) equal(output.totalAllocated, stockUsed + inboundUsed, '总分配数量'); else checked++;
    }
    if (typeof output.remainingStock === 'number') {
      requireThat(output.remainingStock >= 0 && output.remainingStock <= stock, '剩余库存与真实库存边界不符');
      if (recognizedRows && recognizedRows === (output.allocations as unknown[]).length) equal(output.remainingStock, stock - stockUsed, '剩余库存'); else checked++;
    }
  }
  return { checked, detail: `独立资源边界：现货 ${stock}，截止前可用在途 ${inboundAvailable}，总需求 ${totalNeed}；未据部分数值声称整体计划可执行或优先级已满足。` };
}

function serviceState(event: LabEvent): Json { return object(event.data?.service); }
async function checkService(detail: RunDetail, task: TaskRecord, submitted: LabEvent, read: OutcomeEvidenceReader['read'], refs: Set<string>) {
  const introduced = detail.events.find(event => event.role === 'world' && event.type === 'input.request' && event.taskId === task.id)!.seq;
  const observations = detail.events.filter(event => event.role === 'world' && event.type === 'service.inspected' && (!event.taskId || event.taskId === task.id) && event.seq > introduced && event.seq < submitted.seq);
  requireThat(observations.length > 0, '服务任务没有提交前的真实探测证据，不能相信检查/恢复自述');
  observations.forEach(event => refs.add(event.id));
  for (const event of observations) {
    const state = serviceState(event), config = object(state.config);
    requireThat(state.healthy === (number(config.maxConnections) >= number(config.requiredConnections) && config.maintenance === false), '独立服务探测状态内部矛盾');
  }
  if (task.subjectId === 'inspection') return '已确认提交前实际探测及探测状态自洽；正文诊断是否准确、充分仍须 Judge 核对。';
  const state = object(JSON.parse((await read('service.json')).toString('utf8'))), config = object(state.config);
  refs.add('artifact:service.json');
  requireThat(same(state, detail.service), '持久化服务状态与世界记录不符');
  const guide = object(JSON.parse((await read('inputs/service-guide.json')).toString('utf8')));
  refs.add('artifact:inputs/service-guide.json');
  const changes = detail.events.filter(event => event.role === 'world' && event.type === 'service.configured' && event.taskId === task.id && event.seq < submitted.seq);
  requireThat(changes.length > 0, '没有本任务真实服务变更证据');
  changes.forEach(event => refs.add(event.id));
  for (const event of changes) {
    const changed = object(serviceState(event).config);
    requireThat(number(changed.maxConnections) <= number(guide.maxAllowedConnections) && changed.maintenance === false, '服务变更超出业务授权范围');
  }
  const lastChange = changes.at(-1)!, lastObservation = observations.at(-1)!;
  requireThat(lastObservation.seq > lastChange.seq && same(serviceState(lastObservation), state), '服务变更后缺少实际复核，或复核已过时');
  requireThat(state.healthy === true && number(config.maxConnections) >= number(config.requiredConnections) && config.maintenance === false && number(config.maxConnections) <= number(guide.maxAllowedConnections), '实际服务未健康恢复或超出授权容量');
  return '已独立确认实际配置变化、授权范围、最终健康及变更后的复核；不要求固定容量值，变更解释质量仍须 Judge。';
}

export async function evaluateOutcomeTasks(detail: RunDetail, reader: OutcomeEvidenceReader): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  for (const task of detail.tasks) {
    const base: Assertion = { id: `task:${task.id}:verified`, name: task.title, taskId: task.id, status: 'inconclusive', detail: '', evidenceRefs: [`task:${task.id}`] };
    if (!task.introduced) { assertions.push({ ...base, status: 'not_applicable', detail: '任务尚未引入，不计入本次业务评测。' }); continue; }
    const refs = new Set(base.evidenceRefs);
    let delivered: Awaited<ReturnType<typeof inspectDelivery>>;
    try {
      delivered = await inspectDelivery(detail, task, reader, refs);
    } catch (error) {
      const missingSubmission = !detail.events.some(event => event.type === 'task.delivered' && event.role === 'world' && event.taskId === task.id);
      const interrupted = ['stopped', 'interrupted', 'failed'].includes(detail.status) && task.status !== 'completed' && missingSubmission;
      assertions.push({ ...base, status: interrupted ? 'inconclusive' : 'fail', detail: `${interrupted ? '运行提前结束，尚未提交：' : ''}${error instanceof Error ? error.message : String(error)}`, evidenceRefs: [...refs] });
      continue;
    }
    assertions.push({ id: `outcome:${task.id}:delivery`, name: `${task.title} · 提交完整性`, taskId: task.id, status: 'pass', detail: '实际注册文件/正文、提交快照、引入/写入/送达先后与收件人已核对；此项只证明交付，不证明业务完成。', evidenceRefs: [...refs] });
    let factsFailed = false;
    try {
      // Read the original, scoped inputs even if no parser can judge their semantics.
      const sources = new Map<string, Json>();
      for (const input of task.inputs) {
        const bytes = await reader.read(input); refs.add(`artifact:${input}`);
        if (input.endsWith('.json')) sources.set(input, object(JSON.parse(bytes.toString('utf8'))));
      }
      if (task.subjectId === 'report') {
        const expected = reportTotals(sources.get('inputs/orders.json')!);
        const claims = explicitTotals(delivered.texts);
        const wrong = claims.filter(claim => Math.abs(claim.value - expected[claim.key]) > 0.000001);
        requireThat(!wrong.length, wrong.map(claim => `${claim.key} 数值错误：提交 ${claim.value}，独立重算 ${expected[claim.key]}`).join('；'));
        const verified = [...new Set(claims.map(claim => claim.key))];
        assertions.push({ id: `outcome:${task.id}:numbers`, name: `${task.title} · 可确定数值`, taskId: task.id, status: claims.length ? 'pass' : 'inconclusive', detail: `从原始订单独立重算汇总：${JSON.stringify(expected)}。${claims.length ? `仅核对已明确表达的 ${verified.join('、')}；未据此认定明细、异常解释或完整报表合格。` : '未找到无歧义的受支持数值表达，交由 Judge 结合原文件判断，不能因格式不同判失败。'}`, evidenceRefs: [...refs] });
      } else if (['comparison', 'reconciliation', 'planning'].includes(task.subjectId)) {
        const result = structuredNumericalFacts(task, sources, delivered.texts);
        assertions.push({ id: `outcome:${task.id}:numbers`, name: `${task.title} · 可确定数值`, taskId: task.id, status: result.checked ? 'pass' : 'inconclusive', detail: `${result.detail} ${result.checked ? `仅验证 ${result.checked} 项已明确表达的受支持事实；不代表完整业务要求通过。` : '未识别可可靠解析的结构化数值声明，其他格式和语义由 Judge 读取原文件核验，不按格式判失败。'}`, evidenceRefs: [...refs] });
      } else if (task.subjectId === 'inspection' || task.subjectId === 'maintenance') {
        const explanation = await checkService(detail, task, delivered.submitted, reader.read, refs);
        assertions.push({ id: `outcome:${task.id}:service`, name: `${task.title} · 实际服务事实`, taskId: task.id, status: 'pass', detail: explanation, evidenceRefs: [...refs] });
      }
    } catch (error) {
      factsFailed = true;
      assertions.push({ id: `outcome:${task.id}:facts`, name: `${task.title} · 确定事实冲突`, taskId: task.id, status: 'fail', detail: error instanceof Error ? error.message : String(error), evidenceRefs: [...refs] });
    }
    assertions.push({ ...base, status: factsFailed ? 'fail' : 'inconclusive', detail: factsFailed ? '已提交，但存在可独立确定的事实错误；业务说明仍可供 Judge 分维度评审。' : `已提交且完整性通过；业务要求覆盖、合理取舍、内容真实性及可用性需 Judge 读取原始输入、实际成品和送达正文后判定，未计为任务满分。${delivered.limitations.length ? ` 解析覆盖限制：${delivered.limitations.join('；')}` : ''}`, evidenceRefs: [...refs] });
  }
  return assertions;
}
