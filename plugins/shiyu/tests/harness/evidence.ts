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
  | 'synthetic-ui'
  | 'bounded-real-model'
  | 'historical-limited'
  | 'environment-baseline'
  | 'unknown';

export const ALLOWED_EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'offline-module',
  'slice-verification',
  'independent-verification',
  'fixed-host-zero-model',
  'synthetic-ui',
  'bounded-real-model',
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
  'synthetic-ui',
  'bounded-real-model',
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
    sourceIds: ['h2a-events', 'h2a-probe', 'h2b-subscriptions-time', 'round3-lead-integration', 'round3-host-zero-model', 'joint-host-zero-model'],
    levels: ['offline-module', 'slice-verification', 'fixed-host-zero-model'],
    scope: 'H2a event-tool mounting/subscription paths + H2b offline subscription lifecycle/time source/notification routing + Lead integration + zero-model fixed-host diagnostics.timeSource tick.',
    limitations: [
      'No model actually invoked an event tool; real core Goal continuation, declarative-condition tools, platform redelivery and quotas/fanout remain untested.',
      'H2b is G1/G2 offline with synthetic clock/observation/Effect doubles; no DSH schedule/IANA tz database and no monetary/model cost bounding.',
      'Fixed-host evidence is zero-model only (cooperative tick idle, schedules=0, notifications disabled); not V03/V14/V24 acceptance.',
    ],
    partialSubscenarios: ['four publish/subscribe path module tests', 'zero-model restricted worker tool surface probe'],
  },
  {
    rowId: 'SYS.3',
    sourceIds: ['h3-core-planning', 'historical-task-goal'],
    levels: ['offline-module', 'slice-verification', 'historical-limited', 'bounded-real-model', 'fixed-host-zero-model'],
    scope: 'H3 offline controlled multi-step plan/replan with CAS plan versions and Task/Mandate admission; historical limited owner local-note Goal closure.',
    limitations: [
      'No real DSH host/native Goal rounds under current HEAD, no real model plan JSON/cost/cache; only fixed local-note capability binding.',
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
    sourceIds: ['h4-inner-offline', 'h4e-lifecycle-recompute', 'h4e-migration-hotfix', 'h4-host', 'h4b-composition', 'h4b-host', 'h4c-replyer-inner', 'historical-memory', 'h4h5-independent-review'],
    levels: ['offline-module', 'slice-verification', 'fixed-host-zero-model', 'synthetic-ui', 'historical-limited', 'bounded-real-model'],
    scope: 'H4 four inner domains offline + schema4 fixed-host zero-model publication; H4e lifecycle/recompute + additive migration hotfix; H4b synthetic UI; H4c offline replyer inner reference; historical memory samples.',
    limitations: [
      'No real model use of inner state, no real inner bodies/Ombre content, no real browser DOM against real data.',
      'H4e recompute is same-DB bounded deterministic scan; logical retention only (no automatic expiry/physical erase/backup deletion propagation); migration hotfix is offline regression plus separate zero-model host recovery.',
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
    sourceIds: ['h5-g1-module', 'h5b-runtime-integration', 'h4e-migration-hotfix', 'round3-lead-integration', 'round3-host-zero-model', 'h4h5-independent-review'],
    levels: ['offline-module', 'slice-verification', 'independent-verification', 'fixed-host-zero-model'],
    scope: 'H5-B1 G1 checkpoint/restore module + H5b runtime composition/capture integration + H4e additive migration hotfix + round-3 zero-model host reload/probes; independent authenticity review.',
    limitations: [
      'G1 modules/composition only: H5b production capture is blocked (GOAL_SESSION_EXPORT_UNAVAILABLE, trusted staging/manifest missing) and no production restore drill exists.',
      'Round-3 host evidence is zero-model only; checkpoint capture command explicitly unavailable and not executed on host; no real Ombre export/erasure, independent fault domain/V27, RPO/RTO or OS power loss.',
      'No real backup destination or restore drill; not V15/V21/V22/V24/V27 acceptance.',
    ],
    partialSubscenarios: ['G1 backup bundle capture/verify + isolated-root disarmed restore'],
  },
  {
    rowId: 'SYS.9',
    sourceIds: ['h4b-composition', 'h4b-host', 'h6c-channel-projection-ui', 'round3-host-zero-model', 'joint-host-zero-model', 'h0-baseline'],
    levels: ['synthetic-ui', 'fixed-host-zero-model', 'offline-module', 'environment-baseline'],
    scope: 'H4b six-domain dashboard panel + H6c channel projection panel (synthetic-host UI cases); fixed-host zero-model visibility of schema4 publication/summary/projection; H0 status tool check.',
    limitations: [
      'No real DSH client DOM/injection or production browser bundle: H4b/H6c use synthetic host pages, fixtures and synthetic bindings/connections.',
      'No real user interactions beyond read-only status/tool calls; no UI lifecycle/long-list/old-response matrix; round-3 host projection remains zero-model.',
      'Zero-model host checks are not V05/V24 dashboard acceptance; no sensitive-value sweep over real UI.',
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
    sourceIds: ['historical-task-goal', 'joint-host-zero-model', 'h2a-probe', 'h2b-subscriptions-time', 'round3-host-zero-model'],
    levels: ['historical-limited', 'fixed-host-zero-model', 'offline-module'],
    scope: 'Historical Goal lifecycle + joint/round-3 fixed-host zero-model reloads; zero-model tool probes; H2b offline subscription/time foundation.',
    limitations: ['No 20-lifecycle subscription/timer/drain ≤4 s matrix on current HEAD; zero-model only; H2b time source is plugin-owned with synthetic clock, no DSH schedule/DST.'],
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
    sourceIds: ['h5-g1-module', 'h5b-runtime-integration', 'h4e-migration-hotfix', 'round3-lead-integration', 'round3-host-zero-model', 'h4h5-independent-review'],
    levels: ['offline-module', 'slice-verification', 'independent-verification', 'fixed-host-zero-model'],
    scope: 'H5 G1 bundle manifest/verify and isolated restore module; independent authenticity review of H4/H5 committed evidence.',
    limitations: ['No 20-fault recovery matrix, 1 GiB/1000-task benchmark, Goal Session log completeness or RTO≤30 min host drill.'],
    partialSubscenarios: [],
  },
  {
    rowId: 'V24',
    sourceIds: ['h0-baseline', 'h0b-harness', 'h4-host', 'h4b-host', 'round3-host-zero-model', 'joint-host-zero-model', 'historical-capability-3i'],
    levels: ['fixed-host-zero-model', 'environment-baseline', 'historical-limited'],
    scope: 'Fixed installed host zero-model reload/status/probe evidence on several verified builds (incl. round-3 H4e hotfix upgrade/reopen), plus environment/SDK identity.',
    limitations: [
      'Zero-model only: no generation, compression, long-history cold recovery, 20-lifecycle matrix, real UI interactions or allowed-network audit.',
      'Round-3 host had one ordered reload and four zero-model tool calls; checkpoint capture unavailable; lifecycle=degraded reflects retained historical facts.',
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
  readonly matchesFrozenHead: boolean;
  readonly frozenHeadBlobSha256: string | null;
  readonly lastCommit: string | null;
  readonly expectedCommit: string;
  readonly jsonParseable: boolean | null;
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
      const displayPath = file.path;
      const absolute = join(root, displayPath);
      let bytes: Buffer | null = null;
      try {
        bytes = await readFile(absolute);
      } catch {
        sourceIssues.push(`file ${displayPath} is absent from the worktree`);
        files.push({ path: displayPath, sha256: '', bytes: 0, present: false, matchesFrozenHead: false, frozenHeadBlobSha256: null, lastCommit: null, expectedCommit: file.sliceCommit, jsonParseable: null });
        continue;
      }
      const sha256 = sha256Hex(bytes);
      const blob = git(root, ['show', `${frozenHead}:${displayPath}`], 'buffer');
      const blobBytes = blob.status === 0 && Buffer.isBuffer(blob.stdout) ? (blob.stdout as Buffer) : null;
      const frozenHeadBlobSha256 = blobBytes === null ? null : sha256Hex(blobBytes);
      const matches = frozenHeadBlobSha256 === sha256;
      if (!matches) sourceIssues.push(`file ${displayPath} does not match the frozen HEAD blob`);
      const lastCommitRaw = git(root, ['log', '-1', '--format=%H', '--', displayPath]).stdout;
      const lastCommit = (typeof lastCommitRaw === 'string' ? lastCommitRaw : lastCommitRaw.toString()).trim() || null;
      let jsonParseable: boolean | null = null;
      if (displayPath.endsWith('.json')) {
        try {
          const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
          jsonParseable = true;
          jsonCache.set(displayPath, parsed);
        } catch {
          jsonParseable = false;
          sourceIssues.push(`file ${displayPath} is not valid JSON`);
        }
      }
      files.push({ path: displayPath, sha256, bytes: bytes.byteLength, present: true, matchesFrozenHead: matches, frozenHeadBlobSha256, lastCommit, expectedCommit: file.sliceCommit, jsonParseable });
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
