// Shared by the composer and the server. Stable member IDs survive display-name changes.
export function parseMentionTokens(value) {
  const body = typeof value === 'string' ? value : '';
  const tokens = [];
  let index = 0;
  while (index < body.length) {
    if (body[index] === '\\') { index += 2; continue; }
    if (body[index] === '`' || body.startsWith('~~~', index)) {
      const character = body[index];
      let end = index + 1;
      while (body[end] === character) end++;
      const delimiter = body.slice(index, end);
      const close = body.indexOf(delimiter, end);
      index = close < 0 ? body.length : close + delimiter.length;
      continue;
    }
    const rest = body.slice(index);
    const role = rest.match(/^<@&([A-Za-z0-9_.:-]+)>/);
    const member = rest.match(/^<@(@[^<>\s]+:[^<>\s]+)>/);
    if (role || member) {
      const match = role || member;
      tokens.push({ start: index, end: index + match[0].length, kind: role ? 'role' : 'user', id: match[1] });
      index += match[0].length;
      continue;
    }
    const group = rest.match(/^@(everyone|here)(?![\p{L}\p{N}_-])/u);
    const previous = body[index - 1] || '';
    const wordBefore = body.slice(0, index).match(/\S+$/)?.[0] || '';
    if (group && !/[\p{L}\p{N}_@]/u.test(previous) && !wordBefore.includes('://')) {
      tokens.push({ start: index, end: index + group[0].length, kind: group[1] });
      index += group[0].length;
      continue;
    }
    index++;
  }
  return {
    users: [...new Set(tokens.filter(token => token.kind === 'user').map(token => token.id))],
    roles: [...new Set(tokens.filter(token => token.kind === 'role').map(token => token.id))],
    everyone: tokens.some(token => token.kind === 'everyone'),
    here: tokens.some(token => token.kind === 'here'),
    tokens,
  };
}

export function mentionKindsFor(event, userId) {
  const mentions = event.content?.['org.ds_group']?.mentions;
  if (!mentions) {
    const native = event.content?.['m.mentions'] || {};
    return [...(native.user_ids?.includes(userId) ? ['user'] : []), ...(native.room ? ['everyone'] : [])];
  }
  const kinds = [];
  if (mentions.users?.includes(userId)) kinds.push('user');
  if (mentions.replyUserId === userId) kinds.push('reply');
  if (mentions.roleUsers?.includes(userId)) kinds.push('role');
  if (mentions.everyoneUsers?.includes(userId)) kinds.push('everyone');
  if (mentions.hereUsers?.includes(userId)) kinds.push('here');
  return kinds;
}

export function displayMentionText(body, participants = [], roles = []) {
  const { tokens } = parseMentionTokens(body);
  let result = '';
  let previous = 0;
  for (const token of tokens) {
    result += body.slice(previous, token.start);
    if (token.kind === 'user') result += `@${participants.find(person => person.id === token.id)?.name || token.id}`;
    else if (token.kind === 'role') result += `@${roles.find(role => role.id === token.id)?.name || token.id}`;
    else result += `@${token.kind}`;
    previous = token.end;
  }
  return result + body.slice(previous);
}
