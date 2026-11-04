const PUSH_OWNER_KEY = 'ds-group.push-owner';

function decodeApplicationKey(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function deviceName() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  if (/iphone|ipad/i.test(navigator.userAgent)) return 'iPhone / iPad';
  if (/android/i.test(navigator.userAgent)) return 'Android';
  return platform || '浏览器';
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
  };
  const supported = () => window.isSecureContext && 'serviceWorker' in navigator
    && 'PushManager' in window && 'Notification' in window;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const owned = () => Boolean(getSession() && state.subscription
    && localStorage.getItem(PUSH_OWNER_KEY) === getSession().user_id);

  function renderInstall() {
    $('offline-status').textContent = navigator.onLine ? '在线' : '离线 · 待确认消息已保留';
    $('install-app').disabled = standalone();
    $('install-status').textContent = standalone() ? '已安装' : '浏览器模式';
    if (standalone()) $('install-help').textContent = '';
    else if (state.deferredInstall) $('install-help').textContent = '安装后可从桌面或主屏幕打开。';
    else if (/iphone|ipad/i.test(navigator.userAgent)) $('install-help').textContent = '在 Safari 中点“分享 → 添加到主屏幕”。';
    else $('install-help').textContent = '可通过浏览器菜单中的“安装应用”或“添加到主屏幕”安装。';
  }

  function renderNotifications() {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    let status;
    if (!window.isSecureContext) status = '此地址需要 HTTPS 才能启用通知。';
    else if (!supported()) status = '当前浏览器不支持推送通知。';
    else if (!getSession()) status = '登录后可设置此设备的通知。';
    else if (permission === 'denied') status = '通知权限已关闭，请在浏览器或系统设置中允许通知。';
    else if (state.registrationError) status = `应用服务尚未就绪。${state.registrationError}`;
    else if (!state.registration) status = '正在准备应用服务';
    else if (!state.config) status = '正在读取服务器通知配置';
    else if (!state.config.enabled) status = '服务器尚未启用推送通知。';
    else if (owned()) status = `已为 ${getSession().user_id} 开启此设备通知。`;
    else if (state.subscription) status = '此设备已有订阅，点击开启以绑定当前账号。';
    else status = '此设备尚未订阅通知。';
    $('push-status').textContent = status;
    $('enable-push').disabled = state.busy || !supported() || !getSession() || !state.registration
      || !state.config?.enabled || !state.config?.publicKey || permission === 'denied' || owned();
    $('enable-push').textContent = state.busy ? '处理中' : '开启通知';
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('应用服务启动超时')), 15000)),
      ]);
      state.registrationError = null;
    } catch (error) {
      state.registrationError = error.message;
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
      $('push-feedback').textContent = results[0].reason.message;
    }
    if (results[1].status === 'fulfilled') state.subscription = results[1].value;
    else $('push-feedback').textContent = results[1].reason.message;
    renderNotifications();
  }

  async function enableNotifications() {
    if (state.busy || !supported() || !getSession() || !state.registration || !state.config?.enabled) return;
    state.busy = true;
    $('push-feedback').textContent = '';
    let newlyCreated = false;
    try {
      // Keep the permission request directly inside the explicit click gesture.
      const permission = Notification.permission === 'granted'
        ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') {
        $('push-feedback').textContent = permission === 'denied' ? '通知权限未获允许。' : '已取消开启通知。';
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
      $('push-feedback').textContent = '此设备已订阅。可以发送一次测试通知。';
    } catch (error) {
      if (newlyCreated && state.subscription) {
        try { await state.subscription.unsubscribe(); state.subscription = null; }
        catch { /* The next refresh reports the remaining browser subscription. */ }
      }
      $('push-feedback').textContent = `开启失败。${error.message}`;
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
      $('push-feedback').textContent = '此设备通知已关闭。';
    } catch (error) {
      $('push-feedback').textContent = `关闭失败。${error.message}`;
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
      $('push-feedback').textContent = '测试通知已提交，请查看系统通知。';
    } catch (error) {
      $('push-feedback').textContent = `测试通知提交失败。${error.message}`;
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
    $('install-help').textContent = result.outcome === 'accepted' ? '已提交安装。' : '已取消安装。';
    renderInstall();
  });
  $('refresh-app').addEventListener('click', () => location.reload());
  $('enable-push').addEventListener('click', () => void enableNotifications());
  $('disable-push').addEventListener('click', () => void disableNotifications());
  $('test-push').addEventListener('click', () => void testNotification());
  $('push-device-label').value = deviceName();
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'ds-group:open-room') void onOpenRoom(event.data);
  });
  renderInstall();
  renderNotifications();
  return { refresh, beforeIdentityChange };
}
