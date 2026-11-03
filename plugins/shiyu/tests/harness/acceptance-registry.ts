/**
 * H7-acceptance module registry: the 12 areas and 40 modules from
 * `架构与设计/A方案全景/目录.md`, materialised as machine-readable data.
 *
 * Rules:
 * - every module keeps its 目录.md row and module README path (verified by the
 *   acceptance builder; missing docs are reported, not guessed);
 * - code paths / product test-file IDs are filled only where they actually
 *   exist in the current plugin tree (verified at build time);
 * - evidence links point at committed evidence-source ids from `evidence.ts`;
 *   a module without committed evidence stays `not_covered`/`unknown`, never
 *   `passed`;
 * - resource-blocked modules (real devices, credentials) declare the missing
 *   resource id, and the acceptance report lists those blocked resources.
 *
 * This file does not assert product acceptance; the acceptance report gate is
 * always "incomplete / no complete nine-system claim".
 */
export const MODULE_REGISTRY_VERSION = '1.0.0';

export type SystemId = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

export interface ModuleArea {
  readonly id: string;
  /** Parent area id for nested regions (e.g. `plugin` -> `host`). */
  readonly parentId: string | null;
  readonly title: string;
  /** Original graph id from 目录.md. */
  readonly graphId: string;
  /** Row substring expected in 目录.md (the markdown link). */
  readonly docRow: string;
  /** Workspace-relative README path from 目录.md. */
  readonly docPath: string;
}

export interface ModuleDefinition {
  readonly id: string;
  readonly title: string;
  readonly areaId: string;
  /** Original graph id (`user`, `channels`, ...). */
  readonly graphId: string;
  readonly systems: readonly SystemId[];
  /** Row substring expected in 目录.md (module README link). */
  readonly docRow: string;
  /** Workspace-relative module README path from 目录.md. */
  readonly docPath: string;
  /** Design status column value quoted from the doc (not an acceptance claim). */
  readonly designStatus: string;
  /** Implementation status column value quoted from the doc at snapshot time. */
  readonly implementationStatusAtDoc: string;
  /** Existing plugin-relative code paths (verified at build). */
  readonly codePaths: readonly string[];
  /** Existing plugin-relative product test-file ids (file-level ids only). */
  readonly testIds: readonly string[];
  /** Harness oracle ids that are relevant to this module. */
  readonly oracles: readonly string[];
  /** Committed evidence source ids from evidence.ts. */
  readonly evidenceSourceIds: readonly string[];
  /** Non-empty => module-level acceptance is resource-blocked. */
  readonly blockedResourceIds: readonly string[];
  readonly notes: readonly string[];
}

export interface BlockedResource {
  readonly id: string;
  readonly title: string;
  readonly prerequisite: string;
  readonly blocks: string;
}

export const BLOCKED_RESOURCES: readonly BlockedResource[] = [
  {
    id: 'real-device-authorization',
    title: '真实设备授权与可信停止范围',
    prerequisite: '明确设备ID、允许动作/路径、可信停止与物理保护；替身/软件机器人不能替代',
    blocks: 'V18/V19/V20/V26、device-gateway/desktop-device/other-device/robot 模块',
  },
  {
    id: 'real-channel-account',
    title: '真实渠道账号、受众与外发权限',
    prerequisite: '平台/account/channel 范围、凭据来源、收件方与外发权、删除/送达语义',
    blocks: 'V02/V05 完整门槛、SYS.1/SYS.7 完整验收、S 系列真实渠道业务',
  },
  {
    id: 'real-credential-source',
    title: '真实凭据引用与轮换来源',
    prerequisite: '可解析的凭据引用、轮换/失效流程与 canary 使用范围',
    blocks: 'V17 真实凭据分支、credentials 模块',
  },
  {
    id: 'bounded-real-model-budget',
    title: '有界真实模型验收额度',
    prerequisite: '模型/数据、calls/tokens/时间/重试/并发/费用上限与硬停止条件',
    blocks: 'V25、V13/V23 真实模型分支、S/FL 业务语义评测',
  },
  {
    id: 'lab-business-run',
    title: 'Lab 本体业务运行与独立 Judge',
    prerequisite: '冻结剧本、被测本体版本、Lab 公共协议接入、独立效果/业务 oracle 与评分',
    blocks: 'V23 E1–E3、S01–S08/FL01–FL08 业务验收',
  },
  {
    id: 'real-host-acceptance-window',
    title: '固定宿主长生命周期/压缩/长期运行窗口',
    prerequisite: '冻结宿主版本与实际 profile、长时间窗口、压测资源与停止方案',
    blocks: 'V21/V22/V24 完整生命周期与长期门槛',
  },
  {
    id: 'independent-backup-destination',
    title: '真正独立故障域备份目的地',
    prerequisite: '独立目的地与故障域、加密/密钥恢复、保留策略与实际演练',
    blocks: 'V27、backup-copy 完整门槛',
  },
  {
    id: 'holdout-isolation',
    title: 'HOLDOUT 独立保管与流程隔离',
    prerequisite: '独立作者、答案先冻结、真实权限/流程隔离；同机目录不构成秘密隔离',
    blocks: 'V25/S 系列的盲测与 HOLDOUT 结论',
  },
  {
    id: 'double-annotation',
    title: '相处质量双人独立盲评',
    prerequisite: '两名独立标注者、盲化输出、原始分歧与校准记录',
    blocks: 'V25/S07 相处质量结论',
  },
];

