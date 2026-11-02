/** Shared types for the requirement registry and the traceability generator. */

export interface RequirementSource {
  /** Source document id from SOURCE_DOCUMENTS (doc-01/doc-02/doc-plan/doc-v). */
  readonly doc: string;
  /** Heading prefix that must exist in the document (e.g. `### 6.1`, `## 2. 系统 1`). */
  readonly heading: string;
  /** Substring that must appear in that heading (or in the section body for table rows). */
  readonly contains: string;
}

/**
 * Honest evidence-layer statuses. Product requirements are always
 * `not_covered` in H0; harness capabilities can become `self_proven` only
 * from frozen artifacts. No status means "product verified".
 */
export type RequirementStatus =
  | 'not_covered'
  | 'tooling_ready'
  | 'partial_tooling'
  | 'self_proven'
  | 'blocked'
  | 'unknown'
  | 'failing';

export const ALLOWED_STATUSES: readonly RequirementStatus[] = [
  'not_covered',
  'tooling_ready',
  'partial_tooling',
  'self_proven',
  'blocked',
  'unknown',
  'failing',
];
