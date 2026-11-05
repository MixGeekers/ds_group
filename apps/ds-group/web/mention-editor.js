import { parseMentionTokens } from './mention-tokens.js';

const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
const isChip = node => node?.nodeType === 1 && node.hasAttribute('data-mention-token');

export function mentionCandidates(mentionables = {}, query = '') {
  const candidates = [
    ...(mentionables.members || []).map(member => ({ ...member, kind: 'user', memberKind: member.kind })),
    ...(mentionables.roles || []).filter(role => role.canMention ?? (role.mentionable !== false)).map(role => ({ ...role, kind: 'role' })),
    ...((mentionables.canMentionEveryone ?? mentionables.everyone) ? [{ kind: 'everyone', name: 'everyone', description: '所有成员' }] : []),
    ...((mentionables.canMentionHere ?? mentionables.here) ? [{ kind: 'here', name: 'here', description: '在线成员' }] : []),
  ];
  const needle = normalize(query).trim();
  const score = item => {
    const names = [item.name, item.localpart, item.id].map(normalize);
    if (!needle) return 0;
    if (names.some(name => name === needle)) return 0;
    if (names.some(name => name.startsWith(needle))) return 1;
    return names.some(name => name.includes(needle)) ? 2 : 3;
  };
  return candidates.map((item, order) => ({ item, order, score: score(item) }))
    .filter(entry => entry.score < 3)
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, 20).map(entry => entry.item);
}

export function mentionToken(item) {
  if (item.kind === 'everyone' || item.kind === 'here') return `@${item.kind}`;
  if (item.kind === 'role') return `<@&${item.id}>`;
  return `<@${item.id}>`;
}

