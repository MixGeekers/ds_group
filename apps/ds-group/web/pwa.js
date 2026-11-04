import { t, onLocaleChange } from './i18n.js';

const PUSH_OWNER_KEY = 'ds-group.push-owner';

function decodeApplicationKey(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function deviceName() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  if (/iphone|ipad/i.test(navigator.userAgent)) return 'iPhone / iPad';
  if (/android/i.test(navigator.userAgent)) return 'Android';
  return platform || t('pwa.browser');
}

export function initializePwa({ request, getSession, onOpenRoom }) {
  const $ = id => document.getElementById(id);
  const state = {
    registration: null,
    registrationError: null,
    config: null,
    subscription: null,
    busy: false,
    deferredInstall: null,
    feedback: null,
    installFeedback: null,
  };
  const supported = () => window.isSecureContext && 'serviceWorker' in navigator
    && 'PushManager' in window && 'Notification' in window;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const owned = () => Boolean(getSession() && state.subscription
    && localStorage.getItem(PUSH_OWNER_KEY) === getSession().user_id);

  function setFeedback(key, params = {}) {
    state.feedback = key ? { key, params } : null;
    $('push-feedback').textContent = key ? t(key, params) : '';
  }

  function renderInstall() {
    $('offline-status').textContent = navigator.onLine ? t('pwa.online') : t('pwa.offlinePending');
    $('install-app').disabled = standalone();
    $('install-status').textContent = standalone() ? t('pwa.installed') : t('pwa.browserMode');
    if (standalone()) $('install-help').textContent = '';
    else if (state.installFeedback) $('install-help').textContent = t(state.installFeedback);
    else if (state.deferredInstall) $('install-help').textContent = t('pwa.installAvailable');
    else if (/iphone|ipad/i.test(navigator.userAgent)) $('install-help').textContent = t('pwa.installSafari');
    else $('install-help').textContent = t('pwa.installMenu');
  }

  function renderNotifications() {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    let status;
    if (!window.isSecureContext) status = t('pwa.httpsRequired');
    else if (!supported()) status = t('pwa.pushUnsupported');
    else if (!getSession()) status = t('pwa.signInNotifications');
    else if (permission === 'denied') status = t('pwa.permissionDenied');
    else if (state.registrationError) status = t('pwa.serviceError', { error: state.registrationError.code === 'SERVICE_WORKER_TIMEOUT'
      ? t('pwa.serviceTimeout') : state.registrationError.message });
    else if (!state.registration) status = t('pwa.preparingService');
    else if (!state.config) status = t('pwa.loadingPushConfig');
    else if (!state.config.enabled) status = t('pwa.pushDisabled');
    else if (owned()) status = t('pwa.notificationsEnabled', { userId: getSession().user_id });
    else if (state.subscription) status = t('pwa.existingSubscription');
    else status = t('pwa.notSubscribed');
    $('push-status').textContent = status;
    $('enable-push').disabled = state.busy || !supported() || !getSession() || !state.registration
      || !state.config?.enabled || !state.config?.publicKey || permission === 'denied' || owned();
    $('enable-push').textContent = state.busy ? t('pwa.working') : t('pwa.enableNotifications');
    $('disable-push').hidden = !owned();
    $('disable-push').disabled = state.busy;
    $('test-push').disabled = state.busy || !owned() || permission !== 'granted';
  }

  async function registerServiceWorker() {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      state.registration = registration.active ? registration : await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Service worker startup timed out'), { code: 'SERVICE_WORKER_TIMEOUT' })), 15000)),
      ]);
      state.registrationError = null;
    } catch (error) {
      state.registrationError = error;
    }
    renderNotifications();
  }

  const ready = registerServiceWorker();

  async function refresh() {
    renderInstall();
    await ready;
    const results = await Promise.allSettled([
      request('/api/push/config', { auth: false }),
      supported() && state.registration ? state.registration.pushManager.getSubscription() : null,
    ]);
    if (results[0].status === 'fulfilled') state.config = results[0].value;
    else {
      state.config = null;
      setFeedback('pwa.error', { error: results[0].reason.message });
    }
    if (results[1].status === 'fulfilled') state.subscription = results[1].value;
    else setFeedback('pwa.error', { error: results[1].reason.message });
    renderNotifications();
  }

  async function enableNotifications() {
    if (state.busy || !supported() || !getSession() || !state.registration || !state.config?.enabled) return;
    state.busy = true;
    setFeedback(null);
    let newlyCreated = false;
    try {
      // Keep the permission request directly inside the explicit click gesture.
      const permission = Notification.permission === 'granted'
        ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') {
        setFeedback(permission === 'denied' ? 'pwa.permissionNotGranted' : 'pwa.enableCancelled');
        return;
      }
      renderNotifications();
      let subscription = await state.registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await state.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeApplicationKey(state.config.publicKey),
        });
        newlyCreated = true;
      }
      state.subscription = subscription;
      await request('/api/push/subscriptions', {
        method: 'POST',
        body: { subscription: subscription.toJSON(), deviceLabel: $('push-device-label').value.trim() || deviceName() },
      });
      localStorage.setItem(PUSH_OWNER_KEY, getSession().user_id);
      setFeedback('pwa.subscribed');
    } catch (error) {
      if (newlyCreated && state.subscription) {
        try { await state.subscription.unsubscribe(); state.subscription = null; }
        catch { /* The next refresh reports the remaining browser subscription. */ }
      }
      setFeedback('pwa.enableFailed', { error: error.message });
    } finally {
      state.busy = false;
      renderNotifications();
    }
  }

  async function removeCurrentSubscription() {
    if (!state.subscription || !getSession()) return;
    await request('/api/push/subscriptions', { method: 'DELETE', body: { endpoint: state.subscription.endpoint } });
    await state.subscription.unsubscribe();
    state.subscription = null;
    localStorage.removeItem(PUSH_OWNER_KEY);
  }

  async function disableNotifications() {
    if (state.busy || !owned()) return;
    state.busy = true;
    renderNotifications();
    try {
      await removeCurrentSubscription();
      setFeedback('pwa.disabled');
    } catch (error) {
      setFeedback('pwa.disableFailed', { error: error.message });
    } finally {
      state.busy = false;
      renderNotifications();
    }
  }

  async function beforeIdentityChange(nextUserId) {
    if (getSession()?.user_id === nextUserId) return;
    if (!getSession() || localStorage.getItem(PUSH_OWNER_KEY) !== getSession().user_id) return;
    await ready;
    if (supported() && state.registration) state.subscription = await state.registration.pushManager.getSubscription();
    if (owned()) await removeCurrentSubscription();
    renderNotifications();
  }

  async function testNotification() {
    if (state.busy || !owned()) return;
    state.busy = true;
    renderNotifications();
    try {
      await request('/api/push/test', { method: 'POST', body: {} });
      setFeedback('pwa.testSubmitted');
    } catch (error) {
      setFeedback('pwa.testFailed', { error: error.message });
    } finally {
      state.busy = false;
      renderNotifications();
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstall = event;
    renderInstall();
  });
  window.addEventListener('appinstalled', () => { state.deferredInstall = null; renderInstall(); });
  window.addEventListener('online', renderInstall);
  window.addEventListener('offline', renderInstall);
  window.matchMedia('(display-mode: standalone)').addEventListener('change', renderInstall);
  $('install-app').addEventListener('click', async () => {
    if (!state.deferredInstall) { renderInstall(); return; }
    const prompt = state.deferredInstall;
    state.deferredInstall = null;
    await prompt.prompt();
    const result = await prompt.userChoice;
    state.installFeedback = result.outcome === 'accepted' ? 'pwa.installSubmitted' : 'pwa.installCancelled';
    renderInstall();
  });
  $('refresh-app').addEventListener('click', () => location.reload());
  $('enable-push').addEventListener('click', () => void enableNotifications());
  $('disable-push').addEventListener('click', () => void disableNotifications());
  $('test-push').addEventListener('click', () => void testNotification());
  $('push-device-label').value = deviceName();
  onLocaleChange(() => {
    renderInstall();
    renderNotifications();
    if (state.feedback) $('push-feedback').textContent = t(state.feedback.key, state.feedback.params);
  });
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'ds-group:open-room') void onOpenRoom(event.data);
  });
  renderInstall();
  renderNotifications();
  return { refresh, beforeIdentityChange };
}
