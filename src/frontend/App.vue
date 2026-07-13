<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

const TOKEN_KEY = 'rdhx-email-session';
const INBOX_KEY = 'rdhx-email-inboxes';

const state = reactive({
  config: { accessMode: 'public', privacyLock: false, messageRetentionDays: 1, retentionDays: 1 },
  health: null,
  domains: [],
  session: null,
  inboxes: [],
  ownedInboxes: [],
  activeInboxId: '',
  activeOwnedInboxId: '',
  messages: [],
  activeMessage: null,
  attachments: [],
  source: '',
  users: [],
  apiKeys: [],
  apiKeyRequests: [],
  adminApiKeyRequests: [],
  notice: '',
  error: '',
  loading: false,
  route: 'inbox'
});

const loginForm = reactive({ username: '', password: '' });
const inboxForm = reactive({ mode: 'random', localPart: '', domain: '' });
const userForm = reactive({ username: '', password: '', role: 'member' });
const passwordResetForm = reactive({ userId: '', password: '' });
const keyForm = reactive({ ownerUserId: '', name: '' });
const keyRequestForm = reactive({ reason: '' });
const settingsForm = reactive({ accessMode: 'public' });
const adminRejectReasons = reactive({});
const revealedKey = ref('');
const revealedRequestedKey = ref('');
const mobileMenuOpen = ref(false);
const userStatusFilter = ref('active');
const apiKeyStatusFilter = ref('active');
const NOTICE_DURATION_MS = 4000;
const ERROR_DURATION_MS = 5000;
let toastTimer = null;

const isAdmin = computed(() => state.session?.user?.role === 'admin');
const isMember = computed(() => state.session?.user?.role === 'member');
const activeAdminCount = computed(() => state.users.filter((user) => user.role === 'admin' && user.status === 'active').length);
const activeApiKeyOwners = computed(() => state.users.filter((user) => user.status === 'active'));
const isPrivateLocked = computed(() => state.config.accessMode === 'private' && !state.session);
const activeInbox = computed(() => state.inboxes.find((inbox) => inbox.id === state.activeInboxId) || null);
const activeDashboardInbox = computed(() => state.ownedInboxes.find((inbox) => inbox.id === state.activeOwnedInboxId) || null);
const domainsText = computed(() => state.domains.length ? state.domains.join(', ') : 'No active domains loaded');
const docsBaseUrl = computed(() => window.location.origin);
const privacyLockFooterText = computed(() => state.config.privacyLock
  ? 'Privacy Lock enabled — admins cannot inspect inboxes or messages.'
  : 'Privacy Lock disabled — admin inspection may be available.');
const toastMessage = computed(() => state.error || state.notice);
const filteredUsers = computed(() => userStatusFilter.value === 'all'
  ? state.users
  : state.users.filter((user) => user.status === userStatusFilter.value));
const filteredApiKeys = computed(() => apiKeyStatusFilter.value === 'all'
  ? state.apiKeys
  : state.apiKeys.filter((key) => key.status === apiKeyStatusFilter.value));
const SESSION_EXPIRED_MESSAGE = 'Session expired. Please sign in again.';
const ADDRESS_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function iconPath(name) {
  return {
    inbox: 'M4 5.5h16v13H4z M4 7l8 6 8-6',
    lock: 'M7 10V8a5 5 0 0 1 10 0v2 M6 10h12v9H6z',
    users: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 19a5 5 0 0 1 10 0 M17 10a2.5 2.5 0 1 0 0-5 M15 19a4 4 0 0 1 6 0',
    key: 'M14 7a4 4 0 1 0-2.7 3.8L4 18v2h3l1-1h2v-2h2l2.7-2.7A4 4 0 0 0 14 7z',
    status: 'M4 12h4l2-7 4 14 2-7h4',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v3 M12 19v3 M4.9 4.9 7 7 M17.1 17.1l2 2 M2 12h3 M19 12h3',
    mail: 'M3 6h18v12H3z M3 7l9 7 9-7',
    source: 'M8 8 4 12l4 4 M16 8l4 4-4 4 M14 5l-4 14'
  }[name] || 'M5 12h14';
}

function clearToastTimer() {
  if (!toastTimer) return;
  clearTimeout(toastTimer);
  toastTimer = null;
}

function scheduleToastDismiss(duration) {
  clearToastTimer();
  toastTimer = setTimeout(() => {
    dismissToast();
    toastTimer = null;
  }, duration);
}

function dismissToast() {
  state.notice = '';
  state.error = '';
  clearToastTimer();
}

function setNotice(message) {
  state.notice = message;
  state.error = '';
  if (message) scheduleToastDismiss(NOTICE_DURATION_MS);
  else clearToastTimer();
}

function setError(error) {
  const message = error?.message
    || error?.error?.message
    || error?.code
    || error?.error?.code
    || (typeof error?.error === 'string' ? error.error : '')
    || (typeof error === 'string' ? error : 'Request failed');
  state.error = message === 'Inbox address already exists'
    ? 'Address is unavailable. Try another address.'
    : message;
  state.notice = '';
  scheduleToastDismiss(ERROR_DURATION_MS);
}

function loadSavedState() {
  try { state.session = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { state.session = null; }
  try { state.inboxes = JSON.parse(localStorage.getItem(INBOX_KEY) || '[]'); } catch { state.inboxes = []; }
  state.activeInboxId = state.inboxes[0]?.id || '';
}

function saveInboxes() {
  localStorage.setItem(INBOX_KEY, JSON.stringify(state.inboxes));
}

function normalizeAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : '';
}

function addressFromCurrentPath() {
  const pathname = window.location.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!pathname || pathname.startsWith('api/')) return '';
  try {
    return normalizeAddress(decodeURIComponent(pathname));
  } catch {
    return '';
  }
}

function addressRouteId(address) {
  return `address:${address}`;
}

function addressPlaceholder(address) {
  const [localPart, domain] = address.split('@');
  return {
    id: addressRouteId(address),
    address,
    localPart,
    domain,
    status: 'active',
    addressRoute: true
  };
}

function setInboxAddressUrl(address, replace = false) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) return;
  const nextPath = `/${encodeURIComponent(normalizedAddress)}`;
  if (window.location.pathname === nextPath) return;
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', nextPath);
}

function findInboxByAddress(address) {
  const normalizedAddress = normalizeAddress(address);
  return state.inboxes.find((inbox) => normalizeAddress(inbox.address) === normalizedAddress) || null;
}

function currentMessageInbox() {
  return state.route === 'dashboard' ? activeDashboardInbox.value : activeInbox.value;
}

function currentMessageHeaders(inbox) {
  if (state.route === 'dashboard') return authHeaders();
  if (state.session) return authHeaders();
  return inbox?.inboxToken ? { 'x-inbox-token': inbox.inboxToken } : authHeaders();
}

function hasAuthorizationHeader(headers = {}) {
  if (headers instanceof Headers) return headers.has('authorization');
  return Boolean(headers.Authorization || headers.authorization);
}

function handleExpiredSession() {
  state.session = null;
  state.users = [];
  state.apiKeys = [];
  state.apiKeyRequests = [];
  state.adminApiKeyRequests = [];
  state.ownedInboxes = [];
  state.activeOwnedInboxId = '';
  state.messages = [];
  state.activeMessage = null;
  state.attachments = [];
  state.source = '';
  localStorage.removeItem(TOKEN_KEY);
  state.route = 'login';
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.session?.token) headers.Authorization = `Bearer ${state.session.token}`;
  return headers;
}

