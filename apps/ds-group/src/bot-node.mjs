import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MatrixClient } from './matrix-client.mjs';
import { localPath, packageRoot } from './paths.mjs';
import { NodeStore } from './node-store.mjs';
import { NodeFiles, eventAttachments } from './node-files.mjs';
import { boundTaskRequest } from './node-request.mjs';
import { NodeDelivery, createDeliveryClient } from './node-delivery.mjs';
import { normalizeDelivery } from './delivery-policy.mjs';
import { runtimeSettings } from '../scripts/runtime-config.mjs';
import { createNodeWorkClient, scopedTaskRequest } from './node-work.mjs';
import { conversationContext, messageSource, speakerOf, threadOf } from './message-context.mjs';
import { normalizeAttentionConfig, reliableAttentionRoute, attentionMessage, attentionConflict,
  participationDelay, trailingBotTurns } from './attention.mjs';
import { ATTENTION_POLICY_VERSION, DecisionError, validateDecision, createOpenAIDecisionProvider } from './decision-provider.mjs';

const metadataOf = event => event.content?.['org.ds_group'] || {};
const digest = value => createHash('sha256').update(value).digest('hex');
const publicAttachment = ({ id, name, mimeType, size, sha256, contentUri, source }) => ({ id, name, mimeType, size, sha256, contentUri, ...(source ? { source } : {}) });
const uniqueAttachments = values => [...new Map(values.filter(value => value?.id).map(value => [value.id, publicAttachment(value)])).values()];
const legacyBotRoles = new Map([
  ['finance', { role: '财务', duties: '财务核算、预算和金额核对' }],
  ['hr', { role: '人事', duties: '人事、入职安排和人员事项协调' }],
]);
const temporaryTransferError = error => error.networkError === true || ['TimeoutError', 'AbortError'].includes(error.name)
  || error.status >= 500 || [408, 429].includes(error.status);
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
});
async function attentionCall(operation, timeoutMs, parentSignal) {
  const local = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, local.signal]) : local.signal;
  const timer = setTimeout(() => local.abort(new DecisionError('ATTENTION_TIMEOUT')), timeoutMs);
  let interrupted;
  try {
    const interruption = new Promise((resolve, reject) => {
      interrupted = () => reject(local.signal.aborted ? new DecisionError('ATTENTION_TIMEOUT') : new DecisionError('ATTENTION_ABORTED'));
      if (signal.aborted) interrupted(); else signal.addEventListener('abort', interrupted, { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => operation(signal)), interruption]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', interrupted); }
}

export function parseBotOutput(raw, botId, participants, { ignoreDelivery = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Bot returned an empty response');
  const text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed;
  try { parsed = JSON.parse(fenced ? fenced[1] : text); }
  catch { return { text }; }
  // Plain JSON data and scalar answers are chat content. Only explicit delivery
  // fields opt into the text/delegation protocol.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !['text', 'artifacts', 'delegate', 'delivery'].some(key => Object.hasOwn(parsed, key))) return { text };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.text !== 'string' || !parsed.text.trim()) {
    throw new Error('Structured Bot response requires non-empty text');
  }
  if (parsed.text.length > 16000) throw new Error('Bot response is too long');
  const output = { text: parsed.text.trim(), ...(ignoreDelivery || parsed.delivery === undefined ? {} : { delivery: normalizeDelivery(parsed.delivery, participants) }) };
  if (parsed.delegate === undefined) return output;
  const delegate = parsed.delegate;
  if (!delegate || typeof delegate !== 'object' || Array.isArray(delegate)
    || Object.keys(delegate).some(key => !['to', 'body'].includes(key))
    || !participants.some(p => p.kind === 'bot' && p.id === delegate.to)
    || delegate.to === botId || typeof delegate.body !== 'string' || !delegate.body.trim() || delegate.body.length > 16000) {
    throw new Error('Bot delegation must name one other registered Bot and a non-empty request');
  }
  return { ...output, delegate: { to: delegate.to, body: delegate.body.trim() } };
}

export function deliveriesFor(event, output, botId, participants, collaborationRoomId = event.room_id) {
  const meta = metadataOf(event);
  const hop = Number.isInteger(meta.hop) && meta.hop >= 0 ? meta.hop : 0;
  if (hop > 4 || (output.delegate && hop >= 4)) throw new Error('Collaboration hop limit reached');
  const taskId = typeof meta.taskId === 'string' && meta.taskId ? meta.taskId : `task-${digest(event.event_id).slice(0, 24)}`;
  const requestedByBot = participants.some(p => p.kind === 'bot' && p.id === event.sender);
  const originSenderId = requestedByBot && typeof meta.originSenderId === 'string' ? meta.originSenderId : event.sender;
  const originRoomId = requestedByBot && typeof meta.originRoomId === 'string' ? meta.originRoomId : event.room_id;
  const originEventId = requestedByBot && typeof meta.originEventId === 'string' ? meta.originEventId : event.event_id;
  const sourceThreadRootId = threadOf(event) || undefined;
  // The origin thread survives peer rooms independently of the actual thread
  // used for this hop. Human sender metadata cannot choose another origin.
  const originThreadRootId = requestedByBot
    ? typeof meta.originThreadRootId === 'string' && meta.originThreadRootId ? meta.originThreadRootId : undefined
    : sourceThreadRootId;
  const returnTo = requestedByBot && meta.kind === 'task.request'
    && meta.returnTo === event.sender ? meta.returnTo : undefined;
  const prefix = `ds-group-${digest(`${botId}\0${event.event_id}`).slice(0, 40)}`;
  const isFinalResult = requestedByBot && ['task.result', 'task.failure'].includes(meta.kind) && !output.delegate;
  const replyRoomId = isFinalResult ? originRoomId : event.room_id;
  const replyEventId = isFinalResult ? originEventId : event.event_id;
  const replyThreadRootId = isFinalResult ? originThreadRootId : sourceThreadRootId;
  const common = { taskId, originSenderId, originRoomId, originEventId, hop: hop + 1,
    ...(originThreadRootId ? { originThreadRootId } : {}),
    ...(output.delivery || meta.delivery ? { delivery: output.delivery || meta.delivery } : {}) };
  const replyRecipient = isFinalResult ? originSenderId : event.sender;
  const sourceAttachments = uniqueAttachments([...eventAttachments(event), ...(output.sourceAttachments || [])]);
  const attachments = uniqueAttachments(output.attachments || []).filter(file => !output.delegate
    || !sourceAttachments.some(source => source.sha256 === file.sha256 && source.name === file.name));
  const replyAttachments = attachments.length ? attachments : isFinalResult && !output.failure ? uniqueAttachments(output.resultAttachments || eventAttachments(event)) : [];
  const result = [{ roomId: replyRoomId, body: output.text, options: {
    ...common, replyTo: replyEventId, transactionId: `${prefix}-reply`, to: returnTo && !output.delegate ? [returnTo] : [],
    ...(replyThreadRootId ? { threadRootId: replyThreadRootId } : {}),
    deliveryRole: output.controlOnly ? 'control' : output.delegate ? 'ack' : returnTo ? 'peer' : 'final',
    kind: returnTo && !output.delegate ? output.failure ? 'task.failure' : 'task.result' : 'reply',
    ...(replyAttachments.length ? { attachments: replyAttachments } : {}),
    mentions: { users: [], roles: [], everyone: false, here: false, replyUserId: replyRecipient,
      roleUsers: [], everyoneUsers: [], hereUsers: [] },
    mMentions: { user_ids: replyRecipient === botId ? [] : [replyRecipient] },
  } }];
  if (output.delegate) {
    const delegatedFiles = uniqueAttachments([...sourceAttachments, ...attachments]);
    result.push({ roomId: collaborationRoomId, body: output.delegate.body, options: {
      ...common, transactionId: `${prefix}-delegate`, to: [output.delegate.to], returnTo: botId, kind: 'task.request',
      deliveryRole: 'delegate',
      ...(event.room_id === collaborationRoomId ? { replyTo: event.event_id,
        ...(sourceThreadRootId ? { threadRootId: sourceThreadRootId } : {}) } : {}),
      ...(delegatedFiles.length ? { attachments: delegatedFiles } : {}),
      mentions: { users: [output.delegate.to], roles: [], everyone: false, here: false },
      mMentions: { user_ids: [output.delegate.to] },
    } });
  }
  return result.flatMap(delivery => {
    const files = delivery.options.attachments || [];
    if (files.length <= 10) return [delivery];
    const batches = [];
    for (let offset = 0; offset < files.length; offset += 10) batches.push(files.slice(offset, offset + 10));
    return batches.map((batch, index) => {
      const finalPart = index === batches.length - 1;
      const notify = delivery.options.to.length ? finalPart : index === 0;
      return { ...delivery, body: `${delivery.body}\n\n附件 ${index + 1}/${batches.length}`, options: { ...delivery.options,
        attachments: batch, transactionId: `${delivery.options.transactionId}-part-${index + 1}`,
        fileBatch: { id: delivery.options.transactionId, index: index + 1, total: batches.length },
        to: finalPart ? delivery.options.to : [],
        ...(!notify ? { mentions: { users: [], roles: [], everyone: false, here: false }, mMentions: { user_ids: [] } } : {}),
      } };
    });
  });
}

export class BotNode {
  constructor({ participant, participants, roomId, matrix, store, bridge, heartbeat, files, tasks, delivery, roster, work, pollTimeout = 10000,
    transferAttempts = 3, transferRetryDelayMs = 500, controlIntervalMs = 500, onError = console.error,
    attention = {}, decisionProvider, readAttentionView, observe, executionMode, nativeBinding }) {
    this.participant = participant;
    this.participants = participants;
    this.roomId = roomId;
    this.matrix = matrix;
    this.store = store;
    this.bridge = bridge;
    this.sendHeartbeat = heartbeat;
    this.files = files;
    this.tasks = tasks;
    this.roster = roster;
    this.work = work;
    if (executionMode !== undefined && !['native', 'scoped'].includes(executionMode)) throw new RangeError('Invalid Bot execution mode');
    if (nativeBinding && (typeof nativeBinding.nativeBotId !== 'string' || nativeBinding.botId && nativeBinding.botId !== participant.id
      || executionMode === 'scoped')) throw new Error('Native Bot binding does not match this node');
    this.executionMode = executionMode || (nativeBinding ? 'native' : undefined);
    this.nativeBinding = nativeBinding;
    this.nodeTools = [];
    this.roomRosters = new Map();
    this.roomRosterTimes = new Map();
    this.transferAttempts = transferAttempts;
    this.transferRetryDelayMs = transferRetryDelayMs;
    this.controlIntervalMs = controlIntervalMs;
    this.reconciled = new Set();
    this.pollTimeout = pollTimeout;
    this.onError = onError;
    this.runtimeId = randomUUID();
    this.controller = new AbortController();
    this.state = 'idle';
    this.lastError = null;
    this.processing = null;
    const { revision = 0, ...attentionConfig } = attention;
    this.attention = normalizeAttentionConfig(attentionConfig);
    this.attentionRevision = revision;
    this.attentionEpoch = 0;
    this.decisionProvider = decisionProvider;
    this.readAttentionView = readAttentionView || (bridge.readAttentionView ? (input, options) => bridge.readAttentionView(input, options) : undefined);
    this.observe = observe || (bridge.observe ? (input, options) => bridge.observe(input, options) : undefined);
    this.lastObservationError = null;
    this.delivery = new NodeDelivery({ store, participant, participants, matrix, client: delivery,
      tasks: tasks ? { ...tasks, control: (id, options = {}) => this.control(id, options.signal) } : undefined,
      updateTask: (item, value) => this.taskUpdate(item, value), flushTasks: () => this.flushTaskUpdates(),
      ingest: events => this.ingestEvents(events) });
  }

  configureAttention(patch, { revision = patch?.revision } = {}) {
    const { revision: ignored, ...changes } = patch || {};
    const next = normalizeAttentionConfig(changes, this.attention);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new RangeError('Invalid attention revision');
    if (revision !== undefined && revision < this.attentionRevision) return { ...this.attention, revision: this.attentionRevision };
    if (revision !== undefined && revision === this.attentionRevision) {
      if (JSON.stringify(next) !== JSON.stringify(this.attention)) throw new Error('Attention revision already has a different configuration');
      return { ...this.attention, revision: this.attentionRevision };
    }
    if (this.attention.mode !== next.mode) this.store.settleAttention('mode_changed');
    this.attention = next;
    this.attentionRevision = revision ?? this.attentionRevision + 1;
    this.attentionEpoch++;
    if (this.started && !this.attending && (this.observe || next.mode !== 'mention')) this.attending = this.attentionLoop();
    return { ...this.attention, revision: this.attentionRevision };
  }

  setDecisionProvider(provider) {
    if (provider !== undefined && provider !== null && typeof provider.decide !== 'function') throw new TypeError('Invalid decision provider');
    this.decisionProvider = provider || undefined;
    this.decisionHealth = null;
    this.attentionEpoch++;
    return this.attentionStatus();
  }

  wakeAttention(reason, scope = {}) { return this.store.wakeAttention(reason, scope); }

  attentionStatus() {
    const snapshot = this.store.attentionSnapshot();
    const providerHealth = this.decisionHealth || this.decisionProvider?.health?.() || {};
    const configured = Boolean(this.decisionProvider && this.decisionProvider.configured !== false);
    const health = providerHealth.health || (configured ? 'unknown' : 'unconfigured');
    return { mode: this.attention.mode, revision: this.attentionRevision,
      activity: this.state === 'thinking' ? 'working' : this.sendingAttention ? 'speaking' : snapshot.queue.waiting ? 'waiting' : 'listening',
      provider: { id: this.decisionProvider?.id || null, model: this.decisionProvider?.model || null, configured,
        available: !configured || ['error', 'unconfigured'].includes(health) ? false : health === 'ok' ? true : null, health,
        lastErrorCode: providerHealth.lastErrorCode || null, lastSuccessAt: providerHealth.lastSuccessAt || null },
      ...snapshot, ...(this.lastObservationError ? { observationError: this.lastObservationError } : {}) };
  }

  async flushObservations() {
    if (!this.observe) return true;
    if (Date.now() < (this.observationRetryAt || 0)) return false;
    if (this.observing) return this.observing;
    this.observing = (async () => {
      for (let batch = this.store.observationBatch(); batch.events.length; batch = this.store.observationBatch()) {
        try {
          await attentionCall(signal => this.observe({ botId: this.participant.id, events: batch.events,
            cursor: batch.cursor, watermark: batch.watermark,
            rooms: Object.fromEntries([...new Set(batch.events.map(event => event.room_id))].map(roomId => [roomId, this.roomContextFor(roomId)])),
            eventRooms: Object.fromEntries(batch.events.map(event => [event.event_id, this.store.roomContextForEvent(event)])),
          }, { signal }), this.attention.providerTimeoutMs, this.controller.signal);
          this.store.acknowledgeObservation(batch.after, batch.watermark.sequence);
          this.lastObservationError = null;
        } catch {
          this.lastObservationError = { code: 'ATTENTION_OBSERVATION_UNAVAILABLE', at: Date.now() };
          this.observationRetryAt = Date.now() + 1000;
          return false;
        }
      }
      return true;
    })();
    try { return await this.observing; }
    finally { this.observing = null; }
  }

  async processAttentionOnce() {
    if (this.decidingAttention) return false;
    this.decidingAttention = true;
    try {
      const observed = await this.flushObservations();
      if (this.attention.mode === 'mention') return Boolean(this.store.settleAttention('mention_mode'));
      const config = { ...this.attention };
      const epoch = this.attentionEpoch;
      const batch = this.store.nextAttentionBatch({ ...config, limit: config.historyLimit });
      if (!batch) return false;
      const anchor = batch.events.at(-1);
      const recent = this.store.messagesThrough(batch.roomId, batch.watermark.sequence, config.historyLimit);
      const messages = recent.map(event => this.attentionMessageFor(event));
      const room = this.roomContextFor(batch.roomId);
      const sameRoom = event => event?.room_id === batch.roomId ? event : undefined;
      const context = conversationContext({ event: anchor, participants: this.participants, room,
        sourceRoom: this.store.roomContextForEvent(anchor),
        history: recent.filter(event => event.event_id !== anchor.event_id),
        reply: sameRoom(this.store.message(metadataOf(anchor).replyTo || anchor.content?.['m.relates_to']?.['m.in_reply_to']?.event_id)),
        replyRoom: this.store.roomContextForEvent(metadataOf(anchor).replyTo || anchor.content?.['m.relates_to']?.['m.in_reply_to']?.event_id),
        threadRoot: sameRoom(this.store.message(batch.threadRootId)), threadRootRoom: this.store.roomContextForEvent(batch.threadRootId) });
      const self = { id: this.participant.id, name: this.senderName(this.participant.id, room), role: this.roleOf(),
        interests: this.participant.interests || [], instructions: this.participant.instructions || '' };
      const workView = { runtime: { nodeState: this.state, nativeState: 'unknown' }, tasks: this.store.activeTaskView(batch.roomId) };
      const input = { version: 1, policyVersion: ATTENTION_POLICY_VERSION, self, context,
        roomId: batch.roomId, threadRootId: batch.threadRootId, watermark: batch.watermark, eventIds: batch.eventIds,
        trigger: { reason: batch.reason, expiresAt: batch.expiresAt },
        currentMessages: batch.events.map(event => this.attentionMessageFor(event)), recentMessages: messages, workView };
      const id = `attention-${randomUUID()}`;
      this.store.beginAttentionDecision(id, batch, input);
      let providerAttempted = false;
      try {
        if (!observed) throw new DecisionError('ATTENTION_OBSERVATION_UNAVAILABLE');
        if (this.readAttentionView) {
          let view;
          try { view = await attentionCall(signal => this.readAttentionView({ botId: this.participant.id, roomId: batch.roomId,
            threadRootId: batch.threadRootId, watermark: batch.watermark, eventIds: batch.eventIds,
            recentMessages: messages, self, workView }, { signal }), config.providerTimeoutMs, this.controller.signal); }
          catch { throw new DecisionError('ATTENTION_CONTEXT_UNAVAILABLE'); }
          input.memoryView = view ?? { available: false };
          // The durable input must include exactly the view used by the provider.
          this.store.db.prepare('UPDATE attention_decisions SET input_json=? WHERE id=?').run(JSON.stringify(input), id);
        } else {
          input.memoryView = { available: false };
          this.store.db.prepare('UPDATE attention_decisions SET input_json=? WHERE id=?').run(JSON.stringify(input), id);
        }
        if (!this.decisionProvider || this.decisionProvider.configured === false) throw new DecisionError('ATTENTION_PROVIDER_UNCONFIGURED');
        providerAttempted = true;
        const result = validateDecision(await attentionCall(signal => this.decisionProvider.decide(input, { signal }),
          config.providerTimeoutMs, this.controller.signal));
        if (epoch === this.attentionEpoch) this.decisionHealth = { health: 'ok', lastSuccessAt: Date.now(), lastErrorCode: null };
        let outcome;
        let evidence;
        if (epoch !== this.attentionEpoch) outcome = 'configuration_changed';
        else if (Date.now() >= batch.expiresAt) outcome = 'expired';
        else if (config.mode === 'shadow') outcome = 'shadow';
        else if (result.action === 'SPEAK') {
          const blocked = attentionConflict({ botId: this.participant.id, eventIds: batch.eventIds }, anchor,
            this.store.messagesAfter(batch.roomId, batch.watermark.sequence), this.participants);
          if (blocked) outcome = blocked;
          else if (trailingBotTurns(messages.filter(message => (message.source.threadRootId || null) === batch.threadRootId)) >= config.maxBotTurns) outcome = 'bot_turn_limit';
          else {
            const peers = this.participants.filter(person => !room.members?.length || room.members.includes(person.id));
            const delay = participationDelay({ botId: this.participant.id, eventId: batch.eventIds[0], participants: peers,
              recentMessages: messages, coordinationMs: config.coordinationMs });
            evidence = { kind: 'natural', botId: this.participant.id, decisionId: id, eventIds: batch.eventIds,
              sourceEventIds: messages.filter(message => !message.withdrawn).map(message => message.eventId),
              watermark: batch.watermark, expiresAt: batch.expiresAt,
              notBefore: Math.max(Date.now() + delay, (this.lastAttentionSpokeAt || 0) + config.cooldownMs),
              context: { ...context, attention: { decisionId: id, watermark: batch.watermark, eventIds: batch.eventIds,
                participationOnly: true, memoryView: input.memoryView, workView } },
              history: messages.filter(message => message.eventId !== anchor.event_id) };
          }
        }
        this.store.finishAttentionDecision(id, result, { outcome, evidence,
          waitMs: Math.min(result.waitMs || config.waitMs, config.waitTtlMs), waitTtlMs: config.waitTtlMs });
        if (evidence) this.delivery.register(anchor);
      } catch (error) {
        const code = error instanceof DecisionError ? error.code : 'ATTENTION_PROVIDER_ERROR';
        if (providerAttempted && epoch === this.attentionEpoch) this.decisionHealth = {
          health: 'error', lastSuccessAt: this.decisionHealth?.lastSuccessAt || null, lastErrorCode: code,
        };
        this.store.failAttentionDecision(id, code);
        this.onError(`Attention decision ended: ${code}`);
      }
      return true;
    } finally { this.decidingAttention = false; }
  }

  async attentionLoop() {
    while (!this.controller.signal.aborted) {
      try { if (!await this.processAttentionOnce()) await sleep(100, this.controller.signal); }
      catch { await sleep(500, this.controller.signal); }
    }
  }

  attentionSuppression(item) {
    const evidence = item?.attention;
    if (evidence?.kind !== 'natural' || evidence.deliveryAttempted) return undefined;
    if (this.store.roomContext(item.event.room_id).membership === 'leave') return 'room_left';
    if (this.store.withdrawnAttentionSource(evidence)) return 'source_withdrawn';
    // Once actual work has produced an effect, its result keeps the task route.
    if (item.response?.delegated || item.response?.toolCalls > 0 || item.response?.artifacts?.length) return undefined;
    if (this.attention.mode !== 'natural') return 'mode_changed';
    if (!this.decisionProvider || this.decisionProvider.configured === false) return 'provider_unavailable';
    if (Date.now() >= evidence.expiresAt) return 'expired';
    return attentionConflict(evidence, item.event,
      this.store.messagesAfter(item.event.room_id, evidence.watermark.sequence), this.participants);
  }

  suppressAttention(item, reason) {
    if (item.status === 'generated') this.store.cancelDelivery(item.event_id);
    else this.store.failed(item.event_id, `Natural participation superseded: ${reason}`, 'cancelled');
    this.store.attentionOutcome(item.event_id, reason);
  }

  senderName(id, room) { return speakerOf(id, this.participants, room).name; }

  roomContextFor(roomId) {
    const room = this.store.roomContext(roomId);
    const people = this.roomRosters.get(roomId);
    if (!people) return room;
    room.members = people.map(person => person.id);
    room.memberProfiles = { ...(room.memberProfiles || {}) };
    for (const person of people) if (!Object.hasOwn(room.memberProfiles, person.id)) {
      room.memberProfiles[person.id] = { id: person.id, displayname: typeof person.name === 'string' ? person.name : null,
        membership: 'join', observedAt: this.roomRosterTimes.get(roomId) || null, observedSequence: 0,
        eventTimestamp: null, eventId: null, source: 'room-directory' };
    }
    return room;
  }

  attentionMessageFor(event) {
    const source = messageSource(event, this.participants, this.store.roomContextForEvent(event));
    return { ...attentionMessage(event, this.participants), source, senderName: source.sender.name };
  }

  mergeRoomIdentity(person) {
    const previous = this.participants.find(existing => existing.id === person.id);
    if (previous && previous.kind !== person.kind && previous.kind !== 'unknown' && person.kind !== 'unknown') throw new Error('A room participant changed identity kind');
    if (!previous) { this.participants.push({ ...person, name: person.id }); return; }
    if (person.kind === 'unknown') return;
    for (const key of ['id', 'kind', 'ownerId', 'localpart', 'role', 'instructions']) if (person[key] !== undefined) previous[key] = person[key];
    if (person.identitySource !== undefined) previous.identitySource = person.identitySource;
  }

  roleOf(participant = this.participant) {
    return participant.role || legacyBotRoles.get(participant.localpart)?.role || '通用助手';
  }

  async refreshRoster() {
    if (!this.roster) return;
    if (this.refreshingRoster) return this.refreshingRoster;
    this.refreshingRoster = (async () => {
      const { participants } = await this.roster.read();
      if (!Array.isArray(participants) || participants.some(person => !person || typeof person.id !== 'string' || !person.id
        || typeof person.name !== 'string' || !['human', 'bot'].includes(person.kind))
        || new Set(participants.map(person => person.id)).size !== participants.length
        || !participants.some(person => person.id === this.participant.id && person.kind === 'bot')) {
        throw new Error('Core returned an invalid participant roster');
      }
      const existing = new Map(this.participants.map(person => [person.id, person]));
      if (participants.some(person => existing.has(person.id) && existing.get(person.id).kind !== 'unknown' && existing.get(person.id).kind !== person.kind)) {
        throw new Error('A registered participant changed identity kind');
      }
      const updated = participants.map(person => {
        const record = existing.get(person.id) || {};
        delete record.identitySource;
        for (const field of ['id', 'localpart', 'name', 'kind', 'ownerId', 'role', 'instructions']) {
          if (person[field] !== undefined) record[field] = person[field];
        }
        return record;
      });
      const home = this.participant.id.slice(this.participant.id.indexOf(':') + 1);
      for (const people of this.roomRosters.values()) for (const person of people) {
        if (person.id.slice(person.id.indexOf(':') + 1) !== home && !updated.some(existing => existing.id === person.id)) {
          updated.push(existing.get(person.id) || { ...person, name: person.id });
        }
      }
      this.participants.splice(0, this.participants.length, ...updated);
    })();
    try { await this.refreshingRoster; }
    finally { this.refreshingRoster = null; }
  }

  unknownParticipants(events) {
    const known = new Set(this.participants.map(person => person.id));
    const unknown = new Set();
    for (const event of events) {
      const meta = metadataOf(event);
      if (event.type !== 'm.room.message' || event.sender === this.participant.id
        || !Array.isArray(meta.to) || !meta.to.includes(this.participant.id)) continue;
      for (const id of [event.sender, meta.originSenderId, meta.returnTo, meta.delivery?.recipientId, meta.delivery?.originBotId, ...meta.to]) {
        if (typeof id === 'string' && !known.has(id)) unknown.add(id);
      }
    }
    return [...unknown];
  }

  async ensureParticipants(events) {
    if (!this.roster || !this.unknownParticipants(events).length) return;
    await this.refreshRoster();
    if (this.unknownParticipants(events).length) throw new Error('Message participants are not yet registered in the core roster');
  }

  async ingestEvents(events, cursor) {
    await this.refreshRoster();
    if (this.work) {
      for (const roomId of new Set(events.map(event => event.room_id))) {
        try {
          const { participants } = await this.work.directory(roomId);
          this.roomRosters.set(roomId, participants);
          this.roomRosterTimes.set(roomId, Date.now());
          for (const person of participants) this.mergeRoomIdentity(person);
        } catch (error) {
          // Preserve the sync position and inbox. Admission rechecks the exact sender before any work.
          this.onError(`Room work directory unavailable: ${error.message}`);
        }
      }
    } else await this.ensureParticipants(events);
    return this.store.ingest(events, cursor, event => {
      this.delivery.register(event);
      const route = this.store.item(event.event_id)?.attention;
      if (route?.reason === 'active_task_control' && route.sourceEventId) {
        this.store.requestLocalCancellation(route.sourceEventId, event.event_id, route.cancel ? 'cancelled' : 'requirements_updated');
        const original = this.store.item(route.sourceEventId);
        if (original) this.taskUpdate(original, { status: 'cancelled', stage: 'cancelled',
          summary: route.cancel ? '任务已取消' : '任务要求已更新，等待处理新要求' });
      }
    }, { route: event => reliableAttentionRoute(event, { botId: this.participant.id, store: this.store, participants: this.participants }),
      roomContext: roomId => this.roomContextFor(roomId) });
  }

  async start() {
    await this.refreshRoster();
    const setup = await this.bridge.createBot({ botId: this.participant.id, name: this.participant.name,
      role: this.roleOf(),
      ...(this.participant.ownerId ? { ownerId: this.participant.ownerId } : {}),
      instructions: this.instructions(),
      ...(this.executionMode ? { mode: this.executionMode } : {}),
      ...(this.nativeBinding ? { nativeBinding: this.nativeBinding } : {}) });
    this.nodeTools = setup?.tools || [];
    this.model = setup?.model;
    this.bridgeMode = setup?.mode || this.executionMode;
    await this.heartbeat();
    this.processing = this.processLoop();
    this.syncing = this.syncLoop();
    this.heartbeats = this.heartbeatLoop();
    this.started = true;
    if (this.observe || this.attention.mode !== 'mention') this.attending = this.attentionLoop();
    return this;
  }

  instructions() {
    const peers = this.participants.filter(p => p.kind === 'bot' && p.id !== this.participant.id).map(p => `${p.name} (${p.id})`).join('、');
    const duties = this.participant.instructions || legacyBotRoles.get(this.participant.localpart)?.duties
      || '根据请求者的要求处理对话和工作，使用已有工具完成任务';
    return `你是 DS-Group 中独立的${this.participant.name}，身份 ${this.participant.id}。你的职责是${duties}。保留自己的经历并区分每个人的身份。\n`
      + `消息源附有发送者、房间、原消息、任务和回复关系。按这些关系回答当前发送者。可协作的 Bot 为 ${peers}。\n`
      + '当前身份与可协作成员以每轮 event.botIdentity 和 event.availableBots 为准。\n'
      + '你也是群聊中的正式成员，可以分享与自身身份、兴趣和经历相符的看法，参与生活和工作聊天。context.attention 表示本次是自然参与，沿当前话题自然接话，不必把每句话变成受理任务；旁听决策本身不构成新的工具或外部操作授权。\n'
      + '每轮输出一个 JSON 对象，格式为 {"text":"给请求者的回答"}。确实需要其他 Bot 完成工作时，使用 {"text":"你的受理说明","delegate":{"to":"目标 Bot 的完整 ID","body":"具体工作要求及所需事实"}}。\n'
      + '使用宿主提供的文件与终端工具完成工作。附件已下载到任务工作目录，先实际读取内容，再计算或编辑，检查成果后交付。文件修改工作要生成可下载的新文件。最终回复使用 JSON，生成的文件列入 artifacts 数组，每项包含 path 和 name。\n'
      + 'delegate 会真实投递到另一台节点，附带任务文件，由对方返回结果。收到 kind=task.result 后，结合结果向原请求者总结并交付文件。已经收到的结果不要再次委派同一任务。每轮最多一次委派，跨 Bot 协作使用 delegate 字段。';
  }

  async collectRoomEvents(roomId, joined) {
    const timeline = joined.timeline || {};
    const current = (timeline.events || []).map(event => ({ ...event, room_id: roomId }));
    if (!timeline.limited || !timeline.prev_batch) return current;
    const older = [];
    let token = timeline.prev_batch;
    const seenTokens = new Set();
    for (let page = 0; page < 100; page++) {
      if (seenTokens.has(token)) throw new Error('Matrix history pagination did not advance');
      seenTokens.add(token);
      const result = await this.matrix.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100&from=${encodeURIComponent(token)}`);
      const chunk = result.chunk || [];
      const boundary = chunk.findIndex(event => this.store.hasEvent(event.event_id));
      older.push(...(boundary < 0 ? chunk : chunk.slice(0, boundary)));
      if (boundary >= 0 || !chunk.length || !result.end) {
        return [...older.reverse().map(event => ({ ...event, room_id: roomId })), ...current];
      }
      token = result.end;
    }
    throw new Error('Matrix history gap exceeded 100 pages; sync cursor preserved for inspection');
  }

  async syncOnce() {
    const response = await this.matrix.sync({ since: this.store.cursor(), timeout: this.pollTimeout });
    if (this.work) {
      for (const roomId of Object.keys(response.rooms?.invite || {})) this.store.noteInvitation(roomId);
      for (const roomId of [...Object.keys(response.rooms?.join || {}), ...Object.keys(response.rooms?.leave || {})]) this.store.finishInvitation(roomId);
      for (const invitation of this.store.pendingInvitations()) {
        try { await this.work.join(invitation.room_id); this.store.finishInvitation(invitation.room_id); }
        catch (error) {
          if (invitation.last_error !== error.message) this.onError(`Bot room invitation remains unaccepted: ${error.message}`);
          this.store.invitationFailed(invitation.room_id, error.message);
        }
      }
    }
    const events = [];
    for (const [roomId, room] of Object.entries(response.rooms?.join || {})) {
      this.store.noteRoomState(roomId, room.state?.events || []);
      this.store.noteRoomMembership(roomId, 'join');
      events.push(...await this.collectRoomEvents(roomId, room));
    }
    for (const [roomId, room] of Object.entries(response.rooms?.leave || {})) {
      this.store.noteRoomState(roomId, room.state?.events || []);
      this.store.noteRoomMembership(roomId, 'leave');
      events.push(...(room.timeline?.events || []).map(event => ({ ...event, room_id: roomId })));
    }
    await this.ingestEvents(events, response.next_batch);
    if (this.tasks) {
      for (const event of events) {
        const item = this.store.item(event.event_id);
        if (item?.status === 'queued' && !this.store.task(event.event_id)) this.taskUpdate(item, { status: 'queued', stage: 'queued', summary: '等待处理' });
      }
      await this.flushTaskUpdates();
    }
    return events.length;
  }

  async syncLoop() {
    let delay = 500;
    while (!this.controller.signal.aborted) {
      try { await this.syncOnce(); delay = 500; }
      catch (error) {
        if (this.controller.signal.aborted) break;
        this.lastError = `Matrix sync failed: ${error.message}`;
        this.onError(this.lastError);
        await sleep(delay, this.controller.signal);
        delay = Math.min(delay * 2, 10000);
      }
    }
  }

  requestFor(item) {
    const event = item.event;
    this.delivery.register(event);
    const meta = metadataOf(event);
    const replyTo = meta.replyTo || event.content['m.relates_to']?.['m.in_reply_to']?.event_id;
    const replied = replyTo ? this.store.message(replyTo) : undefined;
    const workTransfer = ['task.request', 'task.result', 'task.failure'].includes(meta.kind);
    const sourceThreadRootId = threadOf(event) || undefined;
    const originThreadRootId = workTransfer && this.participants.some(person => person.id === event.sender && person.kind === 'bot')
      ? typeof meta.originThreadRootId === 'string' && meta.originThreadRootId ? meta.originThreadRootId : undefined
      : sourceThreadRootId;
    const referencedFiles = !workTransfer && replied?.room_id === event.room_id ? this.store.messageBatch(replied).flatMap(eventAttachments) : [];
    const ownFiles = workTransfer && meta.fileBatch ? this.store.messageBatch(event).flatMap(eventAttachments) : eventAttachments(event);
    const followupFiles = ownFiles.length || replyTo ? [] : this.delivery.inputFiles(item);
    const history = this.store.historyBefore(event.event_id);
    const inRoom = value => value?.room_id === event.room_id ? value : undefined;
    const room = this.roomContextFor(event.room_id);
    const sourceRoom = this.store.roomContextForEvent(event);
    return { requestId: `matrix-${digest(`${this.participant.id}\0${event.event_id}`)}`, botId: this.participant.id,
      ...(this.executionMode === 'native' ? { mode: 'native', executionMode: 'native' } : {}),
      context: item.attention?.kind === 'natural' ? item.attention.context : conversationContext({ event, participants: this.participants, room, sourceRoom, history,
        earlierCount: Math.max(0, this.store.historyCountBefore(event.event_id) - history.length),
        reply: inRoom(replied), replyRoom: this.store.roomContextForEvent(replyTo),
        threadRoot: inRoom(this.store.message(threadOf(event))), threadRootRoom: this.store.roomContextForEvent(threadOf(event)) }),
      event: { eventId: event.event_id, roomId: event.room_id, senderId: event.sender, senderName: this.senderName(event.sender, sourceRoom),
        botIdentity: { id: this.participant.id, name: this.senderName(this.participant.id, room), role: this.roleOf() },
        availableBots: this.participants.filter(person => person.kind === 'bot' && person.id !== this.participant.id)
          .map(person => ({ id: person.id, name: this.senderName(person.id, room), role: this.roleOf(person) })),
        senderKind: this.participants.find(person => person.id === event.sender)?.kind,
        body: event.content['m.new_content']?.body ?? event.content.body, to: Array.isArray(meta.to) ? meta.to : [], attachments: uniqueAttachments([...ownFiles, ...referencedFiles, ...followupFiles]),
        delivery: this.delivery.publicRoute(item),
        ...(meta.conversationKind ? { conversationKind: meta.conversationKind } : {}),
        ...(meta.taskId ? { taskId: meta.taskId } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(sourceThreadRootId ? { threadRootId: sourceThreadRootId } : {}),
        ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.returnTo ? { returnTo: meta.returnTo } : {}),
        ...(meta.fileBatch ? { fileBatch: meta.fileBatch } : {}),
        ...(meta.originSenderId ? { originSenderId: meta.originSenderId } : {}), ...(Number.isInteger(meta.hop) ? { hop: meta.hop } : {}),
        ...(meta.originRoomId ? { originRoomId: meta.originRoomId } : {}), ...(meta.originEventId ? { originEventId: meta.originEventId } : {}),
        ...(originThreadRootId ? { originThreadRootId } : {}),
      },
      history: item.attention?.kind === 'natural' ? item.attention.history : history.map(previous => ({ eventId: previous.event_id, roomId: previous.room_id,
        source: messageSource(previous, this.participants, this.store.roomContextForEvent(previous)),
        senderId: previous.sender, senderName: this.senderName(previous.sender, this.store.roomContextForEvent(previous)), senderKind: this.participants.find(person => person.id === previous.sender)?.kind,
        body: previous.content['m.new_content']?.body ?? previous.content.body, attachments: eventAttachments(previous), taskId: metadataOf(previous).taskId,
        kind: metadataOf(previous).kind, originSenderId: metadataOf(previous).originSenderId, fileBatch: metadataOf(previous).fileBatch })),
    };
  }

  taskUpdate(item, changes) {
    // Participation and shadow decisions have no task card. Real tools/files or
    // delegation can establish a normal task and keep its existing result chain.
    const latest = this.store.item(item.event_id);
    if (item.attention?.kind === 'natural' && !this.store.task(item.event_id)
      && !latest?.response?.delegated && !(latest?.response?.toolCalls > 0) && !latest?.response?.artifacts?.length) return;
    const request = item.request || (item.request_json ? JSON.parse(item.request_json) : this.requestFor(item));
    const previous = this.store.task(item.event_id);
    if (previous?.status === 'cancelled' && changes.status !== 'cancelled') return;
    const meta = metadataOf(item.event);
    const payload = { requestId: request.requestId, botId: this.participant.id, roomId: item.event.room_id,
      eventId: item.event_id, taskId: request.authorization ? request.event.taskId : meta.taskId || `task-${digest(item.event_id).slice(0, 24)}`,
      status: 'running', stage: 'thinking', summary: '', artifacts: [], toolCalls: 0,
      ...previous, ...changes, delivery: this.delivery.publicRoute(item), updatedAt: new Date().toISOString() };
    this.store.updateTask(item.event_id, payload);
  }

  async flushTaskUpdates() {
    if (!this.tasks) return;
    if (this.flushingTasks) return this.flushingTasks;
    this.flushingTasks = (async () => {
      while (this.store.pendingTaskUpdates().length) {
        for (const update of this.store.pendingTaskUpdates()) {
          try {
            await this.tasks.update(update.payload);
            this.store.acknowledgeTask(update.eventId, update.payload);
          } catch (error) {
            this.onError(`Task status will be sent again: ${error.message}`);
            return;
          }
        }
      }
    })();
    try { await this.flushingTasks; }
    finally { this.flushingTasks = null; }
  }

  async control(requestId, signal) {
    const local = this.store.localCancellation(requestId);
    if (local) return local;
    if (!this.tasks) return { cancelRequested: false };
    const item = this.store.requestItem(requestId);
    if (item?.attention?.kind === 'natural' && !this.store.task(item.event_id)) return { cancelRequested: false };
    try { return await this.tasks.control(requestId, { signal }); }
    catch (error) {
      if (!signal?.aborted) this.onError(`Task control is temporarily unavailable: ${error.message}`);
      return { cancelRequested: false };
    }
  }

  async withTransferControl(item, operation) {
    if (!this.tasks) return operation(this.controller.signal);
    const local = new AbortController();
    const signal = AbortSignal.any([local.signal, this.controller.signal]);
    const requestId = (item.request || (item.request_json ? JSON.parse(item.request_json) : this.requestFor(item))).requestId;
    let cancelled = false;
    const monitoring = (async () => {
      while (!signal.aborted) {
        if ((await this.control(requestId, signal)).cancelRequested) {
          cancelled = true;
          local.abort();
          return;
        }
        await sleep(this.controlIntervalMs, signal);
      }
    })();
    try {
      const result = await operation(signal);
      if (cancelled) throw Object.assign(new Error('任务已取消'), { taskCancelled: true });
      return result;
    } catch (error) {
      if (cancelled) throw Object.assign(new Error('任务已取消'), { taskCancelled: true });
      throw error;
    } finally {
      local.abort();
      await monitoring;
    }
  }

  async prepareRequest(item, request) {
    return this.withTransferControl(item, async signal => {
      for (let attempt = 0; attempt < this.transferAttempts; attempt++) {
        try { return await this.files.prepare(request, signal); }
        catch (error) {
          if (signal.aborted || !temporaryTransferError(error) || attempt === this.transferAttempts - 1) throw error;
          this.taskUpdate(item, { status: 'running', stage: 'downloading', summary: '附件传输中断，正在重试' });
          await this.flushTaskUpdates();
          await sleep(this.transferRetryDelayMs * (attempt + 1), signal);
        }
      }
    });
  }

  parentCancelled(item) {
    if (this.store.cancelledEvent(item.event_id)) return true;
    if (item.attention?.kind === 'natural' && this.store.withdrawnAttentionSource(item.attention)) return true;
    const meta = metadataOf(item.event);
    return ['task.result', 'task.failure'].includes(meta.kind) && meta.originEventId && this.store.task(meta.originEventId)?.status === 'cancelled';
  }

  async checkWaitingTasks() {
    if (!this.tasks) return;
    for (const waiting of this.store.waitingTasks()) {
      if ((await this.control(waiting.payload.requestId)).cancelRequested) {
        this.taskUpdate(this.store.item(waiting.eventId), { status: 'cancelled', stage: 'cancelled', summary: '协作任务已取消' });
      }
    }
    await this.flushTaskUpdates();
  }

  bridgeOptions(item, reconciled = false) {
    return { signal: this.controller.signal,
      control: requestId => this.control(requestId),
      onProgress: async snapshot => {
        this.taskUpdate(item, { status: 'running', stage: snapshot.stage || 'thinking',
          summary: snapshot.summary || '', toolCalls: snapshot.toolCalls || 0, ...(reconciled ? { reconciled: true } : {}) });
        await this.flushTaskUpdates();
      },
    };
  }

  async acceptResult(item, response) {
    if (response.status === 'completed' && this.parentCancelled(item)) {
      // Preserve the actual model/tool receipt, then stop before any new upload
      // or delivery. A cancellation never pretends earlier work did not happen.
      this.store.produced(item.event_id, response);
      this.store.failed(item.event_id, 'Task superseded by a reliable control message', 'cancelled');
      this.taskUpdate(item, { status: 'cancelled', stage: 'cancelled', summary: '任务已取消' });
      await this.flushTaskUpdates();
      return;
    }
    if (response.status !== 'completed') {
      const status = ['unknown', 'cancelled'].includes(response.status) ? response.status : 'failed';
      const reason = response.errorCode || response.summary || `Bridge returned ${response.status}`;
      const meta = metadataOf(item.event);
      const delegated = meta.kind === 'task.request' && meta.returnTo === item.event.sender
        && this.participants.some(person => person.kind === 'bot' && person.id === item.event.sender);
      if (status === 'failed' && delegated && !response.authorizationDenied) {
        this.queueFailure(item, response, `${this.participant.name}执行任务失败。${reason}`);
      } else this.store.failed(item.event_id, reason, status);
      this.taskUpdate(item, { status, stage: status, summary: reason, toolCalls: response.toolCalls || 0 });
      this.lastError = status === 'cancelled' ? null : reason;
      await this.flushTaskUpdates();
      return;
    }
    // The result survives process loss or upload failure before any Matrix send.
    this.store.produced(item.event_id, response);
    this.wakeAttention('task_completed', { roomId: item.event.room_id, threadRootId: threadOf(item.event) });
    await this.publishProduced(this.store.item(item.event_id));
  }

  queueFailure(item, response, text) {
    const receipt = { ...response, text: JSON.stringify({ text }), failure: true, artifacts: [], publishedArtifacts: [], deliveredArtifacts: [] };
    this.store.produced(item.event_id, receipt);
    const output = { text, failure: true };
    this.delivery.applyOutput(item, output);
    const deliveries = deliveriesFor(item.event, output, this.participant.id, this.participants, this.roomId);
    this.store.generated(item.event_id, receipt, deliveries);
  }

  async publishProduced(item) {
    const response = item.response;
    const request = item.request;
    const attachments = [...(response.reusedAttachments || [])];
    this.taskUpdate(item, { status: 'running', stage: 'uploading', summary: '正在保存成果', toolCalls: response.toolCalls || 0 });
    await this.flushTaskUpdates();
    try {
      if (this.work) await this.work.check(request, 'run');
      const output = parseBotOutput(response.text, this.participant.id, this.participants,
        { ignoreDelivery: !this.delivery.acceptsProposal(item) });
      if (request.authorization?.kind === 'scoped' && output.delegate) throw Object.assign(new Error('Cross-server delegation is outside this task grant'), { status: 403 });
      if (this.work && output.delegate && output.delegate.to.slice(output.delegate.to.indexOf(':') + 1)
        !== this.participant.id.slice(this.participant.id.indexOf(':') + 1)) {
        throw Object.assign(new Error('Local work cannot implicitly delegate private context to an external Bot'), { status: 403 });
      }
      this.delivery.applyOutput(item, output);
      output.controlOnly = response.controlOnly === true;
      await this.withTransferControl(item, async signal => {
        for (const artifact of response.artifacts || []) {
          if (this.work) await this.work.check(request, 'upload');
          if (!this.files) throw new Error('This node has no attachment transfer service');
          const key = digest(`${artifact.path}\0${artifact.sha256 || ''}`);
          let uploaded = this.store.uploaded(item.event_id, key);
          if (!uploaded) {
            uploaded = await this.files.upload(artifact, request, signal);
            this.store.recordUpload(item.event_id, key, uploaded);
          }
          attachments.push(uploaded);
        }
      });
      output.attachments = attachments;
      output.sourceAttachments = uniqueAttachments(request.files || []);
      if (request.event?.kind === 'task.result') {
        const earlierParts = (request.history || []).filter(previous => previous.kind === 'task.result'
          && previous.taskId === request.event.taskId && previous.senderId === item.event.sender
          && (!request.event.fileBatch?.id || previous.fileBatch?.id === request.event.fileBatch.id));
        output.resultAttachments = uniqueAttachments([...earlierParts.flatMap(previous => previous.attachments || []), ...(request.event.attachments || eventAttachments(item.event))]);
      }
      const sourceEvent = request.authorization ? { ...item.event, content: { ...item.event.content,
        'org.ds_group': { to: [this.participant.id], taskId: request.event.taskId, hop: 0 } } } : item.event;
      const deliveries = deliveriesFor(sourceEvent, output, this.participant.id, this.participants, this.roomId);
      const deliveredArtifacts = uniqueAttachments(deliveries.filter(delivery => delivery.options.kind !== 'task.request')
        .flatMap(delivery => delivery.options.attachments || []));
      const published = { ...response, publishedArtifacts: attachments, deliveredArtifacts, delegated: Boolean(output.delegate),
        ...(output.delegate ? { delegate: output.delegate } : {}) };
      this.store.generated(item.event_id, published, deliveries);
      this.taskUpdate(item, { stage: 'delivering', summary: '正在发送成果', artifacts: deliveredArtifacts });
      this.lastError = null;
    } catch (error) {
      if (error.taskCancelled) {
        await this.acceptResult(item, { status: 'cancelled', summary: '任务已取消' });
        return;
      }
      const transient = temporaryTransferError(error);
      if (transient) {
        this.lastError = `Artifact delivery pending: ${error.message}`;
        this.taskUpdate(item, { stage: 'uploading', summary: '成果已生成，正在重试上传' });
        throw error;
      }
      await this.acceptResult(item, { status: 'failed', errorCode: error.message, toolCalls: response.toolCalls || 0 });
    }
    await this.flushTaskUpdates();
  }

  finishDeliveryState(delivery) {
    const item = this.store.item(delivery.source_event_id);
    const failure = item.response?.failure;
    if (item.status !== 'completed' && !(item.status === 'failed' && failure)) return;
    this.delivery.sent(item);
    const delegated = item.response?.delegated;
    const finalAttachments = item.response?.deliveredArtifacts || delivery.options.attachments || item.response?.publishedArtifacts || [];
    const status = failure ? 'failed' : delegated ? 'running' : 'completed';
    const stage = failure ? 'failed' : delegated ? 'waiting_for_bot' : 'completed';
    this.taskUpdate(item, { status, stage,
      summary: failure ? item.response.errorCode || delivery.body : delegated ? '等待协作 Bot 的成果' : '已交付', artifacts: finalAttachments });
    this.wakeAttention(delegated ? 'delegation_started' : 'delivery_completed', { roomId: item.event.room_id, threadRootId: threadOf(item.event) });
    if (item.attention?.kind === 'natural') {
      this.store.attentionOutcome(item.event_id, 'delivered');
      this.lastAttentionSpokeAt = Date.now();
    }
    const meta = metadataOf(item.event);
    if (!delegated && ['task.result', 'task.failure'].includes(meta.kind) && meta.originEventId) {
      const parent = this.store.item(meta.originEventId);
      if (parent && parent.event_id !== item.event_id && parent.response?.delegated) {
        this.taskUpdate(parent, { status: failure ? 'failed' : 'completed', stage: failure ? 'failed' : 'completed',
          summary: failure ? delivery.body : '协作成果已交付', artifacts: finalAttachments });
      }
    }
  }

  async recoverInterrupted() {
    if (!this.bridge.status) return false;
    const item = this.store.interrupted().find(candidate => !this.reconciled.has(candidate.event_id));
    if (!item) return false;
    this.reconciled.add(item.event_id);
    try {
      if (this.work && item.request.workGate === 'pending') {
        await this.acceptResult(item, { status: 'failed', errorCode: 'Task stopped before work authorization was durably accepted', authorizationDenied: true });
        return true;
      }
      if (this.work && !item.request.authorization) {
        const current = await this.work.admit(item.event, this.nodeTools, this.files?.maxBytes);
        if (current.mode === 'scoped') throw Object.assign(new Error('An older unscoped result cannot be promoted to cross-server authorization'), { status: 403 });
      }
      let response = await this.bridge.status(item.request.requestId);
      if (['running', 'queued'].includes(response.status)) {
        this.store.resume(item.event_id);
        response = await this.bridge.wait(item.request.requestId, response, this.bridgeOptions(item, true));
      }
      await this.acceptResult(item, response);
      return true;
    }
    catch (error) {
      if (error.status !== 404) this.reconciled.delete(item.event_id);
      this.store.failed(item.event_id, error.message, 'unknown');
      throw error;
    }
  }

  async processOne() {
    let delivery = this.store.pendingDelivery();
    if (delivery) {
      const source = this.store.item(delivery.source_event_id);
      const suppressed = this.attentionSuppression(source);
      if (suppressed) { this.suppressAttention(source, suppressed); return true; }
      let sendAttempted = false;
      const cancelRequested = this.parentCancelled(source) || (this.tasks && (await this.control(source.request.requestId)).cancelRequested);
      if (cancelRequested) {
        this.store.cancelDelivery(source.event_id);
        this.taskUpdate(source, { status: 'cancelled', stage: 'cancelled', summary: '任务已取消' });
        await this.flushTaskUpdates();
        return true;
      }
      try {
        const receipt = await this.delivery.prepare(delivery, prepared => {
          delivery = prepared;
          const suppressed = this.attentionSuppression(this.store.item(source.event_id));
          if (suppressed) throw Object.assign(new Error('Natural participation superseded before sending'), { attentionSuppressed: suppressed });
          const send = () => {
            if (source.attention?.kind === 'natural') {
              this.store.updateAttentionEvidence(source.event_id, { deliveryAttempted: true });
              this.sendingAttention = true;
            }
            return this.matrix.send(delivery.room_id, delivery.body, delivery.options);
          };
          if (!this.work) return send();
          return (async () => {
            const scoped = source.request.authorization?.kind === 'scoped';
            await this.work?.check(source.request, 'deliver', { destinationRoomId: delivery.room_id,
              recipientId: source.request.authorization?.requesterId || delivery.options.originSenderId || source.event.sender, replyTo: delivery.options.replyTo });
            sendAttempted = true;
            const receipt = await send();
            if (scoped) await this.work.check(source.request, 'observe', { effectStatus: 'completed', callId: delivery.transaction_id })
              .catch(error => this.onError(`Known Matrix receipt retained; authorization observation pending: ${error.message}`));
            return receipt;
          })();
        });
        this.store.sent(delivery.transaction_id, receipt.event_id, () => this.finishDeliveryState(delivery));
        this.lastError = null;
        await this.flushTaskUpdates();
      } catch (error) {
        if (error.attentionSuppressed) { this.suppressAttention(source, error.attentionSuppressed); return true; }
        if (sendAttempted && source.request.authorization) await this.work.check(source.request, 'observe', {
          effectStatus: temporaryTransferError(error) ? 'unknown' : 'failed', callId: delivery.transaction_id,
        }).catch(() => {});
        if (error.taskCancelled) {
          this.store.cancelDelivery(source.event_id);
          this.taskUpdate(source, { status: 'cancelled', stage: 'cancelled', summary: '任务已取消' });
          await this.flushTaskUpdates();
          return true;
        }
        const terminal = error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
        this.store.deliveryFailed(delivery.transaction_id, error.message, { terminal });
        this.lastError = `Matrix delivery ${terminal ? 'failed' : 'pending'}: ${error.message}`;
        if (terminal) {
          const item = this.store.item(delivery.source_event_id);
          this.taskUpdate(item, { status: 'failed', stage: 'delivering', summary: error.message });
          await this.flushTaskUpdates();
          this.onError(this.lastError);
          return true;
        }
        throw error;
      } finally { this.sendingAttention = false; }
      return true;
    }
    const produced = this.store.pendingResult();
    if (produced) { await this.publishProduced(produced); return true; }
    if (this.bridge.status && this.store.interrupted().some(item => !this.reconciled.has(item.event_id))) {
      return this.recoverInterrupted();
    }
    const item = this.store.next();
    if (!item) return false;
    const suppressed = this.attentionSuppression(item);
    if (suppressed) { this.suppressAttention(item, suppressed); return true; }
    if (this.store.cancelledEvent(item.event_id)) {
      this.store.failed(item.event_id, 'Task superseded by a reliable control message', 'cancelled');
      return true;
    }
    if (this.roster && !this.work) await this.ensureParticipants([item.event]);
    let request = this.requestFor(item);
    if (this.work) request = { ...request, workGate: 'pending' };
    this.store.begin(item.event_id, request);
    this.state = 'thinking';
    let submitted = false;
    try {
      if (this.work) {
        const admission = await this.work.admit(item.event, this.nodeTools, this.files?.maxBytes);
        for (const person of admission.participants) this.mergeRoomIdentity(person);
        request = scopedTaskRequest(request, admission, item.event);
        if (this.executionMode === 'native' && admission.mode !== 'native') throw Object.assign(new Error('Core has not admitted this native Bot binding'), { status: 403 });
        if (admission.mode === 'native') request.mode = 'native';
        request.workGate = admission.mode === 'scoped' ? 'scoped' : 'local';
        this.store.prepared(item.event_id, request);
        item.request = request;
      }
      request = boundTaskRequest(request);
      const routing = this.delivery.route(item);
      if (routing.error) throw new Error(routing.error);
      const controlResult = this.delivery.controlResult(item);
      if (controlResult) {
        this.store.prepared(item.event_id, request);
        await this.acceptResult(item, controlResult);
        return true;
      }
      if ((request.event.hop ?? 0) > 4) throw new Error('Collaboration hop limit reached');
      if (this.parentCancelled(item)) {
        await this.acceptResult(item, { status: 'cancelled', summary: '协作任务已取消' });
        return true;
      }
      if (request.event.kind === 'task.failure' && this.participants.some(person => person.kind === 'bot' && person.id === item.event.sender)) {
        this.queueFailure(item, { status: 'failed' }, item.event.content.body);
        this.taskUpdate(item, { status: 'failed', stage: 'failed', summary: item.event.content.body });
        await this.flushTaskUpdates();
        return true;
      }
      if (this.files) {
        this.taskUpdate(item, { status: 'running', stage: 'downloading', summary: '正在读取附件' });
        await this.flushTaskUpdates();
        request = await this.prepareRequest(item, request);
        request = boundTaskRequest(request);
      }
      this.store.prepared(item.event_id, request);
      if (this.tasks) {
        this.taskUpdate(item, { status: 'running', stage: 'thinking', summary: '正在处理任务' });
        await this.flushTaskUpdates();
        if ((await this.control(request.requestId)).cancelRequested) {
          await this.acceptResult(item, { status: 'cancelled', summary: '任务已取消' });
          return true;
        }
      }
      submitted = true;
      if (this.work) await this.work.check(request, 'run');
      const response = await this.bridge.turn(request, this.bridgeOptions(item));
      await this.acceptResult(item, response);
    } catch (error) {
      if (this.store.item(item.event_id).status === 'produced') throw error;
      const uncertain = submitted && temporaryTransferError(error);
      const status = error.taskCancelled ? 'cancelled' : uncertain ? 'unknown' : 'failed';
      await this.acceptResult(item, { status, errorCode: error.message, authorizationDenied: Boolean(this.work && request.workGate === 'pending') });
      this.lastError = status === 'cancelled' ? null : error.message;
      if (status !== 'cancelled') this.onError(`Bot turn ${request.requestId} ended: ${error.message}`);
    } finally { this.state = 'idle'; }
    return true;
  }

  async processLoop() {
    while (!this.controller.signal.aborted) {
      try {
        if (!await this.processOne()) await sleep(100, this.controller.signal);
      } catch (error) {
        this.onError(`Delivery retry keeps the same Matrix transaction: ${error.message}`);
        await sleep(2000, this.controller.signal);
      }
    }
  }

  async heartbeat() {
    if (this.bridge.runtimeStatus && this.state !== 'offline') {
      const runtime = await this.bridge.runtimeStatus({
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(2000)]),
      }).catch(() => null);
      this.model = runtime?.model ?? null;
      const identity = runtime?.runtime;
      const observedEngine = identity?.id === 'dscord-kernel' ? 'DSCord kernel'
        : typeof runtime?.engine === 'string' && runtime.engine ? runtime.engine
          : typeof identity?.id === 'string' && identity.id ? identity.id : null;
      const version = typeof identity?.version === 'string' ? identity.version
        : typeof runtime?.engineVersion === 'string' ? runtime.engineVersion : null;
      const fallback = (runtime?.mode || this.bridgeMode || this.executionMode) === 'native' ? 'Native Bot runtime' : 'Bot bridge (legacy)';
      this.engine = observedEngine ? `${observedEngine}${version ? ` ${version}` : ''}` : fallback;
    }
    const snapshot = this.store.snapshot();
    const attention = this.attentionStatus();
    const kernel = this.bridge.kernelState && this.state !== 'offline'
      ? await this.bridge.kernelState({ botId: this.participant.id }, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(2000)]),
      }).catch(() => null) : null;
    await this.sendHeartbeat({ id: this.participant.localpart, botId: this.participant.id, name: this.participant.name,
      runtimeId: this.runtimeId, status: this.lastError && this.state === 'idle' ? 'error' : this.state,
      processed: snapshot.processed, pending: snapshot.pending, sessionId: snapshot.sessionId,
      lastError: this.lastError || snapshot.lastError, model: this.model,
      engine: this.engine || ((this.bridgeMode || this.executionMode) === 'native' ? 'Native Bot runtime' : 'Bot bridge (legacy)'),
      ...(this.executionMode ? { executionMode: this.executionMode } : {}),
      attention, kernel: { ...(kernel || {}), attention }, kernelControl: { version: 1 } });
  }

  async heartbeatLoop() {
    while (!this.controller.signal.aborted) {
      await sleep(5000, this.controller.signal);
      if (this.controller.signal.aborted) break;
      await this.checkWaitingTasks();
      try { await this.heartbeat(); }
      catch (error) { this.onError(`Heartbeat failed: ${error.message}`); }
      await this.flushTaskUpdates();
    }
  }

  async stop() {
    this.controller.abort();
    await this.kernelManagement?.stop();
    await Promise.allSettled([this.processing, this.syncing, this.heartbeats, this.attending, this.observing]);
    this.state = 'offline';
    await this.heartbeat().catch(() => {});
    this.store.close();
  }
}

export function createBridge(endpoint, { token, fetchImpl = fetch, timeoutMs = 180000, pollIntervalMs = 750, taskTimeoutMs = 30 * 60_000 } = {}) {
  async function request(pathname, body, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(pathname, endpoint), { method: body === undefined ? 'GET' : 'POST', headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (cause) { throw Object.assign(new Error(`DS-Bot bridge connection failed: ${cause.message}`), { networkError: true, cause }); }
    let result;
    try { result = await response.json(); }
    catch (cause) { throw Object.assign(new Error('DS-Bot bridge returned an unreadable receipt'), { networkError: true, cause }); }
    if (!response.ok) throw Object.assign(new Error(result.error || result.message || `Bridge HTTP ${response.status}`), {
      status: response.status, networkError: response.status >= 500,
    });
    return result;
  }
  const status = (requestId, options) => request(`/api/ds-group-node/turns/${encodeURIComponent(requestId)}`, undefined, options);
  async function wait(requestId, initial, { signal, onProgress, control } = {}) {
    let snapshot = initial;
    let cancelled = false;
    let previousProgress;
    const deadline = Date.now() + taskTimeoutMs;
    while (['queued', 'running'].includes(snapshot.status)) {
      if (signal?.aborted) throw Object.assign(new Error('Node stopped while its task was running'), { networkError: true });
      const progress = JSON.stringify([snapshot.status, snapshot.stage, snapshot.summary, snapshot.toolCalls]);
      if (onProgress && progress !== previousProgress) {
        await onProgress(snapshot);
        previousProgress = progress;
      }
      if (!cancelled && control && (await control(requestId)).cancelRequested) {
        await request(`/api/ds-group-node/turns/${encodeURIComponent(requestId)}/cancel`, {}, { signal });
        cancelled = true;
      }
      if (Date.now() >= deadline) throw Object.assign(new Error('Task remains active; its receipt will be reconciled after reconnecting'), { networkError: true });
      await sleep(pollIntervalMs, signal);
      snapshot = await status(requestId, { signal });
    }
    return snapshot;
  }
  return {
    createBot: input => request('/api/ds-group-node/bots', input), status, wait,
    runtimeStatus: options => request('/api/ds-group-node/status', undefined, options),
    observe: (input, options) => request('/api/ds-group-node/observe', input, options),
    readAttentionView: (input, options) => request('/api/ds-group-node/attention/view', input, options),
    kernelState: (input, options) => request('/api/ds-group-node/kernel/state', input, options),
    memoryProfiles: (input, options) => request('/api/ds-group-node/memory/profiles', input, options),
    memoryProfile: (input, options) => request('/api/ds-group-node/memory/profile', input, options),
    cancel: requestId => request(`/api/ds-group-node/turns/${encodeURIComponent(requestId)}/cancel`, {}),
    turn: async (input, options = {}) => {
      const snapshot = await request('/api/ds-group-node/turns', { ...input, async: true }, options);
      return wait(input.requestId, snapshot, options);
    },
  };
}

export function createTaskClient(coreUrl, nodeSecret, fetchImpl = fetch) {
  async function request(route, body, { signal } = {}) {
    const response = await fetchImpl(new URL(route, coreUrl), { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${nodeSecret}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (!response.ok) throw Object.assign(new Error(`Task service HTTP ${response.status}`), { status: response.status });
    return response.json();
  }
  return { update: payload => request('/internal/tasks/update', payload),
    control: (requestId, options) => request(`/internal/tasks/${encodeURIComponent(requestId)}/control`, undefined, options) };
}

export function createRosterClient(coreUrl, _accessToken, fetchImpl = fetch) {
  return { read: async () => {
    const response = await fetchImpl(new URL('/api/bootstrap', coreUrl), {
      headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw Object.assign(new Error(`Core roster HTTP ${response.status}`), { status: response.status });
    return response.json();
  } };
}

export async function runNode(argv = process.argv.slice(2)) {
  const argument = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const name = argument('--bot');
  if (!name) throw new Error('Usage: node src/bot-node.mjs --bot ACCOUNT [--endpoint URL]');
  const setup = JSON.parse(await readFile(process.env.DS_GROUP_MATRIX_SETUP_PATH || localPath('matrix-setup.json'), 'utf8'));
  const config = JSON.parse(await readFile(process.env.DS_GROUP_CORE_CONFIG_PATH || localPath('core-config.json'), 'utf8'));
  let nodeConfig = {};
  try { nodeConfig = JSON.parse(await readFile(process.env.DS_GROUP_NODE_CONFIG_PATH || localPath(`dsh-${name}`, 'node-config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.env.DS_GROUP_MATRIX_URL) setup.homeserverUrl = process.env.DS_GROUP_MATRIX_URL;
  const participant = setup.participants.find(p => p.localpart === name && p.kind === 'bot');
  if (!participant) throw new Error(`Unknown Bot ${name}`);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Bot name must be a local account name');
  if (!participant.accessToken) throw new Error('This node needs its own Matrix access token');
  const endpoint = argument('--endpoint') || process.env.DS_GROUP_BOT_ENDPOINT || runtimeSettings(name, { root: packageRoot }).bridgeUrl;
  const directory = localPath('nodes', name);
  await mkdir(directory, { recursive: true });
  const releaseLock = await acquireNodeLock(path.join(directory, 'process.lock'));
  const coreUrl = process.env.DS_GROUP_CORE_URL || config.publicUrl || `http://127.0.0.1:${process.env.DS_GROUP_PORT || 18100}`;
  const work = createNodeWorkClient(coreUrl, config.nodeSecret, participant.id);
  const store = new NodeStore(path.join(directory, 'node.sqlite'), participant.id);
  const bridge = createBridge(endpoint, { token: process.env.DS_GROUP_BRIDGE_TOKEN });
  const executionMode = argument('--execution-mode') || process.env.DS_GROUP_EXECUTION_MODE || config.executionMode || nodeConfig.executionMode;
  const nativeBinding = config.nativeBinding || participant.nativeBinding || nodeConfig.nativeBinding;
  const attentionMode = argument('--attention-mode') || process.env.DSCORD_ATTENTION_MODE || process.env.DS_GROUP_ATTENTION_MODE
    || nodeConfig.attention?.mode || config.attention?.mode || 'mention';
  const decisionKey = process.env.DSCORD_DECISION_API_KEY || process.env.OPENAI_API_KEY;
  const decisionProvider = process.env.DSCORD_DECISION_ENABLED === 'false' ? undefined
    : createOpenAIDecisionProvider({ apiKey: decisionKey });
  const node = new BotNode({ participant, participants: setup.participants, roomId: setup.roomId,
    matrix: new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: participant.accessToken }), store,
    bridge, executionMode, nativeBinding, attention: { mode: attentionMode }, decisionProvider,
    files: new NodeFiles({ coreUrl, accessToken: participant.accessToken, directory: path.join(directory, 'tasks'), work,
      matrix: new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: participant.accessToken }) }),
    work,
    tasks: createTaskClient(coreUrl, config.nodeSecret),
    delivery: createDeliveryClient(coreUrl, participant.accessToken),
    roster: createRosterClient(coreUrl, participant.accessToken),
    heartbeat: async body => {
      const response = await fetch(new URL('/internal/nodes/heartbeat', coreUrl), { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.nodeSecret}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Core heartbeat HTTP ${response.status}`);
    },
  });
  const { KernelNodeClient } = await import('./kernel-node-client.mjs');
  node.kernelManagement = new KernelNodeClient({ coreUrl, nodeSecret: config.nodeSecret, botId: participant.id,
    nodeId: participant.localpart, runtimeId: node.runtimeId,
    operations: { configureAttention: value => { node.configureAttention(value); return node.attentionStatus(); },
      memoryProfiles: args => bridge.memoryProfiles({ botId: participant.id, ...args }),
      memoryProfile: args => bridge.memoryProfile({ botId: participant.id, ...args }) },
    onError: code => node.onError(`Kernel management: ${code}`) });
  try { await node.start(); }
  catch (error) { store.close(); await releaseLock(); throw error; }
  node.kernelManagement.start();
  console.log(`DS-Group node ${name} connected as ${participant.id}`);
  let stopping;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopping ||= node.stop().then(releaseLock).then(() => process.exit(0));
  });
  return node;
}

export async function acquireNodeLock(filename) {
  const identity = { pid: process.pid, runtimeId: randomUUID() };
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,runtime_id TEXT NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT * FROM owner WHERE id=1').get();
    if (previous) {
      let alive = true;
      try { process.kill(previous.pid, 0); }
      catch (error) {
        if (error.code !== 'ESRCH') throw new Error('Node process ownership could not be checked');
        alive = false;
      }
      if (alive) throw Object.assign(new Error(`This Bot already has a local process (${previous.pid})`), { code: 'NODE_PROCESS_ACTIVE' });
    }
    db.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,runtime_id=excluded.runtime_id')
      .run(identity.pid, identity.runtimeId);
    db.exec('COMMIT');
  }
  catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return async () => {
    db.prepare('DELETE FROM owner WHERE runtime_id=?').run(identity.runtimeId);
    db.close();
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runNode().catch(error => { console.error(error.message); process.exitCode = 1; });
}
