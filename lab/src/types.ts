import type { MissedPolicy, TimeConfig, TimelineState } from './time.ts';
export type RunStatus = 'prepared' | 'running' | 'draining' | 'completed' | 'stopped' | 'interrupted' | 'failed';
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type TargetMode = 'reference' | 'external';
export type EvaluationMode = 'protocol' | 'outcome';
export type Role = 'core' | 'worker' | 'replyer' | 'world' | 'lab' | 'memory';
export interface Actor { id: string; name: string; department: string; title: string; color: string; }
export interface Channel { id: string; name: string; kind: 'group' | 'direct' | 'system'; memberIds: string[]; }
export interface Subject { id: string; name: string; description: string; department: string; inputSummary: string; outputSummary: string; }
export interface TaskSpec {
  id: string; subjectId: string; title: string; ownerId: string; channelId: string;
  instructions: string; inputs: string[]; deliverables: string[]; dependencies: string[];
  workMs: number; dueAtMs: number;
  evaluationMode?: EvaluationMode;
  businessRequirements?: string[];
  deliveryPolicy?: { allowText: boolean; minFiles: number };
}
export interface ScheduledInput {
  id: string; atMs: number; actorId: string; channelId: string; text: string;
  kind: 'message' | 'request' | 'query' | 'correction' | 'cancel' | 'memory';
  taskId?: string; data?: Record<string, unknown>;
}
export interface ScenarioAsset { path: string; content: string; encoding?: 'utf8' | 'base64'; }
export interface CompanySnapshot { actors: Actor[]; channels: Channel[]; }
export interface InputAsset { path: string; bytes: number; sha256: string; source?: 'fixture' | 'scenario' | 'user'; }
export interface HumanMessage { channelId: string; text: string; attachments?: string[]; }
export interface HumanTask { title: string; channelId: string; instructions: string; inputs?: string[]; dueAtMs?: number; }
export interface Scenario {
  id: string; name: string; description: string; durationMs: number;
  focus: string[]; tasks: TaskSpec[]; inputs: ScheduledInput[];
  actors?: Actor[]; channels?: Channel[]; assets?: ScenarioAsset[];
}
export interface Catalog { actors: Actor[]; channels: Channel[]; subjects: Subject[]; scenarios: Scenario[]; }
export interface RunConfig {
  scenarioId: string; target: TargetMode; seed: number; noiseCount: number;
  speed: number; workerConcurrency: number; taskDelayMs: number;
  fault: 'none' | 'tool-once' | 'lost-receipt'; maxDurationMs: number;
  /** Omission preserves the original fixed-contract self-test. */
  evaluationMode?: EvaluationMode;
  keepOpen?: boolean;
  /** Opt-in timeline. Omission preserves legacy scaled elapsed-time rooms. */
  time?: TimeConfig;
}
export interface LabEvent {
  id: string; seq: number; runId: string; at: string; elapsedMs: number; businessMs: number;
  type: string; role: Role; actorId?: string; channelId?: string; taskId?: string;
  text: string; data?: Record<string, unknown>; causeId?: string;
  storyAt?: string;
}
export interface TaskRecord extends TaskSpec {
  status: TaskStatus; introduced: boolean; startedAt?: string; finishedAt?: string;
  detail?: string; artifactPaths: string[];
  delivery?: { operationId: string; eventId: string; messageEventId: string; submittedAt: string; paths: string[]; text: string };
}
export interface Artifact {
  path: string; name: string; bytes: number; sha256: string; mime: string; taskId?: string;
}
export interface Assertion {
  id: string; name: string; status: 'pass' | 'fail' | 'inconclusive' | 'not_applicable';
  detail: string; taskId?: string; evidenceRefs: string[];
}
export interface FactReport {
  id: string; at: string; scope: 'lab_self_test' | 'target_evaluation';
  assertions: Assertion[]; tasksPassed: number; tasksTotal: number; completionRate: number;
  summary: string; limitations: string[];
  evaluationMode?: EvaluationMode;
  tasksSubmitted?: number;
  needsJudge?: boolean;
}
export interface JudgeDimension {
  name: string; status: 'scored' | 'not_applicable' | 'insufficient_evidence';
  score?: number; reason: string; evidenceRefs: string[];
}
export interface ReviewResult {
  id: string; at: string; provider: string; status: 'completed' | 'judge_error';
  dimensions: JudgeDimension[]; needsHumanReview: boolean; error?: string;
  usage?: Record<string, unknown>;
}
export interface RunMetrics {
  scheduledInputs: number; injectedInputs: number; replies: number; toolCalls: number;
  completedTasks: number; failedTasks: number; pendingTasks: number;
  maxInjectionLagMs: number; elapsedMs: number;
  storySpanMs?: number;
}
export interface RunSummary {
  id: string; name: string; status: RunStatus; createdAt: string; finishedAt?: string;
  config: RunConfig; metrics: RunMetrics; factReport?: FactReport;
  targetLabel: string; error?: string;
}
export interface ServiceState {
  name: string; config: { maxConnections: number; requiredConnections: number; maintenance: boolean };
  healthy: boolean; revision: number; logs: string[];
}
export interface RunDetail extends RunSummary {
  tasks: TaskRecord[]; events: LabEvent[]; artifacts: Artifact[]; reviews: ReviewResult[];
  service: ServiceState; memory: Record<string, unknown>;
  manifest: Record<string, unknown>;
  company?: CompanySnapshot;
  time?: TimelineState;
}
export interface TargetInput {
  seq: number; event: LabEvent; task?: TaskSpec; evaluationMode?: EvaluationMode;
}
export type TargetAction =
  | { type: 'time.schedule'; scheduleId: string; revision: number; kind: 'reminder' | 'check'; dueAt: string; text: string; everyMs?: number; until?: string; missed?: MissedPolicy }
  | { type: 'time.cancel'; scheduleId: string; revision: number }
  | { type: 'task.deliver'; taskId: string; paths: string[]; text: string }
  | { type: 'task.update'; taskId: string; status: TaskStatus; detail?: string }
  | { type: 'file.read'; path: string }
  | { type: 'file.write'; taskId: string; path: string; content: string; encoding?: 'utf8' | 'base64' }
  | { type: 'message.send'; channelId: string; text: string; taskId?: string; toActorId?: string; attachments?: string[] }
  | { type: 'service.inspect'; taskId?: string }
  | { type: 'service.configure'; taskId: string; maxConnections: number; maintenance: boolean }
  | { type: 'state.record'; domain: 'memory' | 'relationship' | 'cognition' | 'emotion' | 'personality' | 'capability'; key: string; value: unknown; sourceRefs: string[] }
  | { type: 'observe'; role: Role; text: string; taskId?: string; data?: Record<string, unknown> };
export interface ActionResult { ok: boolean; data?: unknown; error?: string; retryable?: boolean; unknown?: boolean; }
export interface EvidencePacket {
  schemaVersion: 1; runId: string; scope: FactReport['scope']; rubricVersion: string;
  instructions: string; events: LabEvent[]; tasks: TaskRecord[]; artifacts: Artifact[];
  facts: FactReport; evidence: Array<{ ref: string; text: string }>;
  company?: CompanySnapshot;
  evaluationMode?: EvaluationMode;
  time?: { mode: TimeConfig['mode']; startAt: string; timeZone: string; storySpanMs: number; realElapsedMs: number;
    occurrenceCount: number; individualDeliveryCount: number; pendingUnknown: boolean; realElapsedStatus: 'measured' | 'lower_bound' };
  fileIndex?: Array<{ ref: string; path: string; kind: 'input' | 'artifact' | 'service'; bytes: number; sha256: string; taskId?: string }>;
}
export interface WorkContext {
  runDir: string; task: TaskSpec; signal: AbortSignal;
  action: (action: TargetAction, operationId?: string) => Promise<ActionResult>;
}