/* ------------------------------------------------------------------ */
/* 12 areas from 目录.md (host/plugin are structural regions).          */
/* ------------------------------------------------------------------ */

export const MODULE_AREAS: readonly ModuleArea[] = [
  { id: 'A.sources', parentId: null, title: '输入与事件', graphId: 'sources', docRow: '(<01-输入与事件/README.md>)', docPath: '架构与设计/A方案全景/01-输入与事件/README.md' },
  { id: 'A.dependencies', parentId: null, title: '外部依赖', graphId: 'dependencies', docRow: '(<02-外部依赖/README.md>)', docPath: '架构与设计/A方案全景/02-外部依赖/README.md' },
  { id: 'A.host', parentId: null, title: 'DSH宿主进程', graphId: 'host', docRow: '(<03-DSH宿主进程/README.md>)', docPath: '架构与设计/A方案全景/03-DSH宿主进程/README.md' },
  { id: 'A.plugin', parentId: 'A.host', title: '识雨插件', graphId: 'plugin', docRow: '(<03-DSH宿主进程/01-识雨插件/README.md>)', docPath: '架构与设计/A方案全景/03-DSH宿主进程/01-识雨插件/README.md' },
  { id: 'A.outer', parentId: 'A.plugin', title: '外层-对话与表达', graphId: 'outer', docRow: '(<03-DSH宿主进程/01-识雨插件/01-外层-对话与表达/README.md>)', docPath: '架构与设计/A方案全景/03-DSH宿主进程/01-识雨插件/01-外层-对话与表达/README.md' },
  { id: 'A.inner', parentId: 'A.plugin', title: '内层-六部分状态', graphId: 'inner', docRow: '(<03-DSH宿主进程/01-识雨插件/02-内层-六部分状态/README.md>)', docPath: '架构与设计/A方案全景/03-DSH宿主进程/01-识雨插件/02-内层-六部分状态/README.md' },
  { id: 'A.execution', parentId: 'A.plugin', title: '任务与执行', graphId: 'execution', docRow: '(<03-DSH宿主进程/01-识雨插件/03-任务与执行/README.md>)', docPath: '架构与设计/A方案全景/03-DSH宿主进程/01-识雨插件/03-任务与执行/README.md' },
  { id: 'A.foundation', parentId: 'A.host', title: 'DSH运行底座', graphId: 'foundation', docRow: '(<03-DSH宿主进程/02-DSH运行底座/README.md>)', docPath: '架构与设计/A方案全景/03-DSH宿主进程/02-DSH运行底座/README.md' },
  { id: 'A.devices', parentId: null, title: '设备执行面', graphId: 'devices', docRow: '(<04-设备执行面/README.md>)', docPath: '架构与设计/A方案全景/04-设备执行面/README.md' },
  { id: 'A.recovery', parentId: null, title: '宿主外恢复', graphId: 'recovery', docRow: '(<05-宿主外恢复/README.md>)', docPath: '架构与设计/A方案全景/05-宿主外恢复/README.md' },
  { id: 'A.data', parentId: null, title: '预留空间', graphId: 'data', docRow: '(<06-预留空间/README.md>)', docPath: '架构与设计/A方案全景/06-预留空间/README.md' },
  { id: 'A.backup', parentId: null, title: '独立备份', graphId: 'backup', docRow: '(<07-独立备份/README.md>)', docPath: '架构与设计/A方案全景/07-独立备份/README.md' },
];

const P = '架构与设计/A方案全景/03-DSH宿主进程/01-识雨插件';

function mod(
  id: string,
  title: string,
  graphId: string,
  areaId: string,
  systems: readonly SystemId[],
  docRowPath: string,
  designStatus: string,
  implementationStatusAtDoc: string,
  extra: Partial<Omit<ModuleDefinition, 'id' | 'title' | 'graphId' | 'areaId' | 'systems' | 'docRow' | 'docPath' | 'designStatus' | 'implementationStatusAtDoc'>> = {},
): ModuleDefinition {
  const rawDocPath = docRowPath.startsWith('架构与设计/')
    ? docRowPath
    : /^0[1-7]-(输入与事件|外部依赖|设备执行面|宿主外恢复|预留空间|独立备份)\//.test(docRowPath)
      ? `架构与设计/A方案全景/${docRowPath}`
      : `${P}/${docRowPath}`;
  const docPath = rawDocPath.endsWith('.md') ? rawDocPath : `${rawDocPath}/README.md`;
  return {
    id,
    title,
    graphId,
    areaId,
    systems,
    docRow: `(<${docPath.replace('架构与设计/A方案全景/', '')}>)`,
    docPath,
    designStatus,
    implementationStatusAtDoc,
    codePaths: extra.codePaths ?? [],
    testIds: extra.testIds ?? [],
    oracles: extra.oracles ?? [],
    evidenceSourceIds: extra.evidenceSourceIds ?? [],
    blockedResourceIds: extra.blockedResourceIds ?? [],
    notes: extra.notes ?? [],
  };
}