export function findMentionQuery(body, caret = body.length) {
  const prefix = body.slice(0, caret);
  const start = prefix.lastIndexOf('@');
  if (start < 0) return null;
  const previous = prefix[start - 1] || '';
  if (previous && !/[\s([{"'“‘]/u.test(previous)) return null;
  const query = prefix.slice(start + 1);
  if (query.length > 64 || /[\n\r@<>`~\\]/u.test(query)) return null;
  // The shared parser decides whether this position is escaped or inside code.
  const probe = prefix.slice(0, start) + '@everyone';
  if (!parseMentionTokens(probe).tokens.some(token => token.start === start && token.kind === 'everyone')) return null;
  return { start, end: caret, query };
}

export function mentionParts(body, mentionables = {}) {
  const parts = [];
  let offset = 0;
  for (const token of parseMentionTokens(body).tokens) {
    if (token.start > offset) parts.push({ kind: 'text', text: body.slice(offset, token.start) });
    const person = token.kind === 'user' ? mentionables.members?.find(item => item.id === token.id) : undefined;
    const role = token.kind === 'role' ? mentionables.roles?.find(item => item.id === token.id) : undefined;
    const name = person?.name || role?.name || token.id || token.kind;
    parts.push({ ...token, name, text: `@${name}`, token: body.slice(token.start, token.end),
      memberKind: person?.kind, color: role?.color });
    offset = token.end;
  }
  if (offset < body.length) parts.push({ kind: 'text', text: body.slice(offset) });
  return parts;
}

function editorText(node) {
  if (node.nodeType === 3) return node.nodeValue || '';
  if (isChip(node)) return node.dataset.mentionToken;
  if (node.nodeType === 1 && node.hasAttribute('data-editor-tail')) return '';
  if (node.nodeType === 1 && node.tagName === 'BR') return '\n';
  let text = '';
  for (const child of node.childNodes) {
    const block = child.nodeType === 1 && ['DIV', 'P', 'LI'].includes(child.tagName);
    if (block && text && !text.endsWith('\n')) text += '\n';
    text += editorText(child);
    if (block && child.nextSibling && !text.endsWith('\n')) text += '\n';
  }
  return text;
}

export function createMentionEditor({ element, popup, getMentionables = () => ({}), onChange = () => {},
  onSubmit = () => {}, onFiles = () => {}, maxLength = 16000, getLabels = () => ({}) } = {}) {
  if (!element || !popup) throw new Error('Mention editor needs an editable element and suggestion popup');
  const document = element.ownerDocument;
  const window = document.defaultView;
  const disposers = [];
  let composing = false;
  let disabled = false;
  let activeQuery = null;
  let candidates = [];
  let activeIndex = 0;
  let dismissedQuery = null;
  let undoStates = [{ body: '', caret: 0 }];
  let undoIndex = 0;

  element.contentEditable = 'true';
  element.setAttribute('role', 'textbox');
  element.setAttribute('aria-multiline', 'true');
  element.setAttribute('aria-autocomplete', 'list');
  element.setAttribute('autocomplete', 'off');
  element.setAttribute('autocapitalize', 'sentences');
  popup.id ||= `mentions-${Math.random().toString(36).slice(2)}`;
  popup.classList.add('mention-popup');
  popup.setAttribute('role', 'listbox');
  popup.setAttribute('aria-label', getLabels().suggestions || '提及成员与身份组');
  element.setAttribute('aria-controls', popup.id);

  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    disposers.push(() => target.removeEventListener(name, callback, options));
  }

  function selectionRange() {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return element.contains(range.startContainer) && element.contains(range.endContainer) ? range : null;
  }

  function selectionOffsets() {
    const range = selectionRange();
    if (!range) return null;
    const before = range.cloneRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    const through = range.cloneRange();
    through.selectNodeContents(element);
    through.setEnd(range.endContainer, range.endOffset);
    return { start: editorText(before.cloneContents()).length, end: editorText(through.cloneContents()).length };
  }

  function placeCaret(offset) {
    const range = document.createRange();
    let remaining = Math.max(0, offset);
    let placed = false;
    for (const node of element.childNodes) {
      const length = editorText(node).length;
      if (remaining <= length) {
        if (node.nodeType === 3) range.setStart(node, Math.min(remaining, node.length));
        else if (remaining === 0) range.setStartBefore(node);
        else range.setStartAfter(node);
        placed = true;
        break;
      }
      remaining -= length;
    }
    if (!placed) { range.selectNodeContents(element); range.collapse(false); }
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function getValue() {
    const body = editorText(element).replace(/\u00a0/g, ' ');
    const { tokens: _tokens, ...mentions } = parseMentionTokens(body);
    return { body, mentions };
  }

  function renderBody(body, caret) {
    const fragment = document.createDocumentFragment();
    for (const part of mentionParts(body, getMentionables())) {
      if (part.kind === 'text') {
        for (const [index, line] of part.text.split('\n').entries()) {
          if (index) fragment.append(document.createElement('br'));
          if (line) fragment.append(document.createTextNode(line));
        }
        continue;
      }
      const chip = document.createElement('span');
      chip.className = `mention-chip mention-chip-${part.kind}`;
      chip.dataset.mentionToken = part.token;
      chip.dataset.mentionKind = part.kind;
      if (part.id) chip.dataset.mentionId = part.id;
      chip.contentEditable = 'false';
      chip.textContent = part.text;
      chip.setAttribute('aria-label', (getLabels().mention || '提及 {name}').replace('{name}', part.name));
      fragment.append(chip);
    }
    // Browsers need a trailing break to place the caret on an empty final line.
    if (!body || body.endsWith('\n')) {
      const tail = document.createElement('br');
      tail.dataset.editorTail = '';
      fragment.append(tail);
    }
    fragment.append(document.createTextNode(''));
    element.replaceChildren(fragment);
    if (caret !== undefined) placeCaret(caret);
  }

  function closeSuggestions() {
    activeQuery = null;
    candidates = [];
    popup.hidden = true;
    popup.replaceChildren();
    element.setAttribute('aria-expanded', 'false');
    element.removeAttribute('aria-activedescendant');
  }

  function publish({ remember = true } = {}) {
    const value = getValue();
    element.dataset.empty = String(!value.body.length);
    if (remember && value.body !== undoStates[undoIndex]?.body) {
      undoStates = undoStates.slice(0, undoIndex + 1);
      undoStates.push({ body: value.body, caret: selectionOffsets()?.end ?? value.body.length });
      if (undoStates.length > 100) undoStates.shift();
      undoIndex = undoStates.length - 1;
    }
    onChange(value);
  }

  function positionPopup() {
    if (popup.hidden) return;
    const range = selectionRange();
    const rectangle = range?.getBoundingClientRect();
    const caret = rectangle?.height ? rectangle : element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const width = Math.min(360, viewportWidth - 16);
    popup.style.position = 'fixed';
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(viewportLeft + 8, Math.min(caret.left, viewportLeft + viewportWidth - width - 8))}px`;
    const above = caret.top - viewportTop - 12;
    const below = viewportTop + viewportHeight - caret.bottom - 12;
    const useAbove = above >= 160 || above >= below;
    popup.style.maxHeight = `${Math.max(80, Math.min(320, useAbove ? above : below))}px`;
    popup.style.top = `${useAbove ? Math.max(viewportTop + 8, caret.top - popup.offsetHeight - 8) : caret.bottom + 8}px`;
  }

  function selectActive(index) {
    if (!candidates.length) return;
    activeIndex = (index + candidates.length) % candidates.length;
    for (const [optionIndex, option] of [...popup.querySelectorAll('[role="option"]')].entries()) {
      option.setAttribute('aria-selected', String(optionIndex === activeIndex));
      option.classList.toggle('selected', optionIndex === activeIndex);
    }
    const selected = popup.querySelectorAll('[role="option"]')[activeIndex];
    element.setAttribute('aria-activedescendant', selected.id);
    selected.scrollIntoView({ block: 'nearest' });
  }

  function showSuggestions(query) {
    const next = mentionCandidates(getMentionables(), query.query);
    if (!next.length) { closeSuggestions(); return; }
    const sameQuery = activeQuery?.start === query.start && activeQuery?.query === query.query;
    activeQuery = query;
    candidates = next;
    if (!sameQuery) activeIndex = 0;
    activeIndex = Math.min(activeIndex, candidates.length - 1);
    popup.replaceChildren();
    for (const [index, item] of candidates.entries()) {
      const option = document.createElement('div');
      option.className = 'mention-suggestion';
      option.id = `${popup.id}-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === activeIndex));
      option.classList.toggle('selected', index === activeIndex);
      const avatar = document.createElement('span');
      avatar.className = `mention-suggestion-avatar ${item.memberKind === 'bot' ? 'is-bot' : ''}`;
      avatar.textContent = item.kind === 'role' ? '@' : item.kind === 'user' ? [...(item.name || item.localpart || '?')][0] : '#';
      avatar.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'mention-suggestion-name';
      label.textContent = item.name || item.localpart || item.id;
      if (item.kind === 'role' && /^#[0-9a-f]{6}$/i.test(item.color || '')) label.style.color = item.color;
      option.append(avatar, label);
      if (item.memberKind === 'bot') {
        const badge = document.createElement('span');
        badge.className = 'mention-suggestion-badge';
        badge.textContent = 'BOT';
        option.append(badge);
      }
      const detail = document.createElement('span');
      detail.className = 'mention-suggestion-detail';
      detail.textContent = getLabels()[item.kind] || item.description || (item.kind === 'role' ? '身份组' : item.localpart || item.id);
      option.append(detail);
      if (item.kind === 'user') {
        const status = document.createElement('span');
        const online = item.online === true || ['online', 'idle', 'thinking', 'busy'].includes(item.status);
        status.className = `mention-suggestion-status ${online ? 'online' : 'offline'}`;
        status.setAttribute('aria-label', online ? getLabels().online || '在线' : getLabels().offline || '离线');
        option.append(status);
      }
      option.addEventListener('pointerdown', event => { event.preventDefault(); choose(item); });
      popup.append(option);
    }
    popup.hidden = false;
    element.setAttribute('aria-expanded', 'true');
    element.setAttribute('aria-activedescendant', `${popup.id}-${activeIndex}`);
    positionPopup();
  }

  function refresh() {
    if (disabled || composing || document.activeElement !== element) { closeSuggestions(); return; }
    const selection = selectionOffsets();
    if (!selection || selection.start !== selection.end) { closeSuggestions(); return; }
    const query = findMentionQuery(getValue().body, selection.end);
    if (!query) { dismissedQuery = null; closeSuggestions(); return; }
    const key = `${query.start}/${query.query}`;
    if (dismissedQuery === key) { closeSuggestions(); return; }
    showSuggestions(query);
  }

  function replaceSelection(text, replacement) {
    const value = getValue();
    const selected = replacement || selectionOffsets() || { start: value.body.length, end: value.body.length };
    const body = value.body.slice(0, selected.start) + text + value.body.slice(selected.end);
    if (body.length > maxLength) {
      element.dispatchEvent(new window.CustomEvent('composer-limit', { bubbles: true, detail: { maxLength } }));
      return false;
    }
    renderBody(body, selected.start + text.length);
    publish();
    return true;
  }

  function choose(item) {
    if (disabled) return;
    const replacement = activeQuery ? { start: activeQuery.start, end: activeQuery.end } : undefined;
    const token = mentionToken(item);
    element.focus();
    replaceSelection(token + ' ', replacement);
    dismissedQuery = null;
    closeSuggestions();
  }

  function restoreUndo(direction) {
    const next = undoIndex + direction;
    if (next < 0 || next >= undoStates.length) return;
    undoIndex = next;
    const state = undoStates[undoIndex];
    renderBody(state.body, state.caret);
    publish({ remember: false });
    closeSuggestions();
  }

  listen(element, 'keydown', event => {
    if (disabled || composing || event.isComposing || event.keyCode === 229) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault(); restoreUndo(event.shiftKey ? 1 : -1); return;
    }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); restoreUndo(1); return; }
    if (!popup.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) && !modifier && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { dismissedQuery = `${activeQuery.start}/${activeQuery.query}`; closeSuggestions(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') selectActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      else choose(candidates[activeIndex]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) { replaceSelection('\n'); refresh(); }
      else { closeSuggestions(); onSubmit(getValue()); }
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const selection = selectionOffsets();
      if (!selection || selection.start !== selection.end) return;
      const token = parseMentionTokens(getValue().body).tokens.find(item => event.key === 'Backspace' ? item.end === selection.start : item.start === selection.end);
      if (token) {
        event.preventDefault();
        replaceSelection('', { start: token.start, end: token.end });
        closeSuggestions();
      }
    }
  });

  listen(element, 'beforeinput', event => {
    if (composing || event.isComposing) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault(); restoreUndo(event.inputType === 'historyUndo' ? -1 : 1);
    }
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault(); replaceSelection('\n');
    }
  });
  function handleInput() {
    if (composing) return;
    const onlyElement = element.childElementCount === 1
      ? element.firstElementChild
      : null;
    // Native deletion can leave a browser placeholder break in an empty editor.
    if (
      onlyElement?.tagName === 'BR' &&
      !onlyElement.hasAttribute('data-editor-tail') &&
      !element.textContent
    ) {
      renderBody('', 0);
    }
    if (getValue().body.length > maxLength) {
      const previous = undoStates[undoIndex];
      renderBody(previous.body, previous.caret);
      element.dispatchEvent(new window.CustomEvent('composer-limit', { bubbles: true, detail: { maxLength } }));
    }
    publish();
    refresh();
  }
  listen(element, 'input', handleInput);
  listen(element, 'compositionstart', () => { composing = true; closeSuggestions(); });
  listen(element, 'compositionend', () => { composing = false; handleInput(); queueMicrotask(refresh); });
  listen(element, 'focus', refresh);
  listen(element, 'blur', closeSuggestions);
  listen(document, 'selectionchange', refresh);
  listen(window, 'resize', positionPopup);
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', positionPopup);
    listen(window.visualViewport, 'scroll', positionPopup);
  }
  listen(element, 'paste', event => {
    if (disabled) return;
    event.preventDefault();
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) onFiles(files);
    const text = event.clipboardData?.getData('application/x-ds-group-message') || event.clipboardData?.getData('text/plain');
    if (text) { replaceSelection(text.replace(/\r\n?/g, '\n')); refresh(); }
  });
  for (const eventName of ['copy', 'cut']) listen(element, eventName, event => {
    const range = selectionRange();
    if (!range || range.collapsed || !event.clipboardData) return;
    event.preventDefault();
    const body = editorText(range.cloneContents());
    event.clipboardData.setData('application/x-ds-group-message', body);
    event.clipboardData.setData('text/plain', mentionParts(body, getMentionables()).map(part => part.text).join(''));
    if (eventName === 'cut' && !disabled) replaceSelection('');
  });
  listen(element, 'dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  listen(element, 'drop', event => {
    if (disabled || !event.dataTransfer) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.files.length) onFiles([...event.dataTransfer.files]);
    const text = event.dataTransfer.getData('application/x-ds-group-message') || event.dataTransfer.getData('text/plain');
    if (text) { replaceSelection(text.replace(/\r\n?/g, '\n')); refresh(); }
  });

  closeSuggestions();
  renderBody('');
  element.dataset.empty = 'true';
  return {
    getValue,
    setValue(value) {
      const body = typeof value === 'string' ? value : value?.body || '';
      renderBody(body);
      undoStates = [{ body, caret: body.length }];
      undoIndex = 0;
      dismissedQuery = null;
      closeSuggestions();
      publish({ remember: false });
    },
    clear() { this.setValue(''); },
    focus() { element.focus(); placeCaret(getValue().body.length); },
    setDisabled(value) {
      disabled = Boolean(value);
      element.contentEditable = String(!disabled);
      element.setAttribute('aria-disabled', String(disabled));
      element.tabIndex = disabled ? -1 : 0;
      if (disabled) closeSuggestions();
    },
    setPlaceholder(text) { element.dataset.placeholder = text; element.setAttribute('aria-placeholder', text); },
    refresh,
    insertMention: choose,
    destroy() { for (const dispose of disposers) dispose(); closeSuggestions(); },
  };
}
