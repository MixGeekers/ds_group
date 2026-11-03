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
    sourceIds: ['h3-core-planning', 'h3-bounded-core-validation-runner', 'h3-core-validation-reconcile', 'round7-lead-integration', 'round8-lead-integration', 'v2-experiment-activation', 'historical-task-goal', 'h2c-real-model-probe', 'h2c-probe-fix-chain', 'round4-localcore-hotfix', 'round4-host-zero-model', 'round5-host-real-model', 'round7-host-bounded-core-goal-failure', 'round8-host-core-validation-reconcile', 'round10-host-v2-create-failure'],
    levels: ['offline-module', 'slice-verification', 'historical-limited', 'bounded-real-model', 'bounded-real-model-diagnostic-only', 'fixed-host-zero-model', 'fixed-host-failure-diagnostic'],
    scope: 'H3 offline controlled multi-step plan/replan with CAS plan versions and Task/Mandate admission; historical limited owner local-note Goal closure.',
    limitations: [
      'The round-5 bounded real-model diagnostic tool round passed (2 requests/2 streams/1 read-only tool round; reported usage 1469/41/2406, attempts 4/5 = 1 request/0 stream/cost unknown) but it is diagnostic-only: not a full core decision/Goal/plan/Task, not V25 and not business acceptance.',
      'Earlier H2c host attempts failed and were not retried; diagnostic pass can never be counted as product/module pass.',
      'Round-7 bounded real core Goal host attempt FAILED at create with GOAL_OPERATION_UNKNOWN: 0 model requests, no retry, no Task/worker/verification/native completion; an unauthorized/paused Goal + Session partial side effect exists; this failure evidence can never be V25/business/nine-system pass.',
      'Round-8 fixed-host reconcile only classifies/cancels the inert residual Goal; it does NOT fix the create failure or prove the business chain.',
      'Round-10 v2 activation is offline/isolated only (1583); the fixed-host v2 attempt then FAILED at history-assert/NATIVE_HISTORY_CHANGED with evaluateAttempts=0, 0 model requests, partial unauthorized/paused v2 Goal+Session, journal unknown, no Task/Effect/budget/artifact; third attempt not authorized — never pass/V25/business/nine-system.',
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
    sourceIds: ['h5-g1-module', 'h5b-runtime-integration', 'h5b-checkpoint-probe', 'h4e-migration-hotfix', 'round3-lead-integration', 'round4-lead-integration', 'round6-lead-integration', 'round7-lead-integration', 'round8-lead-integration', 'v2-experiment-activation', 'h3-core-validation-reconcile', 'round6-host-inner-lifecycle', 'round7-host-bounded-core-goal-failure', 'round8-host-core-validation-reconcile', 'round10-host-v2-create-failure', 'round3-host-zero-model', 'round4-host-zero-model', 'h4h5-independent-review'],
    levels: ['offline-module', 'slice-verification', 'independent-verification', 'fixed-host-zero-model'],
    scope: 'H5-B1 G1 checkpoint/restore module + H5b runtime composition/capture integration and read-only checkpoint availability probe + H4e additive migration hotfix + round-3/4 zero-model host reload/probes; independent authenticity review.',
    limitations: [
      'G1 modules/composition/probe only: H5b production capture remains blocked (CHECKPOINT_STAGING_UNCONFIGURED, GOAL_SESSION_EXPORT_UNAVAILABLE, MEMORY_EXPORT_UNAVAILABLE, trusted staging/manifest missing); the host checkpoint probe returns ready:false and writes no files.',
      'Round-3/4 host evidence is zero-model only; the bounded real-model attempt failed before any model request; no real Ombre export/erasure, independent fault domain/V27, RPO/RTO or OS power loss.',
      'Round-6 inner-lifecycle host probe is diagnostics-only (in-memory, skips memory backend); it does not prove live persistence/checkpoint readiness or V15/V21/V22/V24/V27 acceptance.',
      'Round-7 failure + round-8 reconcile cancelled v1 residual Goal without model/retry; round-10 v2 attempt re-failed at history-assert and left a partial unauthorized/paused v2 Goal+Session with journal unknown — these failure/reconcile diagnostics cannot prove checkpoint/recovery readiness or V15/V21/V22/V24/V27 acceptance.',
      'No real backup destination or restore drill; not V15/V21/V22/V24/V27 acceptance.',
    ],
    partialSubscenarios: ['G1 backup bundle capture/verify + isolated-root disarmed restore'],
  },
  {
    rowId: 'SYS.9',
    sourceIds: ['h4b-composition', 'h4b-host', 'h6c-channel-projection-ui', 'round3-host-zero-model', 'round4-host-zero-model', 'round5-host-real-model', 'round6-host-inner-lifecycle', 'round7-host-bounded-core-goal-failure', 'round8-host-core-validation-reconcile', 'round10-host-v2-create-failure', 'joint-host-zero-model', 'h0-baseline'],
    levels: ['synthetic-ui', 'fixed-host-zero-model', 'bounded-real-model-diagnostic-only', 'offline-module', 'environment-baseline'],
    scope: 'H4b six-domain dashboard panel + H6c channel projection panel (synthetic-host UI cases); fixed-host zero-model visibility of schema4 publication/summary/projection; H0 status tool check.',
    limitations: [
      'No real DSH client DOM/injection or production browser bundle: H4b/H6c use synthetic host pages, fixtures and synthetic bindings/connections.',
      'No real user interactions beyond read-only status/tool calls; no UI lifecycle/long-list/old-response matrix; round-3/4 host projection remains zero-model.',
      'Round-4 host had only a failed bounded real-model attempt; round-5 adds a diagnostic real-model tool round; round-6 adds an isolated inner-lifecycle diagnostic (59072-byte status-final proves only diagnostics-cache passed); round-7 adds a FAILED bounded core Goal attempt (GOAL_OPERATION_UNKNOWN, 0 model requests, partial unauthorized/paused Goal+Session); round-8 reconcile cancelled the residual Goal (58,375-byte status-final proves reconcile cache only). Real browser DOM, sensitive-value sweep and V05/V24 dashboard acceptance remain untested.',
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
