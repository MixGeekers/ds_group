import { mkdir, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeInputContent, validateInputPath } from './scenarios.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { ActionResult, InputAsset, Scenario, ServiceState, TargetAction, WorkContext } from './types.js';

const fixtureDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const initialServiceState: ServiceState = {
  name: '蓝桥订单服务',
  config: { maxConnections: 8, requiredConnections: 32, maintenance: false },
  healthy: false,
  revision: 1,
  logs: ['connection pool exhausted: required=32 configured=8'],
};

/** A fresh run receives independent copies; no mutable source fixture is shared. */
export async function seedWorkspace(runDir: string, scenario: Scenario): Promise<InputAsset[]> {
  const supplied = (scenario.assets ?? []).map(asset => ({ path: validateInputPath(asset.path), bytes: decodeInputContent(asset) }));
  const workspace = path.join(runDir, 'workspace');
  await mkdir(path.join(workspace, 'inputs'), { recursive: true });
  await mkdir(path.join(workspace, 'outputs'), { recursive: true });
  if ((await lstat(workspace)).isSymbolicLink() || (await lstat(path.join(workspace, 'inputs'))).isSymbolicLink()) throw new Error('运行工作区不能是符号链接');
  const result: InputAsset[] = [];
  const put = async (relative: string, bytes: Buffer, source: InputAsset['source']) => {
    const parts = validateInputPath(relative).split('/');
    let directory = workspace;
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('输入目录不是普通目录'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(directory); }
    }
    await writeFile(path.join(workspace, relative), bytes, { flag: 'wx', mode: 0o600 });
    result.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source });
  };
  for (const name of await readdir(fixtureDir)) {
    if (name.endsWith('.json')) await put(`inputs/${name}`, await readFile(path.join(fixtureDir, name)), 'fixture');
  }
  for (const asset of supplied) await put(asset.path, asset.bytes, 'scenario');
  await writeFile(path.join(workspace, 'service.json'), JSON.stringify(initialServiceState, null, 2), { flag: 'wx', mode: 0o600 });
  return result;
}

function ensureActive(ctx: WorkContext): void {
  ctx.signal.throwIfAborted();
}

/** Retry uses the original operation identity, including after a lost receipt. */
async function perform(ctx: WorkContext, action: TargetAction, suffix: string): Promise<unknown> {
  const operationId = `${ctx.task.id}:${suffix}`;
  let last: ActionResult | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    ensureActive(ctx);
    last = await ctx.action(action, operationId);
    if (last.ok) return last.data;
    if (!last.retryable && !last.unknown) break;
  }
  throw new Error(last?.error ?? `工具操作未确认：${operationId}`);
}

async function input<T>(ctx: WorkContext, file: string): Promise<T> {
  const result = await perform(ctx, { type: 'file.read', path: `inputs/${file}` }, `read:${file}`) as { content?: string; encoding?: string };
  if (typeof result?.content !== 'string' || (result.encoding && result.encoding !== 'utf8')) throw new Error(`输入文件无法读取：${file}`);
  return JSON.parse(result.content) as T;
}

