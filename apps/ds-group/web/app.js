import { initializePwa } from './pwa.js';

const SESSION_KEY = 'ds-group.session';
const PENDING_PREFIX = 'ds-group.pending.';
const WORKSPACE_KEY = 'ds-group.workspace';
const $ = id => document.getElementById(id);

function readStored(key) {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); }
  catch { return null; }
}

const state = {
  bootstrap: null,
  session: readStored(SESSION_KEY),
  events: [],
  recipients: new Set(),
  replyTo: null,
  pending: null,
  sending: false,
  loggingIn: false,
  polling: false,
  timer: null,
  eventFingerprint: '',
  status: null,
  roomId: null,
  rooms: [],
  ownedBots: [],
  view: 'chat',
  navigation: null,
  roomDialogMode: 'create',
  roomSubmitting: false,
  roomNotices: new Map(),
};

if (!state.session?.access_token || !state.session?.user_id) state.session = null;
const pwa = initializePwa({ request, getSession: () => state.session, onOpenRoom: openRoomFromNotification });

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function participants() { return state.bootstrap?.participants ?? []; }
function participant(id) { return participants().find(member => member.id === id); }
function displayName(id) { return participant(id)?.name ?? id?.split(':')[0]?.replace(/^@/, '') ?? '未知成员'; }
function currentRoom() { return state.rooms.find(room => room.roomId === state.roomId); }
function pendingKey(roomId = state.roomId, userId = state.session?.user_id) { return userId && roomId ? `${PENDING_PREFIX}${userId}.${roomId}` : null; }
function savePending() {
  const key = pendingKey();
  if (!key) return;
  if (state.pending) sessionStorage.setItem(key, JSON.stringify(state.pending));
  else sessionStorage.removeItem(key);
}

async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (state.session && options.auth !== false) headers.Authorization = `Bearer ${state.session.access_token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout ?? 15000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`服务器返回了无法读取的内容（HTTP ${response.status}）`); }
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message ?? data.message ?? data.errcode;
    const error = new Error(message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showPageError(message) {
  const text = message || state.roomNotices.get(state.roomId)?.message || '';
  $('page-error-text').textContent = text;
  $('page-error').hidden = !text;
}

function showSendError(message) {
  $('send-error').textContent = message;
  $('send-error').hidden = !message;
}

function avatarFor(member, index = 0) {
  const kind = member?.kind === 'bot' ? 'bot' : 'human';
  const alternate = index % 2 ? ' avatar-alternate' : '';
  return element('span', `avatar avatar-${kind}${alternate}`, (member?.name ?? '?').slice(0, 1));
}

function memberRow(member, index) {
  const row = element('div', 'member-row');
  row.append(avatarFor(member, index));
  const info = element('div', 'member-info');
  info.append(element('strong', '', member.name));
  row.append(info);
  if (member.kind === 'bot') row.append(element('span', 'member-kind', 'BOT'));
  const presence = member.kind === 'bot'
    ? state.status?.nodes?.find(node => node.botId === member.id)?.status ?? 'unknown'
    : member.id === state.session?.user_id ? 'online' : 'unknown';
  const dot = element('span', `status-dot member-presence ${statusClass(presence)}`);
  dot.title = STATUS_LABELS[presence] ?? '状态待确认';
  row.append(dot);
  row.title = member.id;
  return row;
}

function contactRow(member, index) {
  const button = element('button', 'member-row contact-row');
  button.type = 'button';
  button.setAttribute('aria-label', `与 ${member.name} 私聊`);
  const selected = currentRoom()?.kind === 'direct' && currentRoom()?.participantIds?.includes(member.id);
  button.classList.toggle('selected', Boolean(selected));
  button.append(...memberRow(member, index).childNodes);
  button.addEventListener('click', () => void openDirect(member.id));
  return button;
}

function renderParticipants() {
  const members = participants();
  const ownIds = new Set(state.ownedBots.map(bot => bot.id));
  const contacts = members.filter(member => member.id !== state.session?.user_id && !ownIds.has(member.id));
  $('member-count').textContent = String(contacts.length);
  $('sidebar-members').replaceChildren(...contacts.map(contactRow));
  $('owned-bot-count').textContent = state.session ? String(state.ownedBots.length) : '—';
  $('owned-bots').replaceChildren(...(state.ownedBots.length
    ? state.ownedBots.map(contactRow)
    : [element('p', 'sidebar-empty', state.session ? '暂无 Bot' : '登录后查看')]));
  $('home-bots').replaceChildren(...(state.ownedBots.length
    ? state.ownedBots.map(contactRow)
    : [element('p', 'muted small', state.session ? '暂无 Bot' : '登录后查看')]));
  $('home-contacts').replaceChildren(...contacts.map(contactRow));
  const roomMembers = currentRoom()?.participantIds?.length
    ? members.filter(member => currentRoom().participantIds.includes(member.id))
    : members;
  const groups = [];
  for (const [kind, title] of [['human', '人类'], ['bot', 'BOT']]) {
    const selected = roomMembers.filter(member => member.kind === kind);
    if (!selected.length) continue;
    const group = element('section', 'member-group');
    group.append(element('div', 'section-heading', `${title} — ${selected.length}`));
    for (const member of selected) {
      const row = member.id === state.session?.user_id ? memberRow(member, members.indexOf(member)) : contactRow(member, members.indexOf(member));
      group.append(row);
    }
    groups.push(group);
  }
  $('room-members').replaceChildren(...groups);
  const previousUser = $('login-user').value;
  $('login-user').replaceChildren(...members.filter(member => member.kind === 'human').map(member => {
    const option = element('option', '', `${member.name} · ${member.localpart ?? member.id}`);
    option.value = member.localpart ?? member.id;
    return option;
  }));
  if (previousUser) $('login-user').value = previousUser;
  $('login-submit').disabled = !$('login-user').value || state.loggingIn;
  renderRecipients();
}

function renderRecipients() {
  const roomMembers = currentRoom()?.participantIds;
  const buttons = participants().filter(member => member.kind === 'bot' && (!roomMembers?.length || roomMembers.includes(member.id))).map(member => {
    const button = element('button', 'recipient-option', `@ ${member.name}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.recipients.has(member.id)));
    button.disabled = !state.session || state.sending || Boolean(state.pending);
    button.addEventListener('click', () => {
      if (state.recipients.has(member.id)) state.recipients.delete(member.id);
      else state.recipients.add(member.id);
      renderRecipients();
      $('message-input').focus();
    });
    return button;
  });
  $('recipient-options').replaceChildren(...buttons);
  $('recipient-hint').textContent = state.recipients.size ? `已选择 ${state.recipients.size} 位` : '';
}

