/**
 * H7-prep evidence-layer mapping for product traceability rows.
 *
 * The traceability product rows (nine systems, 02 matrix, V01–V27, S/FL,
 * scoring dimensions, 02 §6 scenarios) stay `not_covered`: no committed slice
 * proves a complete V/system/business acceptance. What this module adds is a
 * *derived evidence layer*: for each row, which committed slice artifacts
 * exist (path + blob SHA256 in a frozen HEAD), what they can prove, and what
 * they explicitly cannot prove.
 *
 * Rules encoded here:
 * - only committed file content in the frozen HEAD is accepted; a missing or
 *   mismatched file makes the source `unknown` and the row may not claim that
 *   evidence level;
 * - expected slice commits must exist and be ancestors of the frozen HEAD;
 * - a mapping entry must declare scope + limitations and a limited evidence
 *   level; `complete`/`verified`/`passed` style claims are rejected;
 * - product row status is never upgraded (checked by traceability honesty);
 * - mappings are authored from the slice evidence records; the tool does not
 *   infer success from filenames or prose.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256Hex, type CheckResult, type JsonValue, type Violation } from './invariant.js';
import { finish, violation } from './invariant.js';
import { ALL_REQUIREMENT_ROWS, PRODUCT_KINDS } from './traceability-registry.js';

export const H7_EVIDENCE_VERSION = '1.0.0';

export type EvidenceLevel =
  | 'offline-module'
  | 'slice-verification'
  | 'independent-verification'
  | 'fixed-host-zero-model'
  | 'fixed-host-zero-model-reconcile'
  | 'fixed-host-failure-diagnostic'
  | 'fixed-host-create-succeeded-evaluation-failure'
  | 'fixed-host-p0-chat-memory-failed'
  | 'synthetic-ui'
  | 'bounded-real-model'
  | 'bounded-real-model-diagnostic-only'
  | 'independent-review-info'
  | 'historical-limited'
  | 'environment-baseline'
  | 'unknown';

export const ALLOWED_EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'offline-module',
  'slice-verification',
  'independent-verification',
  'fixed-host-zero-model',
  'fixed-host-zero-model-reconcile',
  'fixed-host-failure-diagnostic',
  'fixed-host-create-succeeded-evaluation-failure',
  'fixed-host-p0-chat-memory-failed',
  'synthetic-ui',
  'bounded-real-model',
  'bounded-real-model-diagnostic-only',
  'independent-review-info',
  'historical-limited',
  'environment-baseline',
  'unknown',
];

/** Levels that are structurally "limited"; a row with only these may never pass. */
export const LIMITED_EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'offline-module',
  'slice-verification',
  'independent-verification',
  'fixed-host-zero-model',
  'fixed-host-zero-model-reconcile',
  'fixed-host-failure-diagnostic',
  'fixed-host-create-succeeded-evaluation-failure',
  'fixed-host-p0-chat-memory-failed',
  'synthetic-ui',
  'bounded-real-model',
  'bounded-real-model-diagnostic-only',
  'independent-review-info',
  'historical-limited',
  'environment-baseline',
];

/** A mapping must not use these as an evidence level (they are conclusions). */
export const FORBIDDEN_CLAIM_LEVELS: readonly string[] = ['complete', 'completed', 'verified', 'passed', 'pass', 'full', 'accepted'];

export interface EvidenceFileRef {
  /** Workspace-relative path (includes the `plugins/shiyu/` prefix). */
  readonly path: string;
  /** The slice commit expected to have introduced/last-touched this evidence file. */
  readonly sliceCommit: string;
  /**
   * Optional committed snapshot commit. When set, the verifier reads the blob
   * with `git show <blobCommit>:<path>` and hashes that committed content
   * instead of comparing the mutable worktree file to the frozen HEAD blob.
   * This keeps evidence stable for pipeline outputs that are legitimately
   * rewritten after the evidence commit (manifest/traceability/acceptance).
   * The commit must exist and be an ancestor of the frozen HEAD.
   */
  readonly blobCommit?: string;
  /** Optional pinned SHA256 of the committed blob (fails closed on mismatch). */
  readonly expectedSha256?: string;
}

export interface EvidenceSource {
  readonly id: string;
  /** Commits whose evidence this source represents (short or long SHA). */
  readonly commits: readonly string[];
  readonly files: readonly EvidenceFileRef[];
  readonly levels: readonly EvidenceLevel[];
  /** What this evidence can prove. */
  readonly scope: string;
  /** What it explicitly cannot prove; must be non-empty. */
  readonly limitations: readonly string[];
  /** Optional machine-readable observations extracted from a committed JSON file. */
  readonly derive?: readonly { readonly label: string; readonly path: string; readonly jsonPath: string }[];
}

const REF = (path: string, sliceCommit: string): EvidenceFileRef => ({ path: `plugins/shiyu/${path}`, sliceCommit });