async function output(ctx: WorkContext, name: string, content: string | Buffer): Promise<void> {
  const relativePath = `outputs/${ctx.task.id}/${name}`;
  await perform(ctx, {
    type: 'file.write', taskId: ctx.task.id, path: relativePath,
    content: typeof content === 'string' ? content : content.toString('base64'),
    encoding: typeof content === 'string' ? 'utf8' : 'base64',
  }, `write:${name}`);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function csv(rows: unknown[][]): string {
  return rows.map(row => row.map(value => {
    const string = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  }).join(',')).join('\n') + '\n';
}

interface Order { id: string; productId: string; date: string; quantity: number; unitPrice: number; status: string; }
interface OrdersInput { period: { start: string; end: string }; currency: string; orders: Order[]; returns: Array<{ id: string; orderId: string; quantity: number }>; }
async function report(ctx: WorkContext): Promise<void> {
  const source = await input<OrdersInput>(ctx, 'orders.json');
  const unique = [...new Map(source.orders.map(order => [order.id, order])).values()];
  const orders = unique.filter(order => order.status !== 'cancelled' && order.date >= source.period.start && order.date <= source.period.end);
  const byId = new Map(orders.map(order => [order.id, order]));
  const products = new Map<string, { productId: string; grossRevenue: number; refundAmount: number; netRevenue: number; netUnits: number }>();
  for (const order of orders) {
    const row = products.get(order.productId) ?? { productId: order.productId, grossRevenue: 0, refundAmount: 0, netRevenue: 0, netUnits: 0 };
    row.grossRevenue += order.quantity * order.unitPrice;
    row.netUnits += order.quantity;
    products.set(order.productId, row);
  }
  for (const returned of [...new Map(source.returns.map(item => [item.id, item])).values()]) {
    const order = byId.get(returned.orderId);
    if (!order) continue;
    const row = products.get(order.productId)!;
    row.refundAmount += returned.quantity * order.unitPrice;
    row.netUnits -= returned.quantity;
  }
  const byProduct = [...products.values()].sort((a, b) => a.productId.localeCompare(b.productId));
  for (const product of byProduct) product.netRevenue = product.grossRevenue - product.refundAmount;
  const result = {
    period: source.period,
    grossRevenue: byProduct.reduce((sum, row) => sum + row.grossRevenue, 0),
    refundAmount: byProduct.reduce((sum, row) => sum + row.refundAmount, 0),
    netRevenue: byProduct.reduce((sum, row) => sum + row.netRevenue, 0),
    orderCount: orders.length,
    netUnits: byProduct.reduce((sum, row) => sum + row.netUnits, 0),
    byProduct,
  };
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shiyu Lab reference executor';
  const summary = workbook.addWorksheet('经营汇总');
  summary.columns = [
    { header: '产品', key: 'productId', width: 20 },
    { header: '订单金额', key: 'grossRevenue', width: 18 },
    { header: '退款金额', key: 'refundAmount', width: 18 },
    { header: '净收入', key: 'netRevenue', width: 18 },
    { header: '净销售数量', key: 'netUnits', width: 18 },
  ];
  byProduct.forEach((item, index) => {
    const row = summary.addRow(item);
    row.getCell(4).value = { formula: `B${index + 2}-C${index + 2}`, result: item.netRevenue };
  });
  const totalRow = byProduct.length + 2;
  summary.addRow(['合计', { formula: `SUM(B2:B${totalRow - 1})`, result: result.grossRevenue }, { formula: `SUM(C2:C${totalRow - 1})`, result: result.refundAmount }, { formula: `SUM(D2:D${totalRow - 1})`, result: result.netRevenue }, { formula: `SUM(E2:E${totalRow - 1})`, result: result.netUnits }]);
  summary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183B46' } };
  summary.getRow(totalRow).font = { bold: true };
  const detail = workbook.addWorksheet('有效订单');
  detail.addRow(['订单 ID', '产品', '日期', '数量', '单价', '金额']);
  orders.forEach(order => detail.addRow([order.id, order.productId, order.date, order.quantity, order.unitPrice, order.quantity * order.unitPrice]));
  detail.columns.forEach(column => { column.width = 18; });
  const notes = workbook.addWorksheet('统计口径');
  notes.addRow(['统计开始', source.period.start]); notes.addRow(['统计结束', source.period.end]);
  notes.addRow(['货币', source.currency]); notes.addRow(['规则', '按订单 ID 去重，排除取消与期间外订单；退款抵减原产品。']);
  notes.getColumn(1).width = 18; notes.getColumn(2).width = 78;
  await output(ctx, 'report.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  await output(ctx, 'report.csv', csv([['productId', 'grossRevenue', 'refundAmount', 'netRevenue', 'netUnits'], ...byProduct.map(row => [row.productId, row.grossRevenue, row.refundAmount, row.netRevenue, row.netUnits])]));
  await output(ctx, 'result.json', json(result));
}

interface ReconciliationInput {
  purchaseOrders: Array<{ id: string; quantity: number; unitPrice: number }>;
  receipts: Array<{ purchaseOrderId: string; quantity: number }>;
  invoices: Array<{ id: string; purchaseOrderId: string; quantity: number; amount: number }>;
}
async function reconciliation(ctx: WorkContext): Promise<void> {
  const source = await input<ReconciliationInput>(ctx, 'reconciliation.json');
  const differences: Array<{ kind: string; purchaseOrderId: string; invoiceId?: string; expected?: number; actual?: number }> = [];
  const invoices = [...new Map(source.invoices.map(invoice => [invoice.id, invoice])).values()];
  for (const invoice of invoices) {
    const repeats = source.invoices.filter(item => item.id === invoice.id).length;
    if (repeats > 1) differences.push({ kind: 'duplicate_invoice', purchaseOrderId: invoice.purchaseOrderId, invoiceId: invoice.id, expected: 1, actual: repeats });
    const po = source.purchaseOrders.find(item => item.id === invoice.purchaseOrderId);
    if (po && invoice.amount !== invoice.quantity * po.unitPrice) differences.push({ kind: 'amount_mismatch', purchaseOrderId: po.id, invoiceId: invoice.id, expected: invoice.quantity * po.unitPrice, actual: invoice.amount });
  }
  for (const po of source.purchaseOrders) {
    const received = source.receipts.filter(receipt => receipt.purchaseOrderId === po.id).reduce((sum, row) => sum + row.quantity, 0);
    if (received < po.quantity) differences.push({ kind: 'receipt_shortage', purchaseOrderId: po.id, expected: po.quantity, actual: received });
    if (!invoices.some(invoice => invoice.purchaseOrderId === po.id)) differences.push({ kind: 'missing_invoice', purchaseOrderId: po.id, expected: po.quantity, actual: 0 });
  }
  const result = { differences, matchedPurchaseOrderIds: source.purchaseOrders.filter(po => !differences.some(diff => diff.purchaseOrderId === po.id)).map(po => po.id) };
  await output(ctx, 'reconciliation.csv', csv([['kind', 'purchaseOrderId', 'invoiceId', 'expected', 'actual'], ...differences.map(row => [row.kind, row.purchaseOrderId, row.invoiceId, row.expected, row.actual])]));
  await output(ctx, 'result.json', json(result));
}

interface MeetingInput {
  title: string; date: string; decisions: Array<{ id: string; text: string }>;
  actions: Array<{ id: string; ownerId: string; dueDate: string; description: string }>;
  openQuestions: string[]; suggestions: string[];
}
async function document(ctx: WorkContext): Promise<void> {
  const source = await input<MeetingInput>(ctx, 'meeting.json');
  const result = { title: source.title, decisions: source.decisions, actions: source.actions, openQuestions: source.openQuestions };
  const md = `# ${source.title}\n\n日期：${source.date}\n\n## 已确认决定\n\n${source.decisions.map(row => `- ${row.id}：${row.text}`).join('\n')}\n\n## 行动项\n\n${source.actions.map(row => `- ${row.id} · ${row.ownerId} · ${row.dueDate}：${row.description}`).join('\n')}\n\n## 待确认\n\n${source.openQuestions.map(row => `- ${row}`).join('\n')}\n\n## 尚未采纳的建议\n\n${source.suggestions.map(row => `- ${row}`).join('\n')}\n`;
  const heading = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
  const children = [new Paragraph({ text: source.title, heading: HeadingLevel.TITLE }), new Paragraph(`日期：${source.date}`), heading('已确认决定'), ...source.decisions.map(row => new Paragraph(`${row.id}：${row.text}`)), heading('行动项'), ...source.actions.map(row => new Paragraph({ children: [new TextRun({ text: `${row.id} · ${row.ownerId} · ${row.dueDate}：`, bold: true }), new TextRun(row.description)] })), heading('待确认'), ...source.openQuestions.map(row => new Paragraph(row)), heading('尚未采纳的建议'), ...source.suggestions.map(row => new Paragraph(row))];
  const doc = new Document({ sections: [{ children }], creator: 'Shiyu Lab reference executor', title: source.title, styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 }, paragraph: { spacing: { after: 160 } } } } } });
  await output(ctx, 'minutes.docx', await Packer.toBuffer(doc));
  await output(ctx, 'minutes.md', md);
  await output(ctx, 'result.json', json(result));
}