function renderIdentity() {
  const member = participant(state.session?.user_id);
  $('current-name').textContent = state.session ? displayName(state.session.user_id) : '登录';
  $('current-id').textContent = state.session?.user_id ?? '选择账号';
  $('current-avatar').textContent = (member?.name ?? '?').slice(0, 1);
  $('close-login').hidden = !state.session;
  $('settings-account').textContent = state.session?.user_id ?? '尚未登录';
  updateComposer();
}

function updateComposer() {
  $('message-input').disabled = !state.session;
  $('message-input').readOnly = state.sending || Boolean(state.pending);
  $('message-input').placeholder = state.session ? `向 ${currentRoom()?.name ?? '初次协作'} 发消息` : '登录后发送消息';
  $('send-button').disabled = !state.session || state.sending || !state.bootstrap || !($('message-input').value.trim() || state.pending);
  $('send-button-text').textContent = state.sending ? '发送中' : state.pending ? '重试发送' : '发送';
  $('composer-help').textContent = state.pending && !state.sending ? '保留同一消息编号，重试不会创建第二条消息' : 'Enter 发送 · Shift + Enter 换行';
  $('clear-reply').disabled = state.sending || Boolean(state.pending);
  renderRecipients();
}

function renderReplyPreview() {
  const event = state.events.find(item => item.event_id === state.replyTo);
  $('reply-preview').hidden = !state.replyTo;
  $('reply-preview-name').textContent = event ? displayName(event.sender) : '先前消息';
  $('reply-preview-body').textContent = event?.content?.body ?? state.replyTo ?? '';
}

function beginReply(event) {
  if (!state.session) { showLogin(); return; }
  if (state.pending || state.sending) return;
  state.replyTo = event.event_id;
  if (participant(event.sender)?.kind === 'bot') state.recipients.add(event.sender);
  renderReplyPreview();
  renderRecipients();
  $('message-input').focus();
}

function formatTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp));
}

function dayKey(timestamp) {
  if (!Number.isFinite(timestamp)) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(timestamp));
}

