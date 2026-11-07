import { normalizeDelivery, parseDeliveryDirective, isDeliveryResend, isDeliveryFollowup, allowsDirectDeliveryProposal } from './delivery-policy.mjs';

const metadataOf = event => event.content?.['org.ds_group'] || {};
const intentOf = route => route?.kind === 'direct' ? { kind: 'direct', recipientId: route.recipientId } : { kind: 'origin' };
const intentKey = route => JSON.stringify([intentOf(route), route?.sourceEventId, route?.originBotId]);

export class NodeDelivery {
  constructor({ store, participant, participants, matrix, client, tasks, updateTask, flushTasks, ingest }) {
    Object.assign(this, { store, participant, participants, matrix, client, tasks, updateTask, flushTasks, ingest });
  }

  isHuman(id) { return this.participants.some(person => person.id === id && person.kind === 'human'); }

  humanFor(event) {
    return this.isHuman(event.sender) ? event.sender : metadataOf(event).originSenderId;
  }

  validate(intent, event) {
    const normalized = normalizeDelivery({ kind: intent?.kind, ...(intent?.kind === 'direct' ? { recipientId: intent.recipientId } : {}) }, this.participants);
    if (normalized.kind === 'direct' && normalized.recipientId !== this.humanFor(event)) {
      throw Object.assign(new Error('Direct delivery must address the original human requester'), { status: 400 });
    }
    return normalized;
  }

  targetOf(item) {
    const control = item && this.store.control(item.event_id);
    if (control?.action === 'route') return this.store.item(control.targetEventId);
    return item;
  }

  referencedRequest(event) {
    const replyTo = metadataOf(event).replyTo || event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
    if (!replyTo) return undefined;
    let item = this.store.item(replyTo) || this.store.sourceForSentEvent(replyTo);
    if (item && !this.isHuman(item.event.sender)) item = this.store.item(metadataOf(item.event).originEventId);
    return item?.event.sender === event.sender && item.event.room_id === event.room_id ? this.targetOf(item) : undefined;
  }

  register(event) {
    if (this.store.route(event.event_id)) return;
    const meta = metadataOf(event);
    const human = this.isHuman(event.sender);
    let inherited = meta.delivery;
    const parent = !human && meta.originEventId ? this.store.item(meta.originEventId) : undefined;
    const parentRoute = parent && this.store.route(parent.event_id);
    if (parentRoute && (!inherited?.originBotId || parentRoute.originBotId === inherited.originBotId)) inherited = parentRoute;
    let directive;
    let error;
    try { directive = human ? parseDeliveryDirective(event.content.body, event.sender) : undefined; }
    catch (cause) { error = cause.message; }
    const hasReference = Boolean(meta.replyTo || event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id);
    const referenced = human && this.referencedRequest(event);
    let previous = human ? hasReference ? referenced : this.targetOf(this.store.previousRequest(event)) : undefined;
    const resend = human && isDeliveryResend(event.content.body);
    const followup = human && isDeliveryFollowup(event.content.body);
    let ambiguous = false;
    if (previous && !referenced && (directive?.routingOnly || resend || followup)) {
      const humans = this.participants.filter(person => person.kind === 'human').map(person => person.id);
      if (this.store.interveningHuman(event, previous.event_id, humans)) { previous = undefined; ambiguous = true; }
    }
    if (previous && (directive?.routingOnly || resend || followup) && !this.store.route(previous.event_id)) this.register(previous.event);
    const priorRoute = previous && this.store.route(previous.event_id);
    if (priorRoute?.ambiguous) { previous = undefined; ambiguous = true; }
    let intent = { kind: 'origin' };
    let explicit = false;
    try {
      if (directive) { intent = this.validate(directive.delivery, event); explicit = true; }
      else if (human && meta.delivery) { intent = this.validate(meta.delivery, event); explicit = true; }
      else if (!human && inherited) { intent = this.validate(intentOf(inherited), event); explicit = true; }
      else if (human && meta.conversationKind === 'direct') { intent = { kind: 'direct', recipientId: event.sender }; explicit = true; }
      else if ((resend || followup) && previous && priorRoute) { intent = this.validate(intentOf(priorRoute), event); explicit = true; }
    } catch (cause) { error = cause.message; }
    const base = { ...intent, explicit, state: 'requested', sourceEventId: event.event_id,
      authoritative: human, originBotId: human ? this.participant.id : inherited?.originBotId || meta.returnTo || this.participant.id,
      ...(ambiguous ? { ambiguous: true, allowModelDelivery: true } : {}),
      ...(error ? { error } : {}) };
    if (directive?.routingOnly && previous && !error) {
      const task = this.store.task(previous.event_id);
      const waiting = previous.response?.delegated && task?.status === 'running';
      if (!priorRoute?.frozen && (['queued', 'running', 'produced', 'generated'].includes(previous.status) || waiting)) {
        this.store.setRoute(previous.event_id, { ...priorRoute, ...intent, recipientId: intent.recipientId, explicit: true, state: 'requested',
          roomId: undefined, sourceEventId: event.event_id });
        this.updateTask(previous, {});
        this.store.setControl(event.event_id, { action: 'route', targetEventId: previous.event_id, requestedDelivery: intent });
        this.store.setRoute(event.event_id, { kind: 'origin', explicit: true, state: 'requested', authoritative: false,
          sourceEventId: event.event_id, originBotId: this.participant.id });
        return;
      }
      this.store.setControl(event.event_id, { action: 'resend', targetEventId: previous.event_id });
    } else if (resend && previous && !error) {
      this.store.setControl(event.event_id, { action: 'resend', targetEventId: previous.event_id });
    } else if (resend && hasReference && !error) {
      this.store.setControl(event.event_id, { action: 'resend' });
    } else if (followup && previous && !error) {
      this.store.setControl(event.event_id, { action: 'followup', targetEventId: previous.event_id });
    } else if (directive?.routingOnly && !error) {
      this.store.setControl(event.event_id, { action: 'route', requestedDelivery: intent });
      base.authoritative = false;
    }
    this.store.setRoute(event.event_id, base);
    const frozen = this.store.frozenFinal(event.event_id);
    if (frozen) this.store.inheritFrozenDelivery(event.event_id, frozen);
  }