interface ProductInput { id: string; version: string; name: string; batteryHours: number; protection: string; price: number; targetAudience: string; requiredTerms: string[]; forbiddenTerms: string[]; limits: { email: number; description: number; short: number }; notes: string; }
async function copy(ctx: WorkContext): Promise<void> {
  const product = await input<ProductInput>(ctx, 'product.json');
  const result = {
    productId: product.id, sourceVersion: product.version,
    email: { subject: `${product.name}：为外出工作准备`, body: `您好，向您介绍 ${product.name}，面向${product.targetAudience}。标准测试条件下最长续航 ${product.batteryHours} 小时，防护等级 ${product.protection}，参考价格 ${product.price} 元。实际续航因使用方式而异，不支持浸泡使用。如果与团队需求相符，欢迎进一步了解产品资料。` },
    productDescription: `${product.name} 为${product.targetAudience}提供便携选择。标准测试条件下最长续航 ${product.batteryHours} 小时，${product.protection} 防护，参考价格 ${product.price} 元。实际使用续航存在差异，不支持浸泡使用。`,
    shortCopy: `${product.name}，标准条件下最长续航 ${product.batteryHours} 小时，${product.protection} 防护。为外出工作准备。`,
  };
  const sections = [result.email.body, result.productDescription, result.shortCopy];
  const limits = [product.limits.email, product.limits.description, product.limits.short];
  sections.forEach((text, index) => { if (text.length > limits[index]) throw new Error(`文案超过渠道限制：${text.length}/${limits[index]}`); });
  await output(ctx, 'copy.md', `# ${product.name} 文案包\n\n事实来源：产品卡 ${product.version}\n\n## 销售邮件\n\n主题：${result.email.subject}\n\n${result.email.body}\n\n## 产品介绍\n\n${result.productDescription}\n\n## 短文案\n\n${result.shortCopy}\n`);
  await output(ctx, 'result.json', json(result));
}