function renderMessages(force = false) {
  const fingerprint = JSON.stringify(state.events.map(event => [event.event_id, event.sender, event.content]));
  if (!force && fingerprint === state.eventFingerprint) return;
  state.eventFingerprint = fingerprint;
  const timeline = $('timeline');
  const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
  const oldHeight = timeline.scrollHeight;
  const children = [];
  let previousDay;
  for (const event of state.events) {
    const currentDay = dayKey(event.origin_server_ts);
    if (currentDay !== previousDay) {
      children.push(element('div', 'date-separator', currentDay));
      previousDay = currentDay;
    }
    const member = participant(event.sender) ?? { id: event.sender, name: displayName(event.sender), kind: 'unknown' };
    const own = event.sender === state.session?.user_id;
    const message = element('article', `message ${member.kind === 'bot' ? 'bot' : 'human'}${own ? ' own' : ''}`);
    message.dataset.eventId = event.event_id;
    message.append(avatarFor(member, Math.max(0, participants().indexOf(member))));
    const content = element('div', 'message-content');
    const meta = element('div', 'message-meta');
    meta.append(element('span', 'message-name', member.name));
    if (member.kind === 'bot') meta.append(element('span', 'message-kind', 'BOT'));
    if (own) meta.append(element('span', 'message-self', '你'));
    meta.append(element('time', 'message-time', formatTime(event.origin_server_ts)));
    content.append(meta);
    const extension = event.content?.['org.ds_group'] ?? {};
    const quoteId = extension.replyTo ?? event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
    if (quoteId) {
      const quote = state.events.find(item => item.event_id === quoteId);
      content.append(element('div', 'message-quote', quote ? `${displayName(quote.sender)}　${quote.content?.body ?? ''}` : '回复了一条先前消息'));
    }
    if (Array.isArray(extension.to) && extension.to.length) {
      const targets = element('div', 'message-recipients');
      for (const target of extension.to) targets.append(element('span', 'mention-tag', `@ ${displayName(target)}`));
      content.append(targets);
    }
    content.append(element('div', 'message-bubble', event.content?.body ?? ''));
    const actions = element('div', 'message-actions');
    const reply = element('button', 'reply-button', '↳ 回复');
    reply.type = 'button';
    reply.setAttribute('aria-label', `回复 ${member.name} 的消息`);
    reply.addEventListener('click', () => beginReply(event));
    actions.append(reply);
    if (extension.taskId) actions.append(element('span', 'task-label', `事项 ${extension.taskId}`));
    content.append(actions);
    message.append(content);
    children.push(message);
  }
  $('message-list').replaceChildren(...children);
  $('empty-state').hidden = state.events.length > 0;
  $('empty-description').textContent = state.session ? '' : '登录后查看';
  if (nearBottom || !oldHeight || force) timeline.scrollTop = timeline.scrollHeight;
  renderReplyPreview();
}

const STATUS_LABELS = {
  ready: '就绪', idle: '空闲', online: '在线', connected: '已连接',
  busy: '工作中', running: '运行中', thinking: '思考中', processing: '处理中',
  starting: '启动中', connecting: '连接中', stopped: '已停止', offline: '离线',
  error: '异常', failed: '失败', unavailable: '不可用', unknown: '待确认',
};

function statusClass(status) {
  if (['ready', 'idle', 'online', 'connected'].includes(status)) return 'online';
  if (['busy', 'running', 'thinking', 'processing', 'starting', 'connecting'].includes(status)) return 'busy';
  if (['error', 'failed', 'unavailable'].includes(status)) return 'error';
  return '';
}