  routeEventId(item) {
    const meta = metadataOf(item.event);
    const parent = meta.originEventId && this.store.route(meta.originEventId);
    if (['task.result', 'task.failure'].includes(meta.kind) && parent
      && (!meta.delivery?.originBotId || parent.originBotId === meta.delivery.originBotId)) return meta.originEventId;
    return item.event_id;
  }

  route(item) {
    this.register(item.event);
    return this.store.route(this.routeEventId(item)) || this.store.route(item.event_id);
  }

  publicRoute(item) {
    const route = this.route(item);
    const own = this.store.route(item.event_id);
    return { ...intentOf(route), state: route.state || 'requested', authoritative: own?.authoritative === true,
      sourceEventId: route.sourceEventId, originBotId: route.originBotId,
      ...(route.roomId ? { roomId: route.roomId } : {}) };
  }

  inputFiles(item) {
    const control = this.store.control(item.event_id);
    if (control?.action !== 'followup') return [];
    const prior = this.store.finalResult(control.targetEventId);
    return prior?.status === 'completed' ? prior.response?.deliveredArtifacts || prior.response?.publishedArtifacts || [] : [];
  }

  controlResult(item) {
    const control = this.store.control(item.event_id);
    if (!control || control.action === 'followup') return undefined;
    if (control.action === 'route') {
      const text = control.targetEventId
        ? control.requestedDelivery.kind === 'direct' ? '交付位置已更新为私聊。' : '交付位置已更新为当前会话。'
        : '请提供要处理的内容和交付要求。';
      return { status: 'completed', text: JSON.stringify({ text }), artifacts: [], toolCalls: 0, controlOnly: true };
    }
    const previous = this.store.finalResult(control.targetEventId);
    if (previous?.status !== 'completed' || previous.response?.delegated) {
      return { status: 'completed', text: JSON.stringify({ text: '这项工作尚无已确认的交付结果，请查看当前任务状态。' }),
        artifacts: [], toolCalls: 0, controlOnly: true };
    }
    let text = previous.response?.text || '已重新发送成果。';
    try { text = JSON.parse(text).text || text; } catch {}
    return { status: 'completed', text: JSON.stringify({ text }), artifacts: [], toolCalls: 0,
      reusedAttachments: previous.response?.deliveredArtifacts || previous.response?.publishedArtifacts || [], resendOf: previous.event_id };
  }

  acceptsProposal(item) {
    const route = this.route(item);
    return this.isHuman(item.event.sender) && !route.explicit && !route.frozen
      && Boolean(route.allowModelDelivery || allowsDirectDeliveryProposal(item.event.content.body));
  }

  applyOutput(item, output) {
    const route = this.route(item);
    if (route.error) throw new Error(route.error);
    if (output.delivery && this.acceptsProposal(item)) {
      const intent = this.validate(output.delivery, item.event);
      this.store.setRoute(item.event_id, { ...route, ...intent, recipientId: intent.recipientId, explicit: true });
    }
    const selected = this.route(item);
    output.delivery = { ...intentOf(selected), originBotId: selected.originBotId, sourceEventId: selected.sourceEventId };
  }

