import type {
  AckInput, ClaimedDelivery, ClaimInput, EventPrincipal, EventStats, EventTypeDefinition,
  FailInput, PublishEventInput, PublishReceipt, StoredDelivery, StoredEvent,
  StoredSubscription, StoreInfo, SubscribeInput, SubscriptionPatch,
} from "../../contracts/events.js";
import type { TaskCommands, TaskRuntimeIdentity } from './task-domain.js';
import type { GoalBinding, GoalCommandReceipt } from '../dsh/goals.js';

export interface ControlStoreOptions {
  filename: string;
  eventTypes: EventTypeDefinition[];
  componentHandlers: string[];
  /** Required for Task commands; omitted keeps an event-only store. Host-owned identity, never UI input. */
  runtimeIdentity?: TaskRuntimeIdentity;
}

type WithPrincipal<T = unknown> = { principal: EventPrincipal } & T;
export interface StoreCommands extends TaskCommands {
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
