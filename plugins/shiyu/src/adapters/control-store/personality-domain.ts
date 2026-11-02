import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_INNER_SOURCE_REFS, PERSONALITY_LANGUAGES, PERSONALITY_LEARNING_POLICIES, PERSONALITY_PRINCIPLES, PERSONALITY_SOURCE_KINDS,
  PERSONA_BASELINE, innerFail, innerFields, innerId, innerInteger, personaProfile,
  validatePersonalityPayload,
  type InnerSourceRef, type PersonaDiff, type PersonaProfile, type PersonalityCommands, type PersonalityDomainRequest,
  type PersonalityPayload,
} from '../../contracts/inner.js';
export type { PersonalityDomainRequest } from '../../contracts/inner.js';
import { InnerDomainBase, type InnerDomainBaseOptions, type StoredInnerRecord } from './inner-domain.js';
import { SqliteTransactions } from './transaction.js';

/** Stable-profile policy version. Ordinary conversation has no path to change it. */
export const PERSONALITY_POLICY_VERSION = 1;
const RECORD_KINDS = ['profile', 'candidate', 'review'] as const;
const PROFILE_STATUSES = ['active', 'superseded'] as const;
const CANDIDATE_STATUSES = ['awaiting-review', 'approved', 'rejected'] as const;
const LEARNING_POLICY = PERSONALITY_LEARNING_POLICIES[0];
type Options = Omit<InnerDomainBaseOptions, 'domain' | 'policyVersion'>;
interface DomainState { activeRecordId: string; activeProfileVersion: number; learningPolicy: string; revision: number }

/**
 * Stable PersonaProfile with a versioned, reviewed change path.
 *
 * Ordinary chat, tool output and emotion/relationship writes never touch the
 * active profile: the only activation path is an explicit whitelisted proposal
 * plus a separate review decision, both with verified sources and CAS. Learning
 * is disabled by policy, no user text becomes a system prompt field, and
 * withdrawing a profile source fails the profile read closed instead of
 * silently continuing with stale preferences.
 */
