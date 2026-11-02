import { ControlStore } from "../../adapters/control-store/index.js";
import type {
  AckInput, ClaimInput, EventPrincipal, FailInput, PublishEventInput,
  SubscribeInput, SubscriptionPatch,
} from "../../contracts/events.js";

/** Shared Agent/host facade. The trusted caller binds principal outside model tool arguments. */
export class EventService {
  constructor(private readonly store: ControlStore) {}
  types(principal: EventPrincipal) { return this.store.request("types", { principal }); }
  publish(principal: EventPrincipal, input: PublishEventInput) { return this.store.request("publish", { principal, input }); }
  subscribe(principal: EventPrincipal, input: SubscribeInput) { return this.store.request("subscribe", { principal, input }); }
  listSubscriptions(principal: EventPrincipal) { return this.store.request("listSubscriptions", { principal }); }
  update(principal: EventPrincipal, id: string, expectedRevision: number, patch: SubscriptionPatch) {
    return this.store.request("update", { principal, id, expectedRevision, patch });
  }
  unsubscribe(principal: EventPrincipal, id: string, expectedRevision: number) {
    return this.store.request("unsubscribe", { principal, id, expectedRevision });
  }
  listEvents(principal: EventPrincipal, options: { limit?: number } = {}) {
    return this.store.request("listEvents", { principal, ...options });
  }
  listDeliveries(principal: EventPrincipal, options: { subscriptionId?: string; limit?: number } = {}) {
    return this.store.request("listDeliveries", { principal, ...options });
  }
  claim(principal: EventPrincipal, input: ClaimInput) { return this.store.request("claim", { principal, input }); }
  ack(principal: EventPrincipal, input: AckInput) { return this.store.request("ack", { principal, input }); }
  fail(principal: EventPrincipal, input: FailInput) { return this.store.request("fail", { principal, input }); }
  stats(principal: EventPrincipal) { return this.store.request("stats", { principal }); }
}