function runtimeLabel(node) {
  const runtime = node.runtime ?? node.engine ?? node.mode ?? node.adapter;
  if (node.simulated === true || runtime === 'fixture' || runtime === 'mock' || runtime === 'simulated') return '模拟节点';
  if (typeof runtime === 'string' && /ds.?bot/i.test(runtime)) return 'DS-Bot · 真实运行时';
  return '运行类型待报告';
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  $('connection-dot').className = 'status-dot online';
  $('connection-text').textContent = '已连接';
  $('core-status-dot').className = 'status-dot online';
  $('core-title').textContent = '聊天核心已连接';
  $('core-description').textContent = status.core?.name ?? status.core?.engine ?? 'DS-Group / Matrix';
  const nodes = Array.isArray(status.nodes) ? status.nodes : [];
  $('node-count').textContent = String(nodes.length);
  const cards = nodes.map((node, index) => {
    const card = element('article', 'node-card');
    const header = element('div', 'node-header');
    const name = node.name ?? displayName(node.botId);
    header.append(avatarFor({ name, kind: 'bot' }, index));
    const title = element('div', 'node-title');
    title.append(element('strong', '', name), element('small', '', node.id ?? node.nodeId ?? node.botId));
    header.append(title);
    const statusName = node.status ?? 'unknown';
    const indicator = element('span', 'node-state');
    indicator.append(element('span', `status-dot ${statusClass(statusName)}`), document.createTextNode(STATUS_LABELS[statusName] ?? statusName));
    header.append(indicator);
    card.append(header, element('span', 'node-engine', runtimeLabel(node)));
    const meta = element('div', 'node-meta');
    const processed = node.processed ?? node.processedCount;
    meta.append(element('span', '', Number.isFinite(processed) ? `已处理 ${processed} 条` : '处理数待报告'), element('span', '', node.model ? node.model.split('/').at(-1) : 'dsv4.1f'));
    card.append(meta);
    if (node.lastError) card.append(element('p', 'node-error', typeof node.lastError === 'string' ? node.lastError : node.lastError.message ?? node.lastError.code ?? '节点报告错误'));
    return card;
  });
  $('node-list').replaceChildren(...(cards.length ? cards : [element('p', 'muted small', '尚无节点报告状态。')]));
  const budget = status.budget ?? {};
  const used = Number.isFinite(budget.used) ? budget.used : null;
  const limit = Number.isFinite(budget.limit) ? budget.limit : null;
  $('budget-used').textContent = used === null ? '—' : String(used);
  $('budget-limit').textContent = limit === null ? '次 · 按需测试' : `/ ${limit} 次`;
  $('budget-fill').style.width = limit && used !== null ? `${Math.min(100, used / limit * 100)}%` : '0%';
  $('budget-description').textContent = limit === null ? '实际调用由核心记录，远端统一使用 dsv4.1f。' : `本轮剩余 ${budget.remaining ?? Math.max(0, limit - (used ?? 0))} 次。包含核心记录的各类生成调用。`;
  $('last-sync').textContent = `${formatTime(Date.now())} 更新`;
  renderParticipants();
}

function showLogin() {
  if (state.sending) return;
  $('login-error').hidden = true;
  $('close-login').hidden = !state.session;
  if (!$('login-dialog').open) $('login-dialog').showModal();
}

async function login(event) {
  event.preventDefault();
  if (state.loggingIn || !$('login-user').value) return;
  state.loggingIn = true;
  $('login-submit').disabled = true;
  $('login-error').hidden = true;
  try {
    const user = $('login-user').value;
    const password = $('login-password').value;
    const session = password
      ? await request('/api/login', { method: 'POST', body: { user, password }, auth: false })
      : await request(`/api/demo-login?user=${encodeURIComponent(user)}`, { auth: false });
    if (!session.access_token || !session.user_id) throw new Error('登录回执缺少身份或会话信息');
    await pwa.beforeIdentityChange(session.user_id);
    state.session = session;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    state.roomId = state.bootstrap.roomId;
    await loadRooms();
    await loadOwnedBots();
    state.pending = readStored(pendingKey());
    state.recipients = new Set(state.pending?.to ?? []);
    state.replyTo = state.pending?.replyTo ?? null;
    $('message-input').value = state.pending?.body ?? '';
    $('login-password').value = '';
    $('login-dialog').close();
    showSendError(state.pending ? '上一条消息尚未确认。点击重试发送，将使用原消息编号核对。' : '');
    renderIdentity();
    renderParticipants();
    renderMessages(true);
    await loadMessages();
    await applyPendingNavigation();
    void pwa.refresh();
    $('message-input').focus();
  } catch (error) {
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  } finally {
    state.loggingIn = false;
    $('login-submit').disabled = !$('login-user').value;
  }
}

async function loadMessages() {
  if (!state.session || !state.roomId) return;
  const session = state.session;
  const roomId = state.roomId;
  try {
    const result = await request(`/api/rooms/${encodeURIComponent(roomId)}/messages`);
    if (session !== state.session || roomId !== state.roomId) return;
    const events = Array.isArray(result.events) ? result.events : [];
    const seen = new Set();
    state.events = events.filter(event => {
      if (!event.event_id || seen.has(event.event_id) || event.type !== 'm.room.message' || typeof event.content?.body !== 'string') return false;
      seen.add(event.event_id);
      return true;
    });
    renderMessages();
    showPageError('');
  } catch (error) {
    if (session !== state.session || roomId !== state.roomId) return;
    if (error.status === 401) {
      state.session = null;
      sessionStorage.removeItem(SESSION_KEY);
      renderIdentity();
      showLogin();
    }
    throw error;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.session || !state.roomId || state.sending) return;
  const body = $('message-input').value.trim();
  if (!body && !state.pending) return;
  if (!state.pending) {
    state.pending = { body, to: [...state.recipients], transactionId: crypto.randomUUID() };
    if (state.replyTo) state.pending.replyTo = state.replyTo;
    savePending();
  }
  const identity = state.session.user_id;
  const roomId = state.roomId;
  state.sending = true;
  showSendError('');
  updateComposer();
  try {
    const receipt = await request(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: 'POST', body: state.pending, timeout: 30000 });
    if (!receipt.event_id) throw new Error('服务器未返回消息编号，请用原编号重试核对');
    sessionStorage.removeItem(pendingKey(roomId, identity));
    state.pending = null;
    state.replyTo = null;
    $('message-input').value = '';
    renderReplyPreview();
    try { await loadMessages(); }
    catch (error) { showPageError(`消息已发送，记录刷新失败。${error.message}`); }
    $('timeline').scrollTop = $('timeline').scrollHeight;
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 429) {
      state.pending = null;
      savePending();
      showSendError(`消息未被接纳。${error.message}`);
    } else {
      showSendError(`${error.message}。消息保持待确认，重试将使用同一消息编号。`);
    }
  } finally {
    state.sending = false;
    updateComposer();
    if (state.navigation) void applyPendingNavigation();
  }
}