  async refresh(item) {
    const anchor = this.store.item(this.routeEventId(item));
    if (anchor && this.isHuman(anchor.event.sender) && this.matrix.timeline) {
      const events = (await this.matrix.timeline(anchor.event.room_id, 60)).map(event => ({ ...event, room_id: anchor.event.room_id }));
      await this.ingest(events);
      await this.flushTasks();
    }
    if (this.tasks) {
      const requestId = item.request?.requestId;
      if (requestId) {
        const control = await this.tasks.control(requestId);
        if (control.delivery && !this.isHuman(item.event.sender)) {
          const routeId = this.routeEventId(item);
          const current = this.store.route(routeId);
          if (!current?.authoritative && !current?.frozen && intentKey(current) !== intentKey(control.delivery)) {
            const intent = this.validate(control.delivery, item.event);
            this.store.setRoute(routeId, { ...current, ...intent, recipientId: intent.recipientId, explicit: true,
              sourceEventId: control.delivery.sourceEventId, originBotId: control.delivery.originBotId, state: 'requested', roomId: undefined });
          }
        }
        return control;
      }
    }
    return {};
  }

  async prepare(delivery, send) {
    if (delivery.routing_frozen) return send ? send(delivery) : delivery;
    const item = this.store.item(delivery.source_event_id);
    const role = delivery.options.deliveryRole || 'final';
    for (let attempt = 0; attempt < 5; attempt++) {
      const control = await this.refresh(item);
      if (control.cancelRequested) throw Object.assign(new Error('任务已取消'), { taskCancelled: true });
      const routeEventId = this.routeEventId(item);
      const route = this.route(item);
      if (route.error) throw new Error(route.error);
      const intent = this.validate(intentOf(route), item.event);
      let roomId = delivery.room_id;
      const direct = intent.kind === 'direct' && !['ack', 'control'].includes(role);
      const scoped = item.request?.authorization?.kind === 'scoped';
      if (scoped && (['delegate', 'peer'].includes(role) || direct && item.request.authorization.conversationKind !== 'direct')) {
        throw Object.assign(new Error('This cross-server grant permits delivery only in the original approved conversation'), { status: 403 });
      }
      if (direct && !scoped) {
        if (!this.client) throw new Error('Direct delivery service is unavailable');
        const recipient = role === 'delegate' ? item.response?.delegate?.to || delivery.options.to[0]
          : role === 'peer' ? metadataOf(item.event).returnTo || item.event.sender : intent.recipientId;
        roomId = await this.client.direct(recipient);
      }
      const latest = await this.refresh(item);
      if (latest.cancelRequested) throw Object.assign(new Error('任务已取消'), { taskCancelled: true });
      if (this.route(item).revision !== route.revision) continue;
      const applied = this.store.freezeDeliveries({ eventId: item.event_id, role, routeEventId, revision: route.revision, roomId,
        intent: { ...intent, sourceEventId: route.sourceEventId, originBotId: route.originBotId }, freezeTask: role === 'final',
        optionsFor: row => {
          const options = { ...row.options, delivery: { ...intent, originBotId: route.originBotId, sourceEventId: route.sourceEventId } };
          if (row.room_id !== roomId) { delete options.replyTo; delete options.threadRootId; }
          if (intent.kind === 'direct' && role === 'ack') delete options.attachments;
          return { options, ...(intent.kind === 'direct' && role === 'ack' ? { body: '已开始协作，结果会通过私聊交付。' } : {}) };
        },
      });
      if (!applied) continue;
      this.updateTask(item, {});
      const prepared = this.store.delivery(delivery.transaction_id);
      return send ? send(prepared) : prepared;
    }
    throw Object.assign(new Error('Delivery destination is changing; retrying before sending'), { networkError: true });
  }

  sent(item) {
    this.store.deliverySent(item.event_id);
    const parent = this.routeEventId(item);
    if (parent !== item.event_id) this.store.deliverySent(parent);
  }
}

export function createDeliveryClient(coreUrl, token, fetchImpl = fetch) {
  return { direct: async participantId => {
    let response;
    try {
      response = await fetchImpl(new URL('/api/dm', coreUrl), { method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ participantId }), signal: AbortSignal.timeout(20_000) });
    } catch (cause) { throw Object.assign(new Error('Direct conversation service is unavailable'), { networkError: true, cause }); }
    const result = await response.json();
    if (!response.ok || typeof result.roomId !== 'string') throw Object.assign(new Error(result.error || 'Direct conversation could not be resolved'), { status: response.status });
    return result.roomId;
  } };
}