function isCurrentSessionUser(user) {
  return Boolean(user?.id && user.id === state.session?.user?.id);
}

function isLastActiveAdmin(user) {
  return user?.role === 'admin' && user.status === 'active' && activeAdminCount.value <= 1;
}

async function api(path, options = {}) {
  const headers = {
    accept: 'application/json',
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    ...options,
    headers
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && hasAuthorizationHeader(headers)) {
      handleExpiredSession();
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    const errorMessage = payload?.error?.message
      || payload?.message
      || payload?.error?.code
      || (typeof payload?.error === 'string' ? payload.error : '')
      || `Request failed with ${response.status}`;
    const error = new Error(errorMessage);
    error.status = response.status;
    error.code = payload?.error?.code || '';
    throw error;
  }
  return payload;
}

async function withLoading(task) {
  state.loading = true;
  try { return await task(); } catch (error) { setError(error); return null; } finally { state.loading = false; }
}

async function loadBasics() {
  await withLoading(async () => {
    const [config, health, domains] = await Promise.all([api('/api/config'), api('/api/health'), api('/api/domains')]);
    state.config = config;
    state.health = health;
    state.domains = domains.domains || [];
    inboxForm.domain = state.domains[0] || '';
    settingsForm.accessMode = config.accessMode || 'public';
  });
}

async function login() {
  await withLoading(async () => {
    const session = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(loginForm) });
    state.session = session;
    localStorage.setItem(TOKEN_KEY, JSON.stringify(session));
    loginForm.password = '';
    state.route = 'dashboard';
    setNotice(`Signed in as ${session.user.username}`);
    if (session.user.role === 'admin') await loadAdminData();
    await loadApiKeyRequests();
    await loadOwnedInboxes();
  });
}

async function logout() {
  mobileMenuOpen.value = false;
  await withLoading(async () => {
    if (state.session?.token) await api('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    state.session = null;
    state.users = [];
    state.apiKeys = [];
    state.apiKeyRequests = [];
    state.adminApiKeyRequests = [];
    state.ownedInboxes = [];
    state.activeOwnedInboxId = '';
    state.messages = [];
    state.activeMessage = null;
    state.attachments = [];
    state.source = '';
    localStorage.removeItem(TOKEN_KEY);
    state.route = 'login';
    setNotice('Signed out.');
  });
}

async function createInbox() {
  await withLoading(async () => {
    const body = { domain: inboxForm.domain || state.domains[0] };
    const localPart = inboxForm.localPart.trim();
    if (inboxForm.mode === 'custom' || localPart) body.localPart = localPart;
    const payload = await api('/api/inboxes', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    const record = {
      ...payload.inbox,
      ...(!state.session && payload.inboxToken ? { inboxToken: payload.inboxToken } : {}),
      addressRoute: Boolean(payload.openedExisting && !payload.inboxToken)
    };
    state.inboxes = [record, ...state.inboxes.filter((inbox) => inbox.id !== record.id)];
    state.activeInboxId = record.id;
    if (state.session && !payload.openedExisting) {
      state.ownedInboxes = [payload.inbox, ...state.ownedInboxes.filter((inbox) => inbox.id !== payload.inbox.id)];
      state.activeOwnedInboxId = payload.inbox.id;
    }
    inboxForm.localPart = '';
    saveInboxes();
    setInboxAddressUrl(record.address);
    await loadMessages();
    setNotice(payload.openedExisting ? 'Inbox opened.' : `Inbox ${record.address} is ready. Store the inbox token if you need another client.`);
  });
}

async function copyActiveAddress() {
  const address = activeInbox.value?.address;
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    setNotice('Email address copied.');
  } catch (error) {
    setError(error);
  }
}

async function loadMessages(options = {}) {
  const inbox = currentMessageInbox();
  if (!inbox) {
    state.messages = [];
    state.activeMessage = null;
    state.attachments = [];
    state.source = '';
    return false;
  }
  const loaded = await withLoading(async () => {
    const addressRoute = state.route !== 'dashboard' && inbox.addressRoute;
    const payload = addressRoute
      ? await api(`/api/messages?address=${encodeURIComponent(inbox.address)}`, { headers: authHeaders() })
      : await api(`/api/inboxes/${inbox.id}/messages`, { headers: currentMessageHeaders(inbox) });
    if (addressRoute && payload.inbox) {
      const routedInbox = { ...payload.inbox, addressRoute: true };
      state.inboxes = [
        routedInbox,
        ...state.inboxes.filter((item) => item.id !== inbox.id && normalizeAddress(item.address) !== normalizeAddress(payload.inbox.address))
      ];
      state.activeInboxId = routedInbox.id;
      saveInboxes();
    }
    state.messages = payload.messages || [];
    state.activeMessage = null;
    state.attachments = [];
    state.source = '';
    return true;
  });
  if (!loaded && options.inaccessibleMessage && !state.error) setError(options.inaccessibleMessage);
  return Boolean(loaded);
}

async function openInboxAddress(address, { replaceUrl = false } = {}) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) return false;
  state.route = 'inbox';
  mobileMenuOpen.value = false;
  const savedInbox = findInboxByAddress(normalizedAddress);
  const inbox = savedInbox || addressPlaceholder(normalizedAddress);
  state.inboxes = [
    inbox,
    ...state.inboxes.filter((item) => item.id !== inbox.id && normalizeAddress(item.address) !== normalizedAddress)
  ];
  state.activeInboxId = inbox.id;
  state.messages = [];
  state.activeMessage = null;
  state.attachments = [];
  state.source = '';
  setInboxAddressUrl(normalizedAddress, replaceUrl);
  const loaded = await loadMessages({ inaccessibleMessage: 'Inbox not found or not accessible.' });
  if (savedInbox) saveInboxes();
  return loaded;
}

async function handleBrowserLocation() {
  const address = addressFromCurrentPath();
  if (address) {
    await openInboxAddress(address, { replaceUrl: true });
    return;
  }
  state.route = 'inbox';
  if (state.activeInboxId) await loadMessages();
}

async function loadOwnedInboxes() {
  if (!state.session) return;
  if (isAdmin.value && state.config.privacyLock) {
    state.ownedInboxes = [];
    state.activeOwnedInboxId = '';
    return;
  }
  await withLoading(async () => {
    const payload = await api('/api/inboxes', { headers: authHeaders() });
    state.ownedInboxes = payload.inboxes || [];
    if (!state.ownedInboxes.some((inbox) => inbox.id === state.activeOwnedInboxId)) {
      state.activeOwnedInboxId = state.ownedInboxes[0]?.id || '';
    }
    if (state.route === 'dashboard') await loadMessages();
  });
}

async function loadApiKeyRequests() {
  if (!state.session || !isMember.value) {
    state.apiKeyRequests = [];
    return;
  }
  await withLoading(async () => {
    const payload = await api('/api/me/api-key-requests', { headers: authHeaders() });
    state.apiKeyRequests = payload.requests || [];
  });
}

async function openMessage(message) {
  await withLoading(async () => {
    const inbox = currentMessageInbox();
    const payload = await api(`/api/messages/${message.id}`, { headers: currentMessageHeaders(inbox) });
    state.activeMessage = payload.message;
    state.attachments = payload.attachments || [];
    state.source = '';
  });
}