interface SupplierInput { currency: string; quantity: number; deadline: string; minQuality: number; quotes: Array<{ supplierId: string; unitPrice: number; shipping: number; quality: number; deliveryDate: string }>; }
async function comparison(ctx: WorkContext): Promise<void> {
  const source = await input<SupplierInput>(ctx, 'suppliers.json');
  const ranking = source.quotes.map(quote => {
    const reasons: string[] = [];
    if (quote.quality < source.minQuality) reasons.push(`质量评分 ${quote.quality} 低于门槛 ${source.minQuality}`);
    if (quote.deliveryDate > source.deadline) reasons.push(`交期 ${quote.deliveryDate} 超过截止 ${source.deadline}`);
    return { supplierId: quote.supplierId, totalCost: quote.unitPrice * source.quantity + quote.shipping, deliveryDate: quote.deliveryDate, eligible: reasons.length === 0, reasons };
  }).sort((a, b) => a.totalCost - b.totalCost || a.supplierId.localeCompare(b.supplierId));
  const recommendedSupplierId = ranking.find(row => row.eligible)?.supplierId ?? null;
  const result = { currency: source.currency, ranking, recommendedSupplierId };
  await output(ctx, 'comparison.md', `# 供应商方案比较\n\n采购数量：${source.quantity}；最晚交期：${source.deadline}；质量门槛：${source.minQuality}。\n\n|供应商|含运费总价（${source.currency}）|交期|符合条件|依据|\n|---|---:|---|---|---|\n${ranking.map(row => `|${row.supplierId}|${row.totalCost}|${row.deliveryDate}|${row.eligible ? '是' : '否'}|${row.reasons.join('；') || '质量与交期满足条件'}|`).join('\n')}\n\n推荐：${recommendedSupplierId ?? '暂无符合条件的方案'}。采用符合质量与交期条件的最低总价；运费只计一次。\n`);
  await output(ctx, 'result.json', json(result));
}

interface DeliveryInput { stock: number; inbound: Array<{ id: string; quantity: number; date: string }>; orders: Array<{ id: string; quantity: number; dueDate: string; priority: number }>; }
async function planning(ctx: WorkContext): Promise<void> {
  const source = await input<DeliveryInput>(ctx, 'delivery.json');
  let stock = source.stock;
  const inbound = source.inbound.map(row => ({ ...row })).sort((a, b) => a.date.localeCompare(b.date));
  const allocations = [...source.orders].sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate)).map(order => {
    const fromStock = Math.min(stock, order.quantity);
    stock -= fromStock;
    let remaining = order.quantity - fromStock;
    let fromInbound = 0;
    for (const batch of inbound.filter(row => row.date <= order.dueDate)) {
      const quantity = Math.min(remaining, batch.quantity);
      batch.quantity -= quantity; remaining -= quantity; fromInbound += quantity;
    }
    return { orderId: order.id, fromStock, fromInbound, shortage: remaining, promisedDate: remaining === 0 ? order.dueDate : null };
  });
  const result = { allocations, totalAllocated: allocations.reduce((sum, row) => sum + row.fromStock + row.fromInbound, 0), remainingStock: stock, risks: allocations.filter(row => row.shortage > 0).map(row => `${row.orderId} 缺口 ${row.shortage}，需要补货或重新协调交期。`) };
  await output(ctx, 'plan.csv', csv([['orderId', 'fromStock', 'fromInbound', 'shortage', 'promisedDate'], ...allocations.map(row => [row.orderId, row.fromStock, row.fromInbound, row.shortage, row.promisedDate])]));
  await output(ctx, 'result.json', json(result));
}