export class PersonalityDomain extends InnerDomainBase {
  constructor(db: DatabaseSync, tx: SqliteTransactions, options: Options) {
    super(db, tx, { ...options, domain: 'personality', policyVersion: PERSONALITY_POLICY_VERSION });
  }
  protected installDomainTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.prefix}state(id INTEGER PRIMARY KEY CHECK(id=1),
      active_record_id TEXT NOT NULL,active_profile_version INTEGER NOT NULL,learning_policy TEXT NOT NULL,revision INTEGER NOT NULL);`);
  }
  protected initializeDomain(): void {
    const row = this.db.prepare(`SELECT * FROM ${this.prefix}state WHERE id=1`).get() as Record<string, unknown> | undefined;
    if (row) {
      const state = this.domainState();
      if (!this.record(state.activeRecordId)) innerFail('CORRUPT_INNER_DOMAIN', 'Personality state points at a missing profile');
      return;
    }
    if (this.db.prepare(`SELECT record_id FROM ${this.prefix}records LIMIT 1`).get()) {
      innerFail('CORRUPT_INNER_DOMAIN', 'Personality profile history exists without its authority state');
    }
    const record = this.persist({ recordId: 'profile:v1:r1', identity: 'profile:v1', kind: 'profile', status: 'active',
      audience: this.ownedAudience(), sourceRefs: [this.ownerCommand('personality-baseline-v1')],
      payload: validatePersonalityPayload({ kind: 'profile', profileVersion: PERSONA_BASELINE.profileVersion, profile: structuredClone(PERSONA_BASELINE) as unknown as PersonaProfile }) });
    this.db.prepare(`INSERT INTO ${this.prefix}state VALUES(1,?,?,?,1)`).run(record.recordId, PERSONA_BASELINE.profileVersion, LEARNING_POLICY);
  }
  protected validatePayload(kind: string, payload: unknown): Record<string, unknown> {
    const body = validatePersonalityPayload(payload);
    if (body.kind !== kind) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Personality record kind disagrees with its payload');
    return body as unknown as Record<string, unknown>;
  }
  protected checkRecord(record: StoredInnerRecord): void {
    if (!RECORD_KINDS.includes(record.kind as (typeof RECORD_KINDS)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown personality record kind');
    if (record.kind === 'profile' && !PROFILE_STATUSES.includes(record.status as (typeof PROFILE_STATUSES)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown profile status');
    if (record.kind === 'candidate' && !CANDIDATE_STATUSES.includes(record.status as (typeof CANDIDATE_STATUSES)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown candidate status');
    if (record.kind === 'review' && record.status !== 'approved' && record.status !== 'rejected') innerFail('CORRUPT_INNER_DOMAIN', 'Unknown persona review status');
    if (record.kind === 'profile' ? record.audience.kind !== 'owner' : record.audience.kind === 'owner') {
      innerFail('CORRUPT_INNER_DOMAIN', 'Personality profile and proposal audiences disagree with their kind');
    }
    if (!record.identity.startsWith(`${record.kind}:`)) innerFail('CORRUPT_INNER_DOMAIN', 'Personality record identity disagrees with its kind');
  }
  protected captureEligible(record: StoredInnerRecord): boolean {
    // Read views expose the frozen active profile only; candidates are write-record history.
    return record.kind === 'profile' && record.recordId === this.activeRecordId();
  }

  private domainState(): DomainState {
    this.tx.assertUsable();
    const row = this.db.prepare(`SELECT * FROM ${this.prefix}state WHERE id=1`).get() as Record<string, unknown> | undefined;
    if (!row) innerFail('CORRUPT_INNER_DOMAIN', 'Personality authority state is missing');
    if (typeof row.active_record_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(row.active_record_id)
      || !Number.isSafeInteger(row.active_profile_version) || Number(row.active_profile_version) < 1
      || !PERSONALITY_LEARNING_POLICIES.includes(String(row.learning_policy) as never) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) {
      innerFail('CORRUPT_INNER_DOMAIN', 'Personality authority state is invalid');
    }
    return { activeRecordId: String(row.active_record_id), activeProfileVersion: Number(row.active_profile_version),
      learningPolicy: String(row.learning_policy), revision: Number(row.revision) };
  }
  private saveState(state: DomainState): void {
    const changed = this.db.prepare(`UPDATE ${this.prefix}state SET active_record_id=?,active_profile_version=?,learning_policy=?,revision=? WHERE id=1`)
      .run(state.activeRecordId, state.activeProfileVersion, state.learningPolicy, state.revision);
    if (changed.changes !== 1) innerFail('CORRUPT_INNER_DOMAIN', 'Personality authority state disappeared');
  }
  private activeRecordId(): string { return this.domainState().activeRecordId; }
  private activeProfile(): { record: StoredInnerRecord; payload: Extract<PersonalityPayload, { kind: 'profile' }> } {
    const state = this.domainState();
    const record = this.record(state.activeRecordId);
    if (!record || record.kind !== 'profile' || record.status !== 'active') innerFail('CORRUPT_INNER_DOMAIN', 'Active personality profile is missing or superseded');
    return { record, payload: this.payload(record) as unknown as Extract<PersonalityPayload, { kind: 'profile' }> };
  }
  private applyDiff(base: PersonaProfile, diff: PersonaDiff, version: number): PersonaProfile {
    return personaProfile({
      schemaVersion: 1, profileVersion: version,
      displayName: diff.displayName ?? base.displayName,
      language: diff.language ?? base.language,
      style: { ...base.style, ...(diff.style ?? {}) },
      principles: diff.principles ?? base.principles,
    });
  }

  snapshot(input: PersonalityCommands['personality.snapshot']['input']): PersonalityCommands['personality.snapshot']['output'] {
    innerFields(input, ['conversationId']);
    const conversationId = innerId(input.conversationId, 'conversationId');
    return this.tx.atomic(() => {
      this.activeConversation(conversationId);
      const state = this.domainState(), active = this.activeProfile();
      const candidates = this.latestRecords().filter(record => record.kind === 'candidate' && record.status === 'awaiting-review').length;
      return { schemaVersion: 1 as const, profileVersion: state.activeProfileVersion, revision: state.revision,
        learningPolicy: state.learningPolicy as (typeof PERSONALITY_LEARNING_POLICIES)[number],
        policyVersion: this.policyVersion(), candidates, activeRecordId: active.record.recordId,
        activeEvidenceState: this.evidenceState(active.record), sourceRefs: structuredClone(active.record.sourceRefs) };
    });
  }

  propose(input: PersonalityCommands['personality.propose']['input']): PersonalityCommands['personality.propose']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'expectedProfileVersion', 'sourceKind', 'displayName', 'language', 'style', 'principles', 'sourceRefs'],
      ['requestId', 'conversationId', 'expectedProfileVersion', 'sourceKind', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    const expectedProfileVersion = innerInteger(input.expectedProfileVersion, 'expectedProfileVersion');
    if (!PERSONALITY_SOURCE_KINDS.includes(input.sourceKind as never)) innerFail('INVALID_INNER_INPUT', 'Unknown persona source kind');
    const sourceKind = input.sourceKind as (typeof PERSONALITY_SOURCE_KINDS)[number];
    if (sourceKind === 'learned-pattern') {
      innerFail('LEARNING_DISABLED', 'Stable-personality learning is disabled by policy; a learned pattern cannot silently change it');
    }
    const diffFields: Record<string, unknown> = {};
    for (const [field, value] of [['displayName', input.displayName], ['language', input.language], ['style', input.style], ['principles', input.principles]] as const) {
      if (value !== undefined) diffFields[field] = value;
    }
    return this.tx.atomic(() => this.command(requestId, 'propose', {
      conversationId, expectedProfileVersion, sourceKind, diff: diffFields, sourceRefs: input.sourceRefs,
    }, () => {
      const facts = this.activeConversation(conversationId);
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      const state = this.domainState();
      if (state.learningPolicy !== LEARNING_POLICY) innerFail('INCOMPATIBLE_INNER_POLICY', 'Unexpected personality learning policy');
      if (state.activeProfileVersion !== expectedProfileVersion) innerFail('INNER_RECORD_CONFLICT', 'Active profile version changed; refresh before proposing');
      if (!diffFields.displayName && !diffFields.language && !diffFields.style && !diffFields.principles) innerFail('INVALID_INNER_INPUT', 'A persona change proposal needs at least one whitelisted field');
      const payload = validatePersonalityPayload({ kind: 'candidate', candidateId: 'placeholder', baseProfileVersion: state.activeProfileVersion,
        sourceKind: 'user-explicit', diff: diffFields });
      if (payload.kind !== 'candidate') innerFail('INVALID_PERSONALITY_PAYLOAD', 'Unexpected candidate payload');
      const candidateId = randomUUID();
      const recordId = `candidate:${candidateId}:r1`;
      this.persist({ recordId, identity: `candidate:${candidateId}`, kind: 'candidate', status: 'awaiting-review',
        audience: facts.audience, sourceRefs: evidence.refs,
        payload: validatePersonalityPayload({ ...payload, candidateId }) });
      return { requestId, changed: true, record: { candidateId, recordId, revision: 1, status: 'awaiting-review' } };
    }));
  }

  review(input: PersonalityCommands['personality.review']['input']): PersonalityCommands['personality.review']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'candidateId', 'expectedRevision', 'decision', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    const candidateId = innerId(input.candidateId, 'candidateId');
    const expectedRevision = innerInteger(input.expectedRevision, 'expectedRevision');
    if (input.decision !== 'approve' && input.decision !== 'reject') innerFail('INVALID_INNER_INPUT', 'Invalid persona review decision');
    const decision = input.decision;
    return this.tx.atomic(() => this.command(requestId, 'review', { conversationId, candidateId, expectedRevision, decision, sourceRefs: input.sourceRefs }, () => {
      const facts = this.activeConversation(conversationId);
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      const candidate = this.latestOrFail(`candidate:${candidateId}`);
      if (candidate.kind !== 'candidate') innerFail('UNKNOWN_INNER_RECORD', 'This identity is not a persona change candidate');
      if (candidate.status !== 'awaiting-review') innerFail('INNER_RECORD_CONFLICT', 'This persona proposal was already decided');
      if (candidate.revision !== expectedRevision) innerFail('INNER_RECORD_CONFLICT', 'Persona proposal changed; refresh before reviewing');
      if (candidate.audience.audienceId !== conversationId) innerFail('INNER_AUDIENCE_FORBIDDEN', 'A persona review must come from the proposing audience');
      const candidatePayload = this.payload(candidate) as unknown as Extract<PersonalityPayload, { kind: 'candidate' }>;
      const state = this.domainState();
      if (candidatePayload.baseProfileVersion !== state.activeProfileVersion) innerFail('INNER_RECORD_CONFLICT', 'The active profile changed after this proposal');
      const reviewId = randomUUID();
      if (decision === 'reject') {
        this.setStatus({ ...candidate }, 'rejected');
        this.persist({ recordId: `review:${reviewId}:r1`, identity: `review:${reviewId}`, kind: 'review', status: 'rejected',
          audience: candidate.audience, sourceRefs: evidence.refs,
          payload: validatePersonalityPayload({ kind: 'review', candidateId, decision: 'reject' }) });
        return { requestId, changed: true, record: { candidateId, recordId: candidate.recordId, profileVersion: state.activeProfileVersion, status: 'rejected' } };
      }
      if (this.evidenceState(candidate) === 'revoked') innerFail('INNER_SOURCE_REVOKED', 'A withdrawn persona proposal cannot be approved');
      const active = this.activeProfile();
      const profileVersion = innerInteger(state.activeProfileVersion + 1, 'profileVersion');
      const profile = this.applyDiff(active.payload.profile, candidatePayload.diff, profileVersion);
      const combined = [...candidate.sourceRefs, ...evidence.refs].sort((a, b) => `${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`));
      const unique = combined.filter((ref, index) => index === 0 || `${ref.kind}:${ref.sourceId}` !== `${combined[index - 1]!.kind}:${combined[index - 1]!.sourceId}`);
      if (unique.length > MAX_INNER_SOURCE_REFS) innerFail('INVALID_INNER_INPUT', 'A profile version cannot carry unbounded provenance');
      const profileRecordId = `profile:v${profileVersion}:r1`;
      this.setStatus({ ...active.record }, 'superseded');
      this.persist({ recordId: profileRecordId, identity: `profile:v${profileVersion}`, kind: 'profile', status: 'active',
        audience: this.ownedAudience(), sourceRefs: unique,
        payload: validatePersonalityPayload({ kind: 'profile', profileVersion, profile }) });
      this.setStatus({ ...candidate }, 'approved');
      this.persist({ recordId: `review:${reviewId}:r1`, identity: `review:${reviewId}`, kind: 'review', status: 'approved',
        audience: candidate.audience, sourceRefs: evidence.refs,
        payload: validatePersonalityPayload({ kind: 'review', candidateId, decision: 'approve' }) });
      this.saveState({ activeRecordId: profileRecordId, activeProfileVersion: profileVersion, learningPolicy: state.learningPolicy,
        revision: innerInteger(state.revision + 1, 'revision') });
      return { requestId, changed: true, record: { candidateId, recordId: profileRecordId, profileVersion, status: 'approved' } };
    }));
  }

  withdraw(input: PersonalityCommands['personality.withdraw']['input']): PersonalityCommands['personality.withdraw']['output'] {
    return super.withdraw(input);
  }
  captureForView(input: PersonalityCommands['personality.captureForView']['input']): PersonalityCommands['personality.captureForView']['output'] {
    return super.captureForView(input);
  }
  validateForView(input: PersonalityCommands['personality.validateForView']['input']): PersonalityCommands['personality.validateForView']['output'] {
    return super.validateForView(input);
  }
  readBodies(input: PersonalityCommands['personality.readBodies']['input']): PersonalityCommands['personality.readBodies']['output'] {
    return super.readBodies(input);
  }

  execute(request: PersonalityDomainRequest): unknown {
    innerFields(request, ['command', 'args']);
    switch (request.command) {
      case 'personality.snapshot': return this.snapshot(request.args);
      case 'personality.propose': return this.propose(request.args);
      case 'personality.review': return this.review(request.args);
      case 'personality.withdraw': return this.withdraw(request.args);
      case 'personality.captureForView': return this.captureForView(request.args);
      case 'personality.validateForView': return this.validateForView(request.args);
      case 'personality.readBodies': return this.readBodies(request.args);
      default: return innerFail('INVALID_INNER_INPUT', 'Unknown personality command');
    }
  }
}