async function loadSource() {
  if (!state.activeMessage) return;
  await withLoading(async () => {
    const headers = currentMessageHeaders(currentMessageInbox());
    const response = await fetch(`/api/messages/${state.activeMessage.id}/source`, { headers });
    if (response.status === 401 && hasAuthorizationHeader(headers)) {
      handleExpiredSession();
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    if (!response.ok) throw new Error(`Source request failed with ${response.status}`);
    state.source = await response.text();
  });
}

async function deleteMessage(message) {
  await withLoading(async () => {
    await api(`/api/messages/${message.id}`, { method: 'DELETE', headers: currentMessageHeaders(currentMessageInbox()) });
    await loadMessages();
    setNotice('Message deleted from this inbox.');
  });
}

async function downloadAttachment(attachment) {
  if (!state.activeMessage) return;
  await withLoading(async () => {
    const headers = currentMessageHeaders(currentMessageInbox());
    const response = await fetch(`/api/messages/${state.activeMessage.id}/attachments/${attachment.id}`, {
      headers
    });
    if (response.status === 401 && hasAuthorizationHeader(headers)) {
      handleExpiredSession();
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    if (!response.ok) throw new Error(`Attachment request failed with ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = attachment.filename || 'rdhx-email-attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    setNotice('Attachment download started.');
  });
}

async function loadAdminData() {
  if (!isAdmin.value) return;
  await withLoading(async () => {
    const [users, keys, requests, settings] = await Promise.all([
      api('/api/admin/users', { headers: authHeaders() }),
      api('/api/admin/api-keys', { headers: authHeaders() }),
      api('/api/admin/api-key-requests', { headers: authHeaders() }),
      api('/api/admin/settings', { headers: authHeaders() })
    ]);
    state.users = users.users || [];
    state.apiKeys = keys.apiKeys || [];
    state.adminApiKeyRequests = requests.requests || [];
    if (settings.settings) {
      state.config = { ...state.config, ...settings.settings };
      settingsForm.accessMode = settings.settings.accessMode || state.config.accessMode || 'public';
    }
    if (!state.users.some((user) => user.id === passwordResetForm.userId)) {
      passwordResetForm.userId = state.users.find((user) => user.role === 'member')?.id || state.users[0]?.id || '';
    }
    if (!activeApiKeyOwners.value.some((user) => user.id === keyForm.ownerUserId)) {
      keyForm.ownerUserId = activeApiKeyOwners.value.find((user) => user.role === 'member')?.id || activeApiKeyOwners.value[0]?.id || '';
    }
  });
}

async function saveAccessMode() {
  await withLoading(async () => {
    const payload = await api('/api/admin/settings/access-mode', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ accessMode: settingsForm.accessMode })
    });
    if (payload.settings) state.config = { ...state.config, ...payload.settings };
    await loadBasics();
    setNotice(`Access mode switched to ${state.config.accessMode}.`);
  });
}

async function createUser() {
  await withLoading(async () => {
    await api('/api/admin/users', { method: 'POST', headers: authHeaders(), body: JSON.stringify(userForm) });
    userForm.username = '';
    userForm.password = '';
    await loadAdminData();
    setNotice('User created. Password was sent only in this request.');
  });
}

async function disableUser(user) {
  if (isCurrentSessionUser(user)) {
    setError('You cannot disable your own admin account.');
    return;
  }
  if (isLastActiveAdmin(user)) {
    setError('At least one active admin must remain.');
    return;
  }
  await withLoading(async () => {
    await api(`/api/admin/users/${user.id}/disable`, { method: 'POST', headers: authHeaders() });
    await loadAdminData();
    setNotice(`${user.username} is disabled and active sessions are revoked.`);
  });
}

async function enableUser(user) {
  await withLoading(async () => {
    await api(`/api/admin/users/${user.id}/enable`, { method: 'POST', headers: authHeaders() });
    await loadAdminData();
    setNotice(`${user.username} is active again.`);
  });
}

async function resetPassword() {
  await withLoading(async () => {
    await api(`/api/admin/users/${passwordResetForm.userId}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ password: passwordResetForm.password })
    });
    passwordResetForm.password = '';
    await loadAdminData();
    setNotice('Password reset complete. Share the temporary password through an approved channel.');
  });
}

async function createApiKey() {
  if (!activeApiKeyOwners.value.some((user) => user.id === keyForm.ownerUserId)) {
    setError('Choose an active user before creating an API key.');
    return;
  }
  await withLoading(async () => {
    const payload = await api('/api/admin/api-keys', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ownerUserId: keyForm.ownerUserId, name: keyForm.name })
    });
    revealedKey.value = payload.key;
    keyForm.name = '';
    await loadAdminData();
    setNotice('API key created. Copy the plaintext key now; lists show the prefix only.');
  });
}

async function createApiKeyRequest() {
  await withLoading(async () => {
    await api('/api/me/api-key-requests', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ reason: keyRequestForm.reason })
    });
    keyRequestForm.reason = '';
    revealedRequestedKey.value = '';
    await loadApiKeyRequests();
    setNotice('API key request submitted for admin review.');
  });
}

async function generateRequestedApiKey(request) {
  await withLoading(async () => {
    const payload = await api(`/api/me/api-key-requests/${request.id}/generate`, { method: 'POST', headers: authHeaders() });
    revealedRequestedKey.value = payload.key;
    await loadApiKeyRequests();
    setNotice('API key generated. Copy the plaintext key now.');
  });
}

async function approveApiKeyRequest(request) {
  await withLoading(async () => {
    await api(`/api/admin/api-key-requests/${request.id}/approve`, { method: 'POST', headers: authHeaders() });
    await loadAdminData();
    setNotice('API key request approved.');
  });
}

async function rejectApiKeyRequest(request) {
  await withLoading(async () => {
    await api(`/api/admin/api-key-requests/${request.id}/reject`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ rejectionReason: adminRejectReasons[request.id] || '' })
    });
    adminRejectReasons[request.id] = '';
    await loadAdminData();
    setNotice('API key request rejected.');
  });
}

async function resetApiKey(key) {
  await withLoading(async () => {
    const payload = await api(`/api/admin/api-keys/${key.id}/reset`, { method: 'POST', headers: authHeaders() });
    revealedKey.value = payload.key;
    await loadAdminData();
    setNotice('API key reset. Copy the new plaintext key now.');
  });
}

async function revokeApiKey(key) {
  await withLoading(async () => {
    await api(`/api/admin/api-keys/${key.id}/revoke`, { method: 'POST', headers: authHeaders() });
    await loadAdminData();
    setNotice('API key revoked. Automation using it will be rejected by the backend.');
  });
}

function selectRoute(route) {
  mobileMenuOpen.value = false;
  if (route === 'login' && state.session) route = 'dashboard';
  if (route === 'dashboard' && !state.session) {
    state.route = 'login';
    setError('Please sign in to open Dashboard.');
    return;
  }
  if (route.startsWith('admin') && !isAdmin.value) {
    state.route = state.session ? 'dashboard' : 'login';
    setError(state.session ? 'Admin access is required.' : 'Please sign in as an admin to open this page.');
    return;
  }
  state.route = route;
  if (route.startsWith('admin')) loadAdminData();
  if (route === 'dashboard') {
    if (isAdmin.value) loadAdminData();
    loadOwnedInboxes();
  }
}

function messagePreview(message) {
  return message.textBody || message.subject || 'No plain text preview stored for this message.';
}

