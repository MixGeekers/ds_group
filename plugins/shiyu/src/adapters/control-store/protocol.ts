import type {
  AckInput, ClaimedDelivery, ClaimInput, EventPrincipal, EventStats, EventTypeDefinition,
  FailInput, PublishEventInput, PublishReceipt, StoredDelivery, StoredEvent,
  StoredSubscription, StoreInfo, SubscribeInput, SubscriptionPatch,
} from "../../contracts/events.js";
import type { TaskCommands, TaskRuntimeIdentity } from './task-domain.js';
import type { GoalBinding, GoalCommandReceipt } from '../dsh/goals.js';
import type { ConversationCommands } from './conversation-domain.js';
import type { CommitWatermark } from './commit-watermark.js';
import type { ViewCommands } from './view-domain.js';
import type { MemoryCommands } from './memory-domain.js';
import type { MemoryIndexCommands } from './memory-index-domain.js';
import type { AvailableMemoryDomain, UnavailableDomain, StatePublicationReceipt } from '../../state/publication.js';
import type { CoreCommands } from '../../contracts/core.js';

export interface ControlStoreOptions {
  filename: string;
  eventTypes: EventTypeDefinition[];
  componentHandlers: string[];
  /** Required for Task commands; omitted keeps an event-only store. Host-owned identity, never UI input. */
  runtimeIdentity?: TaskRuntimeIdentity;
  /** Host-owned deployment binding, never supplied by a public remember command. */
  memoryBackend?: { backendId: string; deploymentId: string };
}

type WithPrincipal<T = unknown> = { principal: EventPrincipal } & T;
export interface StoreCommands extends TaskCommands, ConversationCommands, ViewCommands, MemoryCommands, MemoryIndexCommands, CoreCommands {
  'core.status': { input: Record<string, never>; output: { ready: boolean; errorCode?: string } };
  'memory.status': { input: Record<string, never>; output: { configured: boolean; ready: boolean; errorCode?: string } };
  'memory.index.status': { input: Record<string, never>; output: { configured: boolean; ready: boolean; errorCode?: string } };
  /** Trusted startup/reconciliation only. Never forward public JSON to this command or accept a caller publisher/manifest. */
  'state.publishMemoryAvailability': { input: { requestId: string; expectedBaselineId: string; expectedStateVersion: number;
    availability: UnavailableDomain | AvailableMemoryDomain }; output: StatePublicationReceipt };
  /** Trusted read-only control write-commit watermark; not the Event sequence or a ReadView stateVersion. */
  'control.watermark': { input: Record<string, never>; output: CommitWatermark };
  /** Trusted host-to-worker bookkeeping only; never exposed as public/model commands. */
  'goal.binding.load': { input: { goalId: string }; output: GoalBinding | undefined };
  'goal.binding.loadCommand': { input: { goalId: string; commandId: string }; output: GoalCommandReceipt | undefined };
  'goal.binding.compareAndSet': { input: { expectedMetadataVersion?: number; binding: GoalBinding }; output: void };
  'goal.binding.list': { input: { ownerId: string; scope: string }; output: GoalBinding[] };
  info: { input: Record<string, never>; output: StoreInfo };
  types: { input: WithPrincipal; output: EventTypeDefinition[] };
  publish: { input: WithPrincipal<{ input: PublishEventInput }>; output: PublishReceipt };
  subscribe: { input: WithPrincipal<{ input: SubscribeInput }>; output: StoredSubscription };
  listSubscriptions: { input: WithPrincipal; output: StoredSubscription[] };
  update: { input: WithPrincipal<{ id: string; expectedRevision: number; patch: SubscriptionPatch }>; output: StoredSubscription };
  unsubscribe: { input: WithPrincipal<{ id: string; expectedRevision: number }>; output: StoredSubscription };
  listEvents: { input: WithPrincipal<{ limit?: number }>; output: StoredEvent[] };
  listDeliveries: { input: WithPrincipal<{ subscriptionId?: string; limit?: number }>; output: StoredDelivery[] };
  claim: { input: WithPrincipal<{ input: ClaimInput }>; output: ClaimedDelivery[] };
  ack: { input: WithPrincipal<{ input: AckInput }>; output: StoredDelivery };
  fail: { input: WithPrincipal<{ input: FailInput }>; output: StoredDelivery };
  stats: { input: WithPrincipal; output: EventStats };
  close: { input: Record<string, never>; output: void };
}

export type StoreRequest = {
  [K in keyof StoreCommands]: { id: number; command: K; args: StoreCommands[K]["input"] }
}[keyof StoreCommands];
export type StoreResponse =
  | { kind: "ready"; info: StoreInfo }
  | { kind: "fatal"; error: { code: string; message: string } }
  | { kind: "result"; id: number; value?: unknown; error?: { code: string; message: string } };