async function poll() {
  clearTimeout(state.timer);
  if (state.polling) return;
  state.polling = true;
  const results = await Promise.allSettled([
    loadMessages(),
    request('/api/status', { auth: false }).then(status => { state.status = status; renderStatus(); }),
  ]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) {
    showPageError(failure.reason.message);
    $('connection-dot').className = 'status-dot error';
    $('connection-text').textContent = '同步异常';
  }
  state.polling = false;
  state.timer = setTimeout(poll, document.hidden ? 12000 : 2000);
}

async function bootstrap() {
  try {
    state.bootstrap = await request('/api/bootstrap', { auth: false });
    if (!state.bootstrap.roomId || !Array.isArray(state.bootstrap.participants)) throw new Error('工作区配置尚未准备完成');
    sessionStorage.setItem(WORKSPACE_KEY, JSON.stringify(state.bootstrap));
    state.roomId = state.bootstrap.roomId;
    state.rooms = [{ roomId: state.bootstrap.roomId, name: state.bootstrap.roomName ?? '初次协作', kind: 'group', participantIds: participants().map(member => member.id) }];
    const name = state.bootstrap.roomName ?? '初次协作';
    $('room-title').textContent = name;
    $('sidebar-room-name').textContent = name;
    renderParticipants();
    if (state.session) {
      try { await loadRooms(); await loadOwnedBots(); }
      catch (error) {
        if (error.status !== 401) throw error;
        state.session = null;
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
    state.pending = state.session ? readStored(pendingKey()) : null;
    if (state.pending) {
      state.recipients = new Set(state.pending.to ?? []);
      state.replyTo = state.pending.replyTo ?? null;
      $('message-input').value = state.pending.body ?? '';
      showSendError('上一条消息尚未确认。重试将使用原消息编号核对。');
    }
    renderIdentity();
    if (!state.session) showLogin();
    showPageError('');
    await poll();
    await applyPendingNavigation();
  } catch (error) {
    const cached = readStored(WORKSPACE_KEY);
    if (!state.bootstrap && cached?.roomId && Array.isArray(cached.participants)) {
      state.bootstrap = cached;
      state.rooms = readStored(`ds-group.rooms.${state.session?.user_id}`) ?? [{ roomId: cached.roomId, name: '初次协作', kind: 'group', participantIds: cached.participants.map(member => member.id) }];
      state.roomId = readStored(`ds-group.room.${state.session?.user_id}`) ?? cached.roomId;
      state.ownedBots = participants().filter(member => member.kind === 'bot' && member.ownerId === state.session?.user_id);
      state.pending = readStored(pendingKey());
      state.recipients = new Set(state.pending?.to ?? []);
      state.replyTo = state.pending?.replyTo ?? null;
      $('message-input').value = state.pending?.body ?? '';
      renderParticipants();
      renderIdentity();
      renderRoomHeading();
      renderMessages(true);
    }
    showPageError(`工作区暂时不可用。${error.message}`);
    $('connection-text').textContent = navigator.onLine ? '等待连接' : '离线';
    $('empty-description').textContent = state.pending ? '待确认消息已保留' : '重新连接后读取消息';
  }
}

function renderRoomHeading() {
  const room = currentRoom();
  $('room-title').textContent = room?.name ?? '初次协作';
  $('room-subtitle').textContent = room?.topic ?? '';
  $('heading-symbol').textContent = room?.kind === 'direct' ? '@' : '#';
  $('group-room-button').classList.toggle('selected', state.roomId === state.bootstrap?.roomId);
  $('group-room-button').setAttribute('aria-current', state.roomId === state.bootstrap?.roomId ? 'page' : 'false');
  renderChannels();
  $('invite-bot-button').hidden = state.view !== 'chat' || room?.kind !== 'group';
  renderParticipants();
  updateComposer();
}

async function loadRooms() {
  if (!state.session) return;
  const session = state.session;
  const result = await request('/api/rooms');
  if (session !== state.session) return;
  if (Array.isArray(result.rooms)) {
    state.rooms = result.rooms;
    for (const room of state.rooms) {
      const pending = state.roomNotices.get(room.roomId)?.pendingIds;
      if (pending?.length && pending.every(id => room.participantIds?.includes(id))) state.roomNotices.delete(room.roomId);
    }
    sessionStorage.setItem(`ds-group.rooms.${state.session.user_id}`, JSON.stringify(state.rooms));
    renderRoomHeading();
  }
}

async function switchRoom(room) {
  if (state.sending) return;
  if (!state.rooms.some(item => item.roomId === room.roomId)) state.rooms.push(room);
  state.roomId = room.roomId;
  const url = new URL(location.href);
  if (room.roomId === state.bootstrap?.roomId) url.searchParams.delete('roomId');
  else url.searchParams.set('roomId', room.roomId);
  url.searchParams.delete('eventId');
  history.replaceState(null, '', url);
  state.view = 'chat';
  $('home-panel').hidden = true;
  $('timeline').hidden = false;
  $('composer-form').hidden = false;
  sessionStorage.setItem(`ds-group.room.${state.session?.user_id}`, JSON.stringify(room.roomId));
  state.events = [];
  state.eventFingerprint = '';
  state.pending = readStored(pendingKey());
  const directBot = room.kind === 'direct' ? room.participantIds?.find(id => participant(id)?.kind === 'bot') : null;
  state.recipients = new Set(state.pending?.to ?? (directBot ? [directBot] : []));
  state.replyTo = state.pending?.replyTo ?? null;
  $('message-input').value = state.pending?.body ?? '';
  showSendError(state.pending ? '本会话有一条待确认消息，重试会使用原消息编号。' : '');
  renderRoomHeading();
  renderMessages(true);
  toggleDetails(false);
  toggleChannels(false);
  try { await loadMessages(); }
  catch (error) { showPageError(error.message); }
}

async function openDirect(participantId) {
  if (!state.session) { showLogin(); return; }
  if (state.sending) return;
  try {
    const room = await request('/api/dm', { method: 'POST', body: { participantId } });
    if (!room.roomId) throw new Error('私聊创建回执缺少房间编号');
    room.participantIds ??= [state.session.user_id, participantId];
    room.name ??= displayName(participantId);
    room.kind = 'direct';
    await switchRoom(room);
  } catch (error) { showPageError(error.message); }
}

async function loadOwnedBots() {
  if (!state.session) { state.ownedBots = []; return; }
  const session = state.session;
  const result = await request('/api/bots');
  if (session !== state.session) return;
  state.ownedBots = Array.isArray(result.bots) ? result.bots : [];
  renderParticipants();
}

function renderChannels() {
  const rooms = state.rooms.filter(room => room.kind === 'group' && room.roomId !== state.bootstrap?.roomId);
  $('additional-rooms').replaceChildren(...rooms.map(room => {
    const button = element('button', `room-item${state.roomId === room.roomId && state.view === 'chat' ? ' selected' : ''}`);
    button.type = 'button';
    button.append(element('span', 'room-symbol', '#'), element('strong', '', room.name));
    button.addEventListener('click', () => void switchRoom(room));
    return button;
  }));
}

function showHome() {
  if (state.sending) return;
  state.view = 'home';
  $('home-panel').hidden = false;
  $('timeline').hidden = true;
  $('composer-form').hidden = true;
  $('room-title').textContent = '主页';
  $('room-subtitle').textContent = '';
  $('heading-symbol').textContent = '@';
  $('invite-bot-button').hidden = true;
  $('group-room-button').classList.remove('selected');
  renderChannels();
  renderParticipants();
  toggleChannels(false);
}

function selectSettingsTab(name) {
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.settingsTab === name));
  }
  for (const panel of document.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== name;
}