onMounted(async () => {
  loadSavedState();
  const routedAddress = addressFromCurrentPath();
  await loadBasics();
  if (isAdmin.value) await loadAdminData();
  if (state.session) await loadApiKeyRequests();
  if (state.session) await loadOwnedInboxes();
  if (routedAddress) await openInboxAddress(routedAddress, { replaceUrl: true });
  else if (state.activeInboxId) await loadMessages();
  window.addEventListener('popstate', handleBrowserLocation);
});

onUnmounted(() => {
  window.removeEventListener('popstate', handleBrowserLocation);
});
</script>

<template>
  <main class="app-shell min-h-screen text-slate-100">
    <div class="landing-canvas mx-auto min-h-screen">
      <header class="top-header">
        <div class="brand-wordmark">Temp-mail</div>
        <nav class="top-nav" aria-label="Primary navigation">
          <button class="nav-button" :class="{ active: state.route === 'inbox' }" @click="selectRoute('inbox')">Home</button>
          <button class="nav-button" :class="{ active: state.route === 'docs' }" @click="selectRoute('docs')">Docs</button>
          <button v-if="!state.session" class="nav-button" :class="{ active: state.route === 'login' }" @click="selectRoute('login')">Login</button>
          <button v-if="state.session" class="nav-button" :class="{ active: state.route === 'dashboard' }" @click="selectRoute('dashboard')">Dashboard</button>
          <button v-if="isAdmin" class="nav-button" :class="{ active: state.route === 'admin-users' }" @click="selectRoute('admin-users')">Users</button>
          <button v-if="isAdmin" class="nav-button" :class="{ active: state.route === 'admin-keys' }" @click="selectRoute('admin-keys')">API keys</button>
          <button v-if="state.session" class="nav-button" @click="logout">Logout</button>
        </nav>
        <button
          class="mobile-menu-icon"
          type="button"
          :aria-expanded="mobileMenuOpen"
          aria-controls="mobile-primary-nav"
          :aria-label="mobileMenuOpen ? 'Close navigation' : 'Open navigation'"
          @click="mobileMenuOpen = !mobileMenuOpen"
        >
          <span></span><span></span><span></span>
        </button>
      </header>

      <nav v-if="mobileMenuOpen" id="mobile-primary-nav" class="mobile-nav" aria-label="Mobile navigation">
        <button class="nav-button" :class="{ active: state.route === 'inbox' }" @click="selectRoute('inbox')">Home</button>
        <button class="nav-button" :class="{ active: state.route === 'docs' }" @click="selectRoute('docs')">Docs</button>
        <button v-if="!state.session" class="nav-button" :class="{ active: state.route === 'login' }" @click="selectRoute('login')">Login</button>
        <button v-if="state.session" class="nav-button" :class="{ active: state.route === 'dashboard' }" @click="selectRoute('dashboard')">Dashboard</button>
        <button v-if="isAdmin" class="nav-button" :class="{ active: state.route === 'admin-users' }" @click="selectRoute('admin-users')">Users</button>
        <button v-if="isAdmin" class="nav-button" :class="{ active: state.route === 'admin-keys' }" @click="selectRoute('admin-keys')">API keys</button>
        <button v-if="state.session" class="nav-button" @click="logout">Logout</button>
      </nav>

      <div
        v-if="toastMessage"
        class="notice-banner"
        :class="{ 'error-banner': state.error, 'success-banner': state.notice && !state.error }"
        role="status"
        aria-live="polite"
      >
        <span>{{ toastMessage }}</span>
        <button class="toast-close-button" type="button" aria-label="Close notification" @click="dismissToast">×</button>
      </div>

      <template v-if="state.route === 'inbox'">
        <section class="inbox-landing">
          <div class="landing-left">
            <section class="hero-copy">
              <h1>Free Temporary Email.</h1>
              <p>Receive emails anonymously with a free, private, and secure temporary email address generator.</p>
              <div class="feature-row" aria-label="Feature summary">
                <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10M8 21h8M9 3v4l3 5-3 5v4M15 3v4l-3 5 3 5v4" /></svg>Valid Forever</span>
                <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 12l2 2 4-5" /></svg>Free</span>
                <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z" /></svg>Secure</span>
              </div>
            </section>

            <form class="panel-card email-card" @submit.prevent="createInbox">
              <p class="email-card-label">Your Temporary Email Address</p>
              <div class="generated-address" aria-live="polite">
                <span>{{ activeInbox?.address || '' }}</span>
                <button class="address-copy-button" type="button" :disabled="!activeInbox?.address" @click="copyActiveAddress" aria-label="Copy email address">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 8h11v11H8z M5 16H4V4h12v1" /></svg>
                </button>
              </div>
              <div v-if="isPrivateLocked" class="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">Private mode requires a valid login or API key before creating inboxes.</div>
              <div class="generator-row">
                <input v-model="inboxForm.localPart" class="input-field local-part-input" placeholder="Leave blank for random email" />
                <select v-model="inboxForm.domain" class="input-field domain-select"><option v-for="domain in state.domains" :key="domain" :value="domain">{{ domain }}</option></select>
                <button class="primary-button" type="submit" :disabled="state.loading">Create</button>
              </div>
            </form>
          </div>

          <div class="landing-right">
            <section class="inbox-preview-card">
              <div class="inbox-preview-topbar">
                <span class="inbox-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4zM4 7l8 6 8-6" /></svg>Inbox</span>
                <button class="icon-refresh-button" type="button" @click="loadMessages" aria-label="Refresh inbox">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 6v5h-5 M4 18v-5h5 M18.4 9a7 7 0 0 0-11.8-2.4L4 9 M5.6 15a7 7 0 0 0 11.8 2.4L20 15" /></svg>
                </button>
              </div>
              <div class="mail-illustration" aria-hidden="true">
                <div class="planet planet-one"></div>
                <div class="planet planet-two"></div>
                <div class="star star-one"></div>
                <div class="star star-two"></div>
                <div class="star star-three"></div>
                <div class="star star-four"></div>
                <div class="star star-five"></div>
                <div class="sparkle sparkle-one"></div>
                <div class="sparkle sparkle-two"></div>
                <div class="orbit-ring"></div>
                <div class="floating-mail floating-mail-left"></div>
                <div class="floating-mail floating-mail-right"></div>
                <div class="mailbox-scene">
                  <div class="signpost-pole"></div>
                  <div class="sign-board sign-board-top"></div>
                  <div class="sign-board sign-board-bottom"></div>
                  <div class="sign-flag"></div>
                  <div class="ground-shape"></div>
                </div>
              </div>
              <div class="inbox-preview-empty">
                <h2 v-if="!activeInbox || !state.messages.length">Your inbox is empty</h2>
                <h2 v-else>{{ state.messages.length }} emails received</h2>
                <p v-if="!activeInbox">Create a temporary email address to start receiving messages.</p>
                <p v-else-if="!state.messages.length">Waiting for incoming emails</p>
                <p v-else>Open Dashboard to inspect saved inboxes, messages, source, and attachments.</p>
              </div>
            </section>
          </div>
        </section>

        <footer class="home-footer">
          <div class="home-footer-inner">
            <p>© 2026 RdhxMail. All rights reserved.</p>
            <div class="home-footer-links" aria-label="Social links">
              <a href="https://github.com/fluffyhowl" target="_blank" rel="noopener noreferrer" aria-label="Open GitHub fluffyhowl">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.2-3.5-1.2-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.7-1.2-4.7-5A3.9 3.9 0 0 1 6.6 9c-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.8 1a9.7 9.7 0 0 1 5.1 0c1.9-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1.1 2.7c0 3.9-2.4 4.8-4.7 5 .4.3.7.9.7 1.8V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z" /></svg>
                fluffyhowl
              </a>
            </div>
          </div>
        </footer>
      </template>

      <template v-else-if="state.route === 'docs'">
      <section class="app-page docs-page grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.65fr)]">
        <div class="space-y-6">
          <article class="panel-card space-y-3">
            <h2 class="section-title">Overview</h2>
            <p class="section-copy">This API allows creating temporary inboxes and reading incoming messages.</p>
            <p class="section-copy">The simplest flow is: create an inbox with <code>{}</code>, keep the returned <code>address</code>, then read messages for that email address.</p>
            <p class="section-copy">Examples use the current site origin as the API base URL.</p>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">Authentication</h2>
            <p class="section-copy">Use an API key in the standard bearer authorization header. The backend reads this exact header format.</p>
            <p class="section-copy">Members can request API keys from Dashboard. After admin approval, the member generates the key and sees the plaintext value once.</p>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>Authorization: Bearer &lt;API_KEY&gt;</code></pre>
          </article>

          <article class="panel-card space-y-4">
            <h2 class="section-title">Create random inbox</h2>
            <p class="section-copy">Send an empty JSON object. The backend chooses the first active verified domain from the configured domain list automatically.</p>
            <p class="section-copy">The response includes <code>address</code>, plus <code>id</code>, <code>domain</code>, and <code>localPart</code> for compatibility. New integrations should keep the returned email address.</p>
            <p class="section-copy">Supported request bodies:</p>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>{}
{ "domain": "&lt;DOMAIN&gt;" }
{ "localPart": "demo" }
{ "localPart": "demo", "domain": "&lt;DOMAIN&gt;" }</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">JavaScript fetch</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>const BASE_URL = window.location.origin;