export const EVIDENCE_SOURCES: readonly EvidenceSource[] = [
  {
    id: 'h0-baseline',
    commits: ['08995d1'],
    files: [REF('artifacts/dsh/h0/baseline-offline.json', '08995d1'), REF('artifacts/dsh/h0/host-status-zero-model.json', '08995d1')],
    levels: ['environment-baseline', 'fixed-host-zero-model'],
    scope: 'H0 environment/SDK identity, offline baseline counts, and the fixed-host lossless shiyu_status tool check.',
    limitations: [
      'Not V01 40/40 contract acceptance, not a full host lifecycle matrix; one zero-model reload/tool call only.',
      'The H0 host check installed an isolated build; it does not prove current-source generation, compression or business behaviour.',
    ],
    derive: [
      { label: 'h0Status', path: 'artifacts/dsh/h0/host-status-zero-model.json', jsonPath: 'status' },
      { label: 'h0BaselineHead', path: 'artifacts/dsh/h0/baseline-offline.json', jsonPath: 'repository.head' },
    ],
  },
  {
    id: 'h0b-harness',
    commits: ['eef00d3', '7bd962c'],
    files: [REF('artifacts/dsh/h0/h0b-test-harness.json', 'eef00d3')],
    levels: ['offline-module'],
    scope: 'H0b test-tooling self-proof, oracle known-verdict suite, manifest and traceability honesty.',
    limitations: ['Tooling only: proves the test infrastructure rejects known errors, not any product requirement.', 'Product rows remain not_covered by design.'],
    derive: [{ label: 'selfProofTests', path: 'artifacts/dsh/h0/h0b-test-harness.json', jsonPath: 'verification.selfProofSuite.tests' }],
  },
  {
    id: 'h0c-business',
    commits: ['7bd962c'],
    files: [REF('artifacts/dsh/h0/h0c-business-scenarios.json', '7bd962c')],
    levels: ['offline-module'],
    scope: 'H0c S/FL synthetic fixture/answer skeleton, four-class answers, split policy, aggregation and coverage index.',
    limitations: [
      'Synthetic fixtures only: no product/model/host/Lab/channel run; every scenario is synthetic-fixture-only-not-run.',
      'Not business acceptance, not HOLDOUT, no double annotation; 27 design steps and all variants remain unmaterialised.',
    ],
    derive: [{ label: 'h0cStatus', path: 'artifacts/dsh/h0/h0c-business-scenarios.json', jsonPath: 'status' }],
  },
  {
    id: 'h1-native-history',
    commits: ['92c857f', '3b3b69f', '31af227'],
    files: [
      REF('artifacts/dsh/h1/h1-verification.json', '31af227'),
      REF('artifacts/dsh/slices/h1-verify.json', 'c6a3f05'),
    ],
    levels: ['offline-module', 'slice-verification', 'independent-verification'],
    scope: 'H1 long native Session history paging/recovery/projection with module + combination tests and an independent verifier suite bound to 92c857f.',
    limitations: [
      'No fixed-host long-history cold recovery, live native Session operations, generation, compression or cache/cost measurement.',
      'Two matching read passes are stable append-only observation, not an atomic snapshot under arbitrary external writers.',
      'Independent suite is an offline oracle bound to 92c857f; it is not host/business acceptance.',
    ],
    derive: [
      { label: 'h1Status', path: 'artifacts/dsh/h1/h1-verification.json', jsonPath: 'status' },
      { label: 'h1Tests', path: 'artifacts/dsh/h1/h1-verification.json', jsonPath: 'verification.implementerIsolatedCheck.tests' },
    ],
  },
  {
    id: 'h1-independent-run',
    commits: ['3b3b69f'],
    files: [
      REF('artifacts/dsh/verify/runs/2026-11-02T18-57-25-813Z-final/manifest.json', '3b3b69f'),
      REF('artifacts/dsh/verify/runs/2026-11-02T18-57-25-813Z-final/results.json', '3b3b69f'),
    ],
    levels: ['independent-verification'],
    scope: 'Independent H1 verifier run (own oracle/Judge, raw TAP, categories/results) bound to commit 92c857f.',
    limitations: ['Offline independent verification only; no host/model/business execution and no product status upgrade.'],
    derive: [
      { label: 'independentRunExit', path: 'artifacts/dsh/verify/runs/2026-11-02T18-57-25-813Z-final/manifest.json', jsonPath: 'exitStatus' },
      { label: 'independentRunId', path: 'artifacts/dsh/verify/runs/2026-11-02T18-57-25-813Z-final/manifest.json', jsonPath: 'runId' },
    ],
  },
  {
    id: 'h2a-events',
    commits: ['a80c33d', '086e43a'],
    files: [
      REF('artifacts/dsh/h2/h2a-events-offline.json', '6f600f4'),
      REF('artifacts/dsh/h2/h2a-slice-summary.json', '6f600f4'),
      REF('artifacts/dsh/slices/h2a-verify.json', 'c6a3f05'),
      REF('artifacts/dsh/slices/h2a-events-verify.json', '3b25e1b'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H2a persistent event tools mounted on restricted worker sessions, four publish/subscribe paths, ack vs context-loaded separation, offline G1/G2.',
    limitations: [
      'Offline module/integration with synthetic native DSH double and independent effect ledger; not fixed-host model behaviour.',
      'Real core Goal continuation wiring, time/condition triggers, anti-loop/fanout quota matrices and event-catalog extension remain untested.',
      'No model actually called an event tool; provider budgets/cache and real task/Goal continuation are unproven.',
    ],
    derive: [{ label: 'h2aStatus', path: 'artifacts/dsh/h2/h2a-slice-summary.json', jsonPath: 'status' }],
  },
  {
    id: 'h2a-probe',
    commits: ['6f600f4', '3b25e1b'],
    files: [
      REF('artifacts/dsh/h2/h2a-probe-slice-summary.json', '6f600f4'),
      REF('artifacts/dsh/slices/h2a-probe-verify.json', '6f600f4'),
    ],
    levels: ['offline-module', 'fixed-host-zero-model'],
    scope: 'H2a zero-model worker-tool-mounting probe and host-invocable diagnostic tool (creates and immediately releases a restricted worker Session).',
    limitations: [
      'Zero-model probe only: proves restricted mounting, non-forgeable tool parameters and release — not that a model called an event tool.',
      'Not Task/Goal continuation, not provider budget/cache/cost, not business acceptance.',
    ],
    derive: [{ label: 'probeStatus', path: 'artifacts/dsh/h2/h2a-probe-slice-summary.json', jsonPath: 'status' }],
  },
  {
    id: 'h3-core-planning',
    commits: ['d7dd731'],
    files: [
      REF('artifacts/dsh/h3/h3-core-planning-offline.json', 'd7dd731'),
      REF('artifacts/dsh/h3/h3-slice-summary.json', 'd7dd731'),
      REF('artifacts/dsh/slices/h3-verify.json', 'd7dd731'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H3 controlled multi-step core planning: candidate-only model plan, trusted validation/CAS plan versions, deterministic Task/Mandate admission, replanning and negative cases.',
    limitations: [
      'G1 module/property + real temporary SQLite/Worker only; no real DSH host/native Goal rounds, real model plan JSON, cost/cache or slot behaviour.',
      'Plan steps currently bind to the existing fixed local-note capability; more authorized capabilities need their own fixed-adapter admission.',
    ],
    derive: [{ label: 'h3Status', path: 'artifacts/dsh/h3/h3-core-planning-offline.json', jsonPath: 'status' }],
  },
  {
    id: 'h4-inner-offline',
    commits: ['2e04eb2'],
    files: [
      REF('artifacts/dsh/h4/h4-inner-domains-offline.json', 'c6a3f05'),
      REF('artifacts/dsh/h4/h4-slice-summary.json', '2e04eb2'),
      REF('artifacts/dsh/slices/h4-verify.json', 'c6a3f05'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H4 relationship/emotion/cognition/personality domains with versions/source refs/withdrawal/deletion barriers, schema4 publication and two-stage ReadView (offline).',
    limitations: [
      'G1 module/property with real temporary SQLite/Worker; no real host, model/embedding, real Ombre bodies, channels or business acceptance.',
      'Cross-domain recomputation (e.g. relationship correction re-evaluating cognition) is not implemented; historical revisions live in the control DB only.',
    ],
    derive: [{ label: 'h4Status', path: 'artifacts/dsh/h4/h4-slice-summary.json', jsonPath: 'status' }],
  },
  {
    id: 'h4-host',
    commits: ['feecf86', '00fb75b'],
    files: [
      REF('artifacts/dsh/h4/h4-host-zero-model.json', 'c6a3f05'),
      REF('artifacts/dsh/h4/shiyu-status-schema4-host.json', 'feecf86'),
    ],
    levels: ['fixed-host-zero-model'],
    scope: 'Fixed-host zero-model reload showing schema4 six-domain publication and truthful inner summary through shiyu_status.',
    limitations: [
      'Startup/publication/status visibility only; no real dashboard DOM, no model/embedding/channel/business action, no real inner bodies.',
      'Single host instance; not a V24 lifecycle matrix and not host business acceptance.',
    ],
    derive: [{ label: 'h4HostStatus', path: 'artifacts/dsh/h4/h4-host-zero-model.json', jsonPath: 'status' }],
  },
  {
    id: 'h4b-composition',
    commits: ['f2f9d42'],
    files: [
      REF('artifacts/dsh/h4/h4b-integration.json', 'f2f9d42'),
      REF('artifacts/dsh/h4/h4b-slice-summary.json', 'f2f9d42'),
      REF('artifacts/dsh/slices/h4b-verify.json', 'c6a3f05'),
    ],
    levels: ['offline-module', 'synthetic-ui', 'slice-verification'],
    scope: 'H4b inner-domain ReadView composition for replyer and dashboard six-domain availability panel; synthetic-host Playwright UI cases.',
    limitations: [
      'UI is validated against synthetic host fixtures (209 cases), not a real browser against real DSH host data.',
      'No real model generation, no real inner body content, no real business data.',
    ],
    derive: [{ label: 'h4bStatus', path: 'artifacts/dsh/h4/h4b-slice-summary.json', jsonPath: 'status' }],
  },
  {
    id: 'h4b-host',
    commits: ['00fb75b'],
    files: [
      REF('artifacts/dsh/h4/h4b-host-visible.json', 'c6a3f05'),
      REF('artifacts/dsh/h4/shiyu-status-h4b-host.json', '00fb75b'),
    ],
    levels: ['fixed-host-zero-model'],
    scope: 'Fixed-host zero-model reload confirming corrected systems.inner summary and six-domain availability data via the status tool.',
    limitations: [
      'No real dashboard rendering (browser DOM) and no real business data; one host instance, zero model calls.',
      'Not V24 UI acceptance, not generation or lifecycle evidence.',
    ],
  },
  {
    id: 'h4c-replyer-inner',
    commits: ['c00c6a9'],
    files: [
      REF('artifacts/dsh/h4/h4c-replyer-inner-context.json', 'c00c6a9'),
      REF('artifacts/dsh/h4/h4c-slice-summary.json', 'c00c6a9'),
      REF('artifacts/dsh/slices/h4c-verify.json', 'c00c6a9'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H4c replyer upstream path consumes bounded inner-domain references via two-stage reads and a deterministic bounded prompt block (module + temp SQLite/Worker).',
    limitations: [
      'Real model generation, how a model uses the inner block, provider cache/cost and quality impact are NOT measured.',
      'conversation.reply.prepare contract not extended with explicit inner-source fields; Lab reply capture does not request inner domains.',
    ],
    derive: [{ label: 'h4cStatus', path: 'artifacts/dsh/h4/h4c-slice-summary.json', jsonPath: 'status' }],
  },
  {
    id: 'h5-g1-module',
    commits: ['5a7bc9e'],
    files: [
      REF('artifacts/dsh/h5/h5-recovery-matrix.json', '5a7bc9e'),
      REF('artifacts/dsh/h5/h5-verification.json', 'c6a3f05'),
      REF('artifacts/dsh/h5/h5-slice-summary.json', '5a7bc9e'),
      REF('artifacts/dsh/slices/h5-verify.json', 'c6a3f05'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H5-B1 G1 module: strict BackupBundle/control SQLite capture, real-byte bundle verification, isolated-root maintenance/disarmed restore with synthetic ports.',
    limitations: [
      'G1 module only: not wired into Runtime; no live host/V24, real Goal Session flush/log, real Ombre export/physical erasure, independent fault domain/V27, RPO/RTO or OS power loss.',
      'Synthetic ports and temporary local roots; not host or business acceptance.',
    ],
    derive: [
      { label: 'h5Status', path: 'artifacts/dsh/h5/h5-slice-summary.json', jsonPath: 'status' },
      { label: 'h5EvidenceLevel', path: 'artifacts/dsh/h5/h5-slice-summary.json', jsonPath: 'evidenceLevel' },
    ],
  },
  {
    id: 'h6a-channel-ingress',
    commits: ['8b34d66'],
    files: [
      REF('artifacts/dsh/h6/h6a-channel-ingress.json', '8b34d66'),
      REF('artifacts/dsh/h6/h6a-slice-summary.json', '8b34d66'),
      REF('artifacts/dsh/slices/h6a-verify.json', '8b34d66'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H6a generic channel ingress foundation: trusted adapter identity, persistent intake/dedup, revisions/tombstones, versioned audiences and two-stage capture (offline SQLite + Worker IPC).',
    limitations: [
      'No real platform adapter/credential/receipt, sending/Effect, native Session/draft consumption, dashboard/HTTP UI, Lab room reuse, long-run/crash windows or migration.',
      'Runtime integration points (channelRef bindings, onInvalidation bridge, dashboard read views) remain for later slices.',
    ],
    derive: [{ label: 'h6aStatus', path: 'artifacts/dsh/h6/h6a-slice-summary.json', jsonPath: 'status' }],
  },
  {
    id: 'h4h5-independent-review',
    commits: ['c6a3f05', '41c496b'],
    files: [
      REF('artifacts/dsh/verify/h4h5-evidence-review.json', '41c496b'),
      REF('artifacts/dsh/verify/implementer-evidence-review.json', '3b3b69f'),
      REF('artifacts/dsh/verify/H4H5-EVIDENCE-REVIEW.md', '41c496b'),
    ],
    levels: ['independent-verification'],
    scope: 'Independent H4/H4b/H4-host/H5 committed-evidence authenticity review (hashes, host boundaries, product-row honesty).',
    limitations: ['Evidence-authenticity review only; it did not run the product, host, model or business scenes and does not upgrade product rows.'],
    derive: [{ label: 'reviewKind', path: 'artifacts/dsh/verify/h4h5-evidence-review.json', jsonPath: 'kind' }],
  },
  {
    id: 'joint-host-zero-model',
    commits: ['a68eeb2'],
    files: [
      REF('artifacts/dsh/host/final-joint-zero-model.json', 'a68eeb2'),
      REF('artifacts/dsh/host/final-host-before.json', 'a68eeb2'),
      REF('artifacts/dsh/host/final-host-after.json', 'a68eeb2'),
      REF('artifacts/dsh/host/final-host-after-tools.json', 'a68eeb2'),
    ],
    levels: ['fixed-host-zero-model'],
    scope: 'Final joint fixed-host zero-model reload of the H1/H2a/H2a-probe/H3/H4/H4b/H4c/H5/H6a build: startup, schema4 publication, lossless read-only status, worker tool diagnosis, preserved business facts.',
    limitations: [
      'Zero-model evidence only: no model-generated reply, no event-tool model invocation, no provider budget/cache/cost, no real task/Goal continuation under a model.',
      'One ordered reload and two tool calls; no real browser DOM, channel, Lab business loop, device, long-run or independent fault domain.',
    ],
    derive: [{ label: 'jointHostStatus', path: 'artifacts/dsh/host/final-joint-zero-model.json', jsonPath: 'status' }],
  },
  {
    id: 'historical-task-goal',
    commits: ['1e1bdd2', '0f946f4', 'f6a4d2a'],
    files: [
      REF('artifacts/task-validation.json', '1e1bdd2'),
      REF('artifacts/goal-validation.json', '0f946f4'),
      REF('artifacts/phase3g-core-host-success.json', 'f6a4d2a'),
    ],
    levels: ['historical-limited', 'bounded-real-model', 'fixed-host-zero-model'],
    scope: 'Historical limited Task/Goal evidence: one repaired synthetic local task, one Goal four-step zero-inference lifecycle, and one 3G-B bounded owner local-note closure with reload no-replay.',
    limitations: [
      'Historical limited samples on earlier builds; they do not prove the current HEAD, general Task/Goal behaviour or V10–V12.',
      'The first task usage failure and A-round failures remain unknown; bounded model calls are not full Session fees.',
    ],
    derive: [{ label: 'firstTaskId', path: 'artifacts/task-validation.json', jsonPath: 'attempts.0.taskId' }],
  },
  {
    id: 'historical-model-context',
    commits: ['1e1bdd2', '9115e35'],
    files: [REF('artifacts/model-validation.json', '1e1bdd2'), REF('artifacts/context-validation.json', '9115e35')],
    levels: ['historical-limited', 'bounded-real-model'],
    scope: 'Historical two-round bounded real-model replyer/context samples on earlier builds (same Session reuse, independent readback, limited accounting).',
    limitations: [
      'Not current-HEAD model acceptance; 2–3 main calls only, no long history/compaction/cache/provider retries or complete fees.',
      'Cannot be reused as V24/V25 or business evidence.',
    ],
  },
  {
    id: 'historical-memory',
    commits: ['840b180', 'e7f7291'],
    files: [REF('artifacts/phase3e-memory-validation.json', '840b180'), REF('artifacts/phase3f-memory-host-validation.json', 'e7f7291')],
    levels: ['historical-limited', 'bounded-real-model'],
    scope: 'Historical limited memory save/exact-read/withdraw and semantic index/retrieval/background-load evidence on earlier builds (local Ombre/Harrier).',
    limitations: [
      'Not current-HEAD, not full six domains, not physical deletion/cross-domain propagation or recall quality; host embedding usage incomplete/unknown.',
      'Historical samples cannot be upgraded to V07/V16/V25 or S/FL pass.',
    ],
  },
  {
    id: 'historical-lab-3hc',
    commits: ['5874cc8'],
    files: [REF('artifacts/phase3h-c-lab-host-validation.json', '5874cc8')],
    levels: ['historical-limited', 'bounded-real-model', 'fixed-host-zero-model'],
    scope: 'Historical 3H-C limited two-channel Lab text loop: three bounded real-model replies, same-group Session reuse and one ordered reload without replay.',
    limitations: [
      'Three text messages in two synthetic channels on a historical build; A/B failures and A unknown retained; not general N-channel, concurrency, in-flight recovery or full S/FL.',
      'Complete provider request/cache/fee unknown; not a business acceptance of S01–S08/FL01–FL08.',
    ],
  },
  {
    id: 'historical-capability-3i',
    commits: ['2402ca8', '8c66737'],
    files: [REF('artifacts/phase3i-capability-offline.json', '2402ca8'), REF('artifacts/phase3i-capability-host-zero-model.json', '8c66737')],
    levels: ['historical-limited', 'offline-module', 'fixed-host-zero-model'],
    scope: 'Historical 3I fixed local-note capability state: offline baseline plus two zero-model ordered reloads with owner enable/disable persistence and binding identity.',
    limitations: [
      'Historical fixed capability only; new-binding real task proof, dynamic candidate/skill matrix, complete V09 and other five domains remain untested.',
      'Zero-model host reloads are not generation or business evidence.',
    ],
  },

  /* ---------------- round-3 delivered slices (H7-round4) ---------------- */
  {
    id: 'h6c-channel-projection-ui',
    commits: ['5062485'],
    files: [REF('artifacts/dsh/h6/h6c-ui.json', '5062485')],
    levels: ['synthetic-ui', 'offline-module'],
    scope: 'H6c read-only channel projection dashboard panel: synthetic-host client UI plus real Chromium/Vite suite (214 UI cases incl. 5 channels specs), 1382/1382 isolated full check recorded in the slice evidence.',
    limitations: [
      'Synthetic host page/ModuleLoader/slots/locale only: not real DSH native-client injection/DOM, not a production bundle under a live profile and not real theme switching.',
      'Projection renders synthetic bindings/connections; no live channel adapters/platform snapshot, no model, embedding, Lab room or business acceptance.',
      'The 214 synthetic UI cases never upgrade V05/V24/S/FL or any product module to pass; real-browser DOM evidence remains absent.',
    ],
    derive: [
      { label: 'h6cStatus', path: 'artifacts/dsh/h6/h6c-ui.json', jsonPath: 'status' },
      { label: 'h6cUiPassed', path: 'artifacts/dsh/h6/h6c-ui.json', jsonPath: 'verdict.isolatedUiSuite.passed' },
    ],
  },
  {
    id: 'h2b-subscriptions-time',
    commits: ['479ad43'],
    files: [REF('artifacts/dsh/h2/h2b-subscriptions-time.json', '479ad43')],
    levels: ['offline-module'],
    scope: 'H2b subscription lifecycle, one-shot waits, plugin-owned time source and notification routing foundation (G1/G2 offline: real temporary SQLite control store/rule file + synthetic clock/schedule/observation/effect doubles).',
    limitations: [
      'G1/G2 offline only: no fixed host, model, embedding, channel, device or real effect endpoint; notification Effect and observations are synthetic doubles.',
      'Runtime wiring (catalog, rule store/lifecycle, time pump, diagnostics) was integrated by Lead under e400fcc; fixed-host/zero-model probe is separate round-3 host evidence.',
      'Agent-facing declarative-condition tools are not mounted; dedupe across reconnect is proven only across process/rule-store restart, not real platform redelivery.',
      'No IANA tz/DST database: daily schedules take injected zoneOffsetMinutes. Budget bounding is structural; monetary/model cost is out of scope.',
    ],
    derive: [
      { label: 'h2bKind', path: 'artifacts/dsh/h2/h2b-subscriptions-time.json', jsonPath: 'kind' },
      { label: 'h2bSlice', path: 'artifacts/dsh/h2/h2b-subscriptions-time.json', jsonPath: 'slice' },
    ],
  },
  {
    id: 'h4e-lifecycle-recompute',
    commits: ['69d725f', 'c2bb475'],
    files: [REF('artifacts/dsh/h4/h4e-lifecycle-recompute.json', '69d725f')],
    levels: ['offline-module'],
    scope: 'H4e memory lifecycle polish plus bounded cross-domain derivation recompute/invalidation (G1 module/property + real temporary SQLite/Worker IPC; file extended by the c2bb475 hotfix).',
    limitations: [
      'G1 module/property with real temporary SQLite/Worker IPC only: no model, embedding, real Ombre body, host reload, real channel or business acceptance.',
      'Retention is explicit logical lifecycle (owner-controlled, no automatic expiry, no physical erase); background retention cleanup and backup deletion propagation are not implemented.',
      'Recompute is a same-DB bounded deterministic scan; cross-component trust is only explicit unknown, not an atomic snapshot; derivation gates current-evidence use without rewriting bodies.',
      'Old records without derivation fields normalize to current: that means "never computed", not a re-proof of history; no model self-asserted status upgrade is allowed.',
    ],
    derive: [
      { label: 'h4eEvidenceLevel', path: 'artifacts/dsh/h4/h4e-lifecycle-recompute.json', jsonPath: 'evidenceLevel' },
      { label: 'h4eSlice', path: 'artifacts/dsh/h4/h4e-lifecycle-recompute.json', jsonPath: 'slice' },
    ],
  },
  {
    id: 'h4e-migration-hotfix',
    commits: ['c2bb475'],
    files: [
      REF('artifacts/dsh/slices/h4e-migration-fix-verify.json', 'c2bb475'),
      REF('tests/inner-upgrade.test.ts', 'c2bb475'),
    ],
    levels: ['offline-module'],
    scope: 'H4e migration hotfix: derivation authority moved to additive per-domain derivation_meta tables so commit-watermark-tracked meta tables are never ALTERed; isolated migration-fix verification plus inner-upgrade regression test.',
    limitations: [
      'This source is offline regression/migration evidence; the real fixed-host activation/recovery proof is recorded separately in round3-host-zero-model (50af4a2).',
      'Covers the old-DB upgrade path and derivation-authority separation only; it does not prove every future migration, physical deletion or backup retention.',
      'No model, embedding, channel, device or business acceptance.',
    ],
    derive: [
      { label: 'h4eMigrationFixVerdict', path: 'artifacts/dsh/slices/h4e-migration-fix-verify.json', jsonPath: 'verdict' },
    ],
  },
  {
    id: 'h5b-runtime-integration',
    commits: ['5eede56'],
    files: [REF('artifacts/dsh/h5/h5b-runtime-integration.json', '5eede56')],
    levels: ['offline-module'],
    scope: 'H5b checkpoint runtime composition ports and capture command handler (G1+ offline Runtime composition with real temporary ControlStore/SQLite/Session files and synthetic native-state/flush/projection/memory seams).',
    limitations: [
      'H5b stays production-blocked: GOAL_SESSION_EXPORT_UNAVAILABLE and required export/flush/durability scope are not satisfied; the checkpoint capture command is explicitly unavailable and was NOT executed on the host.',
      'G1+ offline composition only: no live data root/native Session/control-DB writes, no real Ombre backend, no model/channel/device, no production host readiness.',
      'V22 is sub-scenarios only with synthetic seams; V27 not attempted; full V21/V22/V24 host lifecycle and real RPO/RTO remain unproven.',
    ],
    derive: [
      { label: 'h5bEvidenceLevel', path: 'artifacts/dsh/h5/h5b-runtime-integration.json', jsonPath: 'evidenceLevel' },
      { label: 'h5bTotal', path: 'artifacts/dsh/h5/h5b-runtime-integration.json', jsonPath: 'summary.total' },
    ],
  },
  {
    id: 'h7-acceptance-slice',
    commits: ['09cf6d9'],
    files: [REF('artifacts/dsh/harness/h7-acceptance-slice.json', '09cf6d9')],
    levels: ['offline-module'],
    scope: 'H7-acceptance tooling slice: 12-area/40-module machine-readable registry plus honest full-acceptance gate runner and its tests/slice evidence (gate incomplete, no product acceptance run).',
    limitations: [
      'Harness tooling/evidence only: it does not run product/host/model/business acceptance and cannot upgrade any product module, V item, system or S/FL scenario.',
      'The acceptance gate is deliberately `incomplete` with executed/passed=0; acceptance-report.json/md are regenerated only at the round-end clean HEAD.',
    ],
    derive: [{ label: 'h7AcceptanceStatus', path: 'artifacts/dsh/harness/h7-acceptance-slice.json', jsonPath: 'status' }],
  },
  {
    id: 'round3-lead-integration',
    commits: ['e400fcc'],
    files: [REF('artifacts/dsh/integration/round3-lead-integration.json', 'e400fcc')],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Lead round-3 integration of H2b event rules/time source and H5b checkpoint composition into Runtime (offline-verified integration + isolated full check 1434/1434, 72 targeted tests).',
    limitations: [
      'G1 integration + isolated full check only; fixed-host validation is recorded separately in round3-host-zero-model.',
      'The checkpoint command stays explicitly unavailable while trusted checkpointStagingRoot/checkpointRuntimeManifest are not supplied; no host execution is claimed.',
      'H2b uses plugin-owned rules only, no DSH schedule, no real observation/notification Effect ports and no agent-facing subscription tools; no real model/channel calls.',
    ],
    derive: [
      { label: 'integrationStatus', path: 'artifacts/dsh/integration/round3-lead-integration.json', jsonPath: 'status' },
      { label: 'integrationCheckTests', path: 'artifacts/dsh/integration/round3-lead-integration.json', jsonPath: 'verification.leadIsolatedIntegrationCheck.tests.tests' },
    ],
  },
  {
    id: 'round3-host-zero-model',
    commits: ['50af4a2'],
    files: [
      REF('artifacts/dsh/host/round3-joint-zero-model.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/round3-host-before.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/round3-host-after-disable.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/round3-host-pre-reload2.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/round3-host-after.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/round3-host-after-tools.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/status-after-probes.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/status-after-reload.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/core-event-tool-probe.json', '50af4a2'),
      REF('artifacts/dsh/host/round3/worker-tool-probe.json', '50af4a2'),
    ],
    levels: ['fixed-host-zero-model'],
    scope: 'Round-3 fixed-host zero-model validation of the build after the H4e migration hotfix: one ordered reload, activation/upgrade/publication, restricted diagnostics/core/worker tool probes, diagnostics.timeSource cooperative tick (idle) and truthful status before/after/reload.',
    limitations: [
      'Zero-model evidence only: activation/upgrade/publication/probes/diagnostics are proven, not real model tool invocation, provider budgets, real plan quality or channel traffic.',
      'The checkpoint capture command remains explicitly unavailable because trusted staging/manifest composition is absent; it was NOT executed on the host.',
      'Real browser DOM rendering of the dashboard remains unproven; lifecycle=degraded still reflects retained historical unknown/paused facts; probes are zero-model.',
      'One ordered reload and four tool calls only; no real task/Goal continuation under a model, no channel/Lab business loop and no device/long-run evidence.',
    ],
    derive: [
      { label: 'round3HostStatus', path: 'artifacts/dsh/host/round3-joint-zero-model.json', jsonPath: 'status' },
      { label: 'round3OrderedReloads', path: 'artifacts/dsh/host/round3-joint-zero-model.json', jsonPath: 'scope.orderedReloads' },
    ],
  },
  /* ---------------- round-4 probes / host / failure evidence (H7-round5) ---------------- */
  {
    id: 'h2b-host-time-probe',
    commits: ['8cc6762'],
    files: [
      REF('artifacts/dsh/h2/h2b-host-time-probe.json', '8cc6762'),
      REF('artifacts/dsh/h2/h2b-time-probe-manifest.json', '8cc6762'),
      REF('artifacts/dsh/slices/h2b-time-probe-verify.json', '8cc6762'),
    ],
    levels: ['offline-module'],
    scope: 'H2b zero-model host time-source probe kit: isolated in-memory time-source/rules probe, manifest and isolated slice verification (passed) intended for one explicit fixed-host diagnostic run.',
    limitations: [
      'The kit itself is offline/isolated: it does not execute a live host run; the fixed-host zero-model probe execution and receipts are recorded separately in round4-host-zero-model (bd81270).',
      'No real model, embedding, channel or business call; live rule/time DB, DSH Schedule/IANA DST and real notification Effect remain untested.',
      'Probe evidence cannot upgrade V14/SYS.2 or any product module to pass.',
    ],
    derive: [
      { label: 'h2bTimeProbeKind', path: 'artifacts/dsh/h2/h2b-host-time-probe.json', jsonPath: 'kind' },
      { label: 'h2bTimeProbeVerdict', path: 'artifacts/dsh/slices/h2b-time-probe-verify.json', jsonPath: 'verdict' },
    ],
  },
  {
    id: 'h2c-real-model-probe',
    commits: ['d2da9c7'],
    files: [
      REF('artifacts/dsh/h2/h2c-real-model-probe.json', 'd2da9c7'),
      REF('artifacts/dsh/h2/h2c-real-model-probe-integration.patch', 'd2da9c7'),
      REF('artifacts/dsh/slices/h2c-probe-verify.json', 'd2da9c7'),
    ],
    levels: ['offline-module'],
    scope: 'H2c bounded real-model single-round core event-tool probe kit: implementation + integration patch + isolated full-check verification (1444/1444), prepared for exactly one explicit Lead host attempt.',
    limitations: [
      'The implementer did NOT execute the real model: this source is offline implementation/isolated verification only.',
      'The host bounded real-model attempt failed before any model request and was not retried (recorded in round4-host-zero-model, bd81270): no real-model tool invocation, provider usage, cache or cost is proven.',
      'A failed/unknown real-model attempt must never be counted as pass, product acceptance or V25 evidence; the probe is diagnostic only and does not prove plan quality, provider behavior or usage reporting.',
      'No automatic retry is allowed; the blocked probe Session ended before any assistant message and host root cause is left uninspected in this slice.',
    ],
    derive: [
      { label: 'h2cStatus', path: 'artifacts/dsh/h2/h2c-real-model-probe.json', jsonPath: 'status' },
      { label: 'h2cProbeVerdict', path: 'artifacts/dsh/slices/h2c-probe-verify.json', jsonPath: 'verdict' },
    ],
  },
  {
    id: 'h5b-checkpoint-probe',
    commits: ['dab6d5b'],
    files: [
      REF('artifacts/dsh/h5/h5b-checkpoint-probe.json', 'dab6d5b'),
      REF('artifacts/dsh/h5/runtime-checkpoint-probe.diff', 'dab6d5b'),
    ],
    levels: ['offline-module'],
    scope: 'H5b read-only checkpoint availability probe: G1+ offline probe over a real temporary ControlStore/SQLite with synthetic resolver markers and memory-availability seams; returns explicit ready/unavailable reasons.',
    limitations: [
      'Read-only availability probe only: checkpoint capture/restore is still production-blocked (trusted staging/manifest absent) and no Goal Session/Ombre export or durable checkpoint was produced.',
      'Verified offline with synthetic resolver markers; the fixed-host probe returns ready:false with CHECKPOINT_STAGING_UNCONFIGURED/GOAL_SESSION_EXPORT_UNAVAILABLE/MEMORY_EXPORT_UNAVAILABLE and writes no files.',
      'No real host capture readiness, RPO/RTO drill, backup destination or V22/V27 acceptance; probe evidence cannot upgrade product rows.',
    ],
    derive: [{ label: 'h5bProbePassed', path: 'artifacts/dsh/h5/h5b-checkpoint-probe.json', jsonPath: 'summary.passed' }],
  },
  {
    id: 'h7-round4-slice',
    commits: ['e273aa7'],
    files: [REF('artifacts/dsh/harness/h7-round4-slice.json', 'e273aa7')],
    levels: ['offline-module'],
    scope: 'H7-round4 tooling slice evidence: round-3 sources bound into the evidence map + acceptance index, fail-closed tests and slice evidence (no full artifact refresh in the slice).',
    limitations: [
      'Harness tooling/evidence only: it does not execute product/host/model/business acceptance and cannot upgrade any product row/module/V/S/FL.',
      'The full harness artifacts were later refreshed under dfe4372 (H7 X+1); this source is retained as the slice-level record with its own limited checks.',
    ],
    derive: [{ label: 'h7Round4Status', path: 'artifacts/dsh/harness/h7-round4-slice.json', jsonPath: 'status' }],
  },
  {
    id: 'round4-lead-integration',
    commits: ['1f74180'],
    files: [
      REF('artifacts/dsh/integration/round4-lead-integration.json', '1f74180'),
      REF('artifacts/dsh/slices/round4-integrated-verify.json', '1f74180'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Lead round-4 integration of the H2b time-source probe, H2c real-model core probe and H5b checkpoint availability probe into Runtime and diagnostics tools (offline-verified integration, isolated 1472/1472).',
    limitations: [
      'G1 integration + isolated full check only: fixed-host validation is separate (round4-host-zero-model) and real-model execution is not proven by this source.',
      'The real-model core probe depends on provider behavior; its failed/unknown host outcome must be recorded honestly and never auto-retried or counted as pass.',
      'All three probes are diagnostics only; they do not prove production time triggering, real Session log export, Ombre export readiness or plan quality; checkpoint capture remains unavailable.',
      'No real model/embedding/channel/host reload in this integration evidence.',
    ],
    derive: [
      { label: 'round4IntegrationStatus', path: 'artifacts/dsh/integration/round4-lead-integration.json', jsonPath: 'status' },
      { label: 'round4IntegrationTests', path: 'artifacts/dsh/integration/round4-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests.tests' },
    ],
  },
  {
    id: 'round4-localcore-hotfix',
    commits: ['af201fe'],
    files: [REF('src/control/local-core.ts', 'af201fe'), REF('tests/local-core.test.ts', 'af201fe')],
    levels: ['offline-module'],
    scope: 'Round-4 LocalCoreService delegate hotfix: expose the bounded real-model core probe through the service (one code file + one test file), unblocking the host attempt path.',
    limitations: [
      'Code/test hotfix only: it proves the delegation wiring, not real-model execution, host behavior or plan quality.',
      'The fixed-host bounded real-model attempt still failed before any model request (see round4-host-zero-model); no model usage/cost and no retry.',
      'Cannot be mapped to pass; no product acceptance.',
    ],
    derive: [],
  },
  {
    id: 'round4-host-zero-model',
    commits: ['bd81270'],
    files: [
      REF('artifacts/dsh/host/round4-joint-zero-model-real-model.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/round4-host-before.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/round4-host-after.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/round4b-host-before.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/round4b-host-after.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/round4b-host-after-status.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/round4b-host-after-tools.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/time-source-probe.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/checkpoint-availability-probe.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/worker-tool-probe.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/core-event-tool-probe.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/core-model-tool-probe.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/status-after-reload.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/status-final-cached.json', 'bd81270'),
      REF('artifacts/dsh/host/round4/status-after-core-model-attempt.json', 'bd81270'),
    ],
    levels: ['fixed-host-zero-model'],
    scope: 'Round-4 fixed-host zero-model probe receipts plus one bounded real-model core event-tool attempt: time-source probe pass, checkpoint availability ready:false, restricted mount probes, and an honest failed real-model attempt before any model request.',
    limitations: [
      'The bounded real-model single-round tool probe FAILED before any model request and was not retried: no real-model tool invocation, provider usage, cache or cost is proven; failure must never be recorded as pass.',
      'Zero-model evidence only for mount/time/checkpoint probes; live time triggering (rules in live control DB), checkpoint capture readiness, real Session export and real Ombre export remain untested.',
      'The archived core-model probe Session ended with a blocked turn before any assistant message; host root cause is not investigated further and lifecycle=degraded retains historical pausing facts.',
      'Real browser DOM rendering is unproven; no business facts were written by any probe. scope: orderedReloads=1, failedLiveAttempts=2, toolCalls=9, realModelCalls=0.',
    ],
    derive: [
      { label: 'round4HostStatus', path: 'artifacts/dsh/host/round4-joint-zero-model-real-model.json', jsonPath: 'status' },
      { label: 'round4RealModelCalls', path: 'artifacts/dsh/host/round4-joint-zero-model-real-model.json', jsonPath: 'scope.realModelCalls' },
    ],
  },
  {
    id: 'h7-round4-clean-artifacts',
    commits: ['dfe4372'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: 'dfe4372',
        blobCommit: 'dfe4372',
        expectedSha256: 'c32b773453e64eaccfd67c94e467ddb2a3f0567f18b98da8528fe2aa567d432a',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: 'dfe4372',
        blobCommit: 'dfe4372',
        expectedSha256: 'd208ceb02401f61b8415233ebdf4ba95445569450fd4058f6ba43f8eaa41f061',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: 'dfe4372',
        blobCommit: 'dfe4372',
        expectedSha256: 'c244f683b3200c8b12a65a53b12e8dfb90298019b346c82b25a00606af697d5c',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round4 clean-VCS harness artifacts (X+1): clean-X manifest, traceability with 30 verified evidence sources, and acceptance report (gate incomplete) regenerated on af201fe.',
    limitations: [
      'Tooling evidence only: manifests/traceability/acceptance report prove tool recomputation and honesty, not product/host/model/business acceptance.',
      'executed=0/passed=0 in the acceptance report; product rows remain not_covered and the nine-system gate stays incomplete.',
      'This source is the X+1 artifact snapshot and must be regenerated again at the next round-end clean HEAD; it cannot upgrade V/S/FL or product rows.',
    ],
    derive: [{ label: 'h7Round4CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  /* ---------------- round-5 host/fix-chain/tooling evidence (H7-round6) ---------------- */
  {
    id: 'round5-host-real-model',
    commits: ['511fe65'],
    files: [
      REF('artifacts/dsh/host/round5-joint-zero-model-and-real-model.json', '511fe65'),
      REF('artifacts/dsh/host/round5/time-trigger-probe.json', '511fe65'),
      REF('artifacts/dsh/host/round5/core-model-probe-passed.json', '511fe65'),
      REF('artifacts/dsh/host/round5/core-model-attempt-1-69464312.json', '511fe65'),
      REF('artifacts/dsh/host/round5/core-model-attempt-2-51c5970a.json', '511fe65'),
      REF('artifacts/dsh/host/round5/core-model-attempt-3-d60c7b3a.json', '511fe65'),
      REF('artifacts/dsh/host/round5/core-model-attempt-4-41235a79.json', '511fe65'),
      REF('artifacts/dsh/host/round5/core-model-attempt-5-76894525.json', '511fe65'),
      REF('artifacts/dsh/host/round5/round5-host-before.json', '511fe65'),
      REF('artifacts/dsh/host/round5/round5-host-after-first-reload.json', '511fe65'),
      REF('artifacts/dsh/host/round5/round5-host-after-real-probes.json', '511fe65'),
      REF('artifacts/dsh/host/round5/round5-host-final.json', '511fe65'),
      REF('artifacts/dsh/host/round5/status-final.json', '511fe65'),
    ],
    levels: ['fixed-host-zero-model', 'bounded-real-model-diagnostic-only'],
    scope: 'Round-5 fixed-host run: live zero-model time-trigger probe success plus the first bounded real-model core event-tool diagnostic round (one read-only types tool round; primary provider-reported usage input 1469 / output 41 / total 2406 as reported), with five disclosed pre-pass failures and before/reload/real-probe/final audits.',
    limitations: [
      'This is a bounded diagnostic probe, NOT a full core decision round, Goal, plan or Task; it does not prove real plan quality, provider cache accounting or business acceptance.',
      'Primary provider usage is only reported (input 1469 / output 41 / total 2406 as reported; no cache fields); attempts 4 and 5 show mainModelRequests=1 / mainModelStreams=0 with usage unknown — one request initiated, no stream completed, provider receipt/cost unknown, never claim zero cost.',
      'Five pre-pass attempts and their root causes are disclosed; none was retried after the successful admitted model turn; failed/diagnostic attempts must never be counted as pass.',
      'The live time-trigger probe intentionally appended one undeletable time.occurred event (append-only side effect) and the rule/time state were removed; no live delivery/business tables were written.',
      'Real browser DOM, real channels/devices, checkpoint capture readiness, V25 semantic evaluation and nine-system acceptance remain untested; diagnostic pass cannot upgrade V25 or any product row.',
    ],
    derive: [
      { label: 'round5HostStatus', path: 'artifacts/dsh/host/round5-joint-zero-model-and-real-model.json', jsonPath: 'status' },
      { label: 'round5PrimaryInputTokens', path: 'artifacts/dsh/host/round5-joint-zero-model-and-real-model.json', jsonPath: 'realModelProbe.usage.inputTokens' },
      { label: 'round5Attempt4Requests', path: 'artifacts/dsh/host/round5/core-model-attempt-4-41235a79.json', jsonPath: 'counters.mainModelRequests' },
    ],
  },
  {
    id: 'h2c-probe-fix-chain',
    commits: ['7f57ea1', '7704e5d', '3bec321', '3e2bbf9', '6ae4582'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/core-model-probe-diagnostics-verify.json',
        sliceCommit: '7f57ea1',
        blobCommit: '6ae4582',
        expectedSha256: '27d57675528670d30a2c7e7312ede7de6f96dd62a7656decfcd1fd633c4622eb',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/core-model-probe-context-verify.json',
        sliceCommit: '6ae4582',
        blobCommit: '6ae4582',
        expectedSha256: '82b5642c7f8a257ba59af5ecbb173312e862671404ef6f261a5ae8f130b41b73',
      },
      {
        path: 'plugins/shiyu/tests/core-event-tools.test.ts',
        sliceCommit: '6ae4582',
        blobCommit: '6ae4582',
        expectedSha256: '111f56caf601ab05608d5c7d86063fc7846b8af2e022c1aaee7ac32b8ecfb0c2',
      },
    ],
    levels: ['offline-module'],
    scope: 'H2c core-model probe fix chain: bounded failure diagnostics, host runtime-context reconstruction/structural binding, session-title suppression and tool-history classification; each commit carries isolated slice evidence and fake-host regression tests (4 tests).',
    limitations: [
      'Fake-host offline evidence only: the fixes repair first-step/context/title/tool-history handling; they do NOT widen the H2c boundary, add retries, or prove real model success.',
      'Real-provider behavior is recorded only in round5-host-real-model (one bounded diagnostic pass after five disclosed failures); the fix-chain tests cannot upgrade V25, full core, Goal/Task or business acceptance.',
      'No real model, embedding, channel, device or host run is executed by this source.',
    ],
    derive: [
      { label: 'h2cDiagnosticsVerdict', path: 'artifacts/dsh/slices/core-model-probe-diagnostics-verify.json', jsonPath: 'verdict' },
      { label: 'h2cContextVerdict', path: 'artifacts/dsh/slices/core-model-probe-context-verify.json', jsonPath: 'verdict' },
    ],
  },
  {
    id: 'h2b-live-time-trigger',
    commits: ['6ecb487'],
    files: [
      REF('artifacts/dsh/integration/round5-lead-integration.json', '6ecb487'),
      REF('artifacts/dsh/slices/round5-integrated-verify.json', '6ecb487'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Lead round-5 integration of the live time-trigger probe diagnostic tool and H2c fix-chain: offline-verified integration plus isolated combined check 1492/1492; fixed-host execution and receipts are recorded separately in round5-host-real-model.',
    limitations: [
      'The live time-trigger probe intentionally appends exactly one undeletable time.occurred control event to the live append-only ledger (disclosed real side effect); no live delivery, Task/Goal/Effect or model call is created.',
      'This integration source is offline/isolated only: the fixed-host probe result, failures and real-model diagnostic are separate host evidence; diagnostic pass must never be counted as business acceptance.',
      'Host retest may pass/fail/reveal another shape; no automatic retry is allowed. No V25/complete nine-system claim.',
    ],
    derive: [
      { label: 'round5IntegrationStatus', path: 'artifacts/dsh/integration/round5-lead-integration.json', jsonPath: 'status' },
      { label: 'round5IntegrationTests', path: 'artifacts/dsh/slices/round5-integrated-verify.json', jsonPath: 'verdict' },
    ],
  },
  {
    id: 'h7-blobcommit-hotfix',
    commits: ['444f377'],
    files: [
      REF('artifacts/dsh/harness/h7-round5-slice.json', '444f377'),
      REF('artifacts/dsh/slices/h7-blobcommit-hotfix-verify.json', '444f377'),
    ],
    levels: ['offline-module'],
    scope: 'H7 clean-pipeline self-reference hotfix: evidence refs may pin committed snapshots (blobCommit + expected SHA256) so regenerated manifest/traceability/acceptance artifacts are verified from the evidence commit instead of the rewritten worktree; clean pipeline then passes 38/38 sources.',
    limitations: [
      'Harness tooling hotfix only: it stabilizes evidence verification and does not run product/host/model/business acceptance.',
      'Only the clean-artifact sources use blobCommit snapshots; all other sources keep worktree-vs-HEAD tamper detection; diagnostic/passed probes cannot upgrade product rows/V/S/FL.',
      'The fix does not change the acceptance gate: executed=0/passed=0 and the nine-system gate remains incomplete.',
    ],
    derive: [{ label: 'blobCommitHotfixVerdict', path: 'artifacts/dsh/slices/h7-blobcommit-hotfix-verify.json', jsonPath: 'verdict' }],
  },
  {
    id: 'h7-round5-clean-artifacts',
    commits: ['693fab1'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: '693fab1',
        blobCommit: '693fab1',
        expectedSha256: '2474996a6d4d67d8609b60090bc8d3c1647635f2189d2c136f51b97a961f685f',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: '693fab1',
        blobCommit: '693fab1',
        expectedSha256: 'ca9307dfb6dfb9859fe45bcde183e3040c8362dcf90a90effc60fcf1490550c2',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: '693fab1',
        blobCommit: '693fab1',
        expectedSha256: 'beb367d8acb51c67c4f80e5b570906fe544b818eeb4edab485d5ebdfd187a7be',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round5 clean-VCS harness artifacts (X+1 of 444f377, commit 693fab1): manifest, traceability with 38 verified sources and acceptance report (gate incomplete) regenerated on the blobCommit hotfix X.',
    limitations: [
      'Tooling evidence only: artifacts prove clean-X recomputation/honesty, not product/host/model/business acceptance.',
      'The acceptance report is h7-prep incomplete: executed=0/passed=0, product rows not_covered, gate completeNineSystems=false.',
      'Bound with blobCommit+expectedSha256 so later pipeline rewrites do not invalidate the committed snapshot; this source must never be read from the mutable worktree.',
    ],
    derive: [{ label: 'round5CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  /* ---------------- round-6 host isolated lifecycle evidence (H7-round7) ---------------- */
  {
    id: 'round6-host-inner-lifecycle',
    commits: ['8d4c97c'],
    files: [
      REF('artifacts/dsh/host/round6-joint-zero-model.json', '8d4c97c'),
      REF('artifacts/dsh/host/round6/inner-lifecycle-probe.json', '8d4c97c'),
      REF('artifacts/dsh/host/round6/round6-host-before.json', '8d4c97c'),
      REF('artifacts/dsh/host/round6/round6-host-after-reload.json', '8d4c97c'),
      REF('artifacts/dsh/host/round6/round6-host-after-probe.json', '8d4c97c'),
      REF('artifacts/dsh/host/round6/round6-host-final.json', '8d4c97c'),
      REF('artifacts/dsh/host/round6/status-final.json', '8d4c97c'),
    ],
    levels: ['fixed-host-zero-model'],
    scope: 'Round-6 fixed-host zero-model isolated inner-lifecycle probe: one diagnostic probe call against a private in-memory ControlStore, plus before/reload/after-probe/final audits and a 59072-byte status-final receipt proving the diagnostics cache passed; product rows and gate unchanged.',
    limitations: [
      'Diagnostic-only: the probe uses an isolated :memory: ControlStore and SKIPS the memory backend; it does not prove live memory semantics, live data untouched, real Ombre export or business acceptance.',
      'The status-final 59072-byte receipt proves only that the diagnostics cache reports the probe as passed; it is not a publication, authorization, Task/Effect completion or nine-system acceptance fact.',
      'No real model/embedding/Task/Effect/channel/DOM was involved; product rows stay not_covered and the acceptance gate remains incomplete — this probe can never be counted as pass.',
      'Fixed-host diagnostic evidence cannot upgrade live memory/Ombre/business or any V item/SYS.5 complete status.',
    ],
    derive: [
      { label: 'round6HostStatus', path: 'artifacts/dsh/host/round6-joint-zero-model.json', jsonPath: 'status' },
      { label: 'round6ProbeStatus', path: 'artifacts/dsh/host/round6/inner-lifecycle-probe.json', jsonPath: 'status' },
    ],
  },
  {
    id: 'h4e-isolated-lifecycle-probe',
    commits: ['0965d0f'],
    files: [
      REF('artifacts/dsh/h4/h4e-host-lifecycle-probe.json', '0965d0f'),
      REF('artifacts/dsh/h4/h4e-runtime-integration.diff', '0965d0f'),
      REF('src/control/inner-lifecycle-probe.ts', '0965d0f'),
      REF('tests/inner-lifecycle-probe.test.ts', '0965d0f'),
    ],
    levels: ['offline-module'],
    scope: 'H4e isolated zero-model inner-lifecycle probe implementation: private in-memory probe covering 14 steps / 9 checks (derivation/recompute/capture rejection/cleanup), 9 new tests, integration diff; isolated full check 1507/1507 at baseline 0819d11 plus 9 tests.',
    limitations: [
      'Offline isolated probe only (14 steps / 9 checks; isolated full check 1507/1507): it rejects live path options, uses a private :memory: ControlStore and does not touch the live data root; live memory backend is not exercised.',
      'Fixed-host diagnostic execution and audits are separate evidence (round6-host-inner-lifecycle); the probe receipt is diagnostics only, not publication/authorization/Task/Effect completion or business acceptance.',
      'No model, embedding, Ombre body, channel, DOM or live business write; it cannot upgrade SYS.5/V items/product rows to pass.',
    ],
    derive: [
      { label: 'h4eProbeIsolatedTests', path: 'artifacts/dsh/h4/h4e-host-lifecycle-probe.json', jsonPath: 'verification.isolatedWorktree.tests' },
      { label: 'h4eProbeTestCount', path: 'artifacts/dsh/h4/h4e-host-lifecycle-probe.json', jsonPath: 'verification.probeTests.count' },
    ],
  },
  {
    id: 'round6-lead-integration',
    commits: ['fc124d1'],
    files: [
      REF('artifacts/dsh/integration/round6-lead-integration.json', 'fc124d1'),
      REF('artifacts/dsh/slices/round6-integrated-verify.json', 'fc124d1'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Lead round-6 integration of the isolated inner-lifecycle probe diagnostic tool into Runtime/index: offline-verified integration plus isolated combined check 1515/1515; fixed-host probe execution is recorded separately in round6-host-inner-lifecycle.',
    limitations: [
      'G1 integration + isolated full check only: fixed-host execution/audits are separate; no live memory backend, Ombre body or business write is exercised.',
      'The private in-memory probe cannot prove live data untouched or real inner semantics; its diagnostic pass is never business/nine-system acceptance.',
      'No real model/embedding/channel/host reload is performed by this integration evidence.',
    ],
    derive: [
      { label: 'round6IntegrationStatus', path: 'artifacts/dsh/integration/round6-lead-integration.json', jsonPath: 'status' },
      { label: 'round6IntegrationTests', path: 'artifacts/dsh/integration/round6-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests.tests' },
    ],
  },
  {
    id: 'h7-round6-clean-artifacts',
    commits: ['c89d940'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: 'c89d940',
        blobCommit: 'c89d940',
        expectedSha256: 'e4ab6be069f6d4d4fb4dcc2546ae7814790018a01ae3787830f60caf8e270683',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: 'c89d940',
        blobCommit: 'c89d940',
        expectedSha256: 'fc05cdd0aa8e2e3b3d78c64bc120dd900bdef10ca062671adcc593e39e6a44ad',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: 'c89d940',
        blobCommit: 'c89d940',
        expectedSha256: 'a7ff35c09114b730f158e3b5a33b4869e05e4e87d74a299ad8e6fa5c6c7f269a',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round6 clean-VCS harness artifacts (X+1 of fc124d1, commit c89d940): clean-X manifest, traceability with 43 verified evidence sources and acceptance report (gate incomplete).',
    limitations: [
      'Tooling evidence only: artifacts prove clean-X recomputation/honesty, not product/host/model/business acceptance.',
      'Bound with blobCommit+expectedSha256 so later pipeline rewrites do not invalidate the committed snapshot; never read from the mutable worktree.',
      'executed=0/passed=0, product rows not_covered and the nine-system gate remains incomplete — this artifact source cannot upgrade V/S/FL or product rows.',
    ],
    derive: [{ label: 'round6CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  /* ---------------- round-7 failure / H3 runner / review evidence (H7-round8) ---------------- */
  {
    id: 'round7-host-bounded-core-goal-failure',
    commits: ['cc2e8d1'],
    files: [
      REF('artifacts/dsh/host/round7-bounded-core-goal.json', 'cc2e8d1'),
      REF('artifacts/dsh/host/round7/core-goal-validation-receipt.json', 'cc2e8d1'),
      REF('artifacts/dsh/host/round7/frozen-goal-state.json', 'cc2e8d1'),
      REF('artifacts/dsh/host/round7/round7-host-before.json', 'cc2e8d1'),
      REF('artifacts/dsh/host/round7/round7-host-after-reload.json', 'cc2e8d1'),
      REF('artifacts/dsh/host/round7/round7-host-after-run.json', 'cc2e8d1'),
    ],
    levels: ['fixed-host-failure-diagnostic'],
    scope: 'Round-7 fixed-host attempt of the bounded real core Goal validation: create failed with GOAL_OPERATION_UNKNOWN; receipt status=failed with 0 model requests, no Task/worker/verification/native completion, and disclosed partial side effects.',
    limitations: [
      'This is a FAILED fixed-host attempt / diagnostic evidence, NOT bounded-real-model success and NOT a business validation: create failed with GOAL_OPERATION_UNKNOWN; no core plan, Task, worker, verification or native Goal completion occurred; no model request was admitted (0 model calls), no retry happened, and provider usage/cost is unknown.',
      'A durable partial side effect exists despite the failure: an unauthorized/paused core Goal row plus a core Goal Session were created; the receipt incorrectly reported goal.created=false and the audit correction is recorded in this evidence; the inert partial Goal must be reconciled/cancelled by a later slice.',
      'No Task, Effect, budget reservation or artifact was created; tasks/effects shown in the receipt are pre-existing rows read for context.',
      'Real business chain, plan quality, Task/worker/verification and nine-system acceptance remain unverified; this failure can NEVER be counted as pass, V25, business or nine-system evidence.',
    ],
    derive: [
      { label: 'round7FailureStatus', path: 'artifacts/dsh/host/round7-bounded-core-goal.json', jsonPath: 'status' },
      { label: 'round7ReceiptStatus', path: 'artifacts/dsh/host/round7/core-goal-validation-receipt.json', jsonPath: 'status' },
      { label: 'round7FrozenAuthorized', path: 'artifacts/dsh/host/round7/frozen-goal-state.json', jsonPath: 'authorized' },
    ],
  },
  {
    id: 'h3-bounded-core-validation-runner',
    commits: ['9f841bd'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-bounded-core-validation.json',
        sliceCommit: '9f841bd',
        blobCommit: '9f841bd',
        expectedSha256: '1e1376b8f4d824ef85c2d812a84f15b19ad0ab311069bff01f2bbba9bbef4208',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-bounded-core-validation-integration.patch',
        sliceCommit: '9f841bd',
        blobCommit: '9f841bd',
        expectedSha256: '095c3a4504a1491d64e57881b728cc101685482eb8fa78c3d88210451cdc7383',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/h3-validation-verify.json',
        sliceCommit: '9f841bd',
        blobCommit: '9f841bd',
        expectedSha256: '33220049ae32241c372b81571dfcabb52c2be2b685a9294e13a3840471c8aec9',
      },
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: '9f841bd',
        blobCommit: '9f841bd',
        expectedSha256: '52fac4ff1c00ef1334da979e6a82771367c88c50667a1e12d652a31714740358',
      },
      {
        path: 'plugins/shiyu/tests/core-validation.test.ts',
        sliceCommit: '9f841bd',
        blobCommit: '9f841bd',
        expectedSha256: 'e41f56021897c72f2bb15bb878defce4438b8067669d690b1637f50c845e4fff',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H3 bounded real core Goal validation runner implementation: runner source + 16 focused tests + sliced evidence + integration patch; isolated full check 1531/1531 (baseline 1515 + 16).',
    limitations: [
      'Offline implementation/isolated verification only: real bounded core Goal host run was NOT executed by the implementer (Lead host kit); fixed-host attempt failed separately in round7-host-bounded-core-goal-failure with GOAL_OPERATION_UNKNOWN.',
      'The runner creates real Goal/Task/Effect/budget/Session/artifact and invokes real models when executed; it must run only when the runtime is idle and unpaused, receipts live in memory diagnostics and may be cleared by reload, and provider usage/cost may be unknown (never zero-fill).',
      '16 focused tests + 1531 isolated check cannot upgrade V25/full core/business or nine-system acceptance; failure evidence must never be counted as pass.',
    ],
    derive: [
      { label: 'h3ValidationIsolatedTests', path: 'artifacts/dsh/h3/h3-bounded-core-validation.json', jsonPath: 'verification.isolatedFullCheck.tests.tests' },
      { label: 'h3ValidationFocusedTests', path: 'artifacts/dsh/h3/h3-bounded-core-validation.json', jsonPath: 'verification.focused.tests' },
    ],
  },
  {
    id: 'round7-lead-integration',
    commits: ['183b649'],
    files: [
      REF('artifacts/dsh/integration/round7-lead-integration.json', '183b649'),
      REF('artifacts/dsh/slices/round7-integrated-verify.json', '183b649'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Lead round-7 integration of the bounded core Goal validation runner and diagnostics tool into Runtime/index: offline-verified integration plus isolated combined check 1539/1539; host execution/failure is recorded separately in round7-host-bounded-core-goal-failure.',
    limitations: [
      'G1 integration + isolated full check only: the real bounded business run is separate host evidence and FAILED (GOAL_OPERATION_UNKNOWN), never a pass.',
      'The runner is not read-only: it creates real Goal/Task/Effect/budget/Session/artifact and invokes real models; host execution must be idle/unpaused and receipts can be cleared by reload.',
      'Provider usage/cost may be unknown and must never be zero-filled; no V25/full core/business/nine-system acceptance.',
    ],
    derive: [
      { label: 'round7IntegrationStatus', path: 'artifacts/dsh/integration/round7-lead-integration.json', jsonPath: 'status' },
      { label: 'round7IntegrationTests', path: 'artifacts/dsh/integration/round7-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests.tests' },
    ],
  },
  {
    id: 'h7-round7-clean-artifacts',
    commits: ['cf87322'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: 'cf87322',
        blobCommit: 'cf87322',
        expectedSha256: '99948cb2d05b73a0f85a3eb82dc27b449d6e880a9456d022db59b66271125cc0',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: 'cf87322',
        blobCommit: 'cf87322',
        expectedSha256: 'd9ef264483b922d2e02369352daca9192d885f83cb8431adbd11bf4fde08b441',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: 'cf87322',
        blobCommit: 'cf87322',
        expectedSha256: 'c3bffa29ddf60a392cbea604d06832299899ef345ebf001d4c3d000095813315',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round7 clean-VCS harness artifacts (X+1 of 183b649, commit cf87322): clean-X manifest, traceability with 47 verified evidence sources and acceptance report (gate incomplete).',
    limitations: [
      'Tooling evidence only: artifacts prove clean-X recomputation/honesty, not product/host/model/business acceptance.',
      'Bound with blobCommit+expectedSha256 so later pipeline rewrites do not invalidate the committed snapshot; never read from the mutable worktree.',
      'executed=0/passed=0, product rows not_covered and gate incomplete — this source cannot upgrade V/S/FL or product rows.',
    ],
    derive: [{ label: 'round7CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round7-review',
    commits: ['ab62847'],
    files: [
      REF('artifacts/dsh/verify/round7-evidence-review.json', 'ab62847'),
      REF('artifacts/dsh/verify/ROUND7-EVIDENCE-REVIEW.md', 'ab62847'),
    ],
    levels: ['independent-review-info'],
    scope: 'Round-7 independent evidence review metadata (ROUND7-EVIDENCE-REVIEW.md + JSON): review scope/dispositions/F7 corrections.',
    limitations: [
      'Info/metadata only: this is an independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-8 reconcile evidence (H7-round9) ---------------- */
  {
    id: 'round8-host-core-validation-reconcile',
    commits: ['f10affc'],
    files: [
      REF('artifacts/dsh/host/round8-joint-reconcile.json', 'f10affc'),
      REF('artifacts/dsh/host/round8/reconcile-receipt.json', 'f10affc'),
      REF('artifacts/dsh/host/round8/round8-host-before.json', 'f10affc'),
      REF('artifacts/dsh/host/round8/round8-host-after-reload.json', 'f10affc'),
      REF('artifacts/dsh/host/round8/round8-host-after-run.json', 'f10affc'),
      REF('artifacts/dsh/host/round8/round8-host-final.json', 'f10affc'),
      REF('artifacts/dsh/host/round8/status-final.json', 'f10affc'),
    ],
    levels: ['fixed-host-zero-model-reconcile'],
    scope: 'Round-8 fixed-host zero-model reconcile of the residual round-7 core-validation Goal: classification inert-unauthorized, exactly one cancel with no retry, post-cancel readback and 58,375-byte status-final cache receipt.',
    limitations: [
      'This proves ONLY the reconcile/cancel path: it does not prove the bounded real core Goal business chain and does not fix the original create failure (GOAL_OPERATION_UNKNOWN); a future create would need a new explicit owner decision and newly frozen plan.',
      'Zero-model: no model/embedding/Task/worker/Effect/budget/artifact/Goal completion is involved; the residual Goal Session remains as history (not deleted).',
      'Live data invariant: only +1 commitSeq, no events/deliveries, no new/removed sessions or Goals, state file unchanged; classification inert-unauthorized, postCancel cancelled=true/paused=true/version=2, cancelAttempts=1.',
      'readOnly=true, createsGoal=false, modelCalls=0 and retries=0 are declared on the tool response and committed in the reconcile receipt file and are NOT stored in the diagnostics cache entry; cache-field/receipt consistency is explicitly recorded.',
      'Reconcile/failure evidence can NEVER be counted as pass/V25/business/nine-system evidence; real business chain remains unverified.',
    ],
    derive: [
      { label: 'round8ReconcileStatus', path: 'artifacts/dsh/host/round8-joint-reconcile.json', jsonPath: 'status' },
      { label: 'round8ReconcileClassification', path: 'artifacts/dsh/host/round8/reconcile-receipt.json', jsonPath: 'classification' },
      { label: 'round8ReconcileModelCalls', path: 'artifacts/dsh/host/round8/reconcile-receipt.json', jsonPath: 'modelCalls' },
    ],
  },
  {
    id: 'h3-core-validation-reconcile',
    commits: ['5f9ac00'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-core-validation-reconcile.json',
        sliceCommit: '5f9ac00',
        blobCommit: '5f9ac00',
        expectedSha256: 'f5204668fd1d7a2ac0333982c7c8880511a14e832d25b72cdfaa80d051b874b0',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-core-validation-reconcile-integration.patch',
        sliceCommit: '5f9ac00',
        blobCommit: '5f9ac00',
        expectedSha256: 'd2dac5b8632a1a7340883632a3002c6c27c7233cf7f4c681709eb3d32b7a41f4',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/h3-reconcile-verify.json',
        sliceCommit: '5f9ac00',
        blobCommit: '5f9ac00',
        expectedSha256: 'a0457375ff8487464348eb57f08af72555ab9e3329e56bbaf4f2d4a85495c382',
      },
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: '5f9ac00',
        blobCommit: '5f9ac00',
        expectedSha256: '26899a3207538dd39f16610bcb83c8f975a34634dc5ae564d040c93d6cf658c7',
      },
      {
        path: 'plugins/shiyu/tests/core-validation.test.ts',
        sliceCommit: '5f9ac00',
        blobCommit: '5f9ac00',
        expectedSha256: '939775a0f76e6dec998d418bab9c26004d3e03c80df5b7758a26ff829d1c3f85',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H3 F7-R1 readback/reconcile implementation: exact diff + source + 29 focused tests + sliced evidence; isolated full check 1552/1552 (baseline 1539 + 13 net reconcile tests).',
    limitations: [
      'Offline implementation/isolated verification only: the real host reconcile was NOT executed by the implementer (Lead kit); fixed-host reconcile is separate evidence in round8-host-core-validation-reconcile.',
      'Reconcile only classifies/cancels the inert residual Goal; it does not retry creation, start a new bounded validation or fix the original GOAL_OPERATION_UNKNOWN; the residual Session is retained.',
      'Readback depends on the core domain; otherwise unknown and nothing is written. 29 tests/1552 isolated check cannot upgrade V25/full core/business/nine-system acceptance.',
    ],
    derive: [
      { label: 'h3ReconcileIsolatedTests', path: 'artifacts/dsh/h3/h3-core-validation-reconcile.json', jsonPath: 'verification.isolatedFullCheck.tests.tests' },
      { label: 'h3ReconcileFocusedTests', path: 'artifacts/dsh/h3/h3-core-validation-reconcile.json', jsonPath: 'verification.focused.tests' },
    ],
  },
  {
    id: 'round8-lead-integration',
    commits: ['7c0b22a'],
    files: [
      REF('artifacts/dsh/integration/round8-lead-integration.json', '7c0b22a'),
      REF('artifacts/dsh/slices/round8-integrated-verify.json', '7c0b22a'),
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Lead round-8 integration of the core-validation Goal reconcile command/tool into Runtime/index: offline-verified integration + isolated combined check 1561/1561; host reconcile is separate evidence.',
    limitations: [
      'G1 integration + isolated full check only: host reconcile is separate fixed-host zero-model evidence; no business chain is validated.',
      'Reconcile only classifies/optionally cancels the inert residual Goal; it does not retry creation/start a new validation; readback unknown writes nothing; residual Session retained.',
      'No real model/embedding/business acceptance; cannot upgrade V25/full core/nine-system.',
    ],
    derive: [
      { label: 'round8IntegrationStatus', path: 'artifacts/dsh/integration/round8-lead-integration.json', jsonPath: 'status' },
      { label: 'round8IntegrationTests', path: 'artifacts/dsh/integration/round8-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests.tests' },
    ],
  },
  {
    id: 'h7-round8-clean-artifacts',
    commits: ['f766ab7'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: 'f766ab7',
        blobCommit: 'f766ab7',
        expectedSha256: '6ef13f680e48d268e18ce6a022ddbd4feab9d6d18c8c597dc6fb7c7aec9a562b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: 'f766ab7',
        blobCommit: 'f766ab7',
        expectedSha256: 'bdee819c0018feaf0ce5e9a6c4aee2d96050830a8f546a06f80eda44bcce1672',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: 'f766ab7',
        blobCommit: 'f766ab7',
        expectedSha256: 'c0719e83f63b7eea1de938c444c45e2df2e040560367a516d905d63e05ca2462',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round8 clean-VCS harness artifacts (X+1 of 7c0b22a, commit f766ab7): clean-X manifest, traceability with 52 verified evidence sources and acceptance report (gate incomplete).',
    limitations: [
      'Tooling evidence only: not product/host/model/business acceptance.',
      'Bound with blobCommit+expectedSha256; never read from mutable worktree; later pipeline rewrites do not affect the committed snapshot.',
      'executed=0/passed=0, product rows not_covered, gate incomplete; cannot upgrade V/S/FL or product rows.',
    ],
    derive: [{ label: 'round8CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round8-review',
    commits: ['80e2867'],
    files: [
      REF('artifacts/dsh/verify/round8-evidence-review.json', '80e2867'),
      REF('artifacts/dsh/verify/ROUND8-EVIDENCE-REVIEW.md', '80e2867'),
    ],
    levels: ['independent-review-info'],
    scope: 'Round-8 independent evidence review metadata (ROUND8-EVIDENCE-REVIEW.md + JSON): review scope/dispositions/F8 corrections.',
    limitations: [
      'Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-10 v2 failure / activation evidence (H7-round11) ---------------- */
  {
    id: 'round10-host-v2-create-failure',
    commits: ['6d65135', 'fffa269'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10-bounded-core-goal-v2.json',
        sliceCommit: '6d65135',
        blobCommit: 'fffa269',
        expectedSha256: 'f3b763c01c6f2578c619fa4eb15fa094c4d556bdec8b8e02617be0d73db19791',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10/core-goal-v2-receipt.json',
        sliceCommit: '6d65135',
        blobCommit: '6d65135',
        expectedSha256: '734e1b015f1a507a9acfca6226b30342bd303b2efffa4917a4bfa2df440af38a',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10/plan.json',
        sliceCommit: 'fffa269',
        blobCommit: 'fffa269',
        expectedSha256: 'c6be8da1bcbae6bf3886bf954b1b999209e45052af4c0068d69349f72b6843f3',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10/round10-host-before.json',
        sliceCommit: '6d65135',
        blobCommit: '6d65135',
        expectedSha256: '0dbfef6c3371b83425690cd752fb71597192154fa5e926d262c8a857b4f51d76',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10/round10-host-after-reload.json',
        sliceCommit: '6d65135',
        blobCommit: '6d65135',
        expectedSha256: '1ad7f718990bea2dc529bfaccccf529e43f187230a407f73ab4ad2111a1d8481',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10/round10-host-after-run.json',
        sliceCommit: '6d65135',
        blobCommit: '6d65135',
        expectedSha256: '04beb98e5ee7cc9d1936d8d9746ad82514a3f9705fdc1f5a547b9b6688aba8ee',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10/round10-host-final.json',
        sliceCommit: '6d65135',
        blobCommit: '6d65135',
        expectedSha256: '758db4bbfebe2c288c000f1298bd2c6eb59d403b2059a42bb36655995af25bac',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10/status-final.json',
        sliceCommit: '6d65135',
        blobCommit: '6d65135',
        expectedSha256: '27805dd53765c27534d9d0f91cdfb6a887b7f2356c4a3df0d331730ec515e616',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round10/v2-goal-observation.json',
        sliceCommit: '6d65135',
        blobCommit: '6d65135',
        expectedSha256: '07e0879fd6fb14a2e2c90205dd8883ffb4e1f98740328be425948099b62550d6',
      },
    ],
    levels: ['fixed-host-failure-diagnostic'],
    scope: 'Round-10 fixed-host v2 bounded core Goal attempt: create failed at the same history-assert stage as v1 with NATIVE_HISTORY_CHANGED; receipt status=failed, evaluateAttempts=0, zero model requests, partial v2 Goal+Session, journal unknown, no Task/Effect/budget/artifact.',
    limitations: [
      'FAILED v2 attempt, not bounded-real-model success and NOT business/plan/Task/worker/verification/native acceptance: v2 create failed on history-assert / NATIVE_HISTORY_CHANGED; evaluateAttempts=0, 0 model requests, no retry, no Task/Effect/budget/artifact or native completion.',
      'Partial side effect: an unauthorized/paused v2 Goal (requestId core-validation-frozen-v2) plus one core Goal Session were created; the create command journal is unknown with the same reason; the residual v2 Goal remains unresolved (current reconcile tool is v1-only).',
      'A third attempt is NOT authorized until history-assert semantics are instrumented/fixed; the same-stage two-attempt failure is disclosed. Real business chain remains unverified.',
      'This fail-diagnostic evidence can NEVER be counted as pass, V25, business or nine-system acceptance; the host v2 activation itself is separate offline evidence.',
    ],
    derive: [
      { label: 'round10V2Status', path: 'artifacts/dsh/host/round10-bounded-core-goal-v2.json', jsonPath: 'status' },
      { label: 'round10V2ReceiptStatus', path: 'artifacts/dsh/host/round10/core-goal-v2-receipt.json', jsonPath: 'status' },
      { label: 'round10V2EvaluateAttempts', path: 'artifacts/dsh/host/round10/core-goal-v2-receipt.json', jsonPath: 'counters.evaluateAttempts' },
    ],
  },
  {
    id: 'v2-experiment-activation',
    commits: ['b09416f', 'fffa269'],
    files: [
      {
        path: 'plugins/shiyu/src/index.ts',
        sliceCommit: 'b09416f',
        blobCommit: 'b09416f',
        expectedSha256: '688288102c0d650654dd3a85654dec81faf80ed862faeb2862a293ec3b97c145',
      },
      {
        path: 'plugins/shiyu/src/runtime.ts',
        sliceCommit: 'b09416f',
        blobCommit: 'b09416f',
        expectedSha256: '41c4a5ecc9d9ea17e250fc51f6d7eeb990f7a93bd1e6ea9196ab807daad2bd33',
      },
      {
        path: 'plugins/shiyu/tests/host-diagnostics-tool.test.ts',
        sliceCommit: 'b09416f',
        blobCommit: 'b09416f',
        expectedSha256: '96008d5ad7474c7efd7c2f7f90877971b61bab0bf8c5213a4a4bf4d8b43138b6',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/integration/round10-v2-activation.json',
        sliceCommit: 'b09416f',
        blobCommit: 'fffa269',
        expectedSha256: '647822145d66b23df8989e615dcd0b1151b9927132e629ad4279cb34ab69433b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/round10-v2-activation-verify.json',
        sliceCommit: 'b09416f',
        blobCommit: 'fffa269',
        expectedSha256: '2c19b080eb2cda7dd98bd1050df361cc9495edb6fb32128a979e5c41c92a6991',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'V2 core-validation experiment activation behind a new owner-only tool: runtime/index command+tool, output schema fix and isolated activation verify (1583/1583) against final X tree; real host v2 attempt is separate and FAILED.',
    limitations: [
      'Offline/isolated activation only (G1 integration + 1583/1583 isolated check): it proves the owner-only v2 command/tool wiring and output schema, not real bounded business success.',
      'The fixed-host v2 attempt then FAILED at history-assert/NATIVE_HISTORY_CHANGED with partial v2 Goal+Session and 0 model requests (see round10-host-v2-create-failure); activation must never be reported as a successful v2 run.',
      'Third attempt not authorized; real business chain/V25/nine-system remain unverified; no real model/embedding call in this activation evidence.',
    ],
    derive: [
      { label: 'v2ActivationStatus', path: 'artifacts/dsh/integration/round10-v2-activation.json', jsonPath: 'status' },
      { label: 'v2ActivationTests', path: 'artifacts/dsh/integration/round10-v2-activation.json', jsonPath: 'verification.leadIsolatedCheck.tests.tests' },
    ],
  },
  {
    id: 'h7-round10-clean-artifacts',
    commits: ['b5bc3cc'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: 'b5bc3cc',
        blobCommit: 'b5bc3cc',
        expectedSha256: '34c7d1006856f537b2581ef4e0407b2b6eca45e9fb3536c0a8ced67e357db53d',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: 'b5bc3cc',
        blobCommit: 'b5bc3cc',
        expectedSha256: 'df5959d59adfa732d6010583f66cd5083971e5832f36392c245877784daff0ca',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: 'b5bc3cc',
        blobCommit: 'b5bc3cc',
        expectedSha256: 'dfca3f70a781a01f986e4b2e748d0aad5135c4b6e431a1e6c3cfd546a89bcb46',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round10 clean-VCS harness artifacts (X+1 of b09416f, commit b5bc3cc): clean-X manifest, traceability with 57 verified evidence sources and acceptance report (gate incomplete).',
    limitations: [
      'Tooling evidence only: not product/host/model/business acceptance.',
      'Bound with blobCommit+expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from mutable worktree.',
      'executed=0/passed=0, product rows not_covered and gate incomplete; cannot upgrade V/S/FL or product rows.',
    ],
    derive: [{ label: 'round10CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round10-review',
    commits: ['fffa269'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/round10-evidence-review.json',
        sliceCommit: 'fffa269',
        blobCommit: 'fffa269',
        expectedSha256: '9e6cf9b07c068e1d9f5885e19e87196da95439fc70792ee2fda1efa36eaaa265',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/ROUND10-EVIDENCE-REVIEW.md',
        sliceCommit: 'fffa269',
        blobCommit: 'fffa269',
        expectedSha256: 'ae39959b7a7c3df3204e9d9e2da96bd0942cd62af39551fcec15cfe2f2a31b47',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-10 independent evidence review metadata plus F10 corrections/dispositions.',
    limitations: [
      'Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-11 history-assert diagnostics / reconcile evidence (H7-round12) ---------------- */
  {
    id: 'history-assert-diagnostics',
    commits: ['196024a'],
    files: [
      {
        path: 'plugins/shiyu/src/adapters/dsh/native-context.ts',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: '2a882e63e2a5790e8ced2bb163acfd4c4c932346cde7968d2598f37eeb8567f1',
      },
      {
        path: 'plugins/shiyu/src/adapters/dsh/goals.ts',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: '060e746f2f83aaf936073f56325690dbbf7d86b36d153a17320e38e8e631601a',
      },
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: 'ed4c1e42575e9365c69e3bd1160618c10d4d72e032e3fac43ca044c7f323d942',
      },
      {
        path: 'plugins/shiyu/tests/core-validation.test.ts',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: 'dddb8e49fb2ec409c3bfd57d416d47bcbc32be700aa44367ae51778708d274e0',
      },
      {
        path: 'plugins/shiyu/tests/core-event-tools.test.ts',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: '95d5878318fad97a64a43f9f2a57575e59c5912b71ab987c552876fae33cf180',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-history-assert-diagnosis.json',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: 'b2e94bd3a2c767782b2441f4777c0ad4bbcecd9a01a7b82cdd6afe590908bf38',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/h3-hist-assert-verify.json',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: 'a26bca923858f24af67ee4e0ecf41eddbe91a9c083d3f5f0d7fe477086d4a686',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-11 bounded history-assert diagnostic instrument: controlled mismatchKind/expected/live/delta facts (hash prefixes only, <=300 chars) for NATIVE_HISTORY_CHANGED, surfaced through GoalOperationUnknownError.diagnostic, the bounded-runner create-failure receipt and an independent validator; fake-host classification covers cold-header/live-seq-vs-event-count, append, header-hash, inherited-count, session-id/preset, references and projection; dormant create-only liveCut candidate verified at unit level; 14 net-new tests; isolated check 1597/1597.',
    limitations: [
      'Offline/isolated instrumentation only: the implementer ran no real model or host. The cold-header candidate (cold eventCount includes the Session header while live seq excludes it) is strongly supported by fake-host reproduction at expected.eventCount 4 / live.seq 3 / delta -1 but is NOT host-confirmed.',
      'The create-only liveCut candidate fix is DORMANT/not activated: product create behavior is unchanged, v1/v2 create were not retried, and a result can only be obtained from a next host instrumented run or a new explicit owner-decided attempt.',
      'This diagnostic evidence can NEVER be counted as pass, V25, business or nine-system acceptance; it does not fix the create history-assert failure and does not prove the real host header/cut semantics.',
      'The diagnostic payload is bounded to <=300 characters with hash prefixes only: no event body, message text, inbox content or filesystem path.',
    ],
    derive: [
      { label: 'round11HistoryDiagnosisStatus', path: 'artifacts/dsh/h3/h3-history-assert-diagnosis.json', jsonPath: 'status' },
      { label: 'round11HistoryDiagnosisNetNewTests', path: 'artifacts/dsh/h3/h3-history-assert-diagnosis.json', jsonPath: 'tests.netNew' },
      { label: 'round11HistoryDiagnosisIsolatedTests', path: 'artifacts/dsh/h3/h3-history-assert-diagnosis.json', jsonPath: 'verification.isolatedFullCheck.tests.tests' },
    ],
  },
  {
    id: 'v1v2-reconcile-generalization',
    commits: ['196024a', 'fe6d5f7'],
    files: [
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: 'ed4c1e42575e9365c69e3bd1160618c10d4d72e032e3fac43ca044c7f323d942',
      },
      {
        path: 'plugins/shiyu/tests/core-validation.test.ts',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: 'dddb8e49fb2ec409c3bfd57d416d47bcbc32be700aa44367ae51778708d274e0',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-history-assert-reconcile-integration.patch',
        sliceCommit: '196024a',
        blobCommit: '196024a',
        expectedSha256: 'fd7a2278dd753a48e391b394721ba5495f192764dca56f1e0f6242160d64e7e7',
      },
      {
        path: 'plugins/shiyu/src/index.ts',
        sliceCommit: 'fe6d5f7',
        blobCommit: 'fe6d5f7',
        expectedSha256: 'd09cfa6cdfeadabb9006ea5efcb1196c319a88e26ed057ffb1eb56c31672e59c',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Generalized core-validation Goal reconcile: fixed code-constant targets [core-validation-frozen-v1, core-validation-frozen-v2] that the caller cannot select/override; per target read-only classification (absent/inert-unauthorized/paused-authorized/cancelled/unknown), at most one explicit cancel only for an inert-unauthorized residual Goal, postCancel readback, 0 retries, 0 model calls, no Goal creation; v1-compatible top-level fields plus targets[]; Lead integration needs only the owner tool-description update because the runtime command already caches the whole object.',
    limitations: [
      'Fixed code-constant target order is [core-validation-frozen-v1, core-validation-frozen-v2]; the caller cannot select/override requestIds and arbitrary keys are rejected; v1 top-level fields remain compatible while targets[] carries both. Per target: read-only classification, at most one explicit cancel only for inert-unauthorized, postCancel readback, 0 retries, 0 model calls, no Goal creation.',
      'Offline module + isolated integration evidence only (core-validation focused 40/40; round-11 integrated isolated check 1605/1605): the fixed-host reconcile call is separate evidence and this source cannot prove a real business chain.',
      'Generalized reconcile only classifies and at most cancels inert residual Goals; it NEVER creates/retries an experiment and does NOT fix the v1/v2 create history-assert failure.',
      'A third bounded experiment remains unauthorized and requires an explicit owner decision plus a new frozen requestId/template; caller-supplied requestIds are rejected.',
      'Never pass/V25/business/nine-system: zero model/embedding/host run in this offline source.',
    ],
  },
  {
    id: 'round11-lead-integration',
    commits: ['fe6d5f7'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/integration/round11-lead-integration.json',
        sliceCommit: 'fe6d5f7',
        blobCommit: 'fe6d5f7',
        expectedSha256: '72105e708437dea3cbcac8fc228903f4ef61fc36751aa16e20a1a54e74310a6a',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/round11-integrated-verify.json',
        sliceCommit: 'fe6d5f7',
        blobCommit: 'fe6d5f7',
        expectedSha256: 'ff59dbe9c7a361c328a66de0e68ea58c233a3fcba64b111bbe7bca67d7c94060',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-11 Lead integration on X=fe6d5f7 of the history-assert diagnostics and generalized v1/v2 reconcile: owner tool-description wiring, integration evidence and an isolated full check of 1605/1605 (1583 baseline + 14 diagnostic/reconcile + 8 H7-round11).',
    limitations: [
      'Integration + isolated check only: 0 real model calls, 0 embedding calls and 0 host reloads in this integration source; the fixed-host reconcile evidence is separate.',
      'Never pass/V25/business/nine-system; the third bounded experiment remains unauthorized and the create history-assert failure remains unfixed.',
    ],
    derive: [
      { label: 'round11LeadIntegrationStatus', path: 'artifacts/dsh/integration/round11-lead-integration.json', jsonPath: 'status' },
      { label: 'round11LeadIntegrationTests', path: 'artifacts/dsh/integration/round11-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests' },
      { label: 'round11LeadIntegrationExitCode', path: 'artifacts/dsh/integration/round11-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.exitCode' },
    ],
  },
  {
    id: 'round11-host-v1v2-reconcile',
    commits: ['7d9979e', 'a29dd29'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round11-joint-reconcile-v1v2.json',
        sliceCommit: '7d9979e',
        blobCommit: 'a29dd29',
        expectedSha256: '063490c650a8b867dc1d0dee42804738115418267c853178c42fe3109ff5989d',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round11/plan.json',
        sliceCommit: '7d9979e',
        blobCommit: '7d9979e',
        expectedSha256: '8733779142627a28c94f66ac293e55899cdd736afe7e3664f7c1e52afc0350c5',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round11/reconcile-v1v2-receipt.json',
        sliceCommit: '7d9979e',
        blobCommit: '7d9979e',
        expectedSha256: '0a6ea978553aa83959b5841afb07e594595496847a7a922fef1e654d71777a14',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round11/round11-host-before.json',
        sliceCommit: '7d9979e',
        blobCommit: '7d9979e',
        expectedSha256: '223c9279208ca8a4d8bed3f625e82a9212f3e55bf2accbcaf5d31d9c962a886e',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round11/round11-host-after-reload.json',
        sliceCommit: '7d9979e',
        blobCommit: '7d9979e',
        expectedSha256: '2a29ff1a8a7c735648e768f4c46f4929f8a30c618fffccf29774ce6e14cdc0ed',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round11/round11-host-after-run.json',
        sliceCommit: '7d9979e',
        blobCommit: '7d9979e',
        expectedSha256: '27d52f8beee2bb99957ccf9f650e8a327bda94bfbb58231be3c6168493ba4943',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round11/round11-host-final.json',
        sliceCommit: '7d9979e',
        blobCommit: '7d9979e',
        expectedSha256: '72ac438d7e6ca3d1f0229e4a477d0f0512a059f93af4a1229396940a492371da',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round11/status-final.json',
        sliceCommit: '7d9979e',
        blobCommit: '7d9979e',
        expectedSha256: '3b59525954139c07db64fe51088dc6535062b1c2380a6104f8f081b6175d9c8b',
      },
    ],
    levels: ['fixed-host-zero-model-reconcile'],
    scope: 'Round-11 fixed-host generalized zero-model reconcile call on the installed X=fe6d5f7 build (dist 113 files, digest fce8d047...): fixed targets [v1,v2]; v1 was already cancelled and received no action; v2 was inert-unauthorized and received exactly one cancel (postCancel cancelled=true, paused=true, version=2); both readbacks complete, no unknowns; runtime invariants: exactly +1 commitSeq for the v2 cancel, no events, no Goal/Task/Effect/budget/Session/artifact change and unchanged state file; the 61122-byte final status caches the receipt.',
    limitations: [
      'Zero-model reconcile only, NOT a bounded-real-model/business/complete/passed run: v1 cancelled with no action; v2 inert-unauthorized with exactly one cancel and postCancel version 2; 0 model calls, 0 retries, 0 Goal creations, 0 Task/Effect/budget/artifact; only +1 commitSeq and no state-file change.',
      'It does not fix the v1/v2 create history-assert failure: the cold-header root-cause candidate is NOT host-confirmed and the liveCut fix remains inactive; this call exercised only the reconcile path.',
      'The final status call is read-only and caches the reconcile receipt (61122 bytes, fields present per the cached snapshot; readOnly/createsGoal/modelCalls/retries are declared in the receipt file); it is a diagnostics cache, not a product UI/render acceptance.',
      'A third bounded experiment is NOT authorized and requires an explicit owner decision after the diagnostic fix is activated and host-confirmed. This evidence can NEVER be pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'round11ReconcileStatus', path: 'artifacts/dsh/host/round11-joint-reconcile-v1v2.json', jsonPath: 'status' },
      { label: 'round11V1Classification', path: 'artifacts/dsh/host/round11-joint-reconcile-v1v2.json', jsonPath: 'targets.0.classification' },
      { label: 'round11V1CancelAttempts', path: 'artifacts/dsh/host/round11-joint-reconcile-v1v2.json', jsonPath: 'targets.0.cancelAttempts' },
      { label: 'round11V2Classification', path: 'artifacts/dsh/host/round11-joint-reconcile-v1v2.json', jsonPath: 'targets.1.classification' },
      { label: 'round11V2CancelAttempts', path: 'artifacts/dsh/host/round11-joint-reconcile-v1v2.json', jsonPath: 'targets.1.cancelAttempts' },
      { label: 'round11V2PostCancelVersion', path: 'artifacts/dsh/host/round11-joint-reconcile-v1v2.json', jsonPath: 'targets.1.postCancel.version' },
      { label: 'round11ReconcileModelCalls', path: 'artifacts/dsh/host/round11-joint-reconcile-v1v2.json', jsonPath: 'modelCalls' },
    ],
  },
  {
    id: 'h7-round11-clean-artifacts',
    commits: ['7ad2621'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: '7ad2621',
        blobCommit: '7ad2621',
        expectedSha256: '27401364c723eba40fc6baf43459a6a4bc186b5863cfefa360df44127a7ce538',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: '7ad2621',
        blobCommit: '7ad2621',
        expectedSha256: '592c9bd8875e2062883984f22dceabac21d1a5da8889d2133da7aa18d18b3339',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: '7ad2621',
        blobCommit: '7ad2621',
        expectedSha256: '37e292861b94e6a6779cac1887e0fd85f304ffe00e0cd53842a99b6c28228559',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round11 clean-VCS harness artifacts (X+1 of fe6d5f7, commit 7ad2621): clean-X manifest (vcs head fe6d5f7, dirty=false, 404 files), traceability with 61 verified evidence sources/198 files and acceptance report (gate incomplete, executed=passed=0, product 79/79 not_covered).',
    limitations: [
      'Tooling evidence only: not product/host/model/business acceptance; product rows remain not_covered and the gate incomplete.',
      'Bound with blobCommit=7ad2621 + expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from the mutable worktree.',
      'Cannot upgrade V/S/FL/product rows or the nine-system gate.',
    ],
    derive: [{ label: 'round11CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round11-review',
    commits: ['a29dd29'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/round11-evidence-review.json',
        sliceCommit: 'a29dd29',
        blobCommit: 'a29dd29',
        expectedSha256: 'eb18a4fecf66e82554e57f8e80b7473dfb54fe58c9c29449ae3328f6fb65a391',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/ROUND11-EVIDENCE-REVIEW.md',
        sliceCommit: 'a29dd29',
        blobCommit: 'a29dd29',
        expectedSha256: '98dec4cb4c5cc385cfef724ca92e022f0d56e7ba981c6a99480c28f911d89d92',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-11 independent evidence review metadata plus F11 corrections/dispositions (F11-R1 cached bytes corrected to actual 61122 with semantics; F11-R2 cachedReceipt fields reworded; F11-R3 reload-delta wording; F11-R4 merge info-only).',
    limitations: [
      'Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-12 v3 cold-cut failure / cleanup / review evidence (H7-round13) ---------------- */
  {
    id: 'cold-cut-v3-activation',
    commits: ['ccefc57'],
    files: [
      {
        path: 'plugins/shiyu/src/adapters/dsh/goals.ts',
        sliceCommit: 'ccefc57',
        blobCommit: 'ccefc57',
        expectedSha256: 'a9e38eb5bd6561474f0d01b9f0004e396db0b3dc4822b6189c97218806ef1853',
      },
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: 'ccefc57',
        blobCommit: 'ccefc57',
        expectedSha256: 'a70a8ca018dd7d6dcb606e96a8572ce4b4b4ffa34794b0adaf42e13766ce31d3',
      },
      {
        path: 'plugins/shiyu/tests/core-event-tools.test.ts',
        sliceCommit: 'ccefc57',
        blobCommit: 'ccefc57',
        expectedSha256: '9ef3d5f797c299638dd3f8d2d5c034b052cd3c925df538988fd64cd3a4b1a665',
      },
      {
        path: 'plugins/shiyu/tests/core-validation.test.ts',
        sliceCommit: 'ccefc57',
        blobCommit: 'ccefc57',
        expectedSha256: 'c53ff800cfe8e76d848ac8cd0d6b81d2268a8e820fb7884952e0050a2b49a261',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-v3-livecut-activation.json',
        sliceCommit: 'ccefc57',
        blobCommit: 'ccefc57',
        expectedSha256: 'd6f6da7bf6c164d671d40e56771b26d076e5bf146a3b5207a2fea784243afc19',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-v3-runtime-index.patch',
        sliceCommit: 'ccefc57',
        blobCommit: 'ccefc57',
        expectedSha256: '3dcefda41c627ce03ae6f65ce6a3d1719dd5a4f28500c4a2709aa08a9f11b4f3',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/h3-v3-livecut-verify.json',
        sliceCommit: 'ccefc57',
        blobCommit: 'ccefc57',
        expectedSha256: '3dd6eb2292332b948d9d0ebb47b0925a019013060a5fc0c7afcf5bf52dfa52df',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-12 create-only cold-history-cut activation: GoalSessionAdapter.stabilizeCoreCreateBaseline passes { liveCut: "seq-excluding-header" } to observe/assert only for new-Session create (the cold snapshot subtracts a leading header record from the expected live session.seq); recovery/resume and every expectedPrefix path keep strict event-count semantics; native goals().create is still invoked exactly once and never replayed; frozen v3 experiment is exact-constant-only and the generalized reconcile covers fixed [v1,v2,v3] targets; fake-host focused 95/95 + regression 101/101 (net +8 tests) and isolated full check 1613/1613.',
    limitations: [
      'Offline/fake-host activation only: the implementer ran no real host/model; the cut alignment is a host-candidate, not host-confirmed, and over/under-correction would only surface in a real receipt historyDiagnostic.',
      'Create-only scope: recovery/resume and expectedPrefix strict semantics are unchanged; native create is still once with no retry. The runtime/index patch was provided but not applied in the implementer workspace (Lead integration is separate evidence).',
      'The third real v3 attempt FAILED separately at header-hash (see round12-host-v3-create-failure): this activation evidence must never be reported as a successful v3 run, pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'v3ActivationStatus', path: 'artifacts/dsh/h3/h3-v3-livecut-activation.json', jsonPath: 'status' },
      { label: 'v3ActivationNetNewTests', path: 'artifacts/dsh/h3/h3-v3-livecut-activation.json', jsonPath: 'tests.netNew' },
      { label: 'v3ActivationIsolatedTests', path: 'artifacts/dsh/h3/h3-v3-livecut-activation.json', jsonPath: 'verification.isolatedFullCheck.tests.tests' },
    ],
  },
  {
    id: 'round12-lead-integration',
    commits: ['68b1caf'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/integration/round12-lead-integration.json',
        sliceCommit: '68b1caf',
        blobCommit: '390346d',
        expectedSha256: '9bdab41b47ebe0f99596065eac50a1a1268ca0c4e7a10ff1fca29ec5a2620752',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/round12-integrated-verify.json',
        sliceCommit: '68b1caf',
        blobCommit: '68b1caf',
        expectedSha256: 'c88e19616e6a51dbae4cab231d1c8275b9ebb260b61119db5cd3a16983e1b7d1',
      },
      {
        path: 'plugins/shiyu/src/runtime.ts',
        sliceCommit: '68b1caf',
        blobCommit: '68b1caf',
        expectedSha256: 'd64766e5285b86080bc614e3dfad5c8fb5e95f76107175f47b4698d224afab2b',
      },
      {
        path: 'plugins/shiyu/src/index.ts',
        sliceCommit: '68b1caf',
        blobCommit: '68b1caf',
        expectedSha256: '3b1a404040b1e31e2bb7a139a9dd50ccbf2310c67360ef00153eda30892b64a8',
      },
      {
        path: 'plugins/shiyu/tests/host-diagnostics-tool.test.ts',
        sliceCommit: '68b1caf',
        blobCommit: '68b1caf',
        expectedSha256: 'b0d36da1e163065e409d339f7a56baf6bd8861f7d51d1ecd7e40e9746e49390e',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-12 Lead integration of the cold-cut fix, v3 experiment owner surface and general reconcile targets on X=68b1caf: runtime.probe-core-goal-v3 and shiyu_validate_core_goal_v3 wired around the existing bounded runner with only the exact frozen v3 constant; reconcile covers fixed [v1,v2,v3]; isolated integrated check 1623/1623 (1605 baseline + 8 cold-cut/v3 + 9 H7-round12 + 1 v3 tool test).',
    limitations: [
      'Integration + isolated check only: 0 real model calls, 0 embedding calls and 0 host reloads in this integration source; the third v3 real attempt is separate evidence and FAILED.',
      'F12-R1 note: the isolated verification artifact listed the pre-final h7-round12-slice.json (4,799B WIP snapshot); the final X file is 6,690B/sha fb04c010... and the X+1 clean refresh (1623/1623, 67/67 sources) binds the final file; no code/test failure.',
      'Never pass/V25/business/nine-system; a fourth bounded experiment remains unauthorized.',
    ],
    derive: [
      { label: 'round12IntegrationStatus', path: 'artifacts/dsh/integration/round12-lead-integration.json', jsonPath: 'status' },
      { label: 'round12IntegrationTests', path: 'artifacts/dsh/integration/round12-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests' },
      { label: 'round12IntegrationExitCode', path: 'artifacts/dsh/integration/round12-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.exitCode' },
    ],
  },
  {
    id: 'h7-round12-clean-artifacts',
    commits: ['1113662'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: '1113662',
        blobCommit: '1113662',
        expectedSha256: 'e14d6bde3082ba8528669c79fd60b6db366e64b3a99a2ed00c93ccae8640effc',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: '1113662',
        blobCommit: '1113662',
        expectedSha256: '42c53bc65307e0741c9a5b8aa27b53b2d6c0077b58d6bee4f99465da7a0b1763',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: '1113662',
        blobCommit: '1113662',
        expectedSha256: '52c6bd100223f25f1a87cab791457059c588d6165992e5a5cb853a191e280072',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round12 clean-VCS harness artifacts (X+1 of 68b1caf, commit 1113662): clean-X manifest (vcs head 68b1caf, dirty=false, 404 files), traceability with 67 verified evidence sources/224 files and acceptance report (gate incomplete, executed=passed=0, product 79/79 not_covered).',
    limitations: [
      'Tooling evidence only: not product/host/model/business acceptance; product rows remain not_covered and the gate incomplete.',
      'Bound with blobCommit=1113662 + expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from the mutable worktree.',
      'Cannot upgrade V/S/FL/product rows or the nine-system gate.',
    ],
    derive: [{ label: 'round12CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round12-host-v3-create-failure',
    commits: ['31e5c05', '390346d'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12-bounded-core-goal-v3.json',
        sliceCommit: '31e5c05',
        blobCommit: '390346d',
        expectedSha256: 'ffb0a1998cab6a3c733b79638e854bd6a9b3b82b1917530595d451b51575ed9b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/core-goal-v3-receipt.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: '7eefe41d67be12005ed19e0c75141fcc249bc19d9b90c8c034f191e91535c143',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/plan.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: 'b9393d6bf14856b894bbd035ec44b1d46c36de46136af10fd4f88576b672647a',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/status-final.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: 'e727ffcc5c5d30d2485347b8314784f0f7cf378547e758e9ec6b8078615bac31',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/v3-goal-observation.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: '6164c848a762d1ae66a8f6cf34cb553c172e171804674e1766e09148d2c6fa65',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/round12-host-before.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: 'a8183d21c3b0051b756086f1cc140aec3ee786b48ead6d6f68caef72fe3ceb14',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/round12-host-after-reload.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: '7c51db7866cd9e23e5ea44716b9de1f5022ae56a1f6ca04c0b2c91f3c2945924',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/round12-host-after-run.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: '912e60a03c03a73e952f7196ce28124a9d88ccbbecaf2c2f4668b91604ff841c',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/round12-host-after-reconcile.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: '4aa7a534e488694c3cd3a24016b846f8132df1db2362ef1bfad4eb0d5504e14b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/round12-host-final.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: '6fdf11cc6ef022410de9f7c424e695bb144576ec16d9bc9666412516cddb587f',
      },
    ],
    levels: ['fixed-host-failure-diagnostic'],
    scope: 'Round-12 fixed-host third independent bounded core Goal attempt (v3, explicit owner decision; not a v1/v2 retry) on the installed X=68b1caf build (dist 113 files, digest acfcbd3a...): the cold-cut fix aligned the counts (expected.eventCount 3 == live.seq 3, inherited 0, delta 0) but create then FAILED deterministically at history-assert/NATIVE_HISTORY_CHANGED with mismatchKind=header-hash (cold baa30ad4d06e38bf vs live bbd0090cf84d43d9); 0 model requests, no retry, partial unauthorized/paused v3 Goal + one core Goal Session, journal unknown with the same reason, no new Task/Effect/budget/artifact, +3 commitSeq, goals 4→5, sessions 35→36, state file unchanged.',
    limitations: [
      'FAILED third v3 attempt, not bounded-real-model/business success and NOT pass/V25/nine-system: create failed at history-assert/NATIVE_HISTORY_CHANGED with mismatchKind=header-hash (cold baa30ad4d06e38bf vs live bbd0090cf84d43d9) while the counts now align (expected.eventCount 3 = live.seq 3, inherited 0, delta 0) — the cold-cut is effective for event-count/seq but NOT for the header hash.',
      '0 model requests (evaluateAttempts=0, pollCount=0), stopAction=none, no retry, no core plan/Task/worker/verification/native completion.',
      'Partial side effect: an unauthorized/paused v3 Goal (requestId core-validation-frozen-v3) plus one core Goal Session (four meta events) were created; the create journal is unknown with the same reason; +3 commitSeq and goals 4→5/sessions 35→36, but no new Task/Effect/budget/artifact and the known Sessions/state file are unchanged.',
      'The create failure is NOT fixed: the header difference cause is unknown (volatile trusted header fields, e.g. isSeeded/seed state, need field-level diagnosis before any normalization policy); a fourth attempt is NOT authorized. This failure evidence can NEVER be pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'round12V3Status', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'status' },
      { label: 'round12V3MismatchKind', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'attempt.historyDiagnostic.mismatchKind' },
      { label: 'round12V3ExpectedEventCount', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'attempt.historyDiagnostic.expected.eventCount' },
      { label: 'round12V3LiveSeq', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'attempt.historyDiagnostic.live.seq' },
      { label: 'round12V3Delta', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'attempt.historyDiagnostic.delta' },
      { label: 'round12V3ExpectedHeaderHash', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'attempt.historyDiagnostic.expected.headerHash' },
      { label: 'round12V3LiveHeaderHash', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'attempt.historyDiagnostic.live.headerHash' },
      { label: 'round12V3EvaluateAttempts', path: 'artifacts/dsh/host/round12/core-goal-v3-receipt.json', jsonPath: 'counters.evaluateAttempts' },
      { label: 'round12V3ReceiptStatus', path: 'artifacts/dsh/host/round12/core-goal-v3-receipt.json', jsonPath: 'status' },
      { label: 'round12V3StatusFinalBytes', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'cachedReceipt.bytes' },
    ],
  },
  {
    id: 'round12-host-v3-cleanup-reconcile',
    commits: ['31e5c05', '390346d'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12-bounded-core-goal-v3.json',
        sliceCommit: '31e5c05',
        blobCommit: '390346d',
        expectedSha256: 'ffb0a1998cab6a3c733b79638e854bd6a9b3b82b1917530595d451b51575ed9b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/round12-host-after-reconcile.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: '4aa7a534e488694c3cd3a24016b846f8132df1db2362ef1bfad4eb0d5504e14b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round12/status-final.json',
        sliceCommit: '31e5c05',
        blobCommit: '31e5c05',
        expectedSha256: 'e727ffcc5c5d30d2485347b8314784f0f7cf378547e758e9ec6b8078615bac31',
      },
    ],
    levels: ['fixed-host-zero-model-reconcile'],
    scope: 'Round-12 post-attempt cleanup reconcile on the installed build: one generalized reconcile call with fixed targets [v1,v2,v3]; v1 and v2 were already cancelled (no action), v3 was inert-unauthorized and received exactly one cancel (postCancel cancelled=true, paused=true, version=2), both readbacks complete, no unknowns; audit deltas show only +1 commitSeq (443→444) for the v3 cancel, with no events/sessions/goals/tasks/effects/budget/artifact or state-file change; the read-only final status caches the reconcile receipt.',
    limitations: [
      'Zero-model cleanup only, NOT a business/complete/passed run: v1/v2 cancelled with no action, v3 inert-unauthorized with exactly one cancel and postCancel version 2; 0 model calls, 0 retries; only +1 commitSeq and no other side effect.',
      'It only cleans up the residual partial v3 Goal after the FAILED third attempt; it does NOT fix the create/header-hash failure and does not prove the business chain.',
      'A fourth bounded experiment is NOT authorized; this cleanup can never be reported as pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'round12CleanupV3Classification', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'postAttemptReconcile.targets.2.classification' },
      { label: 'round12CleanupV3CancelAttempts', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'postAttemptReconcile.targets.2.cancelAttempts' },
      { label: 'round12CleanupV3PostCancelVersion', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'postAttemptReconcile.targets.2.postCancel.version' },
      { label: 'round12CleanupV1CancelAttempts', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'postAttemptReconcile.targets.0.cancelAttempts' },
      { label: 'round12CleanupStatusFinalBytes', path: 'artifacts/dsh/host/round12-bounded-core-goal-v3.json', jsonPath: 'postAttemptReconcile.statusPayload.bytes' },
    ],
  },
  {
    id: 'round12-review',
    commits: ['390346d'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/round12-evidence-review.json',
        sliceCommit: '390346d',
        blobCommit: '390346d',
        expectedSha256: '7314b8cedc0d94a0372f05eab4e0645dcb5332a03a5b120c8259e159d47c390c',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/ROUND12-EVIDENCE-REVIEW.md',
        sliceCommit: '390346d',
        blobCommit: '390346d',
        expectedSha256: 'ee3373ebe87ce4372607863874c028a05b72bd52b5462ad0ae93055207a5e700',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-12 independent evidence review metadata plus F12 corrections/dispositions (F12-R1 stale h7-round12-slice binding in the integration verify noted; F12-R2 status-final bytes corrected to actual 69,295/e727ffcc; F12-R3 audit count corrected to five committed audits; F12-R4 round-12 host evidence explicitly left for round-13 mapping).',
    limitations: [
      'Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-13 header-cut probe / correction / review evidence (H7-round14) ---------------- */
  {
    id: 'native-header-cut-probe',
    commits: ['4421b6a'],
    files: [
      {
        path: 'plugins/shiyu/src/adapters/dsh/native-context.ts',
        sliceCommit: '4421b6a',
        blobCommit: '4421b6a',
        expectedSha256: 'd0b5ecb1065f70971e96886ff38a65db7eee6932caaeda71a13b4a92cdfa79cb',
      },
      {
        path: 'plugins/shiyu/src/adapters/dsh/goals.ts',
        sliceCommit: '4421b6a',
        blobCommit: '4421b6a',
        expectedSha256: '4b8fcccb0c2e9a50567c7a0b2175bb9ac95e8f38560e02b2d0ca53f1771d9b9a',
      },
      {
        path: 'plugins/shiyu/src/control/native-header-cut-probe.ts',
        sliceCommit: '4421b6a',
        blobCommit: '4421b6a',
        expectedSha256: '77abc65db9abb923a396489937ce83e99d5ccc25866462a583d6faa90cda0bd3',
      },
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: '4421b6a',
        blobCommit: '4421b6a',
        expectedSha256: 'cac3a711f6b83251f31424f46431f86b09d3ac1a1be7bef175378639ce5f83dc',
      },
      {
        path: 'plugins/shiyu/tests/core-event-tools.test.ts',
        sliceCommit: '4421b6a',
        blobCommit: '4421b6a',
        expectedSha256: 'bec836bac2da1094fbe1a84b17c40cb790fccc765410e59a25081d7bff16cd2d',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-native-header-cut-probe.json',
        sliceCommit: '4421b6a',
        blobCommit: '4421b6a',
        expectedSha256: '8420f6c9357725352f26f3691420facd0a107875a596de71a3a56e7ccfdc75ac',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-native-header-cut-probe.patch',
        sliceCommit: '4421b6a',
        blobCommit: '4421b6a',
        expectedSha256: '3e6d6aadb5c493052975b809550e516374be474c4393b0e66804fc01092da068',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/h3-native-header-cut-verify.json',
        sliceCommit: '4421b6a',
        blobCommit: '4421b6a',
        expectedSha256: '2801b9c121718ce89a17078ad145de0e060f2cd87d4f5a38966e7e304a30db52',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-13 controlled header-field diagnostics + zero-model native header-cut probe source: headerDiff is field-name/value-category only (<=12 entries x <=80 chars, joined <=300; total historyDiagnostic bound raised to 600 and double-validated, documented); the probe creates exactly one bare lifecycle Session via the managed Goal preset/cwd/meta with empty inbox and rejected model requests, then flush -> cold observe -> live assert with the create-only seq-excluding-header cut -> bounded headerDiff -> finally cancel/dispose/archive; receipt bounded/validated incl cleanup facts and admission helper (paused/busy/capacity reject before any Session); 8 net-new tests (core-event-tools 58/58, core-validation 46/46, regression 89/89) and isolated full check 1632/1632.',
    limitations: [
      'Offline/fake-host source only: the implementer ran no real model/embedding and created no Goal; the real zero-model header-cut probe is separate evidence (round13-host-native-header-cut) and this source cannot prove host behaviour.',
      'The probe intentionally creates exactly one disposable Session file (cancelled/disposed/archived); it performs no fix and no fourth bounded Goal attempt; a trusted-field normalization decision is still required before any fourth attempt.',
      'headerDiff total bound expansion 300->600 is documented and validator-enforced (headerDiff itself stays <=300); a header-hash mismatch with an EMPTY headerDiff means the difference is nested/unlisted and the host kit must stop rather than guess.',
      'This diagnostic evidence can NEVER be pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'round13HeaderProbeStatus', path: 'artifacts/dsh/h3/h3-native-header-cut-probe.json', jsonPath: 'status' },
      { label: 'round13HeaderProbeNetNewTests', path: 'artifacts/dsh/h3/h3-native-header-cut-probe.json', jsonPath: 'tests.netNew' },
      { label: 'round13HeaderProbeIsolatedTests', path: 'artifacts/dsh/h3/h3-native-header-cut-probe.json', jsonPath: 'verification.isolatedFullCheck.tests.tests' },
    ],
  },
  {
    id: 'round13-lead-integration',
    commits: ['76c7116'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/integration/round13-lead-integration.json',
        sliceCommit: '76c7116',
        blobCommit: '76c7116',
        expectedSha256: '992d99ece5bd548963d2b388a8fe03894edcfcfdf3a2becfd48a51c11600bcf7',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/round13-integrated-verify.json',
        sliceCommit: '76c7116',
        blobCommit: '76c7116',
        expectedSha256: '31406ee9b94c64b12ae7b48a6b60e2514d09fe84a70900d1b2c1f2654af049a2',
      },
      {
        path: 'plugins/shiyu/src/runtime.ts',
        sliceCommit: '76c7116',
        blobCommit: '76c7116',
        expectedSha256: '84b887296d49cc150a59dd85454391e3ada37a5339cea4f09881d52b97a67e56',
      },
      {
        path: 'plugins/shiyu/src/index.ts',
        sliceCommit: '76c7116',
        blobCommit: '76c7116',
        expectedSha256: '0db034d2a4ff25277afd567efd0781c1fb84f251e6911cd3bbb4aff28ca49065',
      },
      {
        path: 'plugins/shiyu/tests/host-diagnostics-tool.test.ts',
        sliceCommit: '76c7116',
        blobCommit: '76c7116',
        expectedSha256: 'abefc4a424fa6210034a8ed6efc2b65d4f07e61ef70d355c578fcb42b45d87a1',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-13 Lead integration on X=76c7116 of the zero-model native header-cut probe + controlled header diagnostics: owner-only runtime command and tool exposed; isolated integrated check 1643/1643 (1623 baseline + 9 header-diagnostic/probe product tests + 9 H7-round13 + 1 probe tool test); 0 real model calls, 0 embedding calls, 0 Goal creates; the fixed-host probe is separate evidence.',
    limitations: [
      'Integration + isolated check only: 0 real model/embedding calls and 0 Goal creates in this integration source; the host zero-model probe is separate evidence.',
      'Diagnosis only: the integration does not fix the header field difference and does not authorize a fourth bounded Goal attempt; nested/unlisted header differences must stop for reporting.',
      'Never pass/V25/business/nine-system.',
    ],
    derive: [
      { label: 'round13IntegrationStatus', path: 'artifacts/dsh/integration/round13-lead-integration.json', jsonPath: 'status' },
      { label: 'round13IntegrationTests', path: 'artifacts/dsh/integration/round13-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests' },
      { label: 'round13IntegrationGoalCreates', path: 'artifacts/dsh/integration/round13-lead-integration.json', jsonPath: 'scope.goalCreates' },
    ],
  },
  {
    id: 'h7-round13-clean-artifacts',
    commits: ['4c2de7c'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: '4c2de7c',
        blobCommit: '4c2de7c',
        expectedSha256: 'd08f947d172883e0c5e1ddbce84edadd9230d072d840a86eb58afeb163a587d2',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: '4c2de7c',
        blobCommit: '4c2de7c',
        expectedSha256: '7a2988b0ba0958619fa3eed08db1dc7bb13b203de7622e5774b231cb013391e7',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: '4c2de7c',
        blobCommit: '4c2de7c',
        expectedSha256: '303833183044e5dda02d71828cfa104122a718c44640f65d65e28c26e010fd7a',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round13 clean-VCS harness artifacts (X+1 of 76c7116, commit 4c2de7c): clean-X manifest (vcs head 76c7116, dirty=false, 407 files), traceability with 73 verified evidence sources/254 files and acceptance report (gate incomplete, executed=passed=0, product 79/79 not_covered).',
    limitations: [
      'Tooling evidence only: not product/host/model/business acceptance; product rows remain not_covered and the gate incomplete.',
      'Bound with blobCommit=4c2de7c + expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from the mutable worktree.',
      'Cannot upgrade V/S/FL/product rows or the nine-system gate.',
    ],
    derive: [{ label: 'round13CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round13-host-native-header-cut',
    commits: ['9ba7e70', 'd221561'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round13-joint-header-cut.json',
        sliceCommit: '9ba7e70',
        blobCommit: 'd221561',
        expectedSha256: 'b40250218cd95861fcd2d761f2d3e7cddb0ed644812e01d6a4943b0d00dcdc8c',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round13/native-header-cut-receipt.json',
        sliceCommit: '9ba7e70',
        blobCommit: '9ba7e70',
        expectedSha256: 'a7cc6e8336547300c7974d7c57d356e9fbf22bb32f12ebc5f628a4a5772dd0ed',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round13/plan.json',
        sliceCommit: '9ba7e70',
        blobCommit: '9ba7e70',
        expectedSha256: 'be469f796e47706048d18a2a812ac26af3198e6ec010a0a74fe0be873f33cc17',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round13/round13-host-before.json',
        sliceCommit: '9ba7e70',
        blobCommit: '9ba7e70',
        expectedSha256: '58b199ae688efe3092715baa44069445d6577d3e130611f3ead48f0a5e9e68de',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round13/round13-host-after-reload.json',
        sliceCommit: '9ba7e70',
        blobCommit: '9ba7e70',
        expectedSha256: '0de2a963ce6fe57de8af2553123d27c1f4b8e158e5fc885403f7476c7449d2b3',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round13/round13-host-after-probe.json',
        sliceCommit: '9ba7e70',
        blobCommit: '9ba7e70',
        expectedSha256: '27e29c066d8d8a90e1899907795f47f55f05960cbcf03fe5001e16d98165d36c',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round13/round13-host-final.json',
        sliceCommit: '9ba7e70',
        blobCommit: '9ba7e70',
        expectedSha256: '4eeed7bfe7829c402cbc41392a76d00cabee2d6b2e2d85249a3d6b9e1b2b049f',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round13/status-final.json',
        sliceCommit: '9ba7e70',
        blobCommit: '9ba7e70',
        expectedSha256: '9abd48d743fd4dc222f2236a2fc7653bc1fdaafe0179c811856c45b59a675424',
      },
    ],
    levels: ['fixed-host-zero-model'],
    scope: 'Round-13 fixed-host zero-model native header-cut probe on the installed X=76c7116 build (dist 114 files, digest 87f18741...): exactly one owner-only call created one bare lifecycle Session with the managed Goal preset/cwd/meta and empty inbox, rejected model requests, then flush -> cold observe (eventCount 3, inherited 0, headerHash 421ba38b88bb3384) -> live assert with the create-only seq-excluding-header cut (seq 3 / eventCount 3 / inherited 0 / headerHash 815793bba716d8fc); matched=false, mismatchKind=header-hash, headerDiff ["delegationDepth: number:0→absent"]; cleanup released/disposed/archived ok; audit shows sessions 36→37 (exactly one probe Session, archived) while commitSeq/events 59/goals 5/tasks/budget/effects/state are unchanged; 0 model/embedding/Goal/Task/Effect/business writes and 0 retries; the 60692-byte final status caches the validated probe receipt.',
    limitations: [
      'Zero-model header-cut DIAGNOSIS only, NOT a fix and NOT pass/V25/business/nine-system: matched=false with headerDiff ["delegationDepth: number:0→absent"] — the cold persisted header has delegationDepth number:0 while the live Session header omits it (absent); the event-count/seq cut is already aligned at 3/3, so this single trusted-volatile field difference explains the remaining header-hash mismatch.',
      'Exactly one bare lifecycle Session was created and archived (released/disposed/archived ok); 0 model requests, 0 embeddings, 0 Goal/Task/Effect/budget creations, 0 business writes, 0 retries; no plan/worker/verification/native completion or business chain occurred.',
      'It does not fix the create failure and does not authorize a fourth bounded attempt; a create-only trusted-field normalization decision is still required, and the probe covers only the header/history cut (not plan/model/Task semantics).',
      'This diagnostic evidence can NEVER be pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'round13HeaderCutStatus', path: 'artifacts/dsh/host/round13-joint-header-cut.json', jsonPath: 'status' },
      { label: 'round13HeaderCutMatched', path: 'artifacts/dsh/host/round13-joint-header-cut.json', jsonPath: 'result.matched' },
      { label: 'round13HeaderCutDiff0', path: 'artifacts/dsh/host/round13-joint-header-cut.json', jsonPath: 'result.headerDiff.0' },
      { label: 'round13HeaderCutColdEventCount', path: 'artifacts/dsh/host/round13-joint-header-cut.json', jsonPath: 'result.cold.eventCount' },
      { label: 'round13HeaderCutLiveSeq', path: 'artifacts/dsh/host/round13-joint-header-cut.json', jsonPath: 'result.live.seq' },
      { label: 'round13HeaderCutStatusFinalBytes', path: 'artifacts/dsh/host/round13-joint-header-cut.json', jsonPath: 'cachedReceipt.bytes' },
      { label: 'round13HeaderCutCreatedGoal', path: 'artifacts/dsh/host/round13-joint-header-cut.json', jsonPath: 'result.createdGoal' },
      { label: 'round13HeaderCutZeroModel', path: 'artifacts/dsh/host/round13-joint-header-cut.json', jsonPath: 'result.zeroModel' },
    ],
  },
  {
    id: 'round13-review',
    commits: ['d221561'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/round13-evidence-review.json',
        sliceCommit: 'd221561',
        blobCommit: 'd221561',
        expectedSha256: '545a6018e1383148f9f34c0159884a9f84a1213ef5b12fef69d3c77a0324448a',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/ROUND13-EVIDENCE-REVIEW.md',
        sliceCommit: 'd221561',
        blobCommit: 'd221561',
        expectedSha256: '226a6fd2b4984ccc850908137c7e30eaef1eedb3196f787b37bac705e31bd30b',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-13 independent evidence review metadata plus F13 corrections/dispositions (F13-R1 receipt/status bytes corrected to actual 903/60692; F13-R2 placeholder slice-evidence correction required and later committed; F13-R3 headerDiff total bound 300->600 documented and double-validated; F13-R4 host probe is diagnosis-only and left for round-14 mapping).',
    limitations: [
      'Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  {
    id: 'h7-round13-slice-correction',
    commits: ['d6934b6'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/h7-round13-slice.json',
        sliceCommit: 'd6934b6',
        blobCommit: 'd6934b6',
        expectedSha256: '511040acf717f0b5fed53b7ed1e9ae88c91c78a82731f0fee87dda6eb19ac5a1',
      },
      {
        path: 'plugins/shiyu/tests/harness-round13.test.ts',
        sliceCommit: 'd6934b6',
        blobCommit: 'd6934b6',
        expectedSha256: '3c2bea27af60a9fa34f7efe7a4ef4b8b869621164d9e67f640305f7298b5d620',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-13 evidence correction record (R13-CORR-1, info-only): replaces the committed H7-round13 slice-evidence placeholders with real archived log SHA/bytes and archivedCopies, marks the shared-tree run as blockedByConcurrentWip with NO green claim (removing the unobserved 142/142/0 placeholder), and adjusts the round-13 slice test assertion accordingly; sourceCounts/files/productRows/toolingReady/gate facts are unchanged.',
    limitations: [
      'Info/metadata correction only: it documents the true provenance of the round-13 slice evidence; it is not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-14 delegationDepth normalization / v4 create-success eval-failure evidence (H7-round15) ---------------- */
  {
    id: 'delegation-depth-normalization-v4',
    commits: ['2752f49', '7d5d2e1'],
    files: [
      {
        path: 'plugins/shiyu/src/adapters/dsh/native-context.ts',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: '4aa15fed07b050bae743e3f0e5a6a09214ce504346eb9e5d9f39c9586d4b6f87',
      },
      {
        path: 'plugins/shiyu/src/adapters/dsh/goals.ts',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: 'cce0a5eb650e131b51e76894fb3e5bc66ea664031f05de362a2b50afd00b54fc',
      },
      {
        path: 'plugins/shiyu/src/control/native-header-cut-probe.ts',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: '20de09280ce292d2b67352dbf294d4a105e84f9d5f10740a13ca86eb0f355e2d',
      },
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: 'b2a44c3526b013b2400c09303c012ed528bace216c54fed566f4a6e358db500a',
      },
      {
        path: 'plugins/shiyu/tests/core-event-tools.test.ts',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: '6108e487c0a93d6572cd27fb2dddb288c1d8ca12aace4dceadbac4919f1cfa1b',
      },
      {
        path: 'plugins/shiyu/tests/core-validation.test.ts',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: 'f0d3a428df5bb8a6c84ef04e8d5fd3b46b9e82c3a2a0427e553cd48e4d1685c4',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-v4-trusted-header-fix.json',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: 'a3aae8c0f46ae7958c83f5f99084668b6bc0537243446d8216bc767986bc14be',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-v4-runtime-index.patch',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: 'aaa64310c20219fba331381bed625de1de8d20e431896d8e88d676fbf8b80587',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/h3-v4-trusted-header-verify.json',
        sliceCommit: '2752f49',
        blobCommit: '2752f49',
        expectedSha256: '69c31013aa33663a436ea2199b437d03dd377720e473421819f5714a0df7de4c',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/integration/round14-lead-integration.json',
        sliceCommit: '7d5d2e1',
        blobCommit: '7d5d2e1',
        expectedSha256: '9d62faf4935f48b41ef8660d78e2a88c25fca453de77c39de7f1c59448f473ee',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/round14-integrated-verify.json',
        sliceCommit: '7d5d2e1',
        blobCommit: '7d5d2e1',
        expectedSha256: 'a1ac26240dfe34865995d27ced6f870b5b9997d3be749248b6b78f8fd4e09fb3',
      },
      {
        path: 'plugins/shiyu/src/runtime.ts',
        sliceCommit: '7d5d2e1',
        blobCommit: '7d5d2e1',
        expectedSha256: 'fe034ee4b5897a17a9e7e02bd7667c582698bc3f6cec010f3f797ee66f936a15',
      },
      {
        path: 'plugins/shiyu/src/index.ts',
        sliceCommit: '7d5d2e1',
        blobCommit: '7d5d2e1',
        expectedSha256: 'ba6de25795efc8b1fec2aa505e1f1a7b4ca1a6c2bb3acfd7966affcd7fd212b5',
      },
      {
        path: 'plugins/shiyu/tests/host-diagnostics-tool.test.ts',
        sliceCommit: '7d5d2e1',
        blobCommit: '7d5d2e1',
        expectedSha256: '612ff6dd8e7c90fc4718166e1e5c59d5904cdcd22f091fc0e50d603f9e4d911e',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-14 create-only delegationDepth normalization + frozen v4 experiment + integration: canonicalLiveHeader inserts delegationDepth=0 only when the caller passes headerCanonicalization=delegation-depth-default-zero, the cold baseline headerFacts delegationDepth is number:0, and the live header delegationDepth is absent/null (applied on the create stabilize baseline + title-append assertions); recovery/resume, every expectedPrefix path and the default assert stay strict, and no other header field is normalized; the zero-model probe mirrors it and now reports matched=true for cold-0/live-absent; CORE_VALIDATION_EXPERIMENT_V4 is frozen (requestId/template/content sha, exact-reference-only) and reconcile covers fixed [v1,v2,v3,v4]; focused 112/112 + regression 89/89 (net +8) and isolated 1651/1651; Lead integration isolated 1662/1662 (1643 baseline + 8 + 10 H7-round14 + 1 v4 tool test).',
    limitations: [
      'Offline/fake-host source only: the implementer ran no real host/model; the real fourth v4 attempt is separate evidence (round14-host-v4-create-success-eval-failure) and its create success does not make this offline slice a business acceptance.',
      'The normalization is conditional and narrow: if the real cold header lacks delegationDepth: number:0, strict semantics remain and a create attempt would fail header-hash without retry; non-zero or absent/null mismatches beyond this exact pair are NOT normalized and still carry the controlled historyDiagnostic/headerDiff.',
      'It does not fix the separate evaluation/pre-step blocker: the real v4 evaluation failed before any model request (reason masked as owner_paused) and a fifth attempt is NOT authorized until reason preservation/pre-step shape fixes land.',
      'This source can NEVER be pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'round14NormalizationStatus', path: 'artifacts/dsh/h3/h3-v4-trusted-header-fix.json', jsonPath: 'status' },
      { label: 'round14NormalizationNetNewTests', path: 'artifacts/dsh/h3/h3-v4-trusted-header-fix.json', jsonPath: 'tests.netNew' },
      { label: 'round14NormalizationIsolatedTests', path: 'artifacts/dsh/h3/h3-v4-trusted-header-fix.json', jsonPath: 'verification.isolatedFullCheck.tests.tests' },
      { label: 'round14IntegrationTests', path: 'artifacts/dsh/integration/round14-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests' },
    ],
  },
  {
    id: 'h7-round14-clean-artifacts',
    commits: ['4f8c342'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: '4f8c342',
        blobCommit: '4f8c342',
        expectedSha256: 'c5370f8efd7ba71248416003237c2bf61019719955dca2e0e29fa560a080a8fd',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: '4f8c342',
        blobCommit: '4f8c342',
        expectedSha256: 'bdf46d46c7997b2826ea993a87aa5aad2bfe955bce5c7992c2890991471b6000',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: '4f8c342',
        blobCommit: '4f8c342',
        expectedSha256: 'c146621def46ac029741752e30fb049297506e715038658f11087d7adf8a9cff',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round14 clean-VCS harness artifacts (X+1 of 7d5d2e1, commit 4f8c342): clean-X manifest (vcs head 7d5d2e1, dirty=false, 407 files), traceability with 79 verified evidence sources/282 files and acceptance report (gate incomplete, executed=passed=0, product 79/79 not_covered).',
    limitations: [
      'Tooling evidence only: not product/host/model/business acceptance; product rows remain not_covered and the gate incomplete.',
      'Bound with blobCommit=4f8c342 + expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from the mutable worktree.',
      'Cannot upgrade V/S/FL/product rows or the nine-system gate.',
    ],
    derive: [{ label: 'round14CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round14-host-v4-create-success-eval-failure',
    commits: ['732b9f7', '6130b80'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14-bounded-core-goal-v4.json',
        sliceCommit: '732b9f7',
        blobCommit: '6130b80',
        expectedSha256: 'c0293928561fee131bb84175d93eb0087db93c7c4946a7625357ea8c7c5a6ac7',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14/core-goal-v4-receipt.json',
        sliceCommit: '732b9f7',
        blobCommit: '732b9f7',
        expectedSha256: 'c378aaea3ca47c4f7a7abcfb9e6b6a875baa1852ae5bd9060807170ed88ec7b4',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14/plan.json',
        sliceCommit: '732b9f7',
        blobCommit: '732b9f7',
        expectedSha256: '85cc16845f9b9cc9ae4fb248210a1a1296a1e6fd8ba12a6d653777eeb1c10b53',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14/round14-host-before.json',
        sliceCommit: '732b9f7',
        blobCommit: '732b9f7',
        expectedSha256: 'd2117eb95ddfadb3a80fbadd07e31cac4a70e3bffcefd2942bdb30bf114b4034',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14/round14-host-after-reload.json',
        sliceCommit: '732b9f7',
        blobCommit: '732b9f7',
        expectedSha256: 'b4fbeebcc1d6cf71364299b1291c3f70c28ad8f1c5ec635b30ee23b605af8775',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14/round14-host-after-run.json',
        sliceCommit: '732b9f7',
        blobCommit: '732b9f7',
        expectedSha256: 'c3b08004ea45e82794a754e96b19330ca9a89ec3e035ee9e2952498359968270',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14/round14-host-final.json',
        sliceCommit: '732b9f7',
        blobCommit: '732b9f7',
        expectedSha256: '85858465667c4fd3edb2b34c3bab8c94c2bc39c45af9f8922aa543261b044d00',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14/status-final.json',
        sliceCommit: '732b9f7',
        blobCommit: '732b9f7',
        expectedSha256: 'f8443b15200ebb4dcd11a4b69a9487da29e559840914c65a5f5d6afb3f9638cd',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round14/v4-goal-session-events.json',
        sliceCommit: '732b9f7',
        blobCommit: '732b9f7',
        expectedSha256: 'ade3663c5b6f94f02300313b981e14b98a49664db25aa77b1378dc73c0c9526b',
      },
    ],
    levels: ['fixed-host-create-succeeded-evaluation-failure'],
    scope: 'Round-14 fixed-host fourth independent bounded core Goal attempt (v4, explicit owner decision; not a v1/v2/v3 retry) on the installed X=7d5d2e1 build (dist 114 files, digest cbc10d58...): the create-only delegationDepth normalization worked — create returned exactly ONE authorized (authorized=true), owner-mandated, native-active Goal with a confirmed binding, goalRef revision 1 and exactly one Goal Session, partialCreation=false; the single evaluation then failed as CORE_VALIDATION_EVALUATION_UNKNOWN (evaluateAttempts=1) with 0 model requests — the 13-event Goal Session has title/goal-change/end-seed/inbox-spliced/turn-start/input-removed/turn-end-aborted/pause but NO request or assistant event; the reason is masked as owner_paused by the pause path, stopAction=pause ok (goalVersion 5), and the audit shows +14 commitSeq (456→470), goals 5→6, sessions 37→38, budget unknown 3→4 with held tokens 16384/calls 2, no events/Task/Effect/artifact and unchanged state/known Sessions; the 65594-byte final status caches the failed receipt.',
    limitations: [
      'It is a FAILED fourth attempt despite the create success: create succeeded (authorized/active/mandate/binding confirmed/goalRef rev1/1 Goal Session, partialCreation=false) but the single evaluation is unknown with evaluateAttempts=1 and 0 model requests (13 Goal-Session events contain no request/assistant event); this is NOT business/complete/passed and can NEVER be pass, V25, business or nine-system acceptance.',
      'The evaluation reason is masked as owner_paused (the pause-path classification overwrites the original decision-round failure reason); the likely cause is the decision-run pre-step still expecting one message while the host claims the owner prompt plus its runtime-context snapshot — both are evidence-integrity defects disclosed for follow-up slices, not fixed here.',
      'The audit is exactly +14 commitSeq (456→470), goals 5→6, sessions 37→38, budget unknown 3→4 (held 16384 tokens/calls 2), no events/Task/Effect/artifact and unchanged state/known Sessions; the v4 Goal remains authorized/paused with an unknown evaluation and a held reservation, and no retry was made.',
      'No real business chain occurred (0 model requests, no plan/Task/worker/native completion); a fifth attempt is NOT authorized until reason preservation/pre-step shape fixes land and the unknown budget is reconciled or disclosed.',
    ],
    derive: [
      { label: 'round14V4Status', path: 'artifacts/dsh/host/round14-bounded-core-goal-v4.json', jsonPath: 'status' },
      { label: 'round14V4ReasonCode', path: 'artifacts/dsh/host/round14-bounded-core-goal-v4.json', jsonPath: 'result.reasonCode' },
      { label: 'round14V4EvaluateAttempts', path: 'artifacts/dsh/host/round14-bounded-core-goal-v4.json', jsonPath: 'result.counters.evaluateAttempts' },
      { label: 'round14V4GoalAuthorized', path: 'artifacts/dsh/host/round14-bounded-core-goal-v4.json', jsonPath: 'result.goal.authorized' },
      { label: 'round14V4GoalPaused', path: 'artifacts/dsh/host/round14-bounded-core-goal-v4.json', jsonPath: 'result.goal.paused' },
      { label: 'round14V4StopKind', path: 'artifacts/dsh/host/round14-bounded-core-goal-v4.json', jsonPath: 'result.stopAction.kind' },
      { label: 'round14V4BudgetHeldTokens', path: 'artifacts/dsh/host/round14-bounded-core-goal-v4.json', jsonPath: 'result.businessSideEffects.budget.held.tokens' },
      { label: 'round14V4StatusFinalBytes', path: 'artifacts/dsh/host/round14-bounded-core-goal-v4.json', jsonPath: 'cachedReceipt.bytes' },
    ],
  },
  {
    id: 'round14-review',
    commits: ['6130b80'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/round14-evidence-review.json',
        sliceCommit: '6130b80',
        blobCommit: '6130b80',
        expectedSha256: '3a2383a7d809c7328a08c09e31687c7f2fff602ba84e75bd7a9e639aa0870aa4',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/ROUND14-EVIDENCE-REVIEW.md',
        sliceCommit: '6130b80',
        blobCommit: '6130b80',
        expectedSha256: '03cb33657b09f3cd2fc69f9ae975ef5e76eb55f22917a7c35e82d873a6de214b',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-14 independent evidence review metadata plus F14 dispositions (F14-R1 cachedReceipt bytes corrected to actual 65594/f8443b15; F14-R2 placeholder H7-round14 slice evidence corrected and committed 437ac97; F14-R3 create-time vs final binding status wording accepted; F14-R4 evaluation reason masking / 0 model requests / held unknown budget / fifth attempt unauthorized accepted as an honest boundary).',
    limitations: [
      'Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  {
    id: 'h7-round14-slice-correction',
    commits: ['437ac97'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/h7-round14-slice.json',
        sliceCommit: '437ac97',
        blobCommit: '437ac97',
        expectedSha256: '3eca7e3f7493c4015f19dad8a11905bf1cb95b188f25993f9d1c517dc92a6cd7',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-14 evidence correction record (R14-CORR-1, info-only): replaces the committed H7-round14 slice-evidence placeholders with real archived log SHA/bytes and archivedCopies (isolated tsc 11B, harness 152/152 11773B, full check 1653/1653 175049B), keeps sharedTree explicitly blockedByConcurrentWip with NO green claim; all other slice facts unchanged.',
    limitations: [
      'Info/metadata correction only: it documents the true provenance of the round-14 slice evidence; it is not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-15 v5 decision pre-step / reason preservation / context rejection evidence (H7-round16) ---------------- */
  {
    id: 'decision-prestep-reason-preservation-v5',
    commits: ['91fdbf6', '94251aa'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-v5-decision-prestep-fix.json',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: '88f97532de82c8a08395aa9a0fcd39800cd812ecb3dac94a7b7bc07a5a031380',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-v5-runtime-index.patch',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: 'c4b8657ba1b3b936beaee5137e99971e0ae8c61dcad6cfbfb7b46a036c54412b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/h3-v5-decision-prestep-verify.json',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: '0dedcd142be8782d8fbed1e8f3c71c1c00350c157c8131815fa3b19638abbfaa',
      },
      {
        path: 'plugins/shiyu/src/adapters/dsh/core-decision.ts',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: '0b2a520f3dd60c6d29cc8349293e92aeb8ed42b8a683de12cbb4d48daba03f5b',
      },
      {
        path: 'plugins/shiyu/src/adapters/control-store/core-domain.ts',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: 'ec36e8e4ac3b5a153dedbd59e55c4c4784f565a7465f71f57da4bf296dec75ca',
      },
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: '199eb601b94d1934d4c2d9dbd9fcc796b983779db3bbf7aeb6357964e8f6fbcd',
      },
      {
        path: 'plugins/shiyu/tests/core-event-tools.test.ts',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: 'ec1b1d70b9d0f38f43a126d511655f8825c3d720e3fe5dad948c5642524a4764',
      },
      {
        path: 'plugins/shiyu/tests/core-validation.test.ts',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: 'fe22b484083d5c098d3021f6a4023de73b3f61d1ce442d242141941ca42c1c5c',
      },
      {
        path: 'plugins/shiyu/tests/core-domain.test.ts',
        sliceCommit: '91fdbf6',
        blobCommit: '91fdbf6',
        expectedSha256: '8298284423872fdf60affecf50404d3b3aa7cce9468512013051379b79afe23f',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/integration/round15-lead-integration.json',
        sliceCommit: '94251aa',
        blobCommit: '94251aa',
        expectedSha256: 'f2b5c116606a4c207ba31377b71f00477e338185fb29f032a67ed8d815d85489',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/round15-integrated-verify.json',
        sliceCommit: '94251aa',
        blobCommit: '94251aa',
        expectedSha256: '22acc17a9afe274b5e744f856bd380b3ce746ec6a8e9e6c6942d7a0203f78e5a',
      },
      {
        path: 'plugins/shiyu/src/runtime.ts',
        sliceCommit: '94251aa',
        blobCommit: '94251aa',
        expectedSha256: '4745c1f2a3ad3ede5d2ff053772cec6c7d0c1f672d0f2e6d5119ca852297c5ee',
      },
      {
        path: 'plugins/shiyu/src/index.ts',
        sliceCommit: '94251aa',
        blobCommit: '94251aa',
        expectedSha256: '22da3b041064ed564f9eb6e1d46e6f5d05d8c6e28b7c2b90198901fdb944fc9e',
      },
      {
        path: 'plugins/shiyu/tests/host-diagnostics-tool.test.ts',
        sliceCommit: '94251aa',
        blobCommit: '94251aa',
        expectedSha256: 'd308579cb8d094a34fce535e2ece13802e1cd7888a62de5f15aa77b8c07b3084',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-15 decision pre-step + first reason preservation + frozen v5: the step-0 pre-step now admits exactly 1-2 messages (the registered owner input plus the exact host runtime-context snapshot: source kind/form=snapshot, exactly one working-directory:current section with exact cwd text, exactly one text block with the exact rendered snapshot and a UUIDv4 id); any third/wrong-order/changed message still fails closed before any request. CoreDomain.unknown() now returns an already-unknown evaluation unchanged so the FIRST unknown reason is preserved and the reservation is not reconciled twice, and the bounded runner captures preStopEvaluation {evaluationId,status,reasonCode} immediately before its single stop action (bounded validator). CORE_VALIDATION_EXPERIMENT_V5 is frozen (exact-reference-only) and reconcile covers fixed [v1..v5]; focused 150/150 + regression 101/101 (net +8) and isolated 1671/1671; Lead integration isolated 1682/1682.',
    limitations: [
      'Offline/fake-host source only: the implementer ran no real host/model; the fifth real v5 attempt is separate failed evidence (round15-host-v5-create-success-context-rejected) and its create success does not make this slice a business acceptance.',
      'The pre-step admits ONLY the exact owner+runtime-context shape; any other host injection shape fails closed, and the real v5 attempt still failed with CORE_NATIVE_CONTEXT_REJECTED because the host-provided second message did not match the exact expected structural/text binding (the exact field-level difference is the next diagnostic target).',
      'Reason preservation keeps only the FIRST unknown reason by design; it does not fix the runtime-context claim shape, does not reconcile the v4/v5 unknown reservations, and does not authorize a sixth attempt.',
      'This source can NEVER be pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'round15PrestepFixStatus', path: 'artifacts/dsh/h3/h3-v5-decision-prestep-fix.json', jsonPath: 'status' },
      { label: 'round15PrestepFixNetNewTests', path: 'artifacts/dsh/h3/h3-v5-decision-prestep-fix.json', jsonPath: 'tests.netNew' },
      { label: 'round15PrestepFixIsolatedTests', path: 'artifacts/dsh/h3/h3-v5-decision-prestep-fix.json', jsonPath: 'verification.isolatedFullCheck.tests.tests' },
      { label: 'round15IntegrationTests', path: 'artifacts/dsh/integration/round15-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests' },
    ],
  },
  {
    id: 'round15-host-v5-create-success-context-rejected',
    commits: ['3d31da3', 'b59c8af'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15-bounded-core-goal-v5.json',
        sliceCommit: '3d31da3',
        blobCommit: 'b59c8af',
        expectedSha256: '7c1fe4234cc89250a23076c63ba9956c35fe9b1f0b7b01810b1cb1de00aedf3b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15/core-goal-v5-receipt.json',
        sliceCommit: '3d31da3',
        blobCommit: '3d31da3',
        expectedSha256: '274ce6dfb5c01b077b25ac64b51aad0c0f68d7891a853bcdfebacf95db8cdd51',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15/plan.json',
        sliceCommit: '3d31da3',
        blobCommit: '3d31da3',
        expectedSha256: '32e06b6f996a9ebed2334730a570965d4f34114288c6e7c82359ccb578efcf78',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15/round15-host-before.json',
        sliceCommit: '3d31da3',
        blobCommit: '3d31da3',
        expectedSha256: 'b50198aacd6853d1eeea5d060fe82477cdf810ab49b00f6e91c78a13108d76b5',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15/round15-host-after-reload.json',
        sliceCommit: '3d31da3',
        blobCommit: '3d31da3',
        expectedSha256: 'a9c4422fc75603c1d1cc06a734a1d4b13e2a14a5ab0af8b1e960cada9d2c318e',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15/round15-host-after-run.json',
        sliceCommit: '3d31da3',
        blobCommit: '3d31da3',
        expectedSha256: '489aa73540f9bc0f22999cc0915b0c3c0b7cf565976f852f556dec33de44fc61',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15/round15-host-final.json',
        sliceCommit: '3d31da3',
        blobCommit: '3d31da3',
        expectedSha256: 'f29e20259ed4f792546b34b8df8b12eab4175bdc0576bb6b5dd2fc74ba996046',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15/status-final.json',
        sliceCommit: '3d31da3',
        blobCommit: '3d31da3',
        expectedSha256: '6ab5b46acf2f85a0aa0dc26e4d9ae20426b09e3238eaa795112bd96bd0210724',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round15/v5-goal-session-events.json',
        sliceCommit: '3d31da3',
        blobCommit: '3d31da3',
        expectedSha256: '262513a860b817848c434bb45156bcc3407fb946b1adeec3ec543378354d0df1',
      },
    ],
    levels: ['fixed-host-create-succeeded-evaluation-failure'],
    scope: 'Round-15 fixed-host fifth independent bounded core Goal attempt (v5, explicit owner decision; not a v1-v4 retry) on the installed X=94251aa build (dist 114 files, digest 25cf9790...): create succeeded a SECOND time (authorized=true/active/mandate/confirmed binding/goalRef revision 1/exactly one Goal Session, partialCreation=false), and the reason-preservation fix worked — preStopEvaluation.reasonCode=CORE_NATIVE_CONTEXT_REJECTED (no longer masked as owner_paused); the single evaluation is CORE_VALIDATION_EVALUATION_UNKNOWN with evaluateAttempts=1 and 0 model requests (the 13-event Goal Session has title/goal-change/end-seed/inbox-spliced/turn-start/input-removed/turn-end-aborted/pause but NO request/assistant event); the stop policy paused the Goal; audit shows +14 commitSeq (476→490), goals 6→7, sessions 38→39, budget unknown 4→5 with held 16384/2, no events/Task/Effect/artifact and unchanged state/known Sessions; v4 AND v5 authorized/paused Goals with unknown reservations remain; the 67986-byte final status caches the failed receipt including preStopEvaluation.',
    limitations: [
      'It is a FAILED fifth attempt despite the second create success: evaluation is CORE_VALIDATION_EVALUATION_UNKNOWN with evaluateAttempts=1 and preStopEvaluation.reasonCode=CORE_NATIVE_CONTEXT_REJECTED (the preserved real reason, no longer owner_paused) while 0 model requests were issued (13 Goal-Session events contain no request/assistant event); this can NEVER be pass, V25, business or nine-system acceptance.',
      'The new precise blocker is the runtime-context claim shape: the step-0 pre-step admits 1-2 messages but the host-provided second runtime-context message did not match the exact expected structural/text binding; the exact field-level difference is not yet captured and is the next diagnostic target.',
      'Audit: +14 commitSeq (476→490), goals 6→7, sessions 38→39, budget unknown 4→5 (held 16384 tokens/calls 2), no events/Task/Effect/artifact and unchanged state/known Sessions; the v4 and v5 Goals plus their unknown reservations remain and must be disclosed/reconciled rather than silently cleared.',
      'No real business chain occurred (0 model requests, no plan/Task/worker/native completion); a sixth attempt is NOT authorized until the runtime-context binding fix plus an explicit owner decision, and the unknown budgets are preserved.',
    ],
    derive: [
      { label: 'round15V5Status', path: 'artifacts/dsh/host/round15-bounded-core-goal-v5.json', jsonPath: 'status' },
      { label: 'round15V5PreStopReason', path: 'artifacts/dsh/host/round15-bounded-core-goal-v5.json', jsonPath: 'result.preStopEvaluation.reasonCode' },
      { label: 'round15V5EvaluateAttempts', path: 'artifacts/dsh/host/round15-bounded-core-goal-v5.json', jsonPath: 'result.counters.evaluateAttempts' },
      { label: 'round15V5GoalAuthorized', path: 'artifacts/dsh/host/round15-bounded-core-goal-v5.json', jsonPath: 'result.goal.authorized' },
      { label: 'round15V5StopKind', path: 'artifacts/dsh/host/round15-bounded-core-goal-v5.json', jsonPath: 'result.stopAction.kind' },
      { label: 'round15V5BudgetHeldTokens', path: 'artifacts/dsh/host/round15-bounded-core-goal-v5.json', jsonPath: 'result.businessSideEffects.budget.held.tokens' },
      { label: 'round15V5StatusFinalBytes', path: 'artifacts/dsh/host/round15-bounded-core-goal-v5.json', jsonPath: 'cachedReceipt.bytes' },
    ],
  },
  {
    id: 'h7-round15-clean-artifacts',
    commits: ['b1c9061'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: 'b1c9061',
        blobCommit: 'b1c9061',
        expectedSha256: '6705aaaf5654e114a6c584e64e273e3b5311d1a29c239a8f9b327c99d6476df7',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: 'b1c9061',
        blobCommit: 'b1c9061',
        expectedSha256: 'e461798c2837e368af294a58103874df10ae03abf3ca1b1699f3d696ea07796e',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: 'b1c9061',
        blobCommit: 'b1c9061',
        expectedSha256: '4f304a74faca36588115a3bd1218f9dd24bb161cdf6ef7db801f3f6a45cee532',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round15 clean-VCS harness artifacts (X+1 of 94251aa, commit b1c9061): clean-X manifest (vcs head 94251aa, dirty=false, 407 files), traceability with 84 verified evidence sources/311 files and acceptance report (gate incomplete, executed=passed=0, product 79/79 not_covered).',
    limitations: [
      'Tooling evidence only: not product/host/model/business acceptance; product rows remain not_covered and the gate incomplete.',
      'Bound with blobCommit=b1c9061 + expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from the mutable worktree.',
      'Cannot upgrade V/S/FL/product rows or the nine-system gate.',
    ],
    derive: [{ label: 'round15CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round15-review',
    commits: ['b59c8af'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/round15-evidence-review.json',
        sliceCommit: 'b59c8af',
        blobCommit: 'b59c8af',
        expectedSha256: '151340e939be4db5c3e287c03a9bc16bcd4cf5604e11c6ded0c15c0beb2d0363',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/ROUND15-EVIDENCE-REVIEW.md',
        sliceCommit: 'b59c8af',
        blobCommit: 'b59c8af',
        expectedSha256: '3a3ea641f399784ec769a0572036f7aa4a0aabce9469a7b701259902c7a87088',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-15 independent evidence review metadata plus F15 dispositions (F15-R1 cachedReceipt bytes corrected to actual 67986/6ab5b46a; host v5 preStopEvaluation/context-rejection boundary and the v5 slice clean-refresh evidence reviewed; host fifth attempt left for round-16 mapping).',
    limitations: [
      'Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-16 v6 runtime-context binding / host first model request with empty stream evidence (H7-round17) ---------------- */
  {
    id: 'runtime-context-binding-v6',
    commits: ['fcb7604', 'dcede28'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-v6-decision-context-binding.json',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: 'de571cfa99f03a9791ce45a2d999aae0924776a05489bea0ee13c261bf428b5d',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/h3/h3-v6-runtime-index.patch',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: '54c21f474d68a18f0b172cc4336102c8da8f44458cb42021eeb4ea365386b8e3',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/h3-v6-context-binding-verify.json',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: '66ffe20c6d7d0534bce8f3619b0bab31db7282fea74297345433798a39ec4d84',
      },
      {
        path: 'plugins/shiyu/src/adapters/control-store/core-domain.ts',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: 'e264eef56ab8c1ce615512b7da3e4b3fac3bdd2ef75a69a22367e4781f21be9a',
      },
      {
        path: 'plugins/shiyu/src/adapters/dsh/core-decision.ts',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: 'a2b999e472f7ab05295be14f972ca599364f193e4e5201d88e92358463de4445',
      },
      {
        path: 'plugins/shiyu/src/adapters/dsh/goals.ts',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: 'fb213e156d9b8f6688d8383e5f0546dbc4883e55c6c9463e829514b4cd1e628c',
      },
      {
        path: 'plugins/shiyu/src/control/core-validation.ts',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: '26929d5eb5c61dbc1c05a905ac0767f9c24ecd6cb091ac5561e2fea7c5d98f65',
      },
      {
        path: 'plugins/shiyu/tests/core-domain.test.ts',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: 'c8fc1b46d53edbe3bcb2703717cc76e37d549b84c0176abbbc06bcd9ff2cf9e4',
      },
      {
        path: 'plugins/shiyu/tests/core-event-tools.test.ts',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: '1d59f876026dfb396a9062a2b79c7b57af71ad6447910616285d52fd6c661223',
      },
      {
        path: 'plugins/shiyu/tests/core-validation.test.ts',
        sliceCommit: 'fcb7604',
        blobCommit: 'fcb7604',
        expectedSha256: 'b9b0470f6c55c0eeecb3a029f915473a5922d0bdb565a97e28aff591154d9113',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/integration/round16-lead-integration.json',
        sliceCommit: 'dcede28',
        blobCommit: 'dcede28',
        expectedSha256: '6931ddfc42c3db3b7320baab7a029d105c5558ac13a75104aa745371d2ca501f',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/slices/round16-integrated-verify.json',
        sliceCommit: 'dcede28',
        blobCommit: 'dcede28',
        expectedSha256: 'a569dac8046f862bab47dbf38abcaef133f5031bb999fc1127e673cf7d485855',
      },
      {
        path: 'plugins/shiyu/src/index.ts',
        sliceCommit: 'dcede28',
        blobCommit: 'dcede28',
        expectedSha256: '7ae2914dae538e5bdb6f3917312bbdcd0580b58a9176cc18cf8b52b3006cb043',
      },
      {
        path: 'plugins/shiyu/src/runtime.ts',
        sliceCommit: 'dcede28',
        blobCommit: 'dcede28',
        expectedSha256: '96d68abda4be741d4d65dc42edc19dc29bd30bd03b4efebe8510a5c8aa5df437',
      },
      {
        path: 'plugins/shiyu/tests/host-diagnostics-tool.test.ts',
        sliceCommit: 'dcede28',
        blobCommit: 'dcede28',
        expectedSha256: '4e7ad90ae445834c3c4f7376e9323b74aa7a0b9b457100d3fa616d17c52039f2',
      },
    ],
    levels: ['offline-module', 'slice-verification'],
    scope: 'Round-16 decision pre-step runtime-context binding through the host assembly renderer + field-level controlled contextDiagnostic + frozen v6 experiment + fixed v1-v6 reconcile: the step-0 pre-step binds the host-assembled runtime-context claim by exact rendered hash or structural binding (source kind/form/section rendering/cwd), projects extra sections only when the assembly renders them and still admits exactly 1-2 messages whose first message is exactly the owner input; a third/wrong-order/bad context is rejected before any request. The controlled contextDiagnostic carries only mismatchKind/fieldNames/shaPrefixes (no body/path) and flows from the error through the unknown evaluation into preStopEvaluation while the FIRST unknown reason is preserved (never overwritten by the pause path). CORE_VALIDATION_EXPERIMENT_V6 is frozen (exact-reference-only) and reconcile covers the fixed targets [v1..v6]; offline isolated 1689/1689 and Lead integration isolated 1700/1700 (1682 baseline + 7 product tests + 10 H7-round16 + 1 v6 tool test).',
    limitations: [
      'Offline/fake-host source only: the implementer ran no real host/model. The sixth real v6 attempt is separate failed evidence (round16-host-v6-first-model-request-empty-stream): it finally reached the first real model request but the provider stream was empty, so this slice does not prove a completed model round, plan, Task/worker or native completion.',
      'The structural binding aligns the claim shape only; it does not surface or fix the empty provider stream, does not reconcile the v4/v5/v6 unknown reservations and does not authorize a seventh attempt.',
      'The contextDiagnostic is deliberately bounded (field names / hash prefixes only); it must not carry prompt text, paths, credentials or full request bodies.',
      'This source can NEVER be pass, V25, business or nine-system acceptance.',
    ],
    derive: [
      { label: 'round16BindingStatus', path: 'artifacts/dsh/h3/h3-v6-decision-context-binding.json', jsonPath: 'status' },
      { label: 'round16BindingNetNewTests', path: 'artifacts/dsh/h3/h3-v6-decision-context-binding.json', jsonPath: 'tests.netNew' },
      { label: 'round16BindingIsolatedTests', path: 'artifacts/dsh/h3/h3-v6-decision-context-binding.json', jsonPath: 'verification.isolatedFullCheck.tests.tests' },
      { label: 'round16IntegrationTests', path: 'artifacts/dsh/integration/round16-lead-integration.json', jsonPath: 'verification.leadIntegratedIsolatedCheck.tests' },
    ],
  },
  {
    id: 'round16-host-v6-first-model-request-empty-stream',
    commits: ['893f846', '9d41966'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16-bounded-core-goal-v6.json',
        sliceCommit: '893f846',
        blobCommit: '9d41966',
        expectedSha256: 'f451169be1b186c6045a938d8b10992db2b9890222a0f45db828b71af941a273',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16/core-goal-v6-receipt.json',
        sliceCommit: '893f846',
        blobCommit: '893f846',
        expectedSha256: '80afd9bd64daf4e9a28079e178e0be65ea7c43190dcb635fcf9d53470ab99de9',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16/plan.json',
        sliceCommit: '893f846',
        blobCommit: '893f846',
        expectedSha256: '1648f8744c95a9b10803c4912e84a51d006202f81530df85cbeea006dc582c1b',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16/round16-host-before.json',
        sliceCommit: '893f846',
        blobCommit: '893f846',
        expectedSha256: '4d04ddbd690cdf6cd51bdb92a6b297c23193d8a2d043f68829fc3bac0ed517f2',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16/round16-host-after-reload.json',
        sliceCommit: '893f846',
        blobCommit: '893f846',
        expectedSha256: '539e092c5ea3608f9ac24e19ae525a32820d63b8129d74825acb7cfd4b5b2ad2',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16/round16-host-after-run.json',
        sliceCommit: '893f846',
        blobCommit: '893f846',
        expectedSha256: '0cb56b36ce4f8a361de76012bf46d41b192cfcd11acc9c7492a46b0cbdf1955a',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16/round16-host-final.json',
        sliceCommit: '893f846',
        blobCommit: '893f846',
        expectedSha256: 'b4182d28d4e92946b068d5692e95d1a15696dba722c140fb252ddb669a3f0b6c',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16/status-final.json',
        sliceCommit: '893f846',
        blobCommit: '893f846',
        expectedSha256: 'ea856219cba7db02d5a27dfe34a7c94ad1e0e4a39718b48fea86cbb0ce185265',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/host/round16/v6-goal-session-events.json',
        sliceCommit: '893f846',
        blobCommit: '893f846',
        expectedSha256: '73d47588255c0d4e639ececcc60d5aedbba6a3b94e70cd7fefd51c45af793250',
      },
    ],
    levels: ['fixed-host-create-succeeded-evaluation-failure'],
    scope: 'Round-16 fixed-host sixth independent bounded core Goal attempt (v6, explicit owner decision; NOT a v1-v5 retry) on the installed X=dcede28 build (dist 114 files, digest eafa6e50...): create succeeded a THIRD time (authorized=true/active/mandate/confirmed binding/goalRef revision 1/exactly one Goal Session, partialCreation=false), and the assembly-rendered runtime-context binding was effective — the decision pre-step entered and the 21-event Goal Session contains step/start, the core system message, the owner user message, the host runtime-context user message, a request/header (provider=opencode-go, model=deepseek-v4.1-flash, the three mounted read-only event tools), a request/context (1M context window) and an assistant/attempt. This is the FIRST real model request in the whole validation series; however the provider stream was EMPTY (assistant/attempt streamLength=0), the turn aborted (turn/end "Core decision cancelled") and the single evaluation became CORE_VALIDATION_EVALUATION_UNKNOWN with preStopEvaluation.reasonCode=CORE_EXECUTION_UNCONFIRMED (reason preserved, not masked), evaluateAttempts=1, no token usage and no retry. The stop policy paused the Goal; the audit shows +14 commitSeq (496→510), goals 7→8, sessions 39→40, budget unknown 5→6 with held 16384/2, no events/Task/Effect/artifact and unchanged state/known Sessions; the v4, v5 and v6 authorized/paused Goals with unknown reservations remain; the 70,221-byte final status caches the failed receipt including preStopEvaluation; the seventh attempt is NOT authorized.',
    limitations: [
      'It is a FAILED sixth attempt despite the third create success: the decision round reached the real model layer and emitted request/header + request/context with the three read-only event tools, but the provider stream was EMPTY (assistant/attempt streamLength=0) and the run aborted before any assistant message, so the single evaluation is CORE_VALIDATION_EVALUATION_UNKNOWN with preStopEvaluation.reasonCode=CORE_EXECUTION_UNCONFIRMED (preserved), evaluateAttempts=1, 0 usage and no completed stream; this can NEVER be pass, V25, business or nine-system acceptance.',
      'The exact provider/stream error is not yet surfaced: whether the empty stream is a provider/transport error, a request-shape rejection or a timeout remains unknown and must be instrumented next; no completed model stream, no token usage and no plan/Task/worker/native completion were observed.',
      'Audit: +14 commitSeq (496→510), goals 7→8, sessions 39→40, budget unknown 5→6 (held 16384 tokens/calls 2), no events/Task/Effect/artifact and unchanged state/known Sessions; the v4, v5 and v6 Goals plus their unknown reservations remain and must be reconciled or disclosed rather than silently cleared.',
      'No real business chain occurred (no completed model stream, 0 usage, no plan/Task/worker/native completion); the seventh attempt is NOT authorized until the empty-stream error is instrumented and fixed plus an explicit owner decision, and the v4/v5/v6 unknown budgets are preserved.',
    ],
    derive: [
      { label: 'round16V6Status', path: 'artifacts/dsh/host/round16-bounded-core-goal-v6.json', jsonPath: 'status' },
      { label: 'round16V6PreStopReason', path: 'artifacts/dsh/host/round16-bounded-core-goal-v6.json', jsonPath: 'result.preStopEvaluation.reasonCode' },
      { label: 'round16V6EvaluateAttempts', path: 'artifacts/dsh/host/round16-bounded-core-goal-v6.json', jsonPath: 'result.counters.evaluateAttempts' },
      { label: 'round16V6StopKind', path: 'artifacts/dsh/host/round16-bounded-core-goal-v6.json', jsonPath: 'result.stopAction.kind' },
      { label: 'round16V6BudgetHeldTokens', path: 'artifacts/dsh/host/round16-bounded-core-goal-v6.json', jsonPath: 'result.businessSideEffects.budget.held.tokens' },
      { label: 'round16V6SessionEventCount', path: 'artifacts/dsh/host/round16-bounded-core-goal-v6.json', jsonPath: 'sessionEvents.count' },
      { label: 'round16V6StatusFinalBytes', path: 'artifacts/dsh/host/round16-bounded-core-goal-v6.json', jsonPath: 'cachedReceipt.bytes' },
    ],
  },
  {
    id: 'h7-round16-clean-artifacts',
    commits: ['40df964'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/manifest.json',
        sliceCommit: '40df964',
        blobCommit: '40df964',
        expectedSha256: '48c91d63bc9110f9e1ea20e6516e2b82909e851adfea71846b762d4b89d12c95',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/traceability.json',
        sliceCommit: '40df964',
        blobCommit: '40df964',
        expectedSha256: 'f4bd91031c21641d80115c0e07654b3427873208100446ac505560c4988ec595',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/harness/acceptance-report.json',
        sliceCommit: '40df964',
        blobCommit: '40df964',
        expectedSha256: '250e45c85dc99a39302b257bd8451b45e8715f68ab684001a3ea8680e1096964',
      },
    ],
    levels: ['offline-module'],
    scope: 'H7-round16 clean-VCS harness artifacts (X+1 of dcede28, commit 40df964): clean-X manifest (vcs head dcede28, dirty=false, 407 files, generatedAt 2026-11-03T16:51:35.805Z), traceability with 88 verified evidence sources/339 files and acceptance report (gate incomplete, executed=passed=0, product 79/79 not_covered).',
    limitations: [
      'Tooling evidence only: not product/host/model/business acceptance; product rows remain not_covered and the gate incomplete.',
      'Bound with blobCommit=40df964 + expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from the mutable worktree.',
      'Cannot upgrade V/S/FL/product rows or the nine-system gate.',
    ],
    derive: [{ label: 'round16CleanGate', path: 'artifacts/dsh/harness/acceptance-report.json', jsonPath: 'gate.overall' }],
  },
  {
    id: 'round16-review',
    commits: ['9d41966'],
    files: [
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/round16-evidence-review.json',
        sliceCommit: '9d41966',
        blobCommit: '9d41966',
        expectedSha256: '9cb684b1726da4b85d6328c9bd8a2f2b97a57f46b83a831d8a1c4cbe0105f7aa',
      },
      {
        path: 'plugins/shiyu/artifacts/dsh/verify/ROUND16-EVIDENCE-REVIEW.md',
        sliceCommit: '9d41966',
        blobCommit: '9d41966',
        expectedSha256: '060fedfcbf91caaa264286ea8752d73367e03915420804f7d0a171a3d500829e',
      },
    ],
    levels: ['independent-review-info'],
    scope: 'Round-16 independent evidence review metadata plus F16 dispositions (F16-R1 cachedReceipt bytes corrected to the actual 70221 bytes of status-final.json with sha ea856219... and bytesSemantics; F16-R2 createSuccess now distinguishes the create-time bindingReceiptStatus absent from the final confirmed binding; F16-R3 empty provider stream/new blocker info; host sixth v6 attempt boundary and H7 X+1 verified; round-16 host attempt left for round-17 mapping).',
    limitations: [
      'Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.',
      'Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.',
      'Cannot upgrade V/S/FL/product rows or nine-system gate.',
    ],
  },
  /* ---------------- round-17 P0 memory / emotion continuation / writable workspace / v7 stream instrumentation evidence (H7-round18) ---------------- */
  {
    id: "h2d-single-user-memory-chat",
    commits: ["fc9daae"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/h2/h2d-single-user-memory-chat.json",
        sliceCommit: "fc9daae",
        blobCommit: "fc9daae",
        expectedSha256: "e9d2b2e3e09d846c54e287af79df203383d04e0818a589cc0cdb752222208b3f",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h2/runtime-memory-readiness.patch.diff",
        sliceCommit: "fc9daae",
        blobCommit: "fc9daae",
        expectedSha256: "b6e06c337b143346e38b4fd2ab96a96c3af1ab72825204625facb2d0b1e02f9f",
      },
      {
        path: "plugins/shiyu/src/adapters/control-store/memory-index-domain.ts",
        sliceCommit: "fc9daae",
        blobCommit: "fc9daae",
        expectedSha256: "7c93d5001c2bcdbe0e247c3eea815c9c214ce731dc29e6149edd2f4ee9736e81",
      },
      {
        path: "plugins/shiyu/src/adapters/control-store/worker.ts",
        sliceCommit: "fc9daae",
        blobCommit: "fc9daae",
        expectedSha256: "3273aaffa59b35a449242a4b69a80afce607305abba545d214eb3ec6fddfb3c0",
      },
      {
        path: "plugins/shiyu/src/adapters/ombre/readiness.ts",
        sliceCommit: "fc9daae",
        blobCommit: "fc9daae",
        expectedSha256: "dce490b04d20e1aec87e7b1004babf40c0e35ba620bd70fee00e1a404c053616",
      },
      {
        path: "plugins/shiyu/src/runtime.ts",
        sliceCommit: "fc9daae",
        blobCommit: "fc9daae",
        expectedSha256: "6e74aaaa9c2075e2e7066090a2ef9a40582c6d60512995b67c26c283d191513c",
      },
      {
        path: "plugins/shiyu/tests/memory-single-user-chat.test.ts",
        sliceCommit: "fc9daae",
        blobCommit: "fc9daae",
        expectedSha256: "79030a7e8f7e5b8e7ab7c34b278c953a68891633100a972667a9da210952f908",
      },
      {
        path: "plugins/shiyu/tests/ombre-readiness.test.ts",
        sliceCommit: "fc9daae",
        blobCommit: "fc9daae",
        expectedSha256: "80034afab055b73088fa2d2667e78084dd9ef14e48286fcddcc3327bf9bc7be5",
      },
    ],
    levels: ["offline-module"],
    scope: "H2d P0 single-user memory chat offline slice (author isolated worktree at baseline 9d41966 + 5 slice files, full check 1716/1716 pass/0 fail/0 skip): a readiness module gates semantic_search behind a real verified embedding (profile compatibility plus non-empty index coverage) and otherwise publishes exact_read only with explicit EMBEDDING_UNVERIFIED/INDEX_COVERAGE_INCOMPLETE reasons; the owner-only memory.searchLocal verification path and memory capability publication were added, with targeted tests ombre-readiness 9/9 and memory-single-user-chat 7/7 over a real temporary SQLite/Worker and a fake native driver; the runtime.ts/index.ts changes are delivered as a patch (runtime-memory-readiness.patch.diff) and were NOT applied or host-executed by the implementer.",
    limitations: [
      "Offline/fake-backend only: the fixture embedding/search backend is in-process; it does not prove Harrier retrieval quality, real host readiness, restart recall or model-visible multi-turn recall (hostKit pending).",
      "The single-user chat closure and restart recall still require a Lead-executed host run with a real native Session/binding; this source never claims host/business acceptance.",
      "P0 covers one user only; multi-task concurrency, multi-channel, multi-day stability and emotion behavior remain deferred; no generation model was called.",
      "This source can NEVER be pass, V25, business or nine-system acceptance.",
    ],
    derive: [
      { label: "h2dReadinessStatus", path: "artifacts/dsh/h2/h2d-single-user-memory-chat.json", jsonPath: "status" },
      { label: "h2dAuthorIsolatedTests", path: "artifacts/dsh/h2/h2d-single-user-memory-chat.json", jsonPath: "verification.isolatedWorktree.tests" },
    ],
  },
  {
    id: "h2d-host-memory-embedding-verification",
    commits: ["67bf0bc", "ab08779"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/h2/host/before-embedding-verification.json",
        sliceCommit: "67bf0bc",
        blobCommit: "67bf0bc",
        expectedSha256: "96ae748a4bdfb7fd9ed10a9e3feb90fbe68bc5695bdd823ebcbf3c65ec42d370",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h2/host/after-embedding-verification.json",
        sliceCommit: "67bf0bc",
        blobCommit: "67bf0bc",
        expectedSha256: "8c560e0fc5d251fbcab37e0dcb87882dc13792b6785674d42edf93ff0f8cb9ef",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h2/host/final.json",
        sliceCommit: "67bf0bc",
        blobCommit: "67bf0bc",
        expectedSha256: "da1eed0ecf89be2ec6245068f6ea468a3dd7b7b4860c53ab571cd99f1c906a07",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h2/host/memory-probe-operations.json",
        sliceCommit: "67bf0bc",
        blobCommit: "67bf0bc",
        expectedSha256: "ff42638747643aa4d9b61822525f0723cbd63b1dcfd22b44ca1cdf8131ebf798",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h2/host/memory-readiness-status.json",
        sliceCommit: "67bf0bc",
        blobCommit: "67bf0bc",
        expectedSha256: "a2e6eb168a07f31b030d5d2401eb1b85dc40d1c1a9a0d2719288f4129d4e12cd",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h2/host/status-final.json",
        sliceCommit: "67bf0bc",
        blobCommit: "67bf0bc",
        expectedSha256: "4ac9e162bcada358e0127e8b724cbef37e39cba389a0a55e63904fb418f28af6",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h2/h2d-host-memory-embedding-verification.json",
        sliceCommit: "67bf0bc",
        blobCommit: "ab08779",
        expectedSha256: "ef8bf08f34301902721d44946e2b57d47db2dc2436d4d750332cdc9495bbd45e",
      },
    ],
    levels: ["offline-module", "fixed-host-zero-model"],
    scope: "Round-17 fixed-host P0 memory embedding round-trip (67bf0bc; F17-R1 byte accounting corrected at ab08779) on the installed round-17 build: write one synthetic memory fact into an existing local conversation, index it with the real Harness Harrier embedding backend, run one semantic search and one exact read, withdraw it and verify post-withdraw rejection; the receipt reports ok=true, 5/5 steps passed, embeddingCalls=1 and searchEmbeddingCalls=1 with usageComplete=true, 1 match and semanticHit=true, exactReadBodyMatched=true and postWithdrawRejected with MEMORY_READ_FORBIDDEN; readinessBefore was exact_read/EMBEDDING_UNVERIFIED and readinessAfter is exact_read+semantic_search with embeddingVerified=true/semanticReady=true (reason INDEX_COVERAGE_INCOMPLETE); the audit shows +10 commitSeq (546→556) with sessions and the runtime-state file unchanged and no generation model; the 68173-byte final status caches the readiness/capabilities evidence.",
    limitations: [
      "Fixed-host zero-model verification only: the real Harrier embedding ran locally but no generation model was called, so this does not prove model-visible multi-turn recall, chat closure or restart recall.",
      "Only synthetic, withdrawn probe facts exist: index coverage stays incomplete (readable/indexed 0, stale entries) and synthetic withdrawn/blocked memory operations remain as disclosed side effects; no cleanup was attempted.",
      "Embedding verification is per-process; a startup/first-search verification path for seamless restart is still missing.",
      "This source can NEVER be pass, V25, business or nine-system acceptance.",
    ],
    derive: [
      { label: "h2dHostStatus", path: "artifacts/dsh/h2/h2d-host-memory-embedding-verification.json", jsonPath: "status" },
      { label: "h2dHostSemanticHit", path: "artifacts/dsh/h2/h2d-host-memory-embedding-verification.json", jsonPath: "receipt.semanticHit" },
      { label: "h2dHostEmbeddingCalls", path: "artifacts/dsh/h2/h2d-host-memory-embedding-verification.json", jsonPath: "receipt.embeddingCalls" },
      { label: "h2dHostStatusFinalBytes", path: "artifacts/dsh/h2/h2d-host-memory-embedding-verification.json", jsonPath: "statusFinal.bytes" },
    ],
  },
  {
    id: "h4f-emotion-continuation",
    commits: ["e860ac8", "928c8f1"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/h4/h4f-emotion-runtime.patch.diff",
        sliceCommit: "e860ac8",
        blobCommit: "e860ac8",
        expectedSha256: "984edfa7654c85be8519d3599fdf424d62d38a1c923509a58fbccd1a8ef7caeb",
      },
      {
        path: "plugins/shiyu/src/adapters/control-store/emotion-continuation-probe.ts",
        sliceCommit: "e860ac8",
        blobCommit: "e860ac8",
        expectedSha256: "63949c7a130d0558a71eb21e290df79a60a451641cfe8a6d195231ae1e17b185",
      },
      {
        path: "plugins/shiyu/src/adapters/control-store/emotion-domain.ts",
        sliceCommit: "e860ac8",
        blobCommit: "e860ac8",
        expectedSha256: "5fe72794f6121eb4822b72d5f0b8600d7886205ab8f0b27e829b776de1874593",
      },
      {
        path: "plugins/shiyu/src/contracts/inner.ts",
        sliceCommit: "e860ac8",
        blobCommit: "e860ac8",
        expectedSha256: "e8edd13d1fd05fcfc4f9824d959259cfd6ffcbfabfd00eff6a3357e372888f0a",
      },
      {
        path: "plugins/shiyu/src/index.ts",
        sliceCommit: "e860ac8",
        blobCommit: "e860ac8",
        expectedSha256: "be63c8781ebf7f8a6b8071071dda4d81fac8f73f408a161c828303e798d2da90",
      },
      {
        path: "plugins/shiyu/src/runtime.ts",
        sliceCommit: "e860ac8",
        blobCommit: "e860ac8",
        expectedSha256: "e8bdacdd639864142864053fb482de41f0ed539dedc2c120ee005c1ecaf3234c",
      },
      {
        path: "plugins/shiyu/tests/emotion-continuation.test.ts",
        sliceCommit: "e860ac8",
        blobCommit: "e860ac8",
        expectedSha256: "6772026c20f6246049005f08d4b4f8745e4c783743773b5420d1b9db86df467d",
      },
      {
        path: "plugins/shiyu/tests/host-diagnostics-tool.test.ts",
        sliceCommit: "e860ac8",
        blobCommit: "e860ac8",
        expectedSha256: "30e7edf87e630fa7b3d52311adb0c54ccdf67166de5995edb0c46d8b70a9cfd3",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h4/h4f-emotion-continuation.json",
        sliceCommit: "e860ac8",
        blobCommit: "928c8f1",
        expectedSha256: "eb1a54e07a9abd2c36f07bef67bbaefe656682a38e55af6e9bea4b9f7905a03b",
      },
    ],
    levels: ["offline-module"],
    scope: "H4f emotion-continuation offline slice (e860ac8; evidence JSON extended at 928c8f1 with the host-probe result): a read-only emotion-continuation context command/probe exposes the current emotion state and recent emotion events with source/version/time plus audience trimming, withdrawal refusal and bounded degradation, and an owner-only isolated :memory: probe covers 7 steps/15 checks; the isolated worktree at 20364bc + 4 slice files passed full check 1727/1727 (targeted emotion-continuation 10/10) with a runtime+index patch delivered as a diff that the implementer did NOT apply or host-execute.",
    limitations: [
      "Offline slice + isolated in-memory probe only: no live-chat owner write path/background projection was implemented and the implementer performed no host reload; the host probe is separate limited evidence (round17-host-emotion-memory-probes).",
      "It exposes a read-only local candidate dimension only: upstream Ombre valence/arousal metadata is NOT carried by the DSH memory contract, no metadata is written, no dimensional mapping is guessed and Ombre pulse is never treated as emotion.",
      "decay/review are fixed versioned policies, not a human psychological model; this never claims subjective experience, long-term personality or model self-report authority.",
      "This source can NEVER be pass, V25, business or nine-system acceptance.",
    ],
    derive: [
      { label: "h4fStatus", path: "artifacts/dsh/h4/h4f-emotion-continuation.json", jsonPath: "status" },
      { label: "h4fIsolatedTests", path: "artifacts/dsh/h4/h4f-emotion-continuation.json", jsonPath: "verification.isolatedWorktree.tests" },
      { label: "h4fTargetedTests", path: "artifacts/dsh/h4/h4f-emotion-continuation.json", jsonPath: "verification.targeted.count" },
    ],
  },
  {
    id: "round17-host-emotion-memory-probes",
    commits: ["928c8f1"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/host/round17-joint-emotion-memory.json",
        sliceCommit: "928c8f1",
        blobCommit: "928c8f1",
        expectedSha256: "1798c2340badddb7e17315fe8a212df9bd8acd25f5010464ff28b35d620fc285",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round17/emotion-probe-receipt.json",
        sliceCommit: "928c8f1",
        blobCommit: "928c8f1",
        expectedSha256: "091024b6d9ab96bbceb1a89898faf04f6b820764061d56ad4f3e6e2777218677",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round17/memory-embedding-receipt.json",
        sliceCommit: "928c8f1",
        blobCommit: "928c8f1",
        expectedSha256: "46f596103ada06d448b3d410258a26edae332ce2506db33629ea64c3f30d3700",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round17/round17-host-before.json",
        sliceCommit: "928c8f1",
        blobCommit: "928c8f1",
        expectedSha256: "2a4b76563384ef50b83e66e27cf208e079f44f6c5abf387f18599e05474e5a10",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round17/round17-host-after-reload.json",
        sliceCommit: "928c8f1",
        blobCommit: "928c8f1",
        expectedSha256: "7a21a290f1c783c7d9fff113645a0319e453b39bd0b313334bdf4807b2980cc2",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round17/round17-host-after-probes.json",
        sliceCommit: "928c8f1",
        blobCommit: "928c8f1",
        expectedSha256: "3137435ccde0c924eaa5c51849fea17a52c4754838dde8cdb2ad9ae6e9fcc69b",
      },
    ],
    levels: ["fixed-host-zero-model"],
    scope: "Round-17 fixed-host zero-model joint probe (928c8f1) on the installed round-17 build: after one ordered reload the owner-only emotion-continuation probe passed 15/15 checks in a private :memory: store with zero model/embedding/Task/Effect/send activity and liveDataTouched=false (explicit disclosure: no subjective experience, no long-term personality, no model self-report authority, Ombre pulse not treated as emotion; store closed, worker terminated), and the P0 memory round-trip passed again with one real index embedding plus one real search embedding, 1 semantic match, exact body match, post-withdraw MEMORY_READ_FORBIDDEN and readiness flipped to embeddingVerified/semanticReady with capabilities exact_read+semantic_search; the reload/audit shows normal startup writes and only the memory round-trip added +10 commitSeq (563→573) with sessions/goals/events/runtime-state unchanged.",
    limitations: [
      "Zero generation model and zero real chat: the emotion probe is isolated in-memory (not live conversational emotion behavior) and the memory round-trip leaves one withdrawn synthetic operation with unpopulated coverage (readable 0/stale entries).",
      "Embedding verification is per-process: after a reload readiness falls back to exact_read until an explicit embedding succeeds again; seamless restart chat still needs a startup verification path.",
      "It does not prove subjective experience, long-term personality, model-visible multi-turn recall or business acceptance; this can NEVER be pass, V25, business or nine-system acceptance.",
    ],
    derive: [
      { label: "round17JointStatus", path: "artifacts/dsh/host/round17-joint-emotion-memory.json", jsonPath: "status" },
      { label: "round17EmotionChecksPassed", path: "artifacts/dsh/host/round17-joint-emotion-memory.json", jsonPath: "emotionProbe.checksPassed" },
      { label: "round17EmotionLiveDataTouched", path: "artifacts/dsh/host/round17-joint-emotion-memory.json", jsonPath: "emotionProbe.liveDataTouched" },
      { label: "round17MemoryEmbeddingCalls", path: "artifacts/dsh/host/round17-joint-emotion-memory.json", jsonPath: "memoryRoundTrip.embeddingCalls" },
    ],
  },
  {
    id: "workspace-shared-hardlink",
    commits: ["cce6deb", "ab08779"],
    files: [
      {
        path: "plugins/shiyu/src/adapters/artifacts/SHARED_WORKSPACE.md",
        sliceCommit: "cce6deb",
        blobCommit: "cce6deb",
        expectedSha256: "cd72f227c1e8a219a03076a3e7bc95150217957efd33ea02a4f35523447a8ef7",
      },
      {
        path: "plugins/shiyu/src/adapters/artifacts/index.ts",
        sliceCommit: "cce6deb",
        blobCommit: "cce6deb",
        expectedSha256: "09138ac806be345c3a380c706672042bed535fe00cb7f42b28828f35a1704f27",
      },
      {
        path: "plugins/shiyu/src/adapters/artifacts/shared-workspace.ts",
        sliceCommit: "cce6deb",
        blobCommit: "cce6deb",
        expectedSha256: "68f7b1cc35ee3293298baaaf72c1b131866b363d6da836fe81271f950c217afb",
      },
      {
        path: "plugins/shiyu/tests/workspace-shared-hardlink.test.ts",
        sliceCommit: "cce6deb",
        blobCommit: "cce6deb",
        expectedSha256: "45ca1e5964d14842ff4c837b7e1a05cb6b1073df2995f2724a3704a0cabf9481",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/tasks/workspace-shared-hardlink.json",
        sliceCommit: "cce6deb",
        blobCommit: "ab08779",
        expectedSha256: "c942d80563e0af6c81320f21affa2c91a1ba21b3c61eb46a35155fa85488b27c",
      },
    ],
    levels: ["offline-module"],
    scope: "P0 writable per-task workspace offline module (cce6deb; evidence JSON F17-R2 self-hash corrected at ab08779): {dataDir}/workspaces/<taskId>/{task,shared} mirrors the configured shared workspace by FILE HARD LINKS only (directories recreated; symlinks, external inodes and cross-device targets rejected), discloses that in-place task writes propagate to the canonical shared source, publishes task-created shared files through a controlled action (never silently dropped), deletes only the task-side link by default with shared deletion requiring an explicit owner decision, keeps a pre-task manifest (path/dev/ino/nlink/size/mtime/sha256 plus integrity hash) and an exclusive single-writer lock, and treats unexpected conflicts as unknown/blocked without advancing the shared index; artifact publication remains unchanged; the isolated-worktree full check at baseline 9d41966 passed 1715/1715 with 11/11 workspace cases.",
    limitations: [
      "G1 offline filesystem module only: runtimeWired=false (runtime/index integration not applied), liveHost=false, zero model calls and no real workspace touched; the optional APFS clone snapshot is unverified.",
      "Single-writer/exclusive-lock assumption only: external concurrent writers, long-run rollback drills and crash consistency are not supported/proven; the writable-shared semantics (in-place writes become visible to other tasks) are a deliberate disclosed tradeoff, not isolation.",
      "This source can NEVER be pass, V25, business or nine-system acceptance.",
    ],
    derive: [
      { label: "workspaceCases", path: "artifacts/dsh/tasks/workspace-shared-hardlink.json", jsonPath: "summary.total" },
      { label: "workspacePassed", path: "artifacts/dsh/tasks/workspace-shared-hardlink.json", jsonPath: "summary.passed" },
      { label: "workspaceRuntimeWired", path: "artifacts/dsh/tasks/workspace-shared-hardlink.json", jsonPath: "boundaries.runtimeWired" },
    ],
  },
  {
    id: "h3-v7-stream-error-instrumentation",
    commits: ["fa9e880", "bcb252f"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/h3/h3-v7-stream-error-instrumentation.json",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "6feb6d386b4ed563f4ccaf694cfdcb80f13562dbc59f348ab155535f33d4b4dc",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h3/h3-v7-runtime-index.patch",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "5eebfba01c0192cf106c323577885cae5654e7bb2ca73f4d2146bed927317f1c",
      },
      {
        path: "plugins/shiyu/src/adapters/control-store/core-domain.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "660c55f96e66156268f7ff152239461c28b3121990274a191913d24f777f980f",
      },
      {
        path: "plugins/shiyu/src/adapters/dsh/core-decision.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "a663d0d0089e545b9b50f8ee31ab4e2a59b499a17af6f58e42f618f6ba6d9323",
      },
      {
        path: "plugins/shiyu/src/control/core-validation.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "d1542a059fc0cfac137d36dc901372da9c10861c8aee65e574d39f5dde427fe1",
      },
      {
        path: "plugins/shiyu/src/index.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "b08c57e6df00218c991e5e193975fbbecd4c8ee87c3e865dab98aac1a9d06b15",
      },
      {
        path: "plugins/shiyu/src/runtime.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "bd9bf427184a9253bd093b2354f4d22bbc684403bea12fc8066e5f4a9717f55b",
      },
      {
        path: "plugins/shiyu/tests/core-domain.test.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "2562f128ef1f88b412c39c0378f14147953f065ec19bd7628f545de59fd4152f",
      },
      {
        path: "plugins/shiyu/tests/core-event-tools.test.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "b6ed1a9d45b973d440f18a5b195e3aa72f4e90306e925cf86548344247c81ff9",
      },
      {
        path: "plugins/shiyu/tests/core-validation.test.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "116ff70f935892949f80a659d64ce9bb7f63055c9fb4b9107857ce163ba5a3ca",
      },
      {
        path: "plugins/shiyu/tests/host-diagnostics-tool.test.ts",
        sliceCommit: "fa9e880",
        blobCommit: "fa9e880",
        expectedSha256: "bbb6f751fa7d459241b9ed6a095dea9e81d507c697666e5f722713bf07250b89",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/slices/h3-v7-stream-error-verify.json",
        sliceCommit: "fa9e880",
        blobCommit: "bcb252f",
        expectedSha256: "029985296800b298b70e557dd240e8e846ab892093a26f36c9efc955e9126ed4",
      },
    ],
    levels: ["offline-module", "slice-verification"],
    scope: "Round-17 provider-stream error instrumentation plus frozen v7 experiment preparation (fa9e880; isolated slice verification artifact bcb252f): preStopEvaluation.streamDiagnostic is a bounded field-level diagnostic {category, code, name, chunks, abortedBeforeFirstChunk, abortedAfterFirstChunk, timedOut, message} with categories empty-provider-stream/transport/auth/request-shape/timeout/aborted/unknown (provider internals are never guessed and messages are bounded with no body/path leak), the Goal Session summary is bounded, CORE_VALIDATION_EXPERIMENT_V7 is frozen exact-reference-only and reconcile covers the fixed targets [v1..v7]; focused 167/167 plus regression 101/101 (net +8), and the isolated slice verification at 9d41966 passed 1710/1710 with exit 0; the real host seventh attempt was NOT executed by the implementer.",
    limitations: [
      "Offline instrumentation only: realModelExecutedByImplementer=false, hostReloads=0 and the frozen v7 attempt (core-validation-frozen-v7) was NOT executed; the seventh attempt is NOT authorized.",
      "The stream diagnostic classifies the failure but does not fix the provider empty-stream root cause; whether the v6 empty stream is transport, request-shape or timeout remains unknown until a v7 host attempt is explicitly authorized.",
      "v4/v5/v6 (and the pending v7) unknown reservations remain; this proves instrumentation/classification only, not a completed model round, business chain, V25 or nine-system acceptance and can NEVER be pass.",
    ],
    derive: [
      { label: "v7Status", path: "artifacts/dsh/h3/h3-v7-stream-error-instrumentation.json", jsonPath: "status" },
      { label: "v7NetNewTests", path: "artifacts/dsh/h3/h3-v7-stream-error-instrumentation.json", jsonPath: "tests.netNew" },
      { label: "v7RequestId", path: "artifacts/dsh/h3/h3-v7-stream-error-instrumentation.json", jsonPath: "experimentV7.requestId" },
      { label: "v7SliceTests", path: "artifacts/dsh/slices/h3-v7-stream-error-verify.json", jsonPath: "check.tests.tests" },
    ],
  },
  {
    id: "h7-round17-clean-artifacts",
    commits: ["4110d35"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/harness/manifest.json",
        sliceCommit: "4110d35",
        blobCommit: "4110d35",
        expectedSha256: "7eb07b032d8c257934ba153ea765648292ae7254e5bbdcd1026de3ad9b6d0403",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/harness/traceability.json",
        sliceCommit: "4110d35",
        blobCommit: "4110d35",
        expectedSha256: "32093d1e8fcc2d9c646ff837ce5659f7857ee748b69bb87de0543dc1fb88aada",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/harness/acceptance-report.json",
        sliceCommit: "4110d35",
        blobCommit: "4110d35",
        expectedSha256: "0b8c304ccba2b12c6424f469e34a3c256267a1468da57fe0eb50284957a3ae46",
      },
    ],
    levels: ["offline-module"],
    scope: "H7-round17 clean-VCS harness artifacts (X+1 of 6f6268d, commit 4110d35): clean-X manifest (vcs head 6f6268d, dirty=false, 417 files), traceability with 92 verified evidence sources/368 files and acceptance report (gate incomplete, executed=passed=0, product 79/79 not_covered).",
    limitations: [
      "Tooling evidence only: not product/host/model/business acceptance; product rows remain not_covered and the gate incomplete.",
      "Bound with blobCommit=4110d35 + expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from the mutable worktree.",
      "Cannot upgrade V/S/FL/product rows or the nine-system gate.",
    ],
    derive: [
      { label: "round17CleanGate", path: "artifacts/dsh/harness/acceptance-report.json", jsonPath: "gate.overall" },
    ],
  },
  {
    id: "round17-review",
    commits: ["ab08779"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/verify/ROUND17-EVIDENCE-REVIEW.md",
        sliceCommit: "ab08779",
        blobCommit: "ab08779",
        expectedSha256: "09fa25eba349e2f2dd79d77c9c835f7be7b767988679d9aac7968ea46b6765fa",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/verify/round17-evidence-review.json",
        sliceCommit: "ab08779",
        blobCommit: "ab08779",
        expectedSha256: "179b1e5236a864e5e4b3a81072de2d1b8f8df5ba12207d10a665ffb056e1f943",
      },
    ],
    levels: ["independent-review-info"],
    scope: "Round-17 independent evidence review metadata plus F17 dispositions (F17-R1 h2d host statusFinal byte accounting corrected to the actual 68173 bytes/4ac9e162 sha with bytesSemantics; F17-R2 workspace evidence self-hash refreshed/excluded while the other file facts match their committed blobs; F17-R3 synthetic-memory counts 3/stale 4 disclosed; P0 memory, workspace, emotion continuation, stream/v7 classification and H7 X+1 reviewed; host round-17 probes and round-18 mapping left to later rounds).",
    limitations: [
      "Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.",
      "Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.",
      "Cannot upgrade V/S/FL/product rows or nine-system gate.",
    ],
  },
  /* ---------------- round-18 P0 chat-memory failure / startup embedding verification / TaskRunner workspace integration evidence (H7-round19) ---------------- */
  {
    id: "round18-host-p0-chat-memory",
    commits: ["3673395", "15d86ee"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/h2/host-status-r18-reload1.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "b687bd255f5585e8fbfadb49509e4cc18f970e54b0c2dd0f1b8ecc7d53ab4b57",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/plan.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "aac957a91314ae2d9e54a37f7a1aa6576436d1f1367e5cb47d944207ecfdf533",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/host-before.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "122609e9aae1231a4a464ecd3b84745c52014486da2eaf6db7c518ea5ccdb115",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/host-after-write1.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "2e806d633feb5b018f3dbf44acf7e08937e31a07ef46dfb6f1b5c8397370e9cb",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/host-after-write2.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "39867ad29728b10418da16b9530c6dc1f1c9e4d31619222467495afc7e3368cd",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/host-before-retry.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "55ec51d86abda60567138a1f106b84dcdc7d59c8cafdf33e1ba664709616a20f",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/host-after-reload1.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "3b8d5aaffbf0741637dd2cb0de26a2b3675c78965374c27b72a54fbf7b369f94",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/host-after-reload2.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "5520564ad2d34a92e72bd045bfd1ebf2655543933959e4a697b15a51e6c98a99",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/host-final.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "5f79efa37869336e4873b347f3300d40da542f476916be9d319a6f82239b387a",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/reply-failures.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "c12b5371d1f4cd2eac6cdd7b21aab1175ce728ba99dfea5c5043fe5d67746c7f",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/status-extract.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "dad4725ded485cb30dfade4cf3f9db4499302fe963e0dc9c04390bab21740fb7",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18/status-final.json",
        sliceCommit: "3673395",
        blobCommit: "3673395",
        expectedSha256: "4edb455a1583fb739e3b170559922fd9a5e071f2e3b7b8109f929785a6dc9e07",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/host/round18-p0-chat-memory.json",
        sliceCommit: "3673395",
        blobCommit: "15d86ee",
        expectedSha256: "7a52db4e1b401bee24dab67dd4780022e7456958b6aaf3ee50dd6ee2579999b7",
      },
    ],
    levels: ["fixed-host-p0-chat-memory-failed"],
    scope: "Round-18 fixed-host P0 single-user chat-memory attempt (3673395; F18-R1 effects/budget/state disclosure corrected at 15d86ee) on the installed ff5ea11 build (dist 120 files): under the frozen plan (write phase + ordered reload with automatic startup embedding verification + recall phase, at most 2 local replies of <=256 tokens each, 0 automatic retries) attempt #1 failed BEFORE any generation model call with INVALID_INDEX_OBSERVATION (the probe indexed the synthetic fact and the backend became embeddingVerified, but the published memory manifest still advertised exact_read only, so the reply ReadView rejected the index observation; fixed in ff5ea11 with the trusted onIndexed publish hook; generationModelCalls=0); attempt #2 wrote and indexed the synthetic fact with a real embedding (indexWatermark 6), the reply ReadView observed TWO controlled memory sources and a draft, but the replyer Session was cancelled without a verified assistant draft (reply status unknown / REPLY_FAILED / usage null) — the same upstream empty/failed-stream generation class seen in the v6 core attempt. Per the frozen no-retry rule the recall phase was NOT executed, so restart recall, marker containment and same-Session evidence are NOT verified and the P0 single-user chat-memory round-trip is NOT passed. After the second ordered reload the automatic startup embedding verification passed independently: attempted=true, verified=true, embeddingCalls=1, usageComplete=true, semanticPublished=true, with manifest memory capabilities exact_read+semantic_search and the profile fingerprint (reason INDEX_COVERAGE_INCOMPLETE), which closes the reload-readiness gap but is NOT a chat-memory recall proof. Residual disclosures: two synthetic chat-probe memory facts remain active (no cleanup attempted); the audits show +4 succeeded effects (memory-command/index settlements, 19→21→23; explicitly NOT Task/Goal business effects and no external send) and +4 settled budget (27→29→31, unknown stays 6), and the runtime-state file changed on write2 (F18-R1).",
    limitations: [
      "It is a FAILED P0 chat-memory attempt: write#1 failed before any generation model call with INVALID_INDEX_OBSERVATION (0 generation calls) and, after the ff5ea11 fix, write#2 reached the ReadView with two controlled memory sources and a draft but produced NO current verified draft (REPLY_FAILED/unknown, usage null, replyer Session cancelled); the recall phase was NOT executed, restart recall/marker/same-Session remain unverified and the P0 chat-memory closure is NOT passed — this can NEVER be pass, V25, business or nine-system acceptance.",
      "No retry was made under the frozen no-retry rule; a further attempt is a new explicit owner decision. The generation/reply failure is the same upstream empty/failed-stream class as the v6 core attempt and its root cause is still unknown.",
      "The startup automatic embedding verification success (attempted/verified/embeddingCalls=1/semanticPublished=true after reload2) is an independent readiness success item, NOT a recall proof: index coverage stays incomplete (readable/indexed 2, stale 4) and verification scope is backend-instance.",
      "Residual side effects are disclosed: two synthetic chat-probe memory facts remain active (no cleanup attempted); the memory-command/index settlements added +4 succeeded effects (19→21→23) and +4 settled budget (27→29→31, unknown 6) while no Task/Goal business effect or external send occurred, and the runtime-state file changed on write2 (F18-R1) — these are memory-operation settlements, not chat-memory acceptance.",
    ],
    derive: [
      { label: "round18P0Status", path: "artifacts/dsh/host/round18-p0-chat-memory.json", jsonPath: "status" },
      { label: "round18StartupVerified", path: "artifacts/dsh/host/round18-p0-chat-memory.json", jsonPath: "startupEmbeddingVerification.value.verified" },
      { label: "round18StartupEmbeddingCalls", path: "artifacts/dsh/host/round18-p0-chat-memory.json", jsonPath: "startupEmbeddingVerification.value.embeddingCalls" },
      { label: "round18StartupSemanticPublished", path: "artifacts/dsh/host/round18-p0-chat-memory.json", jsonPath: "startupEmbeddingVerification.value.semanticPublished" },
    ],
  },
  {
    id: "h2e-chat-memory-probe",
    commits: ["c47502d", "ff5ea11"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/h2/h2e-single-user-chat-memory-probe.json",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "165871ed0e65334b503aca8d5db7ff19fcbac84aec64764f8f6bf056d94a8c63",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/h2/h2e-runtime-index.patch.diff",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "3eab0953b3028691c84875299093bf09f9ce7cb6d8268012f803c8af81b9dae2",
      },
      {
        path: "plugins/shiyu/src/control/chat-memory-probe.ts",
        sliceCommit: "c47502d",
        blobCommit: "ff5ea11",
        expectedSha256: "4704409ec6945ec2fe1995130b49376eb78106af99185b11deddbc1632c52098",
      },
      {
        path: "plugins/shiyu/src/control/startup-embedding-verifier.ts",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "88f59f5e0728d0f69807d31db6686b7215fbd59d9c5d3c0aedbbc79af882cce2",
      },
      {
        path: "plugins/shiyu/src/runtime.ts",
        sliceCommit: "c47502d",
        blobCommit: "ff5ea11",
        expectedSha256: "7ff0117fb2715cf5faeeebb59a40b80decbde67078f90f0270d79b9c98999010",
      },
      {
        path: "plugins/shiyu/src/index.ts",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "7a30920f408868930ea4b873e9982bb7acf4feabb9f5a9f3b223ec91539c1e17",
      },
      {
        path: "plugins/shiyu/tests/chat-memory-probe.test.ts",
        sliceCommit: "c47502d",
        blobCommit: "ff5ea11",
        expectedSha256: "07d0e2c0345f7b6d0262a2b69085fb310e75b70504ed2963a2bc7bbf666eaf77",
      },
      {
        path: "plugins/shiyu/tests/ombre-startup-embedding.test.ts",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "eff49a0c0a9773198646af2ea027b1fa6a7827c10a751d3e3a6db63027fada13",
      },
      {
        path: "plugins/shiyu/tests/host-diagnostics-tool.test.ts",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "102fbb6ae28855b598af3a7c47c4d4717d3260de175767d629a694c28534442b",
      },
    ],
    levels: ["offline-module"],
    scope: "H2e P0 single-user chat-memory two-phase probe plus automatic startup embedding verification offline slice (c47502d; ff5ea11 fix included and blob-bound): a two-phase owner-only probe (write: save a synthetic fact + real local embedding index + one local reply <=256 tokens; recall: second reply <=256 tokens with a marker-free prompt and a strict oracle = reply contains the marker AND controlled memorySources carry the operationId AND the same native Session, under a fixed <=2-call/0-retry order) and a startup embedding verifier that performs exactly one fixed local embedding query to publish semantic_search after reload (controlled NO_ELIGIBLE_MEMORY when no readable+indexed conversation memory exists, never bypassed with generation or fake data); targeted tests 18/18 (chat-memory-probe 11 + ombre-startup-embedding 7), isolated worktree full check 1782/1782 pass/0 fail/0 skip and the runtime/index integration delivered as a patch (h2e-runtime-index.patch.diff, applied by the Lead), with the receipt carrying no reply body and synthetic memory retained until a successful recall.",
    limitations: [
      "Offline/fake-ports only: the implementer ran no real model/embedding/host reload; the real host chat-memory closure is separate failed host evidence (round18-host-p0-chat-memory) and is NOT passed.",
      "The probe and startup verifier are bounded (at most 2 generation calls of <=256 tokens, 0 retries, strict oracle on controlled memorySources/background-load and same Session); natural-language wording alone is never an oracle.",
      "Synthetic probe memories are a disclosed temporary side effect (retained for reload verification until a successful recall; a failed path may retain them and must disclose).",
      "This source can NEVER be pass, V25, business or nine-system acceptance.",
    ],
    derive: [
      { label: "h2eStatus", path: "artifacts/dsh/h2/h2e-single-user-chat-memory-probe.json", jsonPath: "status" },
      { label: "h2eTargetedTests", path: "artifacts/dsh/h2/h2e-single-user-chat-memory-probe.json", jsonPath: "verification.targeted.count" },
      { label: "h2eIsolatedTests", path: "artifacts/dsh/h2/h2e-single-user-chat-memory-probe.json", jsonPath: "verification.isolatedWorktree.tests" },
    ],
  },
  {
    id: "workspace-taskrunner-integration",
    commits: ["c47502d", "15d86ee"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/tasks/workspace-runtime-integration.json",
        sliceCommit: "c47502d",
        blobCommit: "15d86ee",
        expectedSha256: "2634d6e26f85176bd774a62eb027c571bff6d4f15d9d19c2a686e8263d08ba44",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/tasks/runtime-task-workspace.diff",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "cdc9e2688d887a367432d2cdd5f7f3fa4570f1df6b61227704756bfadfd817ce",
      },
      {
        path: "plugins/shiyu/src/adapters/artifacts/SHARED_WORKSPACE.md",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "ea4b15ac295c82f69e9f880f1372b90b2476c9a9bf3cbe8aa77fd2389ddc9353",
      },
      {
        path: "plugins/shiyu/src/adapters/artifacts/shared-workspace.ts",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "7f944d1e9f7d43869f8204c4307c4d03b91b4d711e8b74252fc45c4263711930",
      },
      {
        path: "plugins/shiyu/src/control/task-runner.ts",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "b04c02ff4c70edac6ef4f2519f23178288310c4678a3955c2fa1a395fa289d14",
      },
      {
        path: "plugins/shiyu/src/control/task-workspace.ts",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "dd3def64eea09d9119225e8ea13aea242fb1338c998c7dca516607ee2cffe7d3",
      },
      {
        path: "plugins/shiyu/tests/task-workspace-runtime.test.ts",
        sliceCommit: "c47502d",
        blobCommit: "c47502d",
        expectedSha256: "061a9fdbde8cf404b1d9ae62a344617e8dbecd8645f7c7c77eced02f6572b43f",
      },
    ],
    levels: ["offline-module"],
    scope: "P0 TaskRunner workspace integration offline slice (c47502d; F18-R2 wiring wording/disclosure corrected at 15d86ee): the Runtime/plugin wiring is now REAL — RuntimeConfig.sharedWorkspaceRoot (trusted owner config) plus RuntimeOptions.workspaceExpectedChanges/workspaceOwnerDecision (trusted plan projections) flow through a TaskWorkspaceCoordinator into the LocalTaskRunner 4th argument (runtime-task-workspace.diff applies, patchSha256 recorded, no client or model tool change), and the offline module covers per-task workspace plus no-shared no-op compatibility, in-place write propagation, new-file publish, delete semantics, conflict detection, single-writer lock, symlink/cross-device rejection, manifest tamper detection and optional rollback (10/10 cases) verified in an isolated worktree (full check 1776/1776, exit 0).",
    limitations: [
      "G1 offline filesystem/TaskRunner module only: liveHost=false, modelCalls=0 and no real workspace touched; execution through a real host worker (including a real worker shared-file tool surface) is NOT proven.",
      "The author did NOT edit runtime/index (patch delivery); the Lead applied the integration in c47502d, so the earlier adapter evidence runtimeWired=false is accurate only for the pre-integration adapter slice and must NOT be misread as the runtime never being wired (F18-R2).",
      "Single-writer/exclusive-lock assumption only: external concurrent writers, crash consistency and long-run rollback drills remain unsupported; writable-shared in-place write propagation is a deliberate disclosed tradeoff.",
      "This source can NEVER be pass, V25, business or nine-system acceptance.",
    ],
    derive: [
      { label: "workspaceIntegrationCases", path: "artifacts/dsh/tasks/workspace-runtime-integration.json", jsonPath: "summary.total" },
      { label: "workspaceIntegrationPassed", path: "artifacts/dsh/tasks/workspace-runtime-integration.json", jsonPath: "summary.passed" },
      { label: "workspacePatchApplies", path: "artifacts/dsh/tasks/workspace-runtime-integration.json", jsonPath: "integration.patchApplies" },
      { label: "workspaceRuntimeEditedByLead", path: "artifacts/dsh/tasks/workspace-runtime-integration.json", jsonPath: "boundaries.runtimeTsEditedByLead" },
    ],
  },
  {
    id: "h7-round18-clean-artifacts",
    commits: ["8a06066"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/harness/manifest.json",
        sliceCommit: "8a06066",
        blobCommit: "8a06066",
        expectedSha256: "69b70cea51ab1359a5aad2dae24b62f0db4b9a679d02546d31f11bc127d50720",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/harness/traceability.json",
        sliceCommit: "8a06066",
        blobCommit: "8a06066",
        expectedSha256: "e9dacd6a6a0d998d9126b616d9a464f690de479ab4846068d1a6c32cacdf4392",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/harness/acceptance-report.json",
        sliceCommit: "8a06066",
        blobCommit: "8a06066",
        expectedSha256: "24f4955ad9b354b90b778d4e0177c644bf8ecccc611732cf145f3bda5bbf9f94",
      },
    ],
    levels: ["offline-module"],
    scope: "H7-round18 clean-VCS harness artifacts (X+1 of fc4b947, commit 8a06066): clean-X manifest (vcs head fc4b947, dirty=false, 426 files), traceability with 100 verified evidence sources/420 files and acceptance report (gate incomplete, executed=passed=0, product 79/79 not_covered); the same commit also carries the R18-CORR h7-round18 slice-evidence correction.",
    limitations: [
      "Tooling evidence only: not product/host/model/business acceptance; product rows remain not_covered and the gate incomplete.",
      "Bound with blobCommit=8a06066 + expectedSha256; later pipeline rewrites do not affect the committed snapshot; never read from the mutable worktree.",
      "Cannot upgrade V/S/FL/product rows or the nine-system gate.",
    ],
    derive: [
      { label: "round18CleanGate", path: "artifacts/dsh/harness/acceptance-report.json", jsonPath: "gate.overall" },
    ],
  },
  {
    id: "round18-review",
    commits: ["15d86ee"],
    files: [
      {
        path: "plugins/shiyu/artifacts/dsh/verify/ROUND18-EVIDENCE-REVIEW.md",
        sliceCommit: "15d86ee",
        blobCommit: "15d86ee",
        expectedSha256: "7a1327e2131c5f8ca0e48326ba8d06873f7cce5b03549ca444873cb5f399518f",
      },
      {
        path: "plugins/shiyu/artifacts/dsh/verify/round18-evidence-review.json",
        sliceCommit: "15d86ee",
        blobCommit: "15d86ee",
        expectedSha256: "ccc461baac3616c297061d4bfc52fbd6bcad11b43a0dc671d223ef1542dd0269",
      },
    ],
    levels: ["independent-review-info"],
    scope: "Round-18 independent evidence review metadata plus F18 dispositions (F18-R1 host audit effects/budget/state disclosure added: effects 19→21→23, settled budget 27→29→31 with unknown 6 and the runtime-state file change on write2 while the earlier no-Effect wording was corrected; F18-R2 workspace runtime wiring wording corrected — the Lead applied the runtime integration in c47502d so runtimeWired=false must not be misread as the runtime never being wired; P0 chat-memory failure, startup embedding verification, H7 round-18 evidence and X+1 reviewed; host round-18 mapping left to round-19).",
    limitations: [
      "Info/metadata only: independent review record, not product/host/model/business verification and not a pass claim.",
      "Deliberately NOT referenced by any product row/module/system in the evidence map to avoid turning review metadata into acceptance evidence.",
      "Cannot upgrade V/S/FL/product rows or nine-system gate.",
    ],
  },
];

const SOURCE_BY_ID = new Map(EVIDENCE_SOURCES.map(source => [source.id, source]));

export interface RowEvidenceMapping {
  readonly rowId: string;
  readonly sourceIds: readonly string[];
  readonly levels: readonly EvidenceLevel[];
  /** What the mapped evidence layers can support for this row. */
  readonly scope: string;
  readonly limitations: readonly string[];
  /** Explicit partial sub-scenarios already exercised (never a full V/S/FL pass). */
  readonly partialSubscenarios: readonly string[];
}

export const PRODUCT_EVIDENCE_MAPPINGS: readonly RowEvidenceMapping[] = [
  {
    rowId: 'SYS.1',
    sourceIds: ['h6a-channel-ingress', 'h4c-replyer-inner', 'h6c-channel-projection-ui', 'historical-lab-3hc', 'joint-host-zero-model'],
    levels: ['offline-module', 'slice-verification', 'synthetic-ui', 'historical-limited', 'bounded-real-model', 'fixed-host-zero-model'],
    scope: 'H6a offline channel identity/dedup/audience foundation + H4c offline replyer inner composition + H6c synthetic-host channel projection UI + historical two-channel Lab text loop + joint zero-model host status.',
    limitations: [
      'No real platform adapter, sending Effect, native draft delivery or multi-channel conversation business loop on current HEAD.',
      'H6c UI runs Chromium against a synthetic host page only: no real DSH client DOM/injection, no live projection or business acceptance.',
      'Historical Lab loop is three text messages; not V05/V23/V25 or S/FL acceptance.',
    ],
    partialSubscenarios: ['two-channel text loop (historical, 3 messages)', 'channel ingress identity/dedup offline', 'replyer inner-reference composition offline'],
  },
  {
    rowId: 'SYS.2',
    sourceIds: ['h2a-events', 'h2a-probe', 'h2b-subscriptions-time', 'h2b-host-time-probe', 'h2b-live-time-trigger', 'h2c-real-model-probe', 'h2c-probe-fix-chain', 'round3-lead-integration', 'round4-lead-integration', 'round5-host-real-model', 'round3-host-zero-model', 'round4-host-zero-model', 'joint-host-zero-model'],
    levels: ['offline-module', 'slice-verification', 'fixed-host-zero-model', 'bounded-real-model-diagnostic-only'],
    scope: 'H2a event-tool mounting/subscription paths + H2b offline subscription lifecycle/time source/notification routing + Lead integration + zero-model fixed-host diagnostics.timeSource tick.',
    limitations: [
      'No model actually invoked an event tool; real core Goal continuation, declarative-condition tools, platform redelivery and quotas/fanout remain untested.',
      'H2b is G1/G2 offline with synthetic clock/observation/Effect doubles; no DSH schedule/IANA tz database and no monetary/model cost bounding.',
      'Round-5 fixed-host host evidence is zero-model + bounded-real-model-diagnostic-only: the diagnostic tool round passed with reported usage 1469/41/2406 (attempts 4/5 = 1 request/0 stream/cost unknown), but this is NOT V25, full core/Goal or business acceptance and never pass.',
      'The live time-trigger probe intentionally appended one undeletable time.occurred event (append-only side effect); no live delivery/model/Task/Goal/Effect; diagnostic pass cannot upgrade V03/V14/V24.',
    ],
    partialSubscenarios: ['four publish/subscribe path module tests', 'zero-model restricted worker tool surface probe'],
  },
  {
    rowId: 'SYS.3',
    sourceIds: ['h3-core-planning', 'h3-bounded-core-validation-runner', 'h3-core-validation-reconcile', 'round7-lead-integration', 'round8-lead-integration', 'v2-experiment-activation', 'historical-task-goal', 'h2c-real-model-probe', 'h2c-probe-fix-chain', 'round4-localcore-hotfix', 'round4-host-zero-model', 'round5-host-real-model', 'round7-host-bounded-core-goal-failure', 'round8-host-core-validation-reconcile', 'round10-host-v2-create-failure', 'history-assert-diagnostics', 'v1v2-reconcile-generalization', 'round11-lead-integration', 'round11-host-v1v2-reconcile', 'cold-cut-v3-activation', 'round12-lead-integration', 'round12-host-v3-create-failure', 'round12-host-v3-cleanup-reconcile', 'native-header-cut-probe', 'round13-lead-integration', 'round13-host-native-header-cut', 'delegation-depth-normalization-v4', 'round14-host-v4-create-success-eval-failure', 'decision-prestep-reason-preservation-v5', 'round15-host-v5-create-success-context-rejected', 'runtime-context-binding-v6', 'round16-host-v6-first-model-request-empty-stream', 'h3-v7-stream-error-instrumentation', 'h2e-chat-memory-probe', 'round18-host-p0-chat-memory'],
    levels: ['offline-module', 'slice-verification', 'historical-limited', 'bounded-real-model', 'bounded-real-model-diagnostic-only', 'fixed-host-zero-model', 'fixed-host-failure-diagnostic', 'fixed-host-zero-model-reconcile', 'fixed-host-create-succeeded-evaluation-failure'],
    scope: 'H3 offline controlled multi-step plan/replan with CAS plan versions and Task/Mandate admission; historical limited owner local-note Goal closure.',
    limitations: [
      'The round-5 bounded real-model diagnostic tool round passed (2 requests/2 streams/1 read-only tool round; reported usage 1469/41/2406, attempts 4/5 = 1 request/0 stream/cost unknown) but it is diagnostic-only: not a full core decision/Goal/plan/Task, not V25 and not business acceptance.',
      'Earlier H2c host attempts failed and were not retried; diagnostic pass can never be counted as product/module pass.',
      'Round-7 bounded real core Goal host attempt FAILED at create with GOAL_OPERATION_UNKNOWN: 0 model requests, no retry, no Task/worker/verification/native completion; an unauthorized/paused Goal + Session partial side effect exists; this failure evidence can never be V25/business/nine-system pass.',
      'Round-8 fixed-host reconcile only classifies/cancels the inert residual Goal; it does NOT fix the create failure or prove the business chain.',
      'Round-10 v2 activation is offline/isolated only (1583); the fixed-host v2 attempt then FAILED at history-assert/NATIVE_HISTORY_CHANGED with evaluateAttempts=0, 0 model requests, partial unauthorized/paused v2 Goal+Session, journal unknown, no Task/Effect/budget/artifact; third attempt not authorized — never pass/V25/business/nine-system.',
      'Round-11 adds the bounded history-assert instrument (mismatchKind/expected/live/delta, hash prefixes only; 14 net-new tests; isolated 1597/1597) and generalizes reconcile to fixed targets [v1,v2]; the create-only liveCut candidate fix is DORMANT and NOT host-confirmed. The fixed-host generalized reconcile is zero-model only: v1 cancelled/no action, v2 inert-unauthorized with exactly one cancel to version 2, 0 model/0 retries/0 creations, only +1 commitSeq; it does NOT fix the create failure and a third attempt is NOT authorized — never pass/V25/business/nine-system.',
      'Round-12 activates the create-only cold-cut (host-candidate; offline 1613/1623, recovery/expectedPrefix strict unchanged, native create once), but the third independent v3 host attempt FAILED at history-assert/header-hash: event-count/seq aligned (expected 3 = live 3, delta 0) while cold/live header hashes differ (baa30ad4 vs bbd0090c), 0 model requests, no retry, partial unauthorized/paused v3 Goal + Session, journal unknown, no new Task/Effect/budget/artifact; a fourth attempt is NOT authorized. The post-attempt generalized cleanup reconcile is zero-model (v1/v2 cancelled no action, v3 inert exactly one cancel to version 2, only +1 commitSeq) and does NOT fix the create failure — never pass/V25/business/nine-system.',
      'Round-13 adds the controlled field-level headerDiff and a zero-model native header-cut probe (offline 1632, integration 1643), then the fixed-host zero-model probe (installed X=76c7116) reports matched=false, mismatchKind=header-hash, headerDiff ["delegationDepth: number:0→absent"] with eventCount/seq already aligned 3/3; exactly one bare Session created/archived, 0 model/Goal/Task/Effect/business writes and 0 retries. This is diagnosis only: no fix, a fourth attempt is NOT authorized, and it cannot prove the business chain or V25/nine-system acceptance.',
      'Round-14 activates the create-only delegationDepth normalization (only cold delegationDepth number:0 + live absent/null, create path only; recovery/default strict unchanged) and freezes v4. The fixed-host fourth attempt then achieved the FIRST real create success (authorized/active/mandate/binding confirmed/goalRef rev1/1 Goal Session, partialCreation=false) but the single evaluation failed CORE_VALIDATION_EVALUATION_UNKNOWN with evaluateAttempts=1 and 0 model requests (13-event Goal Session has no request/assistant), reason masked as owner_paused, stopAction pause, +14 commitSeq/goals 5→6/sessions 37→38/budget unknown 3→4 with held 16384/2; no Task/Effect/artifact or business chain and a fifth attempt is NOT authorized — never pass/V25/business/nine-system.',
      'Round-15 fixes the decision pre-step to admit the exact owner+host-runtime-context claim shape and preserves the first unknown reason via preStopEvaluation (offline 1671/integration 1682). The fixed-host fifth v5 attempt created the Goal a second time (authorized/active/mandate/goalRef rev1/1 Goal Session) but the evaluation failed CORE_VALIDATION_EVALUATION_UNKNOWN with preStopEvaluation.reasonCode=CORE_NATIVE_CONTEXT_REJECTED (no longer owner_paused), evaluateAttempts=1 and 0 model requests; +14 commitSeq/goals 6→7/sessions 38→39/budget unknown 4→5 held 16384/2, v4+v5 residuals, no Task/Effect/artifact or business chain, sixth attempt NOT authorized — never pass/V25/business/nine-system.',
      'Round-16 binds the decision pre-step runtime-context claim through the exact host assembly renderer (exact rendered hash or structural kind/form/section/cwd binding; extra sections projected only when rendered; third/wrong-order/bad context still fails closed) plus a field-level bounded contextDiagnostic and the frozen v6 experiment/reconcile [v1..v6] (offline 1689/integration 1700). The fixed-host sixth v6 attempt then created the Goal a THIRD time and reached the FIRST real model request (21-event Goal Session with system/owner/runtime-context messages, request/header provider=opencode-go model=deepseek-v4.1-flash with the three read-only event tools, request/context 1M), but the provider stream was EMPTY (assistant/attempt streamLength=0), the turn aborted and the single evaluation stayed CORE_VALIDATION_EVALUATION_UNKNOWN with preStopEvaluation.reasonCode=CORE_EXECUTION_UNCONFIRMED preserved, evaluateAttempts=1 and 0 usage; +14 commitSeq/goals 7→8/sessions 39→40/budget unknown 5→6 held 16384/2, v4/v5/v6 residuals, no Task/Effect/artifact or completed business chain, seventh attempt NOT authorized — never pass/V25/business/nine-system.',
      'Round-17 freezes the bounded provider-stream failure instrumentation and the v7 experiment but does NOT execute it: preStopEvaluation.streamDiagnostic classifies empty-provider-stream/transport/auth/request-shape/timeout/aborted/unknown with bounded field facts, the Goal Session summary is bounded, CORE_VALIDATION_EXPERIMENT_V7 is frozen exact-reference-only and reconcile covers [v1..v7] (offline focused 167/167, regression 101/101, isolated slice verification 1710/1710) — realModelExecuted=false, hostReloads=0, the seventh attempt is NOT authorized and the empty-stream root cause is still unknown — never pass/V25/business/nine-system.',
      'Round-18 adds control-layer limited diagnosis only: the H2e two-phase chat-memory probe and startup embedding verifier are offline/fake-ports (targeted 18/18, isolated 1782/1782) and the fixed-host P0 chat-memory attempt FAILED (write#1 INVALID_INDEX_OBSERVATION with 0 generation calls; write#2 reached ReadView with 2 controlled sources and a draft but REPLY_FAILED/unknown/usage null/replyer Session cancelled, 0 retry, recall not executed, P0 chat-memory NOT passed); its reply failure is the same upstream empty/failed-stream class as the v6 core attempt, and the startup embedding verification success is independent of recall — never pass/V25/business/nine-system.',
      'No real DSH host/native Goal rounds under current HEAD; historical goal closure is limited owner local-note evidence.',
      'Open-ended planning, multi-Goal timers and worker slot behaviour remain untested.',
    ],
    partialSubscenarios: ['offline plan candidate validation/CAS/replan', 'historical bounded owner local-note closure'],
  },
  {
    rowId: 'SYS.4',
    sourceIds: ['historical-task-goal', 'h3-core-planning', 'h4h5-independent-review'],
    levels: ['historical-limited', 'offline-module', 'independent-verification'],
    scope: 'Historical limited one repaired synthetic Task/Effect/Goal lifecycle; H3 offline deterministic Task admission; independent review of H4/H5 evidence authenticity.',
    limitations: [
      'Historical one-task samples and G1 modules only; no current-HEAD concurrent worker/lease/cancel/late-result matrix or cross-assignment fencing.',
      'Independent review only checked evidence authenticity, not product behaviour.',
    ],
    partialSubscenarios: ['historical single local task with independent artifact/effect check', 'offline plan→Task admission'],
  },
  {
    rowId: 'SYS.5',
    sourceIds: ['h4-inner-offline', 'h4e-lifecycle-recompute', 'h4e-migration-hotfix', 'h4e-isolated-lifecycle-probe', 'h4-host', 'h4b-composition', 'h4b-host', 'h4c-replyer-inner', 'round6-lead-integration', 'round6-host-inner-lifecycle', 'historical-memory', 'h4h5-independent-review'],
    levels: ['offline-module', 'slice-verification', 'fixed-host-zero-model', 'synthetic-ui', 'historical-limited', 'bounded-real-model'],
    scope: 'H4 four inner domains offline + schema4 fixed-host zero-model publication; H4e lifecycle/recompute + additive migration hotfix + isolated inner-lifecycle probe (implementation/integration/host diagnostic); H4b synthetic UI; H4c offline replyer inner reference; historical memory samples.',
    limitations: [
      'No real model use of inner state, no real inner bodies/Ombre content, no real browser DOM against real data.',
      'H4e recompute is same-DB bounded deterministic scan; logical retention only (no automatic expiry/physical erase/backup deletion propagation); migration hotfix is offline regression plus separate zero-model host recovery.',
      'Round-6 host inner-lifecycle probe is diagnostic-only with an isolated :memory: ControlStore and skips the memory backend; status-final diagnostics-cache passed is NOT live memory/business/nine-system acceptance.',
      'Historical memory samples are earlier-build limited; deletion propagation/physical erasure not proven.',
    ],
    partialSubscenarios: ['schema4 six-domain publication on fixed host (zero model)', 'inner ReadView/UI synthetic composition', 'bounded inner prompt block offline'],
  },
  {
    rowId: 'SYS.6',
    sourceIds: ['h1-native-history', 'h1-independent-run', 'historical-model-context', 'joint-host-zero-model'],
    levels: ['offline-module', 'independent-verification', 'fixed-host-zero-model', 'historical-limited', 'bounded-real-model'],
    scope: 'H1 native paged history/recovery/independent verifier suite; historical bounded real-model two-turn samples; joint zero-model host status.',
    limitations: [
      'No fixed-host long-history cold recovery/compaction under current HEAD, no real generation/usage/cache measurement, no full provider fees.',
      'Independent verifier is offline; historical real-model samples are earlier builds and very small.',
    ],
    partialSubscenarios: ['bounded paged recovery + independent offline oracle', 'historical two-turn real-model Session reuse'],
  },
  {
    rowId: 'SYS.7',
    sourceIds: ['h6a-channel-ingress', 'historical-task-goal', 'historical-capability-3i', 'historical-lab-3hc', 'joint-host-zero-model'],
    levels: ['offline-module', 'historical-limited', 'bounded-real-model', 'fixed-host-zero-model'],
    scope: 'H6a offline trusted identity/audience/revision foundation; historical Task/Goal budgets, fixed capability enable/disable and two-channel Lab authorization samples; joint host read-only status.',
    limitations: [
      'No current-HEAD full Mandate/budget/pause/revoke matrix, no real channel credentials/receipts, no security canary sweep of model inputs or real device fences.',
      'Historical policy/budget samples cannot be reused as V10/V17/V18–V20 acceptance.',
    ],
    partialSubscenarios: ['offline identity/audience ingress foundation', 'historical fixed-capability enable/disable persistence'],
  },
  {
    rowId: 'SYS.8',
    sourceIds: ['h5-g1-module', 'h5b-runtime-integration', 'h5b-checkpoint-probe', 'h4e-migration-hotfix', 'round3-lead-integration', 'round4-lead-integration', 'round6-lead-integration', 'round7-lead-integration', 'round8-lead-integration', 'v2-experiment-activation', 'h3-core-validation-reconcile', 'round6-host-inner-lifecycle', 'round7-host-bounded-core-goal-failure', 'round8-host-core-validation-reconcile', 'round10-host-v2-create-failure', 'history-assert-diagnostics', 'v1v2-reconcile-generalization', 'round11-lead-integration', 'round11-host-v1v2-reconcile', 'cold-cut-v3-activation', 'round12-lead-integration', 'round12-host-v3-create-failure', 'round12-host-v3-cleanup-reconcile', 'native-header-cut-probe', 'round13-lead-integration', 'round13-host-native-header-cut', 'delegation-depth-normalization-v4', 'round14-host-v4-create-success-eval-failure', 'decision-prestep-reason-preservation-v5', 'round15-host-v5-create-success-context-rejected', 'runtime-context-binding-v6', 'round16-host-v6-first-model-request-empty-stream', 'h2d-single-user-memory-chat', 'h2d-host-memory-embedding-verification', 'h4f-emotion-continuation', 'workspace-shared-hardlink', 'round17-host-emotion-memory-probes', 'h2e-chat-memory-probe', 'round18-host-p0-chat-memory', 'workspace-taskrunner-integration', 'h7-round18-clean-artifacts', 'round3-host-zero-model', 'round4-host-zero-model', 'h4h5-independent-review'],
    levels: ['offline-module', 'slice-verification', 'independent-verification', 'fixed-host-zero-model', 'fixed-host-zero-model-reconcile', 'fixed-host-failure-diagnostic', 'fixed-host-create-succeeded-evaluation-failure'],
    scope: 'H5-B1 G1 checkpoint/restore module + H5b runtime composition/capture integration and read-only checkpoint availability probe + H4e additive migration hotfix + round-3/4 zero-model host reload/probes; independent authenticity review.',
    limitations: [
      'G1 modules/composition/probe only: H5b production capture remains blocked (CHECKPOINT_STAGING_UNCONFIGURED, GOAL_SESSION_EXPORT_UNAVAILABLE, MEMORY_EXPORT_UNAVAILABLE, trusted staging/manifest missing); the host checkpoint probe returns ready:false and writes no files.',
      'Round-3/4 host evidence is zero-model only; the bounded real-model attempt failed before any model request; no real Ombre export/erasure, independent fault domain/V27, RPO/RTO or OS power loss.',
      'Round-6 inner-lifecycle host probe is diagnostics-only (in-memory, skips memory backend); it does not prove live persistence/checkpoint readiness or V15/V21/V22/V24/V27 acceptance.',
      'Round-7 failure + round-8 reconcile cancelled v1 residual Goal without model/retry; round-10 v2 attempt re-failed at history-assert and left a partial unauthorized/paused v2 Goal+Session with journal unknown — these failure/reconcile diagnostics cannot prove checkpoint/recovery readiness or V15/V21/V22/V24/V27 acceptance.',
      'Round-11 generalized the reconcile to fixed v1+v2 targets and the fixed-host zero-model call cancelled the inert v2 residual Goal (v1 already cancelled with no action; exactly one cancel, postCancel version 2, 0 model/0 retries/0 creations, only +1 commitSeq, unchanged state file; the 61122-byte final status caches the receipt). This is reconcile/cancel diagnostics only: the create history-assert failure is unfixed, the dormant liveCut fix and cold-header candidate are not host-confirmed, and it cannot prove checkpoint/recovery readiness or V15/V21/V22/V24/V27 acceptance.',
      'Round-12 activated the create-only cold-cut and froze v3, but the third independent v3 host attempt FAILED at history-assert/header-hash (counts aligned 3=3/delta 0, cold baa30ad4 vs live bbd0090c; 0 model requests, no retry, partial unauthorized/paused v3 Goal+Session, journal unknown; +3 commitSeq, goals 4→5, sessions 35→36, no new Task/Effect/budget/artifact, state file unchanged). The post-attempt zero-model generalized cleanup reconcile cancelled only the inert v3 target (v1/v2 no action; exactly one cancel to version 2; only +1 commitSeq). These are failure/cleanup diagnostics only: the create failure is unfixed, a fourth attempt is NOT authorized, and they cannot prove checkpoint/recovery readiness or V15/V21/V22/V24/V27 acceptance.',
      'Round-13 adds a fixed-host zero-model native header-cut diagnosis that explains the remaining header-hash mismatch as exactly delegationDepth: number:0→absent with eventCount/seq 3/3; it creates and archives exactly one bare Session, changes no events/goals/tasks/budget/effects/state (only sessions 36→37), makes 0 model requests and 0 retries, and neither fixes the create failure nor authorizes a fourth attempt; it cannot prove checkpoint/recovery readiness or V15/V21/V22/V24/V27 acceptance.',
      'Round-14 normalizes the create-only delegationDepth field and the fourth fixed-host v4 attempt achieved the first real create success (1 authorized/active Goal + 1 Goal Session, budget held 16384/2), but the evaluation failed before any model request (EVALUATION_UNKNOWN, evaluateAttempts=1, reason masked owner_paused) with +14 commitSeq and an unknown budget reservation left in place; it proves create-path progress only, not planning/Task/worker/native completion or checkpoint/recovery readiness, and a fifth attempt is NOT authorized.',
      'Round-15 fixes the decision pre-step claim shape and reason preservation; the fifth fixed-host v5 attempt created the Goal a second time but the evaluation failed with the preserved CORE_NATIVE_CONTEXT_REJECTED reason, evaluateAttempts=1, 0 model requests and only +14 commitSeq/goals 6→7/sessions 38→39/budget unknown 4→5 held 16384/2, leaving v4+v5 unknown reservations; it proves pre-step/reason progress only, not planning/Task/native completion or checkpoint/recovery readiness, and a sixth attempt is NOT authorized.',
      'Round-16 aligns the pre-step runtime-context claim with the host assembly renderer and adds a bounded contextDiagnostic (offline 1689/integration 1700); the sixth fixed-host v6 attempt created the Goal a third time and reached the first real model request (request/header+context, three read-only event tools, 21-event Goal Session) but the provider stream was empty (assistant/attempt streamLength=0) so the evaluation stayed unknown with the preserved CORE_EXECUTION_UNCONFIRMED reason, evaluateAttempts=1, 0 usage and only +14 commitSeq/goals 7→8/sessions 39→40/budget unknown 5→6 held 16384/2, leaving v4/v5/v6 unknown reservations; it proves binding/create progress only, not a completed model round, planning/Task/native completion or checkpoint/recovery readiness, and a seventh attempt is NOT authorized.',
      'Round-17 adds limited data/lifecycle evidence, not recovery acceptance: the H2d readiness/offline slice gates semantic memory on verified embeddings (1716/1716), the P0 fixed-host embedding round-trip passed with 1+1 real Harrier embedding calls, 1 semantic match, exact read and post-withdraw MEMORY_READ_FORBIDDEN while leaving only withdrawn synthetic facts (coverage incomplete, +10 commitSeq 546→556, no generation model), the H4f emotion-continuation offline slice (1727/1727) plus the zero-model joint host probe (15/15 checks, in-memory store, liveDataTouched=false, +10 commitSeq 563→573) and the offline writable shared-workspace module (1715/1715, 11/11 cases, runtimeWired=false, hard-link write-propagation disclosed) each prove only their bounded paths — no restart chat closure, no recovery drill, no V15/V21/V22/V24/V27 acceptance.',
      'Round-18 adds limited data/lifecycle evidence, not chat-memory or recovery acceptance: the fixed-host P0 single-user chat-memory attempt FAILED (write#1 INVALID_INDEX_OBSERVATION before any generation call; write#2 reached ReadView with 2 controlled memory sources + draft but REPLY_FAILED/unknown/usage null and the replyer Session was cancelled; recall phase NOT executed, restart recall/marker/same-Session unverified, P0 chat-memory NOT passed; 0 retry; two synthetic facts retained active); the automatic startup embedding verification independently passed after reload2 (verified=true, embeddingCalls=1, semanticPublished=true, coverage incomplete) and is a readiness item, NOT recall proof; a TaskRunner workspace integration is wired in code/tests (10/10 cases, isolated 1776/1776) but host worker execution is unproven; memory-command/index settlements added effects 19→21→23, settled budget 27→29→31 (unknown 6) and a state-file change on write2 (F18-R1) — no Task/Goal business effect or send; no recovery drill, no V15/V21/V22/V24/V27 acceptance.',
      'No real backup destination or restore drill; not V15/V21/V22/V24/V27 acceptance.',
    ],
    partialSubscenarios: ['G1 backup bundle capture/verify + isolated-root disarmed restore'],
  },
  {
    rowId: 'SYS.9',
    sourceIds: ['h4b-composition', 'h4b-host', 'h6c-channel-projection-ui', 'round3-host-zero-model', 'round4-host-zero-model', 'round5-host-real-model', 'round6-host-inner-lifecycle', 'round7-host-bounded-core-goal-failure', 'round8-host-core-validation-reconcile', 'round10-host-v2-create-failure', 'round11-host-v1v2-reconcile', 'round12-host-v3-create-failure', 'round12-host-v3-cleanup-reconcile', 'round13-host-native-header-cut', 'round14-host-v4-create-success-eval-failure', 'round15-host-v5-create-success-context-rejected', 'round16-host-v6-first-model-request-empty-stream', 'h2d-host-memory-embedding-verification', 'round17-host-emotion-memory-probes', 'round18-host-p0-chat-memory', 'joint-host-zero-model', 'h0-baseline'],
    levels: ['synthetic-ui', 'fixed-host-zero-model', 'fixed-host-zero-model-reconcile', 'fixed-host-failure-diagnostic', 'fixed-host-create-succeeded-evaluation-failure', 'bounded-real-model-diagnostic-only', 'offline-module', 'environment-baseline'],
    scope: 'H4b six-domain dashboard panel + H6c channel projection panel (synthetic-host UI cases); fixed-host visibility of schema4 publication/summary/projection, the round-11/round-12 generalized reconcile receipt caches, the round-13 header-cut probe receipt, the round-14 failed v4 receipt cache, the round-15 failed v5 receipt cache and the round-16 failed v6 receipt cache (all with preStopEvaluation; v6 also records the 21-event first-real-model-request Session with an empty provider stream) and the round-17 fixed-host status caches (68173-byte memory readiness/embedding verification with semantic_search publication; joint emotion/memory probe status after reload); H0 status tool check.',
    limitations: [
      'No real DSH client DOM/injection or production browser bundle: H4b/H6c use synthetic host pages, fixtures and synthetic bindings/connections.',
      'No real user interactions beyond read-only status/tool calls; no UI lifecycle/long-list/old-response matrix; round-3/4 host projection remains zero-model.',
      'Round-4 host had only a failed bounded real-model attempt; round-5 adds a diagnostic real-model tool round; round-6 adds an isolated inner-lifecycle diagnostic (59072-byte status-final proves only diagnostics-cache passed); round-7 adds a FAILED bounded core Goal attempt (GOAL_OPERATION_UNKNOWN, 0 model requests, partial unauthorized/paused Goal+Session); round-8 reconcile cancelled the residual Goal (58,375-byte status-final proves reconcile cache only). Round-11 adds a 61122-byte final status that caches the generalized v1/v2 reconcile receipt (v1 cancelled/no action, v2 inert exactly one cancel to version 2, 0 model/0 retries/0 creations, +1 commitSeq). round-12 adds a 69,295-byte final status caching BOTH the failed v3 create receipt (header-hash mismatch, 0 model requests, partial v3 Goal+Session) and the generalized cleanup reconcile receipt (v1/v2 no action, v3 inert exactly one cancel to version 2, only +1 commitSeq) — diagnostics caches, not dashboard/render or V05/V24 acceptance. Round-13 adds a 60,692-byte final status caching the zero-model header-cut probe receipt (matched=false, headerDiff delegationDepth: number:0→absent, one bare Session archived, 0 model/Goal/Task/Effect/business writes) — a diagnostics cache, not dashboard/render or V05/V24 acceptance. Round-14 adds a 65,594-byte final status caching the failed v4 receipt (create succeeded but evaluation unknown, 0 model requests, reason masked owner_paused, unknown budget 3→4 held 16384/2) — a diagnostics cache, not dashboard/render or V05/V24 acceptance. Round-15 adds a 67,986-byte final status caching the failed v5 receipt including preStopEvaluation (create succeeded again, evaluation unknown with CORE_NATIVE_CONTEXT_REJECTED, 0 model requests, v4/v5 unknown reservations held 16384/2) — a diagnostics cache, not dashboard/render or V05/V24 acceptance. Round-16 adds a 70,221-byte final status caching the failed v6 receipt including preStopEvaluation (create succeeded a third time, FIRST real model request with request/header+context and three read-only event tools, empty provider stream, CORE_EXECUTION_UNCONFIRMED preserved, evaluateAttempts=1, 0 usage, v4/v5/v6 unknown reservations held 16384/2) — a diagnostics cache, not dashboard/render or V05/V24 acceptance. Round-17 adds a 68173-byte final status caching the P0 memory readiness/embedding verification (readinessBefore exact_read/EMBEDDING_UNVERIFIED → readinessAfter exact_read+semantic_search/embeddingVerified with INDEX_COVERAGE_INCOMPLETE; 1+1 real embedding calls, 1 semantic match, post-withdraw rejection, +10 commitSeq) and the joint zero-model emotion/memory probe status after one ordered reload (15/15 in-memory checks, liveDataTouched=false, +10 commitSeq 563→573) — diagnostics caches only, not dashboard/render, live chat recall or V05/V24 acceptance. Round-18 adds a 69,563-byte final status and related host status/reply-failure extracts caching the failed P0 chat-memory attempt (write#1 INVALID_INDEX_OBSERVATION/0 generation; write#2 REPLY_FAILED/unknown/usage null), the startup embedding verification success (verified/embeddingCalls=1/semanticPublished) and the retained synthetic memories — diagnostics/audit caches only, not dashboard/render or chat-memory recall acceptance. Real browser DOM, sensitive-value sweep and V05/V24 dashboard acceptance remain untested.',
    ],
    partialSubscenarios: ['synthetic-host six-domain panel UI cases', 'fixed-host zero-model status/read-only visibility'],
  },
  {
    rowId: 'V01',
    sourceIds: ['h0-baseline', 'h0b-harness'],
    levels: ['environment-baseline', 'offline-module'],
    scope: 'Environment/SDK identity and offline test-tooling baseline captured at H0/H0b.',
    limitations: ['Not 40/40 module responsibility/contract acceptance; no current-HEAD 40-module ownership audit.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'V02',
    sourceIds: ['h6a-channel-ingress', 'historical-lab-3hc'],
    levels: ['offline-module', 'historical-limited'],
    scope: 'Offline trusted identity/audience/dedup foundation + historical two-channel Lab identity sample.',
    limitations: ['No current-HEAD 40 identity/control combination matrix; no real platform accounts/namespaces; historical Lab sample is small.'],
    partialSubscenarios: ['offline normalized identity/audience tests'],
  },
  {
    rowId: 'V03',
    sourceIds: ['h2a-events'],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H2a offline event acceptance/dedup/publish-subscribe and ack-vs-context separation module tests.',
    limitations: ['No 100 unique×10 replay/20 out-of-order seed matrix, no fixed-host subscription lifecycle, no model business context load.'],
    partialSubscenarios: ['offline duplicate/ordering/ack separation tests'],
  },
  {
    rowId: 'V04',
    sourceIds: ['h6a-channel-ingress', 'h4c-replyer-inner', 'joint-host-zero-model'],
    levels: ['offline-module', 'fixed-host-zero-model'],
    scope: 'Offline read-only audience/identity foundations and inner read views; fixed-host lossless read-only status tool calls.',
    limitations: ['No ≥30 unauthorized-path matrix and 1000-read purity benchmark on current HEAD; zero-model status calls only.'],
    partialSubscenarios: ['fixed-host lossless read-only status call'],
  },
  {
    rowId: 'V05',
    sourceIds: ['h6a-channel-ingress', 'historical-lab-3hc'],
    levels: ['offline-module', 'historical-limited', 'bounded-real-model'],
    scope: 'Offline channel identity/audience revision foundation + historical three-reply two-channel Lab loop with Session reuse.',
    limitations: ['No 20-session/1000-message/20-seed fairness or P95 queue/stop targets; historical loop is 3 messages.'],
    partialSubscenarios: ['historical two-channel three-text loop'],
  },
  {
    rowId: 'V06',
    sourceIds: ['h3-core-planning', 'h0b-harness'],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H3 offline plan-version CAS and atomic admission module tests; H0b oracle/tooling self-proof.',
    limitations: ['No 100-proposal same-version race or 20-breakpoint atomicity matrix; plan binding is fixed local-note only.'],
    partialSubscenarios: ['offline plan CAS/admission tests'],
  },
  {
    rowId: 'V07',
    sourceIds: ['historical-memory'],
    levels: ['historical-limited', 'bounded-real-model'],
    scope: 'Historical limited memory save/exact-read/withdraw and semantic retrieval/background-load samples.',
    limitations: ['No 40-oracle/10,000-record/200-query benchmark or current-HEAD backend; 10k scale and quality metrics untested.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'V09',
    sourceIds: ['historical-capability-3i', 'h4-inner-offline'],
    levels: ['historical-limited', 'offline-module', 'fixed-host-zero-model'],
    scope: 'Historical fixed local-note capability state with two zero-model reloads; H4 offline schema4 domain availability publication.',
    limitations: ['No ≥24 live capability combination matrix, no dynamic skill/candidate verification or new-binding real task proof.'],
    partialSubscenarios: ['fixed capability enable/disable persistence across reloads'],
  },
  {
    rowId: 'V10',
    sourceIds: ['historical-task-goal', 'historical-capability-3i', 'h2a-events'],
    levels: ['historical-limited', 'fixed-host-zero-model', 'offline-module'],
    scope: 'Historical task/goal budget settlement and pause samples; fixed capability readiness; H2a offline ack/dispatch separation.',
    limitations: ['No current-HEAD 32授权/预算/暂停组合 matrix, no real execution-point recheck under model, unknown budgets not settled.'],
    partialSubscenarios: ['historical single task budget settlement'],
  },
  {
    rowId: 'V11',
    sourceIds: ['historical-task-goal', 'h3-core-planning'],
    levels: ['historical-limited', 'offline-module'],
    scope: 'Historical single local task/assignment outcome and H3 offline deterministic Task admission.',
    limitations: ['No 50-worker contention or 20-per-race late-result matrix; unknown resource policies untested.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'V12',
    sourceIds: ['historical-task-goal', 'h5-g1-module'],
    levels: ['historical-limited', 'offline-module'],
    scope: 'Historical Task/Effect/Goal outcome samples; H5 G1 bundle capture/verify and isolated restore module.',
    limitations: ['No 20-per-breakpoint idempotency/unknown matrix, no wired Runtime recovery or real backend receipts.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'V13',
    sourceIds: ['historical-lab-3hc', 'historical-model-context', 'h4c-replyer-inner'],
    levels: ['historical-limited', 'bounded-real-model', 'offline-module'],
    scope: 'Historical bounded real-model replies/context and H4c offline bounded inner-reference prompt block.',
    limitations: ['No ≥80 injection/routing/usage edge matrix; provider cache/retry/fee visibility incomplete.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'V14',
    sourceIds: ['historical-task-goal', 'joint-host-zero-model', 'h2a-probe', 'h2b-subscriptions-time', 'h2b-host-time-probe', 'h2b-live-time-trigger', 'round3-host-zero-model', 'round4-host-zero-model', 'round5-host-real-model'],
    levels: ['historical-limited', 'fixed-host-zero-model', 'bounded-real-model-diagnostic-only', 'offline-module'],
    scope: 'Historical Goal lifecycle + joint/round-3/4/5 fixed-host zero-model reloads and live time-trigger probe; zero-model tool probes; H2b offline subscription/time foundation.',
    limitations: ['No 20-lifecycle subscription/timer/drain ≤4 s matrix on current HEAD; the live time-trigger probe passed once with one append-only time.occurred event but the bounded real-model diagnostic round is NOT V14/V25/business acceptance; H2b time source is plugin-owned with synthetic clock, no DSH schedule/DST/live rules.'],
    partialSubscenarios: ['historical Goal lifecycle + ordered reload'],
  },
  {
    rowId: 'V15',
    sourceIds: ['h5-g1-module'],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H5 G1 real temporary SQLite/file capture/restore module with injected interruption cases.',
    limitations: ['G1 module only; no 12-breakpoint×20 capacity/migration matrix, no real disk-full/lock/volume or single-writer host evidence.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'V16',
    sourceIds: ['historical-memory', 'h4-inner-offline'],
    levels: ['historical-limited', 'offline-module'],
    scope: 'Historical memory withdraw samples and H4 offline inner-domain source withdrawal/deletion-barrier module tests.',
    limitations: ['No 20-subject/7-30-90-180-day propagation matrix, no real backend physical erasure or old-backup restore scan.'],
    partialSubscenarios: ['offline inner-domain withdrawal/deletion barrier'],
  },
  {
    rowId: 'V21',
    sourceIds: ['h5-g1-module'],
    levels: ['offline-module', 'slice-verification'],
    scope: 'H5 G1 restore module starts in maintenance/disarmed state in isolated roots with synthetic ports.',
    limitations: ['Not wired to Runtime; no ≥20 recovery-ready≤120 s host runs, no supervisor restart budget or paused-not-auto-start host evidence.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'V22',
    sourceIds: ['h5-g1-module', 'h5b-runtime-integration', 'h5b-checkpoint-probe', 'h4e-migration-hotfix', 'round3-lead-integration', 'round4-lead-integration', 'round4-host-zero-model', 'h4h5-independent-review'],
    levels: ['offline-module', 'slice-verification', 'independent-verification', 'fixed-host-zero-model'],
    scope: 'H5 G1 bundle manifest/verify + H5b offline composition and read-only checkpoint availability probe + H4e additive migration hotfix + round-4 host checkpoint availability receipt (ready:false); independent authenticity review.',
    limitations: [
      'H5b production capture remains blocked: the checkpoint probe returns ready:false with CHECKPOINT_STAGING_UNCONFIGURED/GOAL_SESSION_EXPORT_UNAVAILABLE/MEMORY_EXPORT_UNAVAILABLE; no capture/restore was executed on the host and no files were written.',
      'No 20-fault recovery matrix, 1 GiB/1000-task benchmark, Goal Session log completeness, real backup destination or RTO≤30 min host drill.',
    ],
    partialSubscenarios: [],
  },
  {
    rowId: 'V24',
    sourceIds: ['h0-baseline', 'h0b-harness', 'h4-host', 'h4b-host', 'round3-host-zero-model', 'round4-host-zero-model', 'round5-host-real-model', 'joint-host-zero-model', 'historical-capability-3i'],
    levels: ['fixed-host-zero-model', 'bounded-real-model-diagnostic-only', 'environment-baseline', 'historical-limited'],
    scope: 'Fixed installed host zero-model reload/status/probe evidence on several verified builds (incl. round-3 H4e hotfix upgrade/reopen), plus environment/SDK identity.',
    limitations: [
      'Zero-model only: no generation, compression, long-history cold recovery, 20-lifecycle matrix, real UI interactions or allowed-network audit.',
      'Round-3 host had one ordered reload and four zero-model tool calls; checkpoint capture unavailable; lifecycle=degraded reflects retained historical facts.',
      'Round-4 host had one ordered reload/nine tool calls, realModelCalls=0; round-5 host had six ordered reloads and one bounded real-model diagnostic tool round (reported usage 1469/41/2406; attempts 4/5 = 1 request/0 stream/cost unknown) plus an intentional append-only time.occurred event; diagnostic pass is NOT V24 acceptance.',
      'Installed builds were isolated verified builds of their slices, not current-HEAD generation acceptance.',
    ],
    partialSubscenarios: ['fixed-host startup/status/read-only zero-model reloads', 'zero-model worker tool surface probe'],
  },
  {
    rowId: 'V25',
    sourceIds: ['historical-lab-3hc', 'historical-model-context'],
    levels: ['historical-limited', 'bounded-real-model'],
    scope: 'Historical bounded real-model text samples (three Lab replies; two-turn replyer/context).',
    limitations: ['No 300-dialogue/200-query/80-injection scale, no precision/recall/Recall@10 thresholds, no double annotation or current-HEAD model routing.'],
    partialSubscenarios: ['historical 3-message two-channel loop'],
  },
  {
    rowId: 'S01',
    sourceIds: ['historical-memory'],
    levels: ['historical-limited', 'bounded-real-model'],
    scope: 'Historical limited memory save/exact-read/withdraw sample on an earlier build.',
    limitations: ['Does not execute S01 story (correction, attribution, cross-day recall); not S01 acceptance.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'S03',
    sourceIds: ['historical-task-goal'],
    levels: ['historical-limited', 'bounded-real-model', 'fixed-host-zero-model'],
    scope: 'Historical owner local-note Goal closure and lifecycle sample.',
    limitations: ['Does not execute S03 subscription/no-change/stop story; not S03 acceptance.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'S04',
    sourceIds: ['historical-lab-3hc'],
    levels: ['historical-limited', 'bounded-real-model'],
    scope: 'Historical two-channel reply loop with same-group Session reuse and one reload.',
    limitations: ['Does not execute S04 task/chat interplay, stale-draft or cancel steps; not S04 acceptance.'],
    partialSubscenarios: ['historical two-channel text loop'],
  },
  {
    rowId: 'S05',
    sourceIds: ['historical-task-goal'],
    levels: ['historical-limited', 'bounded-real-model'],
    scope: 'Historical first-task unknown usage failure and second repaired task outcome, retained as-is.',
    limitations: ['Retains unknown; does not execute S05 unknown-effect/recovery story or current-HEAD evidence.'],
    partialSubscenarios: [],
  },
];

/** 02 §5 matrix rows reuse their system's mapping (same evidence layers). */
export function mappingForRow(rowId: string): RowEvidenceMapping | undefined {
  const direct = PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === rowId);
  if (direct !== undefined) return direct;
  const matrix = /^MATRIX\.(\d)$/.exec(rowId);
  if (matrix !== null) return PRODUCT_EVIDENCE_MAPPINGS.find(mapping => mapping.rowId === `SYS.${matrix[1]}`);
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Verification against a frozen committed HEAD.                       */
/* ------------------------------------------------------------------ */

export interface VerifiedEvidenceFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly present: boolean;
  /** True when the verified blob matches the expected committed blob (for
   * blobCommit refs) or the frozen HEAD blob (default behaviour). */
  readonly matchesFrozenHead: boolean;
  readonly frozenHeadBlobSha256: string | null;
  readonly lastCommit: string | null;
  readonly expectedCommit: string;
  readonly jsonParseable: boolean | null;
  /** Set when the ref uses a committed snapshot instead of the worktree. */
  readonly blobCommit?: string;
  /** Set when the ref pins an expected blob SHA256. */
  readonly expectedSha256?: string;
}

export interface VerifiedEvidenceSource {
  readonly id: string;
  readonly status: 'verified' | 'unknown';
  readonly levels: readonly EvidenceLevel[];
  readonly commits: readonly { readonly sha: string; readonly exists: boolean; readonly ancestor: boolean }[];
  readonly files: readonly VerifiedEvidenceFile[];
  readonly observations: readonly { readonly label: string; readonly value: JsonValue }[];
  /** Fatal issues: file/commit/JSON-parse failures make the source unknown. */
  readonly issues: readonly string[];
  /** Non-fatal authoring hints (e.g. derived path missing); never used for claims. */
  readonly warnings: readonly string[];
  readonly scope: string;
  readonly limitations: readonly string[];
}

export interface EvidenceVerificationReport {
  readonly version: string;
  readonly frozenHead: string;
  readonly sources: readonly VerifiedEvidenceSource[];
  readonly issues: readonly { readonly code: string; readonly sourceId: string; readonly message: string }[];
  readonly warnings: readonly { readonly code: string; readonly sourceId: string; readonly message: string }[];
  readonly unknownSourceIds: readonly string[];
  readonly counts: { readonly sources: number; readonly verified: number; readonly unknown: number; readonly files: number; readonly warnings: number };
}

interface GitFacts {
  readonly blob: Buffer | null;
  readonly lastCommit: string | null;
}

function git(workspaceRoot: string, args: readonly string[], encoding: 'utf8' | 'buffer' = 'utf8'): { status: number; stdout: string | Buffer } {
  const result = spawnSync('git', ['-C', workspaceRoot, ...args], { encoding, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  if (result.error !== undefined || result.stdout === undefined) return { status: result.status ?? 1, stdout: encoding === 'buffer' ? Buffer.alloc(0) : '' };
  return { status: result.status ?? 1, stdout: result.stdout as string | Buffer };
}

function resolveJsonPath(value: unknown, path: string): JsonValue | undefined {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  if (current === undefined) return undefined;
  if (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean' || current === null) return current as JsonValue;
  return undefined;
}

export interface EvidenceFileFactsOutcome {
  readonly facts: VerifiedEvidenceFile;
  readonly issues: readonly string[];
  /** Committed/worktree bytes used for JSON derive (never cached by the verifier). */
  readonly bytes: Buffer | null;
}

/**
 * Verify one evidence file.
 *
 * Default: read the worktree file and compare its SHA256 with the frozen HEAD
 * blob (tamper/dirty worktree fails closed).
 * With `blobCommit`: read `git show <blobCommit>:<path>` directly and compare
 * the committed blob with `expectedSha256` when pinned; worktree rewrites of
 * pipeline output paths do not affect this committed snapshot.
 */
export async function verifyEvidenceFileFacts(root: string, frozenHead: string, file: EvidenceFileRef): Promise<EvidenceFileFactsOutcome> {
  const displayPath = file.path;
  const issues: string[] = [];
  const lastCommitRaw = git(root, ['log', '-1', '--format=%H', '--', displayPath]).stdout;
  const lastCommit = (typeof lastCommitRaw === 'string' ? lastCommitRaw : lastCommitRaw.toString()).trim() || null;
  let bytes: Buffer | null = null;
  let sha256 = '';
  let present = false;
  let matches = false;
  let frozenHeadBlobSha256: string | null = null;
  const base = { path: displayPath, expectedCommit: file.sliceCommit, lastCommit };
  if (file.blobCommit !== undefined) {
    const commitExists = git(root, ['cat-file', '-e', `${file.blobCommit}^{commit}`]).status === 0;
    if (!commitExists) {
      issues.push(`blob commit ${file.blobCommit} is not present`);
    } else if (git(root, ['merge-base', '--is-ancestor', file.blobCommit, frozenHead]).status !== 0) {
      issues.push(`blob commit ${file.blobCommit} is not an ancestor of ${frozenHead}`);
    } else {
      const blob = git(root, ['show', `${file.blobCommit}:${displayPath}`], 'buffer');
      if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
        issues.push(`file ${displayPath} is absent at blob commit ${file.blobCommit}`);
      } else {
        bytes = blob.stdout as Buffer;
        sha256 = sha256Hex(bytes);
        present = true;
        frozenHeadBlobSha256 = sha256;
        matches = file.expectedSha256 === undefined ? true : file.expectedSha256 === sha256;
        if (file.expectedSha256 !== undefined && file.expectedSha256 !== sha256) {
          issues.push(`file ${displayPath} does not match expected committed blob SHA (expected ${file.expectedSha256.slice(0, 16)}…, got ${sha256.slice(0, 16)}…)`);
        }
      }
    }
  } else {
    try {
      bytes = await readFile(join(root, displayPath));
    } catch {
      issues.push(`file ${displayPath} is absent from the worktree`);
      bytes = null;
    }
    if (bytes !== null) {
      sha256 = sha256Hex(bytes);
      const blob = git(root, ['show', `${frozenHead}:${displayPath}`], 'buffer');
      frozenHeadBlobSha256 = blob.status === 0 && Buffer.isBuffer(blob.stdout) ? sha256Hex(blob.stdout as Buffer) : null;
      matches = frozenHeadBlobSha256 === sha256;
      present = frozenHeadBlobSha256 !== null;
      if (!matches) issues.push(`file ${displayPath} does not match the frozen HEAD blob`);
      if (file.expectedSha256 !== undefined && file.expectedSha256 !== sha256) {
        issues.push(`file ${displayPath} does not match expected committed blob SHA`);
        matches = false;
      }
    }
  }
  let jsonParseable: boolean | null = null;
  if (bytes !== null && displayPath.endsWith('.json')) {
    try {
      JSON.parse(bytes.toString('utf8'));
      jsonParseable = true;
    } catch {
      jsonParseable = false;
      issues.push(`file ${displayPath} is not valid JSON`);
    }
  }
  const facts: VerifiedEvidenceFile = {
    ...base,
    sha256,
    bytes: bytes?.byteLength ?? 0,
    present,
    matchesFrozenHead: matches,
    frozenHeadBlobSha256,
    jsonParseable,
    ...(file.blobCommit === undefined ? {} : { blobCommit: file.blobCommit }),
    ...(file.expectedSha256 === undefined ? {} : { expectedSha256: file.expectedSha256 }),
  };
  return { facts, issues, bytes };
}


export async function verifyEvidenceSources(workspaceRoot: string, frozenHead: string): Promise<{ report: EvidenceVerificationReport; result: CheckResult }> {
  const root = resolve(workspaceRoot);
  const headCheck = git(root, ['cat-file', '-t', frozenHead]);
  const headType = typeof headCheck.stdout === 'string' ? headCheck.stdout.trim() : headCheck.stdout.toString().trim();
  if (headCheck.status !== 0 || headType !== 'commit') {
    const report: EvidenceVerificationReport = {
      version: H7_EVIDENCE_VERSION,
      frozenHead,
      sources: [],
      issues: [{ code: 'frozen_head_unavailable', sourceId: '', message: `frozen HEAD ${frozenHead} is not a readable commit` }],
      warnings: [],
      unknownSourceIds: EVIDENCE_SOURCES.map(source => source.id),
      counts: { sources: EVIDENCE_SOURCES.length, verified: 0, unknown: EVIDENCE_SOURCES.length, files: 0, warnings: 0 },
    };
    return { report, result: finish({ oracle: 'h7-evidence', version: H7_EVIDENCE_VERSION, boundary: EVIDENCE_BOUNDARY, scope: 'frozen-head' }, 0, [violation('frozen_head_unavailable', '$', report.issues[0].message)]) };
  }
  const sources: VerifiedEvidenceSource[] = [];
  const issues: { code: string; sourceId: string; message: string }[] = [];
  const warnings: { code: string; sourceId: string; message: string }[] = [];
  const jsonCache = new Map<string, unknown>();
  for (const source of EVIDENCE_SOURCES) {
    const sourceIssues: string[] = [];
    const commitFacts: { sha: string; exists: boolean; ancestor: boolean }[] = [];
    for (const commit of source.commits) {
      const exists = git(root, ['cat-file', '-e', `${commit}^{commit}`]).status === 0;
      const ancestor = exists && git(root, ['merge-base', '--is-ancestor', commit, frozenHead]).status === 0;
      commitFacts.push({ sha: commit, exists, ancestor });
      if (!exists) sourceIssues.push(`commit ${commit} is not present`);
      else if (!ancestor) sourceIssues.push(`commit ${commit} is not an ancestor of ${frozenHead}`);
    }
    const files: VerifiedEvidenceFile[] = [];
    for (const file of source.files) {
      const outcome = await verifyEvidenceFileFacts(root, frozenHead, file);
      sourceIssues.push(...outcome.issues);
      files.push(outcome.facts);
      if (outcome.bytes !== null && file.path.endsWith('.json')) {
        try {
          jsonCache.set(file.path, JSON.parse(outcome.bytes.toString('utf8')) as unknown);
        } catch {
          // jsonParseable=false was already recorded by the helper.
        }
      }
    }
    const observations: { label: string; value: JsonValue }[] = [];
    const deriveWarnings: string[] = [];
    for (const derive of source.derive ?? []) {
      const derivePath = derive.path.startsWith('plugins/shiyu/') ? derive.path : `plugins/shiyu/${derive.path}`;
      const parsed = jsonCache.get(derivePath);
      const value = parsed === undefined ? undefined : resolveJsonPath(parsed, derive.jsonPath);
      if (value === undefined) deriveWarnings.push(`derived field ${derive.jsonPath} in ${derivePath} is missing or not a primitive (not used for claims)`);
      else observations.push({ label: derive.label, value });
    }
    const unknown = sourceIssues.length > 0;
    if (unknown) {
      issues.push({ code: 'evidence_source_unverified', sourceId: source.id, message: sourceIssues.join('; ') });
    }
    if (deriveWarnings.length > 0) {
      warnings.push({ code: 'evidence_derive_unparsed', sourceId: source.id, message: deriveWarnings.join('; ') });
    }
    sources.push({
      id: source.id,
      status: unknown ? 'unknown' : 'verified',
      levels: unknown ? ['unknown'] : source.levels,
      commits: commitFacts,
      files,
      observations,
      issues: sourceIssues,
      warnings: deriveWarnings,
      scope: source.scope,
      limitations: source.limitations,
    });
  }
  const report: EvidenceVerificationReport = {
    version: H7_EVIDENCE_VERSION,
    frozenHead,
    sources,
    issues,
    warnings,
    unknownSourceIds: sources.filter(source => source.status === 'unknown').map(source => source.id),
    counts: {
      sources: sources.length,
      verified: sources.filter(source => source.status === 'verified').length,
      unknown: sources.filter(source => source.status === 'unknown').length,
      files: sources.reduce((sum, source) => sum + source.files.length, 0),
      warnings: warnings.length,
    },
  };
  const violations = issues.map(issue => violation(issue.code, '$', `${issue.sourceId}: ${issue.message}`));
  return {
    report,
    result: finish(
      { oracle: 'h7-evidence', version: H7_EVIDENCE_VERSION, boundary: EVIDENCE_BOUNDARY, scope: 'source-verification' },
      report.counts.files + report.sources.length,
      violations,
      { frozenHead, sources: report.counts.sources, verified: report.counts.verified, unknown: report.counts.unknown },
    ),
  };
}

const EVIDENCE_BOUNDARY =
  '把证据映射限制为“已提交文件 + frozen HEAD blob SHA256 + 切片 commit 祖先”校验：文件缺失/不匹配/JSON 不可解析/commit 不可达 → 该来源 unknown，' +
  '引用它的产品行不得声称该证据层；映射不得出现 complete/verified/passed 等结论性等级，也不得把 not_covered 升级为通过。' +
  '不证明业务语义，不运行产品/宿主/模型。';

/* ------------------------------------------------------------------ */
/* Mapping evaluation + honesty.                                       */
/* ------------------------------------------------------------------ */

export type EvidenceState = 'none' | 'limited-only' | 'unknown' | 'invalid';

export interface EvaluatedRowEvidence {
  readonly rowId: string;
  readonly state: EvidenceState;
  readonly levels: readonly EvidenceLevel[];
  readonly sources: readonly {
    readonly id: string;
    readonly status: 'verified' | 'unknown';
    readonly levels: readonly EvidenceLevel[];
    readonly scope: string;
    readonly limitations: readonly string[];
    readonly files: readonly { readonly path: string; readonly sha256: string; readonly lastCommit: string | null }[];
    readonly issues: readonly string[];
  }[];
  readonly scope: string;
  readonly limitations: readonly string[];
  readonly partialSubscenarios: readonly string[];
}

export function evaluateEvidenceMapping(report: EvidenceVerificationReport): {
  readonly rows: readonly EvaluatedRowEvidence[];
  readonly issues: readonly { readonly code: string; readonly rowId?: string; readonly message: string }[];
} {
  const issues: { code: string; rowId?: string; message: string }[] = [];
  const byId = new Map(report.sources.map(source => [source.id, source]));
  const rows: EvaluatedRowEvidence[] = [];
  const productRowIds = new Set(ALL_REQUIREMENT_ROWS.filter(row => PRODUCT_KINDS.includes(row.kind)).map(row => row.id));
  for (const mapping of PRODUCT_EVIDENCE_MAPPINGS) {
    if (!productRowIds.has(mapping.rowId)) {
      issues.push({ code: 'mapping_for_unknown_row', rowId: mapping.rowId, message: `evidence mapping references unknown product row ${mapping.rowId}` });
    }
    const forbidden = mapping.levels.filter(level => FORBIDDEN_CLAIM_LEVELS.includes(level));
    for (const level of forbidden) issues.push({ code: 'forbidden_claim_level', rowId: mapping.rowId, message: `mapping uses conclusion level ${level}` });
    if (mapping.limitations.length === 0) issues.push({ code: 'mapping_without_limitations', rowId: mapping.rowId, message: 'mapped evidence layers must declare limitations' });
    if (mapping.scope.trim().length === 0) issues.push({ code: 'mapping_without_scope', rowId: mapping.rowId, message: 'mapped evidence layers must declare what they can prove' });
    const resolvedSources: EvaluatedRowEvidence['sources'][number][] = [];
    for (const sourceId of mapping.sourceIds) {
      const source = byId.get(sourceId);
      if (source === undefined) {
        issues.push({ code: 'mapping_unknown_source', rowId: mapping.rowId, message: `mapping references undefined evidence source ${sourceId}` });
        continue;
      }
      resolvedSources.push({
        id: source.id,
        status: source.status,
        levels: source.levels,
        scope: source.scope,
        limitations: source.limitations,
        files: source.files.map(file => ({ path: file.path, sha256: file.sha256, lastCommit: file.lastCommit })),
        issues: source.issues,
      });
    }
    const unknownSources = resolvedSources.filter(source => source.status === 'unknown');
    const verifiedLevels = [...new Set(resolvedSources.filter(source => source.status === 'verified').flatMap(source => source.levels))];
    const levels: EvidenceLevel[] = unknownSources.length > 0 ? [...new Set([...verifiedLevels, 'unknown' as EvidenceLevel])] : verifiedLevels;
    const state: EvidenceState =
      mapping.sourceIds.length === 0 ? 'none' : unknownSources.length > 0 ? 'unknown' : verifiedLevels.every(level => LIMITED_EVIDENCE_LEVELS.includes(level)) ? 'limited-only' : 'invalid';
    if (state === 'invalid') issues.push({ code: 'evidence_level_invalid', rowId: mapping.rowId, message: 'mapping contains a level outside the limited evidence vocabulary' });
    rows.push({
      rowId: mapping.rowId,
      state,
      levels,
      sources: resolvedSources,
      scope: mapping.scope,
      limitations: [
        ...mapping.limitations,
        ...unknownSources.map(source => `source ${source.id} is unknown: ${source.issues.length > 0 ? source.issues[0] : 'unverified'}`),
      ],
      partialSubscenarios: mapping.partialSubscenarios,
    });
  }
  // 02 §5 matrix rows reuse their system's evidence mapping (alias rows keep
  // the same limited layers while preserving the matrix row identity).
  for (const row of ALL_REQUIREMENT_ROWS.filter(item => PRODUCT_KINDS.includes(item.kind))) {
    if (rows.some(entry => entry.rowId === row.id)) continue;
    const alias = mappingForRow(row.id);
    if (alias === undefined || alias.rowId === row.id) continue;
    const base = rows.find(entry => entry.rowId === alias.rowId);
    if (base !== undefined) rows.push({ ...base, rowId: row.id });
  }
  return { rows, issues };
}

export function checkEvidenceMappingHonesty(rows: readonly EvaluatedRowEvidence[], productRowIds: readonly string[]): CheckResult {
  const violations: Violation[] = [];
  const mapped = new Set(rows.map(row => row.rowId));
  for (const row of rows) {
    if (!productRowIds.includes(row.rowId)) continue;
    if (row.state === 'invalid') violations.push(violation('evidence_level_invalid', '$', `row ${row.rowId} has an invalid evidence level`));
    if (row.state !== 'none' && row.state !== 'unknown' && row.limitations.length === 0) {
      violations.push(violation('evidence_missing_limitations', '$', `row ${row.rowId} lists evidence levels without limitations`));
    }
    if (row.levels.includes('unknown') && !row.limitations.some(item => item.includes('unknown'))) {
      violations.push(violation('evidence_unknown_without_limitation', '$', `row ${row.rowId} has unknown evidence sources but no limitation explains it`));
    }
    for (const level of row.levels) {
      if (FORBIDDEN_CLAIM_LEVELS.includes(level)) violations.push(violation('forbidden_claim_level', '$', `row ${row.rowId} uses forbidden claim level ${level}`));
      else if (!ALLOWED_EVIDENCE_LEVELS.includes(level)) violations.push(violation('evidence_level_invalid', '$', `row ${row.rowId} uses unknown evidence level ${level}`));
    }
    if (row.state === 'limited-only' && row.partialSubscenarios.length === 0) {
      // Allowed: some rows only have module-level evidence without named sub-scenarios.
    }
  }
  for (const rowId of productRowIds) {
    if (!mapped.has(rowId)) {
      // Unmapped product rows are legitimate: they simply have no evidence yet.
    }
  }
  return finish(
    { oracle: 'h7-evidence-mapping', version: H7_EVIDENCE_VERSION, boundary: EVIDENCE_MAPPING_BOUNDARY, scope: 'mapping-honesty' },
    rows.length,
    violations,
    { mappedRows: rows.length },
  );
}

const EVIDENCE_MAPPING_BOUNDARY =
  '核对证据映射的诚实性：产品行只能保留 not_covered；证据等级只能来自有限词表（offline/slice-verify/independent/fixed-host-zero-model/synthetic-ui/bounded-real-model/historical-limited/environment-baseline），' +
  '必须声明 scope 与 limitations；unknown 来源必须显式说明；不得出现 complete/verified/passed 等结论。';

/** Per-system evidence summary used by the H7 mapping report. */
export interface SystemEvidenceSummary {
  readonly systemId: string;
  readonly title: string;
  readonly row: EvaluatedRowEvidence | undefined;
  readonly verifiedLevels: readonly EvidenceLevel[];
  readonly sourceIds: readonly string[];
  readonly limitations: readonly string[];
  readonly partialSubscenarios: readonly string[];
  readonly gaps: readonly string[];
}

export const SYSTEM_GAPS: Readonly<Record<string, readonly string[]>> = {
  'SYS.1': ['真实平台/账号/发送 Effect/多频道业务闭环未运行', '多频道公平/过期草稿/送达未知未验'],
  'SYS.2': ['模型实际调用事件工具、core Goal 续接、时间/外部触发、配额/fanout/防环未验'],
  'SYS.3': ['真实宿主/原生 Goal 下的开放式多步规划、模型 plan JSON、费用/缓存未验'],
  'SYS.4': ['当前 HEAD 并发 worker/租约/取消/迟到结果矩阵、跨 Assignment fencing、真实设备未验'],
  'SYS.5': ['真实模型使用内层状态、真实后端正文、跨域重算、真实 UI DOM 未验'],
  'SYS.6': ['当前 HEAD 长历史冷恢复/压缩、真实生成、缓存/费用、完整 provider 请求未验'],
  'SYS.7': ['当前 HEAD Mandate/预算/暂停/撤权矩阵、真实凭据与 canary 扫描、设备 fencing 未验'],
  'SYS.8': ['仅 G1 模块：未接 Runtime、无真实 Goal 日志/Ombre 导出/独立故障域/RPO-RTO/断电'],
  'SYS.9': ['真实浏览器 DOM、真实数据、只读刷新 1000 次/old-response 矩阵、敏感值扫描未验'],
};

export function buildSystemEvidenceSummaries(rows: readonly EvaluatedRowEvidence[]): SystemEvidenceSummary[] {
  const byId = new Map(rows.map(row => [row.rowId, row]));
  const titles = new Map(ALL_REQUIREMENT_ROWS.filter(row => row.kind === 'nine-system').map(row => [row.id, row.title]));
  const summaries: SystemEvidenceSummary[] = [];
  for (let index = 1; index <= 9; index++) {
    const systemId = `SYS.${index}`;
    const row = byId.get(systemId);
    summaries.push({
      systemId,
      title: titles.get(systemId) ?? systemId,
      row,
      verifiedLevels: (row?.levels ?? []).filter(level => level !== 'unknown'),
      sourceIds: row?.sources.map(source => source.id) ?? [],
      limitations: row?.limitations ?? [],
      partialSubscenarios: row?.partialSubscenarios ?? [],
      gaps: SYSTEM_GAPS[systemId] ?? [],
    });
  }
  return summaries;
}

/* ------------------------------------------------------------------ */
/* H7 markdown report.                                                 */
/* ------------------------------------------------------------------ */

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`),
  ].join('\n');
}

export function renderH7MappingMarkdown(report: EvidenceVerificationReport, rows: readonly EvaluatedRowEvidence[], frozenHead: string, generatedAt: string): string {
  const systems = buildSystemEvidenceSummaries(rows);
  const lines: string[] = [];
  lines.push('# H7-prep 已提交证据 → 产品行映射（只读、派生）');
  lines.push('');
  lines.push(`生成时间：${generatedAt}；frozen HEAD \`${frozenHead}\`；evidence map v${H7_EVIDENCE_VERSION}。`);
  lines.push('');
  lines.push('> **不能用于业务验收。** 本报告只把已提交切片证据按“证据层/子场景/限定”绑定到 traceability 产品行；所有产品行仍为 `not_covered`，没有任何 V01–V27/S/FL/系统被升级为通过。' +
    '证据等级只表示该切片实际跑过的层级（离线模块、独立验证、固定宿主零模型、合成 UI、历史限定等），不表示完整门槛。');
  lines.push('');
  lines.push('## 1. 校验口径');
  lines.push('');
  lines.push(`- 证据来源 ${report.counts.sources} 个（verified=${report.counts.verified}，unknown=${report.counts.unknown}），文件 ${report.counts.files} 个。`);
  lines.push('- 每个文件要求：存在于 frozen HEAD 提交树、磁盘 SHA256 与 `git show HEAD:path` blob 一致、声明的切片 commit 存在且为 HEAD 祖先；缺失/不一致/JSON 不可解析 → 该来源 unknown。');
  lines.push('- 不允许结论性等级（complete/verified/passed 等）；每个映射必须声明 scope 与 limitations；产品行状态不改。');
  lines.push('');
  lines.push('## 2. 逐系统：证据 → 状态 → 缺口');
  lines.push('');
  lines.push(table(
    ['系统', '行状态', '已提交证据层', '证据来源', '部分子场景', '缺口/不能证明'],
    systems.map(system => [
      system.systemId,
      'not_covered（证据层仅限定）',
      system.verifiedLevels.join(', ') || '—',
      system.sourceIds.join(', ') || '—',
      system.partialSubscenarios.join('；') || '—',
      [...system.limitations.slice(0, 4), ...system.gaps].join('；'),
    ]),
  ));
  lines.push('');
  lines.push('## 3. 来源明细（路径 + commit + SHA256 前缀）');
  lines.push('');
  lines.push(table(
    ['来源', '状态', '等级', 'commit(s)', '文件（commit/ sha256 前 16）', 'scope', 'limitations'],
    report.sources.map(source => [
      source.id,
      source.status,
      source.levels.join(', '),
      source.commits.map(commit => `${commit.sha.slice(0, 10)}${commit.ancestor ? '' : '(!)'}`).join(', '),
      source.files.map(file => `${file.path.split('/').pop()} (${file.lastCommit?.slice(0, 8) ?? '—'}/${file.sha256.slice(0, 16)})`).join('; '),
      source.scope,
      source.limitations.join('；'),
    ]),
  ));
  lines.push('');
  if (report.unknownSourceIds.length > 0) {
    lines.push('## 4. Unknown 来源（阻断对应证据层）');
    lines.push('');
    for (const source of report.sources.filter(item => item.status === 'unknown')) {
      lines.push(`- \`${source.id}\`: ${source.issues.join('; ')}`);
    }
    lines.push('');
  }
  lines.push(`## ${report.unknownSourceIds.length > 0 ? 5 : 4}. V01–V27 有限映射（仅证据层，状态仍 not_covered）`);
  lines.push('');
  const vRows = rows.filter(row => /^V\d{2}$/.test(row.rowId)).sort((left, right) => left.rowId.localeCompare(right.rowId));
  lines.push(table(
    ['V', '证据层', '来源', '限定', '部分子场景'],
    vRows.map(row => [row.rowId, row.levels.join(', '), row.sources.map(source => source.id).join(', '), row.limitations.join('；'), row.partialSubscenarios.join('；') || '—']),
  ));
  lines.push('');
  lines.push(`其余 V 项（${27 - vRows.length} 个）无可映射已提交证据，保持 not_covered。`);
  lines.push('');
  lines.push(`## ${report.unknownSourceIds.length > 0 ? 6 : 5}. S/FL 有限映射（仅证据层，状态仍 not_covered）`);
  lines.push('');
  const scenarioRows = rows.filter(row => /^(S0|FL0)/.test(row.rowId));
  lines.push(table(
    ['场景', '证据层', '来源', '限定'],
    scenarioRows.map(row => [row.rowId, row.levels.join(', '), row.sources.map(source => source.id).join(', '), row.limitations.join('；')]),
  ));
  lines.push('');
  lines.push(`S/FL 共 16 行；其中 ${16 - scenarioRows.length} 行没有任何已提交业务运行证据，保持 not_covered。H0c 的 synthetic fixture/answer 骨架不计为业务证据。`);
  lines.push('');
  lines.push(`## ${report.unknownSourceIds.length > 0 ? 7 : 6}. 边界与已知限制`);
  lines.push('');
  lines.push('- 所有“固定宿主”证据均为 **零模型**（启动/发布/只读状态/探针），不含真实生成、压缩、长历史恢复或业务任务。');
  lines.push('- “合成 UI”是 synthetic host fixture 上的 Playwright 用例，不是真实浏览器对真实 DSH 数据的验收。');
  lines.push('- 历史限定样本（phase3e/3f/3g/3h/3i、task/goal/model/context-validation）属于早期构建，保留原失败与 unknown，不得升级为当前 HEAD 或完整 V 项。');
  lines.push('- H2a/H2a-probe 为离线模块+零模型探针；模型实际调用事件工具、core Goal 续接未验。');
  lines.push('- H5 仅 G1 模块；H4b 仅合成 UI + 零模型宿主；H4c 仅离线模块与有界 prompt 块；H1 独立验证为离线 oracle。');
  lines.push('- 证据文件 SHA 证明文件一致，不证明业务正确、授权有效或采集完整；产品结论仍以 02 §9 与各 V 原文门槛为准。');
  lines.push('');
  lines.push(`## ${report.unknownSourceIds.length > 0 ? 8 : 7}. 再生命令`);
  lines.push('');
  lines.push('- `node scripts/harness/manifest.mjs`');
  lines.push('- `node scripts/harness/selfproof.mjs`');
  lines.push('- `node scripts/harness/traceability.mjs --strict`（同时生成本报告）');
  lines.push('- `node scripts/harness/fl-scenarios.mjs --require-selfproof`');
  lines.push('');
  lines.push('复核：任取上表来源，`git show <HEAD>:<path> | shasum -a 256` 应与表中前缀一致；`git merge-base --is-ancestor <sliceCommit> <HEAD>` 应为真；' +
    '相应 traceability 行的 `status` 必须仍是 `not_covered`。');
  lines.push('');
  return lines.join('\n');
}

export { SOURCE_BY_ID };
export type { JsonValue };
