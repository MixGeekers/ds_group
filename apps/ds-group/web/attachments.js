import { t, formatFileSize, onLocaleChange } from './i18n.js';
import { createActionIcon, createFileIcon } from './src/icons.ts';

export { formatFileSize } from './i18n.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function attachmentPreviewKind(attachment) {
  const mime = String(attachment?.mimeType || '').split(';')[0].toLowerCase();
  if (SAFE_IMAGE_TYPES.has(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (TEXT_TYPES.has(mime)) return 'text';
  return null;
}

function fileTypeLabel(attachment) {
  const extension = String(attachment.name || '').split('.').at(-1);
  if (extension && extension !== attachment.name && extension.length <= 8) return extension.toUpperCase();
  if (attachmentPreviewKind(attachment) === 'image') return t('files.image');
  return t('files.file');
}

function fileSymbol(attachment) {
  const kind = attachmentPreviewKind(attachment);
  const symbol = createFileIcon(attachment);
  symbol.classList.add('attachment-file-icon');
  if (kind) symbol.classList.add(`attachment-type-${kind}`);
  return symbol;
}

function button(icon, title, action, className = 'attachment-action') {
  const control = node('button', className);
  control.append(createActionIcon(icon));
  control.type = 'button';
  control.title = title;
  control.setAttribute('aria-label', title);
  control.addEventListener('click', action);
  return control;
}

function validDescriptor(value) {
  return value && typeof value.id === 'string' && value.id
    && typeof value.name === 'string' && Number.isFinite(value.size)
    && value.size >= 0 && typeof value.mimeType === 'string';
}

/** Uploads remain associated with their account and room while the user navigates. */
export function createAttachmentManager({ container, input, getSession, onChange = () => {}, onError = () => {},
  maxBytes = DEFAULT_MAX_BYTES, maxFiles = 10 } = {}) {
  const drafts = new Map();
  let context = '';
  let disabled = false;
  let destroyed = false;

  function recordError(record) {
    return record.errorKey ? t(record.errorKey, record.errorParams) : record.error || null;
  }

  function currentDraft() {
    if (!drafts.has(context)) drafts.set(context, []);
    return drafts.get(context);
  }

  function publicState(record) {
    return { uploadId: record.uploadId, name: record.name, mimeType: record.mimeType, size: record.size,
      status: record.status, progress: record.progress, error: recordError(record), attachment: record.attachment || null };
  }

  function notify(recordContext = context) {
    if (destroyed || recordContext !== context) return;
    render();
    onChange(currentDraft().map(publicState));
  }

  function releaseRecord(record) {
    record.removed = true;
    record.xhr?.abort();
    if (record.previewUrl) URL.revokeObjectURL(record.previewUrl);
    record.previewUrl = null;
    record.file = null;
  }

  function remove(record) {
    if (disabled) return;
    const records = drafts.get(record.context);
    const index = records?.indexOf(record) ?? -1;
    if (index >= 0) records.splice(index, 1);
    releaseRecord(record);
    notify(record.context);
  }

  function upload(record) {
    if (disabled || destroyed || record.removed || !record.file || record.status === 'uploading') return;
    const session = getSession();
    if (!session?.access_token || session.user_id !== record.userId) {
      record.status = 'failed';
      record.errorKey = 'files.returnToAccount';
      record.errorParams = {};
      notify(record.context);
      return;
    }
    record.status = 'uploading';
    record.progress = 0;
    record.error = null;
    record.errorKey = null;
    const xhr = new XMLHttpRequest();
    record.xhr = xhr;
    xhr.open('POST', `/api/attachments?filename=${encodeURIComponent(record.name)}`);
    xhr.timeout = 5 * 60 * 1000;
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('Content-Type', record.mimeType || 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Id', record.uploadId);

    function failed(message, status = 'failed') {
      if (record.removed || record.xhr !== xhr) return;
      record.xhr = null;
      record.status = status;
      record.error = typeof message === 'string' ? message : null;
      record.errorKey = typeof message === 'object' ? message.key : null;
      record.errorParams = typeof message === 'object' ? message.params || {} : {};
      notify(record.context);
    }

    xhr.upload.addEventListener('progress', event => {
      if (record.removed || record.xhr !== xhr) return;
      record.progress = event.lengthComputable ? Math.min(99, Math.round(event.loaded / event.total * 100)) : 0;
      notify(record.context);
    });
    xhr.addEventListener('load', () => {
      if (record.removed || record.xhr !== xhr) return;
      let result;
      try { result = JSON.parse(xhr.responseText); }
      catch { failed({ key: 'files.unreadableReceipt' }); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        failed(typeof result.error === 'string' ? result.error : { key: 'files.uploadHttpError', params: { status: xhr.status } });
        return;
      }
      if (!validDescriptor(result.attachment)) { failed({ key: 'files.incompleteReceipt' }); return; }
      record.xhr = null;
      record.attachment = result.attachment;
      record.progress = 100;
      record.status = 'ready';
      notify(record.context);
    });
    xhr.addEventListener('error', () => failed({ key: 'files.networkInterrupted' }));
    xhr.addEventListener('timeout', () => failed({ key: 'files.uploadTimeout' }));
    xhr.addEventListener('abort', () => failed({ key: 'files.uploadCancelled' }, 'cancelled'));
    xhr.send(record.file);
    notify(record.context);
  }

  function render() {
    const records = currentDraft();
    container.hidden = records.length === 0;
    container.replaceChildren(...records.map(record => {
      const card = node('div', `attachment-draft attachment-draft-${record.status}`);
      card.dataset.uploadId = record.uploadId;
      if (record.previewUrl) {
        const image = node('img', 'attachment-draft-image');
        image.src = record.previewUrl;
        image.alt = '';
        card.append(image);
      } else card.append(fileSymbol(record));
      const information = node('div', 'attachment-draft-info');
      const name = node('strong', 'attachment-name', record.name);
      name.title = record.name;
      information.append(name);
      const status = record.status === 'ready' ? formatFileSize(record.size)
        : record.status === 'uploading' ? `${record.progress}% · ${formatFileSize(record.size)}`
          : recordError(record) || t('files.waitingUpload');
      information.append(node('span', 'attachment-status', status));
      if (record.status === 'uploading') {
        const progress = node('progress', 'attachment-upload-progress');
        progress.max = 100;
        progress.value = record.progress;
        progress.setAttribute('aria-label', t('files.uploadProgress', { name: record.name }));
        information.append(progress);
      }
      card.append(information);
      const actions = node('div', 'attachment-draft-actions');
      if (record.status === 'uploading') {
        const cancel = button('stop', t('files.cancelUpload', { name: record.name }), () => record.xhr?.abort());
        cancel.disabled = disabled;
        actions.append(cancel);
      }
      if (['failed', 'cancelled'].includes(record.status) && record.file) {
        const retry = button('retry', t('files.retryUpload', { name: record.name }), () => upload(record));
        retry.disabled = disabled;
        actions.append(retry);
      }
      const removeButton = button('close', t('files.remove', { name: record.name }), () => remove(record));
      removeButton.disabled = disabled;
      actions.append(removeButton);
      card.append(actions);
      return card;
    }));
  }

  function addFiles(files) {
    if (disabled || destroyed) return;
    const session = getSession();
    if (!session?.access_token) { onError(t('files.signInUpload')); return; }
    const records = currentDraft();
    for (const file of Array.from(files || [])) {
      if (!(file instanceof Blob) || typeof file.name !== 'string') continue;
      if (file.size > maxBytes) { onError(t('files.sizeLimit', { name: file.name, size: formatFileSize(maxBytes) })); continue; }
      if (records.length >= maxFiles) { onError(t('files.countLimit', { count: maxFiles })); break; }
      const duplicate = records.some(record => record.file === file);
      if (duplicate) continue;
      const record = { context, userId: session.user_id, uploadId: crypto.randomUUID(), file,
        name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size,
        status: 'queued', progress: 0, error: null, attachment: null, removed: false };
      if (SAFE_IMAGE_TYPES.has(record.mimeType)) record.previewUrl = URL.createObjectURL(file);
      records.push(record);
      upload(record);
    }
    notify();
  }

  function restore(descriptors) {
    const records = currentDraft();
    for (const attachment of descriptors || []) {
      if (!validDescriptor(attachment) || records.some(record => record.attachment?.id === attachment.id)) continue;
      records.push({ context, userId: getSession()?.user_id, uploadId: `restored-${attachment.id}`,
        name: attachment.name, mimeType: attachment.mimeType, size: attachment.size,
        attachment, status: 'ready', progress: 100, removed: false });
    }
    notify();
  }

  function clear() {
    for (const record of currentDraft()) releaseRecord(record);
    drafts.set(context, []);
    notify();
  }

  function cancelAll() {
    for (const records of drafts.values()) for (const record of records) record.xhr?.abort();
  }

  function onInputChange() {
    addFiles(input.files);
    input.value = '';
  }
  input?.addEventListener('change', onInputChange);
  const stopLocaleUpdates = onLocaleChange(() => { if (!destroyed) render(); });

  return {
    addFiles,
    getReady: () => currentDraft().filter(record => record.status === 'ready').map(record => record.attachment),
    getState: () => currentDraft().map(publicState),
    hasPending: () => currentDraft().some(record => record.status !== 'ready'),
    exportDraft: () => currentDraft().filter(record => record.status === 'ready').map(record => record.attachment),
    restore,
    clear,
    cancelAll,
    setLimits(limits) {
      if (Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0) maxBytes = limits.maxBytes;
      if (Number.isSafeInteger(limits.maxFiles) && limits.maxFiles > 0) maxFiles = limits.maxFiles;
    },
    setContext(key) { context = String(key || ''); notify(); },
    setDisabled(value) { disabled = Boolean(value); if (input) input.disabled = disabled; render(); },
    destroy() {
      destroyed = true;
      stopLocaleUpdates();
      for (const records of drafts.values()) for (const record of records) releaseRecord(record);
      drafts.clear();
      input?.removeEventListener('change', onInputChange);
      container.replaceChildren();
    },
  };
}

/** A message attachment loads its bytes with the current account's credential. */
export function renderAttachmentCard(attachment, { getSession, onPreview, onError = () => {} } = {}) {
  const card = node('article', 'attachment-card');
  card.dataset.attachmentId = attachment.id;
  const controller = new AbortController();
  const objectUrls = new Set();
  const revokeTimers = new Set();
  const kind = attachmentPreviewKind(attachment);
  let loadedBlob;
  let loadedForUser;
  let pendingBlob;
  let disposed = false;
  let busy = false;

  async function loadBlob() {
    const session = getSession();
    if (!session?.access_token) throw new Error(t('files.signInDownload'));
    if (loadedBlob && loadedForUser === session.user_id) return loadedBlob;
    if (pendingBlob) return pendingBlob;
    pendingBlob = (async () => {
      const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000)]),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(typeof result?.error === 'string' ? result.error : t('files.readHttpError', { status: response.status }));
      }
      const blob = await response.blob();
      if (getSession()?.user_id !== session.user_id) throw new Error(t('files.accountChanged'));
      loadedBlob = blob;
      loadedForUser = session.user_id;
      return loadedBlob;
    })();
    try { return await pendingBlob; }
    finally { pendingBlob = null; }
  }

  const information = node('div', 'attachment-info');
  const title = node('strong', 'attachment-name', attachment.name);
  title.title = attachment.name;
  const metadata = node('span', 'attachment-meta');
  const symbol = fileSymbol(attachment);
  information.append(title, metadata);
  card.append(symbol, information);
  const actions = node('div', 'attachment-actions');
  card.append(actions);

  async function perform(action) {
    if (busy || disposed) return;
    busy = true;
    card.setAttribute('aria-busy', 'true');
    for (const control of actions.querySelectorAll('button')) control.disabled = true;
    try { await action(await loadBlob()); }
    catch (error) { if (!disposed && error.name !== 'AbortError') onError(error.message); }
    finally {
      busy = false;
      card.removeAttribute('aria-busy');
      for (const control of actions.querySelectorAll('button')) control.disabled = false;
    }
  }

  function preview() {
    return perform(async blob => {
      const url = URL.createObjectURL(blob);
      const dispose = () => URL.revokeObjectURL(url);
      try { await onPreview({ url, attachment, kind, dispose }); }
      catch (error) { dispose(); throw error; }
    });
  }

  const previewButton = kind && onPreview ? button('preview', '', () => void preview()) : null;
  if (previewButton) actions.append(previewButton);
  const downloadButton = button('download', '', () => void perform(async blob => {
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const link = node('a');
    link.href = url;
    link.download = attachment.name || 'download';
    document.body.append(link);
    link.click();
    link.remove();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url); revokeTimers.delete(timer); }, 30_000);
    revokeTimers.add(timer);
  }));
  actions.append(downloadButton);

  let thumbnail;
  let thumbnailFailed = false;

  function renderLabels() {
    if (disposed) return;
    metadata.textContent = `${fileTypeLabel(attachment)} · ${formatFileSize(attachment.size)}`;
    const previewLabel = t('files.previewNamed', { name: attachment.name });
    if (previewButton) {
      previewButton.title = previewLabel;
      previewButton.setAttribute('aria-label', previewLabel);
    }
    const downloadLabel = t('files.downloadNamed', { name: attachment.name });
    downloadButton.title = downloadLabel;
    downloadButton.setAttribute('aria-label', downloadLabel);
    thumbnail?.setAttribute('aria-label', previewLabel);
    if (thumbnailFailed) card.title = t('files.previewFailed');
  }

  if (kind === 'image') {
    thumbnail = node('button', 'attachment-image-button');
    thumbnail.type = 'button';
    const image = node('img', 'attachment-image');
    image.alt = attachment.name;
    image.loading = 'lazy';
    thumbnail.append(image);
    if (onPreview) thumbnail.addEventListener('click', () => void preview());
    else thumbnail.disabled = true;
    card.prepend(thumbnail);
    card.classList.add('attachment-card-image');
    void loadBlob().then(blob => {
      if (disposed) return;
      const url = URL.createObjectURL(blob);
      objectUrls.add(url);
      image.src = url;
    }).catch(error => {
      if (!disposed && error.name !== 'AbortError') {
        thumbnail.remove();
        card.classList.remove('attachment-card-image');
        thumbnailFailed = true;
        card.title = t('files.previewFailed');
      }
    });
  }
  const stopLocaleUpdates = onLocaleChange(renderLabels);
  renderLabels();

  card.dispose = () => {
    if (disposed) return;
    disposed = true;
    stopLocaleUpdates();
    controller.abort();
    for (const timer of revokeTimers) clearTimeout(timer);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    loadedBlob = null;
  };
  return card;
}