function openSettings(tab = 'account') {
  selectSettingsTab(tab);
  $('settings-account').textContent = state.session?.user_id ?? '尚未登录';
  $('server-url').value ||= location.origin;
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
  void pwa.refresh();
}

async function checkServer(event) {
  event.preventDefault();
  $('check-server').disabled = true;
  $('server-feedback').textContent = '正在检查';
  try {
    const url = new URL($('server-url').value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 HTTP 或 HTTPS 服务器地址');
    const response = await fetch(new URL('/api/bootstrap', url.origin), { credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`);
    const data = await response.json();
    if (!data.roomId || !Array.isArray(data.participants)) throw new Error('地址未返回 DS-Group 工作区');
    $('server-feedback').textContent = `发现服务器 ${data.name ?? 'DS-Group'} · ${url.origin}。当前会话仍连接 ${location.origin}。`;
  } catch (error) {
    $('server-feedback').textContent = `检查失败。${error.message}`;
  } finally { $('check-server').disabled = false; }
}

async function showRoomDialog(mode) {
  if (!state.session) { showLogin(); return; }
  if (state.roomSubmitting || state.sending) return;
  state.roomDialogMode = mode;
  $('room-form-error').textContent = '';
  $('room-name-field').hidden = mode === 'invite';
  $('new-room-name').required = mode === 'create';
  const pending = mode === 'create' ? readStored(`ds-group.pending-room.${state.session.user_id}`) : null;
  $('new-room-name').value = pending?.name ?? '';
  $('room-dialog-title').textContent = mode === 'invite' ? '邀请我的 Bot' : '创建群聊';
  $('room-choice-label').textContent = mode === 'invite' ? '选择 Bot' : '邀请成员';
  $('room-submit').textContent = mode === 'invite' ? '邀请' : '创建';
  try {
    await loadOwnedBots();
    const currentIds = new Set(currentRoom()?.participantIds ?? []);
    const choices = mode === 'invite'
      ? state.ownedBots.filter(bot => !currentIds.has(bot.id))
      : participants().filter(member => member.id !== state.session.user_id && (member.kind === 'human' || member.ownerId === state.session.user_id));
    $('room-choices').replaceChildren(...(choices.length ? choices.map(member => {
      const label = element('label', 'room-choice');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.value = member.id;
      checkbox.checked = pending?.inviteIds?.includes(member.id) ?? false;
      label.append(checkbox, avatarFor(member), element('span', '', member.name));
      if (member.kind === 'bot') label.append(element('span', 'member-kind', 'BOT'));
      return label;
    }) : [element('p', 'muted small', mode === 'invite' ? '没有可邀请的 Bot' : '暂无可邀请成员')]));
    $('room-submit').disabled = mode === 'invite' && !choices.length;
    if (pending) $('room-form-error').textContent = '上次创建结果待确认。保持内容重试会核对原请求，修改内容会创建新请求。';
    $('room-dialog').showModal();
  } catch (error) { showPageError(error.message); }
}

async function submitRoom(event) {
  event.preventDefault();
  if (state.roomSubmitting) return;
  const ids = [...$('room-choices').querySelectorAll('input:checked')].map(input => input.value);
  const mode = state.roomDialogMode;
  if (mode === 'invite' && !ids.length) { $('room-form-error').textContent = '请选择一位 Bot'; return; }
  state.roomSubmitting = true;
  $('room-submit').disabled = true;
  $('close-room-dialog').disabled = true;
  try {
    if (mode === 'create') {
      const key = `ds-group.pending-room.${state.session.user_id}`;
      const saved = readStored(key);
      const name = $('new-room-name').value.trim();
      const inviteIds = [...ids].sort();
      const requestId = saved?.name === name && JSON.stringify(saved.inviteIds) === JSON.stringify(inviteIds)
        ? saved.requestId : crypto.randomUUID();
      const body = { requestId, name, inviteIds };
      sessionStorage.setItem(key, JSON.stringify(body));
      const room = await request('/api/rooms', { method: 'POST', body });
      if (!room.roomId) throw new Error('创建回执缺少房间编号，请保留当前内容重试');
      sessionStorage.removeItem(key);
      if (room.status === 'partially_joined') state.roomNotices.set(room.roomId, {
        message: '群已创建，部分成员待加入。',
        pendingIds: room.joinResults?.filter(result => result.status === 'pending').map(result => result.participantId) ?? [],
      });
      await loadRooms();
      await switchRoom(room);
      showPageError('');
    } else {
      const roomId = state.roomId;
      for (const id of ids) await request(`/api/rooms/${encodeURIComponent(roomId)}/invite`, { method: 'POST', body: { participantId: id } });
      await loadRooms();
      renderParticipants();
    }
    $('room-dialog').close();
  } catch (error) {
    $('room-form-error').textContent = error.message;
  } finally {
    state.roomSubmitting = false;
    $('room-submit').disabled = false;
    $('close-room-dialog').disabled = false;
  }
}

async function openRoomFromNotification({ roomId, eventId }) {
  if (!roomId) return;
  state.navigation = { roomId, eventId };
  if (!state.session) { showLogin(); return; }
  if (state.sending) return;
  await applyPendingNavigation();
}

async function applyPendingNavigation() {
  if (!state.navigation || !state.session || state.sending) return;
  const target = state.navigation;
  try {
    await loadRooms();
    const room = state.rooms.find(item => item.roomId === target.roomId);
    if (!room) throw new Error('当前账号尚未加入通知中的会话');
    await switchRoom(room);
    state.navigation = null;
    const url = new URL(location.href);
    url.searchParams.set('roomId', room.roomId);
    if (target.eventId) url.searchParams.set('eventId', target.eventId);
    else url.searchParams.delete('eventId');
    history.replaceState(null, '', url);
    const message = [...document.querySelectorAll('.message')].find(node => node.dataset.eventId === target.eventId);
    if (message) {
      message.classList.add('notification-target');
      message.scrollIntoView({ block: 'center' });
      setTimeout(() => message.classList.remove('notification-target'), 4000);
    }
  } catch (error) { showPageError(error.message); }
}

function toggleChannels(open) {
  $('channel-panel').classList.toggle('open', open);
  $('channels-button').setAttribute('aria-expanded', String(open));
  if (open) {
    $('details-panel').classList.remove('open');
    $('details-button').setAttribute('aria-expanded', 'false');
  }
  $('panel-backdrop').hidden = !open && !$('details-panel').classList.contains('open');
}

function toggleDetails(open) {
  $('details-panel').classList.toggle('open', open);
  $('details-button').setAttribute('aria-expanded', String(open));
  if (open) {
    $('channel-panel').classList.remove('open');
    $('channels-button').setAttribute('aria-expanded', 'false');
  }
  $('panel-backdrop').hidden = !open && !$('channel-panel').classList.contains('open');
}

$('identity-button').addEventListener('click', showLogin);
$('login-form').addEventListener('submit', login);
$('close-login').addEventListener('click', () => $('login-dialog').close());
$('login-dialog').addEventListener('cancel', event => { if (!state.session) event.preventDefault(); });
$('composer-form').addEventListener('submit', sendMessage);
$('message-input').addEventListener('input', updateComposer);
$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer-form').requestSubmit();
  }
});
$('clear-reply').addEventListener('click', () => { state.replyTo = null; renderReplyPreview(); });
$('group-room-button').addEventListener('click', () => {
  const room = state.rooms.find(item => item.roomId === state.bootstrap?.roomId);
  if (room) void switchRoom(room);
});
$('server-button').addEventListener('click', () => $('group-room-button').click());
$('home-button').addEventListener('click', showHome);
$('settings-button').addEventListener('click', () => openSettings());
$('mobile-settings').addEventListener('click', () => openSettings());
$('server-settings-button').addEventListener('click', () => openSettings('server'));
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('switch-account').addEventListener('click', () => { $('settings-dialog').close(); showLogin(); });
for (const button of document.querySelectorAll('[data-settings-tab]')) {
  button.addEventListener('click', () => selectSettingsTab(button.dataset.settingsTab));
}
$('server-form').addEventListener('submit', checkServer);
$('channels-button').addEventListener('click', () => toggleChannels(!$('channel-panel').classList.contains('open')));
$('close-channels').addEventListener('click', () => toggleChannels(false));
$('create-room-button').addEventListener('click', () => void showRoomDialog('create'));
$('invite-bot-button').addEventListener('click', () => void showRoomDialog('invite'));
$('room-form').addEventListener('submit', submitRoom);
$('close-room-dialog').addEventListener('click', () => $('room-dialog').close());
$('room-dialog').addEventListener('cancel', event => { if (state.roomSubmitting) event.preventDefault(); });
$('retry-connection').addEventListener('click', () => void bootstrap());
$('details-button').addEventListener('click', () => toggleDetails(!$('details-panel').classList.contains('open')));
$('close-details').addEventListener('click', () => toggleDetails(false));
$('panel-backdrop').addEventListener('click', () => { toggleDetails(false); toggleChannels(false); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.bootstrap) void poll(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape') { toggleDetails(false); toggleChannels(false); } });
window.matchMedia('(min-width: 1181px)').addEventListener('change', event => { if (event.matches) toggleDetails(false); });
window.matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches) toggleChannels(false); });
window.addEventListener('online', () => void bootstrap());
const initialUrl = new URL(location.href);
if (initialUrl.searchParams.has('roomId')) state.navigation = { roomId: initialUrl.searchParams.get('roomId'), eventId: initialUrl.searchParams.get('eventId') };
void bootstrap();