export const MODULE_DEFINITIONS: readonly ModuleDefinition[] = [
  mod('MOD.user', '用户与目标', 'user', 'A.sources', ['1', '3'], '01-输入与事件/01-用户与目标', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/dsh/goals.ts'],
    testIds: ['tests/goals.test.ts', 'tests/goal-bindings.test.ts'],
    oracles: ['authority', 'state-machine'],
    evidenceSourceIds: ['historical-task-goal'],
    notes: ['原生 Goal 生命周期仅历史限定证据；用户/目标口径未做完整 V02 矩阵'],
  }),
  mod('MOD.channels', '对话渠道', 'channels', 'A.sources', ['1', '2', '7'], '01-输入与事件/02-对话渠道', '原生 Goal/Session 与业务账本分工已明确；待验证', '仅设计资料', {
    codePaths: ['src/control/channels/index.ts', 'src/control/channels/bridge.ts', 'src/adapters/control-store/ingress-domain.ts'],
    testIds: ['tests/channel-ingress.test.ts', 'tests/channel-identity.test.ts', 'tests/channel-audience.test.ts', 'tests/channel-bridge.test.ts'],
    oracles: ['authority', 'canary', 'causal'],
    evidenceSourceIds: ['h6a-channel-ingress'],
    notes: ['H6a 为离线归一化/去重/受众基础；无真实平台/账号/发送 Effect'],
  }),
  mod('MOD.events', '外部事件', 'events', 'A.sources', ['2'], '01-输入与事件/03-外部事件', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/events/index.ts', 'src/adapters/control-store/protocol.ts'],
    testIds: ['tests/events.test.ts', 'tests/event-tools.test.ts', 'tests/events-paths.test.ts'],
    oracles: ['counts', 'causal', 'state-machine'],
    evidenceSourceIds: ['h2a-events', 'h2a-probe', 'h2b-subscriptions-time', 'h2b-host-time-probe', 'h2b-live-time-trigger', 'h2c-real-model-probe', 'h2c-probe-fix-chain', 'round3-host-zero-model', 'round4-host-zero-model', 'round5-host-real-model'],
    notes: ['H2a 离线+零模型探针；H2b 离线订阅/时间源、宿主零模型时间探针与 live time-trigger（一次不可删 append-only time.occurred）；H2c 修复链为 fake-host 离线，round-5 宿主真实模型诊断 tool round 通过（usage 1469/41/2406；attempt4/5=1 request/0 stream/费用 unknown）但仅 diagnostic，不得记 pass/V25/业务；fan-out/配额未验'],
  }),
  mod('MOD.providers', '模型与服务', 'providers', 'A.dependencies', ['6', '7'], '02-外部依赖/01-模型与服务', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/embedding/index.ts', 'src/adapters/ombre/managed.ts', 'src/adapters/dsh/sessions.ts'],
    testIds: ['tests/embedding.test.ts', 'tests/ombre-managed.test.ts', 'tests/ombre.test.ts'],
    oracles: ['json-text', 'schema', 'counts'],
    evidenceSourceIds: ['historical-model-context'],
    notes: ['历史有界真实模型/embedding 样本；非当前 HEAD 完整 provider 费用/缓存证据'],
  }),
  mod('MOD.links', '渠道链接', 'links', 'A.outer', ['1', '2', '4'], '01-外层-对话与表达/01-渠道链接', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/channels/bridge.ts'],
    testIds: ['tests/channel-conversation-integration.test.ts'],
    oracles: ['authority', 'causal'],
    evidenceSourceIds: ['h6a-channel-ingress'],
    notes: ['运行时 channelRef→Conversation 绑定接线仍待后续切片'],
  }),
  mod('MOD.dialogue-queue', '串行与并行队列', 'dialogue-queue', 'A.outer', ['1', '2'], '01-外层-对话与表达/02-串行与并行队列', '原生 inbox 默认，不叠加待答队列；恢复对账待验证', '仅设计资料', {
    codePaths: ['src/control/background-pump.ts'],
    testIds: ['tests/background-pump.test.ts', 'tests/events-lifecycle.test.ts'],
    oracles: ['counts', 'quiet-window', 'causal'],
    evidenceSourceIds: ['h2a-events', 'h2b-subscriptions-time'],
    notes: ['H2a/H2b 离线事件/订阅基础；无 V05 的 20 会话/1000 消息/20 种子公平与 P95 证据'],
  }),
  mod('MOD.replyer', 'replyer-表现', 'replyer', 'A.outer', ['1', '6'], '01-外层-对话与表达/03-replyer-表现', '受限原生 Session 优先；DS-Bot 旁路为条件备选', '仅设计资料', {
    codePaths: ['src/control/local-reply.ts', 'src/adapters/dsh/sessions.ts'],
    testIds: ['tests/local-reply.test.ts', 'tests/local-reply-memory.test.ts', 'tests/sessions.test.ts'],
    oracles: ['json-text', 'counts', 'canary'],
    evidenceSourceIds: ['h4c-replyer-inner', 'historical-model-context'],
    notes: ['H4c 离线有界内层参考；真实生成/质量/费用未验'],
  }),
  mod('MOD.core', 'core-主动判断', 'core', 'A.inner', ['3'], '02-内层-六部分状态/00-core-主动判断', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/local-core.ts', 'src/control/core-pump.ts', 'src/adapters/dsh/core-decision.ts'],
    testIds: ['tests/local-core.test.ts', 'tests/core-plan.test.ts', 'tests/core-pump.test.ts'],
    oracles: ['schema', 'cas', 'state-machine', 'counts'],
    evidenceSourceIds: ['h3-core-planning', 'h3-bounded-core-validation-runner', 'h4e-lifecycle-recompute', 'h2c-real-model-probe', 'h2c-probe-fix-chain', 'round4-localcore-hotfix', 'round4-host-zero-model', 'round5-host-real-model', 'round6-lead-integration', 'round7-lead-integration', 'round7-host-bounded-core-goal-failure'],
    notes: ['H3 离线受控计划/重规划 + H4e 离线内层派生状态 + LocalCoreService 接线 hotfix + H2c fake-host 修复链；round-5 宿主真实模型诊断 tool round 通过但仅为 diagnostic（非完整 core/Goal/plan、非 V25/业务），不得记 pass；无真实宿主/模型 plan 验收'],
  }),
  mod('MOD.memory', '记忆', 'memory', 'A.inner', ['5'], '02-内层-六部分状态/01-记忆', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/local-memory.ts', 'src/adapters/control-store/memory-domain.ts', 'src/adapters/control-store/memory-index-domain.ts'],
    testIds: ['tests/local-memory.test.ts', 'tests/local-memory-search.test.ts', 'tests/memory-domain.test.ts'],
    oracles: ['causal', 'canary', 'counts'],
    evidenceSourceIds: ['historical-memory', 'h4-inner-offline', 'h4e-lifecycle-recompute', 'h4e-migration-hotfix', 'h4e-isolated-lifecycle-probe', 'round6-host-inner-lifecycle'],
    notes: ['历史限定 save/read/withdraw + H4 离线内层删除屏障 + H4e G1 生命周期/派生失效/加法迁移；无当前 HEAD 真实后端 V07/V16，无物理擦除/备份删除传播'],
  }),
  mod('MOD.relationship', '关系', 'relationship', 'A.inner', ['5'], '02-内层-六部分状态/02-关系', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/control-store/relationship-domain.ts'],
    testIds: ['tests/inner-relationship.test.ts'],
    oracles: ['authority', 'schema'],
    evidenceSourceIds: ['h4-inner-offline', 'h4e-lifecycle-recompute', 'h4e-migration-hotfix', 'h4e-isolated-lifecycle-probe', 'round6-host-inner-lifecycle'],
    notes: ['H4 离线域模块 + H4e G1 跨域派生重算/失效 + isolated lifecycle probe（diagnostic-only, :memory: 跳过 memory backend）；无真实身份/受众矩阵，无跨服务原子快照'],
  }),
  mod('MOD.emotion', '情绪', 'emotion', 'A.inner', ['5'], '02-内层-六部分状态/03-情绪', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/control-store/emotion-domain.ts'],
    testIds: ['tests/inner-emotion.test.ts'],
    oracles: ['schema', 'version'],
    evidenceSourceIds: ['h4-inner-offline', 'h4e-lifecycle-recompute', 'h4e-migration-hotfix', 'h4e-isolated-lifecycle-probe', 'round6-host-inner-lifecycle'],
    notes: ['H4 离线域模块 + H4e 离线派生失效 + isolated lifecycle probe（diagnostic-only）；无真实模型使用/质量证据'],
  }),
  mod('MOD.cognition', '认知', 'cognition', 'A.inner', ['5'], '02-内层-六部分状态/04-认知', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/control-store/cognition-domain.ts'],
    testIds: ['tests/inner-cognition.test.ts'],
    oracles: ['causal', 'version'],
    evidenceSourceIds: ['h4-inner-offline', 'h4e-lifecycle-recompute', 'h4e-migration-hotfix', 'h4e-isolated-lifecycle-probe', 'round6-host-inner-lifecycle'],
    notes: ['H4 离线域模块 + H4e 同库确定性派生重算 + isolated lifecycle probe（diagnostic-only）；无跨域结论撤回/复盘业务证据，无原子跨服务快照'],
  }),
  mod('MOD.personality', '人格', 'personality', 'A.inner', ['5'], '02-内层-六部分状态/05-人格', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/control-store/personality-domain.ts'],
    testIds: ['tests/inner-personality.test.ts'],
    oracles: ['version', 'authority'],
    evidenceSourceIds: ['h4-inner-offline', 'h4e-lifecycle-recompute', 'h4e-migration-hotfix', 'h4e-isolated-lifecycle-probe', 'round6-host-inner-lifecycle'],
    notes: ['H4 离线域模块 + H4e 派生失效/加法迁移 + isolated lifecycle probe（diagnostic-only）；无 100 轮稳定/V08 证据'],
  }),
  mod('MOD.ability', '能力', 'ability', 'A.inner', ['5', '7'], '02-内层-六部分状态/06-能力', '3I固定local-note证据说明策略；动态扩展仍待验', '已接线，1021项模块/204项模拟UI；真实宿主待验', {
    codePaths: ['src/adapters/control-store/capability-domain.ts', 'src/adapters/capability-identity.ts', 'src/contracts/capability.ts'],
    testIds: ['tests/capability-domain.test.ts', 'tests/capability-matrix.test.ts', 'tests/capability-task.test.ts'],
    oracles: ['authority', 'version', 'schema'],
    evidenceSourceIds: ['historical-capability-3i', 'h4-inner-offline'],
    notes: ['历史固定能力启停/零模型重载；新绑定 proof 与动态技能未验'],
  }),
  mod('MOD.views', '只读状态视图', 'views', 'A.inner', ['5', '9'], '02-内层-六部分状态/07-只读状态视图', '补运行仪表盘的受限状态投影；待验证', '仅设计资料', {
    codePaths: ['src/views/index.ts', 'src/views/local.ts', 'src/views/core.ts', 'src/adapters/control-store/view-domain.ts'],
    testIds: ['tests/views.test.ts', 'tests/inner-readview.test.ts', 'tests/local-views.test.ts'],
    oracles: ['schema', 'canary', 'authority'],
    evidenceSourceIds: ['h4b-composition', 'h4-host', 'h6c-channel-projection-ui', 'round3-host-zero-model', 'round4-host-zero-model', 'round5-host-real-model', 'round6-host-inner-lifecycle', 'round7-host-bounded-core-goal-failure', 'h4c-replyer-inner'],
    notes: ['离线 ReadView + H4b/H6c 合成 UI（Chromium/Playwright）+ round-3 零模型宿主投影可见性；真实 DSH DOM/injection、业务数据未验'],
  }),
  mod('MOD.mandate', '任务授权与范围', 'mandate', 'A.execution', ['4', '7'], '03-任务与执行/01-任务授权与范围', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/policy/mandates.ts', 'src/adapters/control-store/authority.ts'],
    testIds: ['tests/mandates.test.ts', 'tests/mandates-catalog.test.ts'],
    oracles: ['authority', 'version', 'counts'],
    evidenceSourceIds: ['historical-task-goal', 'h2a-events', 'h3-bounded-core-validation-runner', 'round7-host-bounded-core-goal-failure'],
    notes: ['历史 Task/Goal 预算/暂停样本；H3 runner 离线 + round-7 失败（未授权/暂停 partial Goal）；无当前 HEAD 32 授权组合矩阵'],
  }),
  mod('MOD.tasks', '任务与执行实例', 'tasks', 'A.execution', ['4'], '03-任务与执行/02-任务与执行实例', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/tasks/index.ts', 'src/adapters/control-store/task-domain.ts', 'src/adapters/control-store/task-repositories.ts'],
    testIds: ['tests/tasks.test.ts', 'tests/task-domain.test.ts', 'tests/task-repositories.test.ts'],
    oracles: ['cas', 'state-machine', 'causal'],
    evidenceSourceIds: ['historical-task-goal', 'h3-core-planning', 'h3-bounded-core-validation-runner', 'round7-host-bounded-core-goal-failure'],
    notes: ['历史单任务 + H3 离线准入/runner；round-7 失败未产生 Task/worker/核验；无 50 worker 竞争/取消/迟到矩阵'],
  }),
  mod('MOD.worker', 'worker-任务执行', 'worker', 'A.execution', ['4'], '03-任务与执行/03-worker-任务执行', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/dsh/workers.ts', 'src/control/task-runner.ts'],
    testIds: ['tests/workers.test.ts', 'tests/task-runner.test.ts'],
    oracles: ['counts', 'causal', 'state-machine'],
    evidenceSourceIds: ['historical-task-goal', 'h3-core-planning'],
    notes: ['worker 真实并行/槽位/旧实例迟到未验'],
  }),
  mod('MOD.verify', '结果核验与回执', 'verify', 'A.execution', ['4'], '03-任务与执行/04-结果核验与回执', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/effects/index.ts', 'src/adapters/artifacts/index.ts'],
    testIds: ['tests/effects.test.ts', 'tests/artifacts.test.ts'],
    oracles: ['causal', 'counts', 'json-text'],
    evidenceSourceIds: ['historical-task-goal', 'h5-g1-module'],
    notes: ['历史独立产物/Effect 核验 + H5 G1；无跨服务 unknown 矩阵'],
  }),
  mod('MOD.model-session', '模型与会话', 'model-session', 'A.foundation', ['6'], '架构与设计/A方案全景/03-DSH宿主进程/02-DSH运行底座/01-模型与会话', '用户确认三角色优先原生 Session、恢复与压缩', '仅设计资料', {
    codePaths: ['src/adapters/dsh/sessions.ts', 'src/adapters/dsh/native-context.ts', 'src/adapters/dsh/native-message.ts', 'src/adapters/dsh/session-title.ts'],
    testIds: ['tests/sessions.test.ts', 'tests/native-history.test.ts', 'tests/native-context.test.ts'],
    oracles: ['json-text', 'counts', 'version'],
    evidenceSourceIds: ['h1-native-history', 'h1-independent-run', 'historical-model-context'],
    notes: ['H1 离线+独立验证；无固定宿主长历史/压缩/完整费用'],
  }),
  mod('MOD.tool-policy', '工具与权限', 'tool-policy', 'A.foundation', ['7'], '架构与设计/A方案全景/03-DSH宿主进程/02-DSH运行底座/02-工具与权限', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/dsh/event-tools.ts'],
    testIds: ['tests/event-tools.test.ts', 'tests/events-worker-mount.test.ts'],
    oracles: ['authority', 'schema', 'canary'],
    evidenceSourceIds: ['h2a-probe', 'h2c-real-model-probe', 'h2c-probe-fix-chain', 'h3-bounded-core-validation-runner', 'round4-host-zero-model', 'round5-host-real-model', 'round7-host-bounded-core-goal-failure', 'historical-capability-3i'],
    notes: ['零模型工具挂载探针 + H2c fake-host 修复链 + round-5 宿主真实模型 diagnostic tool round（usage 1469/41/2406；仅诊断、禁止 pass/V25/业务）；权限矩阵未验'],
  }),
  mod('MOD.event-schedule', '事件与定时', 'event-schedule', 'A.foundation', ['2'], '架构与设计/A方案全景/03-DSH宿主进程/02-DSH运行底座/03-事件与定时', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/events/index.ts'],
    testIds: ['tests/events-lifecycle.test.ts'],
    oracles: ['counts', 'quiet-window', 'business-clock'],
    evidenceSourceIds: ['h2b-subscriptions-time', 'h2b-host-time-probe', 'h2b-live-time-trigger', 'round5-host-real-model'],
    notes: ['H2b 插件自有时间源（注入 zoneOffset）离线 G1；DSH Schedule ingress/IANA DST/真实触发未实现，host 仅零模型 cooperative tick idle'],
  }),
  mod('MOD.persistence', '持久化接口', 'persistence', 'A.foundation', ['8'], '架构与设计/A方案全景/03-DSH宿主进程/02-DSH运行底座/04-持久化接口', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/control-store/transaction.ts', 'src/adapters/control-store/index.ts', 'src/adapters/control-store/worker.ts'],
    testIds: ['tests/transaction.test.ts', 'tests/store.test.ts'],
    oracles: ['cas', 'schema', 'version'],
    evidenceSourceIds: ['h5-g1-module', 'h4e-migration-hotfix', 'h4e-isolated-lifecycle-probe', 'h5b-runtime-integration', 'h5b-checkpoint-probe', 'round7-host-bounded-core-goal-failure', 'h4-inner-offline'],
    notes: ['真实临时 SQLite + H5 G1/G1+ + H4e 加法迁移；H5b 生产 capture blocked，无当前 HEAD 崩溃/满盘/完整迁移矩阵'],
  }),
  mod('MOD.lifecycle', '插件生命周期', 'lifecycle', 'A.foundation', ['8', '6'], '架构与设计/A方案全景/03-DSH宿主进程/02-DSH运行底座/05-插件生命周期', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/runtime.ts', 'src/index.ts'],
    testIds: ['tests/runtime.test.ts', 'tests/runtime-capability.test.ts'],
    oracles: ['state-machine', 'counts'],
    evidenceSourceIds: ['h4b-host', 'round3-lead-integration', 'round4-lead-integration', 'round6-lead-integration', 'round7-lead-integration', 'h2b-live-time-trigger', 'round3-host-zero-model', 'round4-host-zero-model', 'round5-host-real-model', 'round6-host-inner-lifecycle', 'round7-host-bounded-core-goal-failure', 'joint-host-zero-model'],
    notes: ['零模型有序重载/启停 + round-3/4/5 集成与 H4e hotfix 恢复激活；round-5 宿主 6 次有序重载 + live time-trigger + bounded real-model diagnostic round（仅诊断，不得 pass）；checkpoint capture 宿主 unavailable，无 V14 20 次生命周期与 drain 实测'],
  }),
  mod('MOD.device-gateway', '设备能力接口', 'device-gateway', 'A.devices', ['4', '7'], '04-设备执行面/01-设备能力接口', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    blockedResourceIds: ['real-device-authorization'],
    notes: ['无设备能力接口实现与真实设备证据'],
  }),
  mod('MOD.desktop-device', '桌面设备', 'desktop-device', 'A.devices', ['4', '7'], '04-设备执行面/02-桌面设备', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    blockedResourceIds: ['real-device-authorization'],
    notes: ['无真实桌面设备/动作路径/停止证据'],
  }),
  mod('MOD.other-device', '其他终端', 'other-device', 'A.devices', ['4', '7'], '04-设备执行面/03-其他终端', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    blockedResourceIds: ['real-device-authorization'],
    notes: ['无真实其他终端证据'],
  }),
  mod('MOD.robot', '机器人', 'robot', 'A.devices', ['4', '7'], '04-设备执行面/04-机器人', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    blockedResourceIds: ['real-device-authorization'],
    notes: ['软件替身不能替代机器人物理安全/本地停止验收'],
  }),
  mod('MOD.supervisor', '进程监督', 'supervisor', 'A.recovery', ['8'], '05-宿主外恢复/01-进程监督', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    notes: ['外部监督器属宿主外组件，无实现/证据；不得建立第二核心'],
  }),
  mod('MOD.recovery-entry', '恢复入口', 'recovery-entry', 'A.recovery', ['8'], '05-宿主外恢复/02-恢复入口', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/recovery/restore.ts', 'src/recovery/capture.ts'],
    testIds: ['tests/recovery-restore.test.ts', 'tests/recovery-capture.test.ts'],
    oracles: ['state-machine', 'schema', 'version'],
    evidenceSourceIds: ['h5-g1-module', 'h5b-runtime-integration', 'h5b-checkpoint-probe', 'round7-host-bounded-core-goal-failure'],
    notes: ['H5 G1 隔离恢复 + H5b 离线 composition/availability probe（ready:false）；round-7 失败只证明需 reconcile partial Goal/Session，不是恢复演练；未接 supervisor，无真实恢复演练/RPO-RTO'],
  }),
  mod('MOD.state', '内部权威状态', 'state', 'A.data', ['8'], '06-预留空间/01-内部权威状态', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/state/publication.ts', 'src/state/safety.ts'],
    testIds: ['tests/state-publication.test.ts', 'tests/local-state.test.ts'],
    oracles: ['version', 'schema', 'cas'],
    evidenceSourceIds: ['h4-inner-offline', 'h4e-migration-hotfix', 'h4e-isolated-lifecycle-probe', 'h5-g1-module'],
    notes: ['schema4 发布/离线状态 + H4e 加法 derivation_meta 迁移（旧库升级回归）；无完整删除/恢复水位生产证据'],
  }),
  mod('MOD.task-store', '目标与授权及任务', 'task-store', 'A.data', ['4', '8'], '06-预留空间/02-目标与授权及任务', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/control-store/task-domain.ts', 'src/adapters/control-store/task-repositories.ts', 'src/adapters/control-store/goal-bindings.ts'],
    testIds: ['tests/task-domain.test.ts', 'tests/goal-store-integration.test.ts'],
    oracles: ['cas', 'version', 'state-machine'],
    evidenceSourceIds: ['historical-task-goal', 'h4-inner-offline'],
    notes: ['历史单任务与本地绑定；无当前 HEAD 全任务/授权存储矩阵'],
  }),
  mod('MOD.evidence', '经历与证据及回执', 'evidence', 'A.data', ['8'], '06-预留空间/03-经历与证据及回执', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/control/effects/index.ts', 'src/adapters/control-store/commit-watermark.ts'],
    testIds: ['tests/effects.test.ts', 'tests/commit-watermark.test.ts'],
    oracles: ['causal', 'counts', 'schema'],
    evidenceSourceIds: ['historical-task-goal', 'h5-g1-module'],
    notes: ['独立 Effect/回执模块 + H5 G1；无跨服务真实回执矩阵'],
  }),
  mod('MOD.artifacts', '工作文件与产物', 'artifacts', 'A.data', ['4', '8'], '06-预留空间/04-工作文件与产物', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/adapters/artifacts/index.ts'],
    testIds: ['tests/artifacts.test.ts'],
    oracles: ['json-text', 'schema', 'counts'],
    evidenceSourceIds: ['historical-task-goal'],
    notes: ['产物模块有离线测试与历史任务产物核验；无当前 HEAD 真实产物/设备写入'],
  }),
  mod('MOD.cache', '索引与缓存', 'cache', 'A.data', ['6', '8'], '06-预留空间/05-索引与缓存', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    notes: ['无独立缓存模块实现/证据；缓存命中不得由 tokens 推算'],
  }),
  mod('MOD.config', '配置与版本清单', 'config', 'A.data', ['8'], '06-预留空间/06-配置与版本清单', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/state/publication.ts'],
    testIds: ['tests/state-publication.test.ts', 'tests/inner-publication.test.ts'],
    oracles: ['version', 'schema'],
    evidenceSourceIds: ['h4-inner-offline'],
    notes: ['发布清单 schema4 离线证据；无完整组件版本/迁移清单'],
  }),
  mod('MOD.credentials', '凭据引用', 'credentials', 'A.data', ['7', '8'], '06-预留空间/07-凭据引用', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    blockedResourceIds: ['real-credential-source'],
    notes: ['凭据引用仅设计；无真实凭据轮换/脱敏验收'],
  }),
  mod('MOD.checkpoint', '本地检查点', 'checkpoint', 'A.data', ['8'], '06-预留空间/08-本地检查点', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/recovery/capture.ts', 'src/recovery/schema.ts', 'src/recovery/verify.ts'],
    testIds: ['tests/recovery-capture.test.ts', 'tests/recovery-schema.test.ts'],
    oracles: ['schema', 'version', 'counts'],
    evidenceSourceIds: ['h5-g1-module', 'h5b-runtime-integration', 'h5b-checkpoint-probe', 'round4-host-zero-model', 'round7-host-bounded-core-goal-failure'],
    notes: ['H5 G1 + H5b 离线 composition + 只读 checkpoint availability probe（宿主 ready:false，零文件写）；round-7 失败仅记录 partial Goal/Session，不证明 checkpoint；生产 capture 明确 unavailable，未在宿主执行'],
  }),
  mod('MOD.backup-copy', '独立域备份', 'backup-copy', 'A.backup', ['8'], '07-独立备份/01-独立域备份', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/recovery/capture.ts', 'src/recovery/files.ts'],
    testIds: ['tests/recovery-capture.test.ts'],
    oracles: ['schema', 'version', 'causal'],
    evidenceSourceIds: ['h5-g1-module', 'h5b-runtime-integration', 'h5b-checkpoint-probe'],
    notes: ['H5 G1 + H5b 离线 composition/availability probe；同盘副本不构成独立故障域，生产 capture blocked，无 V27'],
  }),
  mod('MOD.restore-test', '恢复演练', 'restore-test', 'A.backup', ['8'], '07-独立备份/02-恢复演练', 'v1.1 复用方案已细化；待验证', '仅设计资料', {
    codePaths: ['src/recovery/restore.ts', 'src/recovery/control-facts.ts'],
    testIds: ['tests/recovery-restore.test.ts', 'tests/recovery-fault-matrix.test.ts'],
    oracles: ['state-machine', 'version', 'counts'],
    evidenceSourceIds: ['h5-g1-module'],
    notes: ['H5 G1 隔离恢复/故障矩阵；无真实 RPO/RTO 恢复演练'],
  }),
];