const response = await fetch(`${BASE_URL}/api/inboxes`, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer &lt;API_KEY&gt;',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({})
});

const data = await response.json();</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">Response shape</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>{
  "inbox": {
    "address": "&lt;EMAIL_ADDRESS&gt;",
    "id": "...",
    "domain": "...",
    "localPart": "..."
  },
  "inboxToken": "..."
}</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">PowerShell Invoke-RestMethod</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>$headers = @{ Authorization = 'Bearer &lt;API_KEY&gt;' }
$BaseUrl = '{{ docsBaseUrl }}'
$body = @{} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/api/inboxes" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">Windows curl.exe</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe -X POST "{{ docsBaseUrl }}/api/inboxes" -H "Authorization: Bearer &lt;API_KEY&gt;" -H "Content-Type: application/json" --data "{}"</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">macOS/Linux curl</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl -X POST '{{ docsBaseUrl }}/api/inboxes' \
  -H 'Authorization: Bearer &lt;API_KEY&gt;' \
  -H 'Content-Type: application/json' \
  --data '{}'</code></pre>
          </article>

          <article class="panel-card space-y-4">
            <h2 class="section-title">Create custom local-part inbox</h2>
            <p class="section-copy">Provide <code>localPart</code> when you want a specific address. The domain is optional and defaults to an active configured domain.</p>

            <h3 class="text-sm font-semibold text-slate-100">JavaScript fetch</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>const BASE_URL = window.location.origin;

const response = await fetch(`${BASE_URL}/api/inboxes`, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer &lt;API_KEY&gt;',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    localPart: 'demo'
  })
});

const data = await response.json();</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">PowerShell Invoke-RestMethod</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>$headers = @{ Authorization = 'Bearer &lt;API_KEY&gt;' }
$BaseUrl = '{{ docsBaseUrl }}'
$body = @{
  localPart = 'demo'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/api/inboxes" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">Windows curl.exe</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe -X POST "{{ docsBaseUrl }}/api/inboxes" -H "Authorization: Bearer &lt;API_KEY&gt;" -H "Content-Type: application/json" --data '{ "localPart": "demo" }'</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">macOS/Linux curl</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl -X POST '{{ docsBaseUrl }}/api/inboxes' \
  -H 'Authorization: Bearer &lt;API_KEY&gt;' \
  -H 'Content-Type: application/json' \
  --data '{ "localPart": "demo" }'</code></pre>
          </article>

          <article class="panel-card space-y-4">
            <h2 class="section-title">Create with selected domain</h2>
            <p class="section-copy">Use <code>domain</code> only when you want to choose a specific active configured system domain. It cannot be an arbitrary external domain.</p>
            <p class="section-copy">For a random local-part on a selected domain, send only <code>{ "domain": "&lt;DOMAIN&gt;" }</code>. For a custom address on that domain, include both fields.</p>

            <h3 class="text-sm font-semibold text-slate-100">JavaScript fetch</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>const BASE_URL = window.location.origin;

const response = await fetch(`${BASE_URL}/api/inboxes`, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer &lt;API_KEY&gt;',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    localPart: 'demo',
    domain: '&lt;DOMAIN&gt;'
  })
});