async function inspect(ctx: WorkContext, suffix: string): Promise<ServiceState> {
  const service = await perform(ctx, { type: 'service.inspect', taskId: ctx.task.id }, suffix) as ServiceState;
  if (!service?.config || typeof service.revision !== 'number' || typeof service.healthy !== 'boolean') throw new Error('服务探测未返回有效观测');
  return service;
}
async function inspection(ctx: WorkContext): Promise<void> {
  await input(ctx, 'service-guide.json');
  const service = await inspect(ctx, 'inspect');
  const checks = [
    { name: 'capacity', passed: service.config.maxConnections >= service.config.requiredConnections, observed: service.config.maxConnections, expected: service.config.requiredConnections },
    { name: 'maintenance', passed: !service.config.maintenance, observed: service.config.maintenance, expected: false },
  ];
  const diagnosis = checks.every(check => check.passed) ? '当前检查通过。' : checks.filter(check => !check.passed).map(check => check.name === 'capacity' ? '连接池容量不足，需要调整配置后复查。' : '服务处于维护模式，需要核实并恢复服务。').join('');
  const result = { serviceName: service.name, revision: service.revision, healthy: service.healthy, checks, diagnosis };
  await output(ctx, 'inspection.md', `# 订单服务巡检\n\n服务：${service.name}；配置版本：${service.revision}；健康：${service.healthy ? '正常' : '异常'}。\n\n${checks.map(check => `- ${check.name}：观测 ${String(check.observed)}，要求 ${String(check.expected)}，${check.passed ? '通过' : '未通过'}。`).join('\n')}\n\n定位：${diagnosis}\n\n来源：本次运行的 service.inspect 工具回执。\n`);
  await output(ctx, 'result.json', json(result));
}
async function maintenance(ctx: WorkContext): Promise<void> {
  const guide = await input<{ maxAllowedConnections: number }>(ctx, 'service-guide.json');
  const before = await inspect(ctx, 'inspect-before');
  if (before.config.requiredConnections > guide.maxAllowedConnections) throw new Error('所需容量超过本次维护范围，需要人工处理');
  await perform(ctx, { type: 'service.configure', taskId: ctx.task.id, maxConnections: before.config.requiredConnections, maintenance: false }, 'configure');
  const after = await inspect(ctx, 'inspect-after');
  if (!after.healthy || after.config.maxConnections < after.config.requiredConnections || after.config.maintenance) throw new Error('配置变更后复查未通过');
  const result = { serviceName: after.name, beforeRevision: before.revision, afterRevision: after.revision, before: before.config, after: after.config, healthy: after.healthy, verified: true };
  await output(ctx, 'maintenance.md', `# 订单服务维护记录\n\n服务：${after.name}。\n\n- 连接池上限：${before.config.maxConnections} → ${after.config.maxConnections}。\n- 维护模式：${before.config.maintenance} → ${after.config.maintenance}。\n- 配置版本：${before.revision} → ${after.revision}。\n- 变更后再次执行 service.inspect，实际健康状态为 ${after.healthy}。\n\n操作范围仅为本次 Lab 运行的测试服务替身。\n`);
  await output(ctx, 'result.json', json(result));
}

/** Deterministic fixture worker: exercises the Lab; it is not the Shiyu implementation. */
export async function executeWork(ctx: WorkContext): Promise<void> {
  ensureActive(ctx);
  const handlers: Record<string, (context: WorkContext) => Promise<void>> = { report, reconciliation, document, copy, comparison, planning, inspection, maintenance };
  const handler = handlers[ctx.task.subjectId];
  if (!handler) throw new Error(`参考执行器尚不支持科目：${ctx.task.subjectId}`);
  await handler(ctx);
}