export const MODULE_BY_ID = new Map(MODULE_DEFINITIONS.map(module => [module.id, module]));
export const BLOCKED_RESOURCE_BY_ID = new Map(BLOCKED_RESOURCES.map(resource => [resource.id, resource]));

/** Extra resource gates for V items that can never be executed in H7-prep. */
export const V_RESOURCE_BLOCKS: Readonly<Record<string, readonly string[]>> = {
  V02: ['real-channel-account'],
  V05: ['real-channel-account', 'bounded-real-model-budget'],
  V13: ['bounded-real-model-budget'],
  V17: ['real-credential-source'],
  V18: ['real-device-authorization'],
  V19: ['real-device-authorization'],
  V20: ['real-device-authorization'],
  V21: ['real-host-acceptance-window'],
  V22: ['real-host-acceptance-window', 'independent-backup-destination'],
  V23: ['lab-business-run', 'bounded-real-model-budget'],
  V24: ['real-host-acceptance-window', 'bounded-real-model-budget'],
  V25: ['bounded-real-model-budget', 'holdout-isolation', 'double-annotation'],
  V26: ['real-device-authorization'],
  V27: ['independent-backup-destination'],
};

/** S/FL business acceptance requires real Lab/model resources; skeleton is not enough. */
export const SCENARIO_RESOURCE_BLOCKS: readonly string[] = ['lab-business-run', 'bounded-real-model-budget', 'holdout-isolation', 'double-annotation'];

export function systemIds(): readonly SystemId[] {
  return ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
}

export function modulesForSystem(system: SystemId): readonly ModuleDefinition[] {
  return MODULE_DEFINITIONS.filter(module => module.systems.includes(system));
}