const data = await response.json();</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">PowerShell Invoke-RestMethod</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>$headers = @{ Authorization = 'Bearer &lt;API_KEY&gt;' }
$BaseUrl = '{{ docsBaseUrl }}'
$body = @{
  localPart = 'demo'
  domain = '&lt;DOMAIN&gt;'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/api/inboxes" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">Windows curl.exe</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe -X POST "{{ docsBaseUrl }}/api/inboxes" -H "Authorization: Bearer &lt;API_KEY&gt;" -H "Content-Type: application/json" --data '{ "localPart": "demo", "domain": "&lt;DOMAIN&gt;" }'</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">macOS/Linux curl</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl -X POST '{{ docsBaseUrl }}/api/inboxes' \
  -H 'Authorization: Bearer &lt;API_KEY&gt;' \
  -H 'Content-Type: application/json' \
  --data '{ "localPart": "demo", "domain": "&lt;DOMAIN&gt;" }'</code></pre>
          </article>

          <article class="panel-card space-y-4">
            <h2 class="section-title">List owned inboxes</h2>
            <p class="section-copy">Use this when you need to recover owned inbox addresses. The response includes only inboxes owned by the API key user, with each inbox address and compatibility ID.</p>

            <h3 class="text-sm font-semibold text-slate-100">JavaScript fetch</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>const BASE_URL = window.location.origin;

const response = await fetch(`${BASE_URL}/api/inboxes`, {
  headers: {
    Authorization: 'Bearer &lt;API_KEY&gt;'
  }
});

const data = await response.json();</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">PowerShell Invoke-RestMethod</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>$headers = @{ Authorization = 'Bearer &lt;API_KEY&gt;' }
$BaseUrl = '{{ docsBaseUrl }}'

Invoke-RestMethod `
  -Method Get `
  -Uri "$BaseUrl/api/inboxes" `
  -Headers $headers</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">Windows curl.exe</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe "{{ docsBaseUrl }}/api/inboxes" -H "Authorization: Bearer &lt;API_KEY&gt;"</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">macOS/Linux curl</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl '{{ docsBaseUrl }}/api/inboxes' \
  -H 'Authorization: Bearer &lt;API_KEY&gt;'</code></pre>
          </article>

          <article class="panel-card space-y-4">
            <h2 class="section-title">Read inbox messages</h2>
            <p class="section-copy">Read messages by email address. The address must belong to the API key user.</p>

            <h3 class="text-sm font-semibold text-slate-100">JavaScript fetch</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>const address = encodeURIComponent('&lt;EMAIL_ADDRESS&gt;');
const BASE_URL = window.location.origin;

const response = await fetch(
  `${BASE_URL}/api/messages?address=${address}`,
  {
    headers: {
      Authorization: 'Bearer &lt;API_KEY&gt;'
    }
  }
);

const data = await response.json();</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">PowerShell Invoke-RestMethod</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>$headers = @{ Authorization = 'Bearer &lt;API_KEY&gt;' }
$BaseUrl = '{{ docsBaseUrl }}'
$address = [uri]::EscapeDataString('&lt;EMAIL_ADDRESS&gt;')

Invoke-RestMethod `
  -Method Get `
  -Uri "$BaseUrl/api/messages?address=$address" `
  -Headers $headers</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">Windows curl.exe</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe "{{ docsBaseUrl }}/api/messages?address=&lt;EMAIL_ADDRESS&gt;" -H "Authorization: Bearer &lt;API_KEY&gt;"</code></pre>

            <h3 class="text-sm font-semibold text-slate-100">macOS/Linux curl</h3>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl '{{ docsBaseUrl }}/api/messages?address=&lt;EMAIL_ADDRESS&gt;' \
  -H 'Authorization: Bearer &lt;API_KEY&gt;'</code></pre>

            <p class="section-copy">Backward compatibility: ID-based reads with <code>GET /api/inboxes/:id/messages</code> still work for existing clients, but new integrations should prefer the email address route.</p>
          </article>
        </div>

        <aside class="space-y-6">
          <article class="panel-card space-y-3">
            <h2 class="section-title">Discover domains</h2>
            <p class="section-copy">Only call this if you want to choose a specific configured domain. It returns configured domains that are active and verified; arbitrary external domains are rejected.</p>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>const BASE_URL = window.location.origin;

const response = await fetch(`${BASE_URL}/api/domains`);
const data = await response.json();</code></pre>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>$BaseUrl = '{{ docsBaseUrl }}'

Invoke-RestMethod `
  -Method Get `
  -Uri "$BaseUrl/api/domains"</code></pre>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">API access</h2>
            <p class="section-copy">API keys can create inboxes and read messages for inboxes owned by the API key user.</p>
            <p class="section-copy">API key permissions are managed internally and cannot access other users' inboxes.</p>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">Security notes</h2>
            <ul class="space-y-2 text-sm leading-6 text-slate-400">
              <li>Plaintext API key is shown only once.</li>
              <li>Revoked API keys cannot be used.</li>
              <li>Disabled users cannot use API keys.</li>
              <li>API keys cannot access inboxes owned by another user.</li>
              <li>Private mode requires sign-in. Privacy Lock is config-only and disables admin inbox/message inspection.</li>
            </ul>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">Base URL</h2>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>{{ docsBaseUrl }}</code></pre>
          </article>
        </aside>
      </section>

      <footer class="home-footer docs-footer">
        <div class="home-footer-inner">
          <p>© 2026 RdhxMail. All rights reserved.</p>
          <div class="home-footer-links" aria-label="Social links">
            <a href="https://github.com/fluffyhowl" target="_blank" rel="noopener noreferrer" aria-label="Open GitHub fluffyhowl">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.2-3.5-1.2-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.7-1.2-4.7-5A3.9 3.9 0 0 1 6.6 9c-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.8 1a9.7 9.7 0 0 1 5.1 0c1.9-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1.1 2.7c0 3.9-2.4 4.8-4.7 5 .4.3.7.9.7 1.8V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z" /></svg>
              fluffyhowl
            </a>
          </div>
        </div>
      </footer>
      </template>

      <section v-else-if="state.route === 'login'" class="login-page">
        <div class="login-shell">
          <aside class="login-visual" aria-hidden="true">
            <div class="login-visual-copy">
              <p class="login-brand">RDHX Email</p>
              <h2>Temporary mail dashboard</h2>
            </div>
            <div class="login-visual-art">
              <div class="login-mail-card login-mail-card-one"></div>
              <div class="login-mail-card login-mail-card-two"></div>
              <div class="login-orb login-orb-one"></div>
              <div class="login-orb login-orb-two"></div>
            </div>
          </aside>

          <form v-if="!state.session" class="panel-card login-card" @submit.prevent="login">
            <div class="login-copy">
              <p class="login-brand">RDHX Email</p>
              <h2>Login</h2>
              <p>Sign in to access your dashboard.</p>
            </div>
            <div class="login-fields">
              <label class="field-label">Username<input v-model="loginForm.username" class="input-field" autocomplete="username" placeholder="Enter your username" /></label>
              <label class="field-label">Password<input v-model="loginForm.password" class="input-field" type="password" autocomplete="current-password" placeholder="Enter your password" /></label>
            </div>
            <button class="primary-button login-submit" type="submit">Sign in</button>
          </form>

          <div v-else class="panel-card login-card">
            <div class="login-copy">
              <p class="login-brand">RDHX Email</p>
              <h2>{{ state.session.user.username }}</h2>
              <p>You already have an active session.</p>
            </div>
            <button class="primary-button login-submit" @click="selectRoute('dashboard')">Open dashboard</button>
          </div>
        </div>
      </section>

      <section v-else-if="state.route === 'dashboard' || state.route === 'admin-users' || state.route === 'admin-keys'" class="app-page operational-view">
        <div class="hero-heading mb-6 flex flex-col gap-3 rounded-lg border border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm uppercase tracking-[0.22em] text-blue-200">RDHX Email</p>
            <h2 class="mt-1 text-2xl font-semibold">Dashboard</h2>
          </div>
          <div class="text-sm text-slate-300">{{ state.health?.ok ? 'API health: online' : 'API health: checking' }}</div>
        </div>

        <div v-if="state.route === 'dashboard' && isAdmin" class="utility-strip mb-6">
          <div class="status-panel rounded-lg border border-white/10 p-4 text-sm text-slate-300">
            <p class="font-medium text-white">Backend authority</p>
            <p class="mt-2">Access Mode: <span class="font-semibold text-blue-200">{{ state.config.accessMode }}</span></p>
            <p>Privacy Lock: <span class="font-semibold text-blue-200">{{ state.config.privacyLock ? 'Enabled' : 'Disabled' }}</span></p>
            <p>Retention: {{ state.config.messageRetentionDays || state.config.retentionDays }} day message cleanup</p>
            <p class="mt-2 break-words text-slate-400">Domains: {{ domainsText }}</p>
          </div>

          <div class="login-panel rounded-lg border border-white/10 p-4">
            <p class="text-sm text-slate-400">Signed in as</p>
            <p class="mt-2 font-semibold">{{ state.session.user.username }} <span class="status-chip">{{ state.session.user.role }}</span></p>
            <p class="mt-2 text-xs text-slate-400">Internal system information is visible to admins only.</p>
          </div>

          <form class="login-panel rounded-lg border border-white/10 p-4" @submit.prevent="saveAccessMode">
            <p class="font-medium text-white">Access Mode</p>
            <p class="mt-2 text-xs text-slate-400">Public allows public temp inboxes. Private requires sign-in.</p>
            <label class="field-label mt-3 text-slate-200">Mode
              <select v-model="settingsForm.accessMode" class="input-field">
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>
            </label>
            <button class="secondary-button mt-3" type="submit">Save mode</button>
          </form>
        </div>

        <div v-if="state.route === 'dashboard' && isAdmin" class="panel-card mb-6">
          <h3 class="section-title">Privacy Lock</h3>
          <p v-if="state.config.privacyLock" class="section-copy">Privacy Lock is enabled. Admins cannot inspect public or user inboxes/messages.</p>
          <p v-else class="section-copy">Privacy Lock is disabled. Admin inbox/message inspection is available to admins.</p>
        </div>

        <section v-if="state.route === 'dashboard' && isMember" class="mb-6 grid gap-6 xl:grid-cols-[360px_1fr]">
          <form class="panel-card space-y-4" @submit.prevent="createApiKeyRequest">
            <h3 class="section-title">Request API key</h3>
            <p class="section-copy">Submit a request for API access. After admin approval, you can generate your API key once.</p>
            <label class="field-label text-slate-200">Reason
              <textarea v-model="keyRequestForm.reason" class="input-field min-h-28" maxlength="500" placeholder="Describe the automation or integration that needs API access."></textarea>
            </label>
            <button class="primary-button w-full" type="submit">Submit request</button>
            <div v-if="revealedRequestedKey" class="rounded-xl border border-blue-300/30 bg-blue-300/10 p-3">
              <p class="text-xs uppercase tracking-[0.2em] text-blue-200">Plaintext key shown once</p>
              <code class="mt-2 block break-all text-sm text-white">{{ revealedRequestedKey }}</code>
            </div>
          </form>

          <div class="panel-card">
            <div class="mb-4 flex items-center justify-between">
              <h3 class="section-title">API key requests</h3>
              <button class="secondary-button" @click="loadApiKeyRequests">Refresh</button>
            </div>
            <div v-if="!state.apiKeyRequests.length" class="empty-state">No API key requests yet.</div>
            <div v-else class="overflow-x-auto">
              <table class="data-table">
                <thead><tr><th>Status</th><th>Reason</th><th>Admin reason</th><th>Created</th><th>Action</th></tr></thead>
                <tbody>
                  <tr v-for="request in state.apiKeyRequests" :key="request.id">
                    <td><span class="status-chip">{{ request.status }}</span></td>
                    <td>{{ request.reason }}</td>
                    <td>{{ request.rejectionReason || '-' }}</td>
                    <td>{{ request.createdAt }}</td>
                    <td>
                      <button v-if="request.status === 'approved'" class="primary-button" @click="generateRequestedApiKey(request)">Generate API key</button>
                      <span v-else-if="request.status === 'fulfilled'" class="text-sm text-slate-400">Generated</span>
                      <span v-else class="text-sm text-slate-400">No action</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section v-if="state.route === 'dashboard' && state.session && (!isAdmin || !state.config.privacyLock)" class="operational-mail-panels mb-6">
          <div class="panel-card saved-inboxes-panel">
            <div class="mb-3 flex items-center justify-between"><h3 class="section-title">Saved inboxes</h3><button class="secondary-button" @click="loadOwnedInboxes">Refresh</button></div>
            <div v-if="!state.ownedInboxes.length" class="empty-state">No owned inboxes found for this account. Create one to start monitoring inbound messages.</div>
            <button v-for="inbox in state.ownedInboxes" :key="inbox.id" class="inbox-row" :class="{ active: inbox.id === state.activeOwnedInboxId }" @click="state.activeOwnedInboxId = inbox.id; loadMessages()">
              <span class="font-medium">{{ inbox.address }}</span>
              <span class="text-xs text-slate-400">{{ inbox.status }} - {{ inbox.lastMessageAt || 'no messages yet' }}</span>
            </button>
          </div>

          <div class="messages-stack">
            <div class="panel-card min-w-0">
              <div class="mb-4 flex items-center justify-between"><h3 class="section-title">Messages</h3><span class="status-chip">{{ state.messages.length }} loaded</span></div>
              <div v-if="!activeDashboardInbox" class="empty-state">Select or create an owned inbox to load messages.</div>
              <div v-else-if="!state.messages.length" class="empty-state">No messages stored for {{ activeDashboardInbox.address }}. Inbound mail appears here after Email Routing delivers it.</div>
              <button v-for="message in state.messages" :key="message.id" class="message-row" @click="openMessage(message)">
                <span class="font-medium">{{ message.subject || 'Untitled message' }}</span>
                <span class="truncate text-sm text-slate-400">{{ message.fromAddress || 'unknown sender' }}</span>
                <span class="line-clamp-2 text-xs text-slate-500">{{ messagePreview(message) }}</span>
              </button>
            </div>

            <article class="panel-card min-w-0">
              <div v-if="!state.activeMessage" class="empty-state">Open a message to inspect body, attachments, deletion, and raw source basics.</div>
              <div v-else class="space-y-4">
                <div class="border-b border-white/10 pb-4">
                  <p class="text-sm text-slate-400">From {{ state.activeMessage.fromAddress || 'unknown sender' }}</p>
                  <h3 class="mt-1 text-xl font-semibold">{{ state.activeMessage.subject || 'Untitled message' }}</h3>
                  <p class="mt-1 text-xs text-slate-500">Received {{ state.activeMessage.receivedAt }} - {{ state.activeMessage.sizeBytes || 0 }} bytes</p>
                </div>
                <p class="whitespace-pre-wrap rounded-lg bg-black/35 p-4 text-sm leading-6 text-slate-200">{{ state.activeMessage.textBody || 'No plain text body stored.' }}</p>
                <div v-if="state.attachments.length" class="space-y-2"><p class="text-sm font-medium">Attachments</p><button v-for="item in state.attachments" :key="item.id" class="block w-full rounded-lg border border-white/10 p-3 text-left text-sm text-blue-200 hover:bg-blue-300/10" @click="downloadAttachment(item)">{{ item.filename }} - {{ item.size_bytes || item.sizeBytes }} bytes</button></div>
                <div class="flex flex-wrap gap-2"><button class="secondary-button" @click="loadSource"><svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="iconPath('source')" /></svg>View source</button><button class="danger-button" @click="deleteMessage(state.activeMessage)">Delete message</button></div>
                <pre v-if="state.source" class="max-h-72 overflow-auto rounded-lg bg-black p-4 text-xs text-slate-300">{{ state.source }}</pre>
              </div>
            </article>
          </div>
        </section>

        <section v-if="state.route === 'admin-users' && isAdmin" class="grid gap-6 xl:grid-cols-[360px_1fr]">
          <div class="space-y-6">
            <form class="panel-card space-y-4" @submit.prevent="createUser">
              <h3 class="section-title">Create user</h3>
              <label class="field-label text-slate-200">Username<input v-model="userForm.username" class="input-field" /></label>
              <label class="field-label text-slate-200">Temporary password<input v-model="userForm.password" class="input-field" type="password" /></label>
              <label class="field-label text-slate-200">Role
                <select v-model="userForm.role" class="input-field">
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </label>
              <button class="primary-button w-full">Create user</button>
            </form>

            <form class="panel-card space-y-4" @submit.prevent="resetPassword">
              <h3 class="section-title">Reset password</h3>
              <p class="section-copy">Rotates a selected user's password through the admin API. The frontend never reads the old hash.</p>
              <label class="field-label text-slate-200">User
                <select v-model="passwordResetForm.userId" class="input-field">
                  <option v-for="user in state.users" :key="user.id" :value="user.id">{{ user.username }} · {{ user.role }}</option>
                </select>
              </label>
              <label class="field-label text-slate-200">New temporary password<input v-model="passwordResetForm.password" class="input-field" type="password" /></label>
              <button class="secondary-button w-full">Reset password</button>
            </form>
          </div>

          <div class="panel-card">
            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h3 class="section-title">Users</h3>
              <div class="flex flex-wrap items-center gap-2">
                <div class="filter-tabs" aria-label="Filter users by status">
                  <button class="filter-tab" :class="{ active: userStatusFilter === 'all' }" type="button" @click="userStatusFilter = 'all'">All</button>
                  <button class="filter-tab" :class="{ active: userStatusFilter === 'active' }" type="button" @click="userStatusFilter = 'active'">Active</button>
                  <button class="filter-tab" :class="{ active: userStatusFilter === 'disabled' }" type="button" @click="userStatusFilter = 'disabled'">Disabled</button>
                </div>
                <button class="secondary-button" @click="loadAdminData">Refresh</button>
              </div>
            </div>
            <div v-if="!filteredUsers.length" class="empty-state">No users match this filter.</div>
            <div class="overflow-x-auto">
              <table class="data-table">
                <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th>Action</th></tr></thead>
                <tbody>
                  <tr v-for="user in filteredUsers" :key="user.id">
                    <td>{{ user.username }}</td>
                    <td>{{ user.role }}</td>
                    <td>{{ user.status }}</td>
                    <td>{{ user.lastLoginAt || 'never' }}</td>
                    <td>
                      <button v-if="user.status === 'active' && !isCurrentSessionUser(user) && !isLastActiveAdmin(user)" class="danger-button" @click="disableUser(user)">Disable</button>
                      <button v-else-if="user.status === 'disabled'" class="secondary-button" @click="enableUser(user)">Enable</button>
                      <span v-else-if="isCurrentSessionUser(user)" class="text-sm text-slate-400">Current admin</span>
                      <span v-else-if="isLastActiveAdmin(user)" class="text-sm text-slate-400">Last active admin</span>
                      <span v-else class="text-sm text-slate-400">No action</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section v-else-if="state.route === 'admin-keys' && isAdmin" class="grid gap-6 xl:grid-cols-[360px_1fr]">
          <form class="panel-card space-y-4" @submit.prevent="createApiKey">
            <h3 class="section-title">Create API key</h3>
            <label class="field-label text-slate-200">Owner
              <select v-model="keyForm.ownerUserId" class="input-field">
                <option value="" disabled>Select active user</option>
                <option v-for="user in activeApiKeyOwners" :key="user.id" :value="user.id">{{ user.username }} · {{ user.role }}</option>
              </select>
            </label>
            <p class="section-copy">API keys can only be created for active users.</p>
            <label class="field-label text-slate-200">Name<input v-model="keyForm.name" class="input-field" placeholder="mail automation" /></label>
            <button class="primary-button w-full" :disabled="!keyForm.ownerUserId">Create key</button>
            <div v-if="revealedKey" class="rounded-xl border border-blue-300/30 bg-blue-300/10 p-3">
              <p class="text-xs uppercase tracking-[0.2em] text-blue-200">Plaintext key shown once</p>
              <code class="mt-2 block break-all text-sm text-white">{{ revealedKey }}</code>
            </div>
          </form>

          <div class="panel-card">
            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h3 class="section-title">API keys</h3>
              <div class="flex flex-wrap items-center gap-2">
                <div class="filter-tabs" aria-label="Filter API keys by status">
                  <button class="filter-tab" :class="{ active: apiKeyStatusFilter === 'all' }" type="button" @click="apiKeyStatusFilter = 'all'">All</button>
                  <button class="filter-tab" :class="{ active: apiKeyStatusFilter === 'active' }" type="button" @click="apiKeyStatusFilter = 'active'">Active</button>
                  <button class="filter-tab" :class="{ active: apiKeyStatusFilter === 'revoked' }" type="button" @click="apiKeyStatusFilter = 'revoked'">Revoked</button>
                </div>
                <button class="secondary-button" @click="loadAdminData">Refresh</button>
              </div>
            </div>
            <div v-if="!filteredApiKeys.length" class="empty-state">No API keys match this filter.</div>
            <div class="overflow-x-auto">
              <table class="data-table">
                <thead><tr><th>Name</th><th>Owner</th><th>Prefix</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  <tr v-for="key in filteredApiKeys" :key="key.id">
                    <td>{{ key.name }}</td>
                    <td>{{ key.ownerUsername }}<span v-if="key.ownerStatus && key.ownerStatus !== 'active'" class="text-slate-400"> · {{ key.ownerStatus }}</span></td>
                    <td><code>{{ key.prefix }}</code></td>
                    <td><span class="status-chip">{{ key.status === 'active' ? 'Active' : key.status === 'revoked' ? 'Revoked' : key.status }}</span></td>
                    <td class="space-x-2">
                      <template v-if="key.status === 'active'">
                        <button class="secondary-button" @click="resetApiKey(key)">Reset</button>
                        <button class="danger-button" @click="revokeApiKey(key)">Revoke</button>
                      </template>
                      <span v-else class="text-sm text-slate-400">No actions</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="panel-card xl:col-span-2">
            <div class="mb-4 flex items-center justify-between">
              <h3 class="section-title">API key requests</h3>
              <button class="secondary-button" @click="loadAdminData">Refresh</button>
            </div>
            <div v-if="!state.adminApiKeyRequests.length" class="empty-state">No API key requests submitted yet.</div>
            <div v-else class="overflow-x-auto">
              <table class="data-table">
                <thead><tr><th>Requester</th><th>Reason</th><th>Status</th><th>Created</th><th>Admin reason</th><th>Actions</th></tr></thead>
                <tbody>
                  <tr v-for="request in state.adminApiKeyRequests" :key="request.id">
                    <td>{{ request.requesterUsername }} · {{ request.requesterRole }}</td>
                    <td>{{ request.reason }}</td>
                    <td><span class="status-chip">{{ request.status }}</span></td>
                    <td>{{ request.createdAt }}</td>
                    <td>
                      <input v-if="request.status === 'pending'" v-model="adminRejectReasons[request.id]" class="input-field" placeholder="Reason required to reject" />
                      <span v-else>{{ request.rejectionReason || '-' }}</span>
                    </td>
                    <td class="space-x-2">
                      <template v-if="request.status === 'pending'">
                        <button class="secondary-button" @click="approveApiKeyRequest(request)">Approve</button>
                        <button class="danger-button" @click="rejectApiKeyRequest(request)">Reject</button>
                      </template>
                      <span v-else class="text-sm text-slate-400">Reviewed</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section v-else class="panel-card space-y-5">
          <div><h3 class="section-title">Dashboard settings</h3><p class="section-copy">This frontend stores only local session and inbox convenience state. Authorization, roles, API key hashing, and private mode decisions remain in the Worker API.</p></div>
          <dl class="grid gap-4 md:grid-cols-2"><div class="metric-card"><dt>Access mode</dt><dd>{{ state.config.accessMode }}</dd></div><div class="metric-card"><dt>Health</dt><dd>{{ state.health?.ok ? 'online' : 'unknown' }}</dd></div><div class="metric-card"><dt>Active domains</dt><dd>{{ state.domains.length }}</dd></div><div class="metric-card"><dt>Owned inboxes</dt><dd>{{ state.ownedInboxes.length }}</dd></div></dl>
          <div class="rounded-xl border border-white/10 bg-slate-950/60 p-4 text-sm text-slate-300"><p class="font-medium text-white">Security note</p><p class="mt-2">Admin navigation is hidden for non-admin sessions to reduce clutter. The server still returns 401 or 403 for admin APIs when a non-admin token calls them.</p></div>
        </section>
      </section>
    </div>
  </main>
</template>
