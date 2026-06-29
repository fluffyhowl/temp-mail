<script setup>
import { computed, onMounted, reactive, ref } from 'vue';

const TOKEN_KEY = 'rdhx-email-session';
const INBOX_KEY = 'rdhx-email-inboxes';

const state = reactive({
  config: { accessMode: 'public', retentionDays: 1 },
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
  notice: '',
  error: '',
  loading: false,
  route: 'inbox'
});

const loginForm = reactive({ username: '', password: '' });
const inboxForm = reactive({ mode: 'random', localPart: '', domain: '' });
const userForm = reactive({ username: '', password: '', role: 'member' });
const passwordResetForm = reactive({ userId: '', password: '' });
const keyForm = reactive({ ownerUserId: '', name: '', scope: 'inboxes:write' });
const revealedKey = ref('');

const isAdmin = computed(() => state.session?.user?.role === 'admin');
const activeAdminCount = computed(() => state.users.filter((user) => user.role === 'admin' && user.status === 'active').length);
const activeApiKeyOwners = computed(() => state.users.filter((user) => user.status === 'active'));
const isPrivateLocked = computed(() => state.config.accessMode === 'private' && !state.session);
const activeInbox = computed(() => state.inboxes.find((inbox) => inbox.id === state.activeInboxId) || null);
const activeDashboardInbox = computed(() => state.ownedInboxes.find((inbox) => inbox.id === state.activeOwnedInboxId) || null);
const domainsText = computed(() => state.domains.length ? state.domains.join(', ') : 'No active domains loaded');
const SESSION_EXPIRED_MESSAGE = 'Session expired. Please sign in again.';

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

function setNotice(message) {
  state.notice = message;
  state.error = '';
}

function setError(error) {
  state.error = error?.message
    || error?.error?.message
    || error?.error?.code
    || (typeof error?.error === 'string' ? error.error : '')
    || (typeof error === 'string' ? error : 'Request failed');
  state.notice = '';
}

function loadSavedState() {
  try { state.session = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { state.session = null; }
  try { state.inboxes = JSON.parse(localStorage.getItem(INBOX_KEY) || '[]'); } catch { state.inboxes = []; }
  state.activeInboxId = state.inboxes[0]?.id || '';
}

function saveInboxes() {
  localStorage.setItem(INBOX_KEY, JSON.stringify(state.inboxes));
}

function currentMessageInbox() {
  return state.route === 'dashboard' ? activeDashboardInbox.value : activeInbox.value;
}

function currentMessageHeaders(inbox) {
  if (state.route === 'dashboard') return authHeaders();
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
    throw new Error(errorMessage);
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
    await loadOwnedInboxes();
  });
}

async function logout() {
  await withLoading(async () => {
    if (state.session?.token) await api('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    state.session = null;
    state.users = [];
    state.apiKeys = [];
    state.ownedInboxes = [];
    state.activeOwnedInboxId = '';
    state.messages = [];
    state.activeMessage = null;
    state.attachments = [];
    state.source = '';
    localStorage.removeItem(TOKEN_KEY);
    state.route = 'login';
    setNotice('Signed out. Local session token removed.');
  });
}

async function createInbox() {
  await withLoading(async () => {
    const body = { domain: inboxForm.domain || state.domains[0] };
    const localPart = inboxForm.localPart.trim();
    if (inboxForm.mode === 'custom' || localPart) body.localPart = localPart;
    const payload = await api('/api/inboxes', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    const record = state.session ? payload.inbox : { ...payload.inbox, inboxToken: payload.inboxToken };
    state.inboxes = [record, ...state.inboxes.filter((inbox) => inbox.id !== record.id)];
    state.activeInboxId = record.id;
    if (state.session) {
      state.ownedInboxes = [payload.inbox, ...state.ownedInboxes.filter((inbox) => inbox.id !== payload.inbox.id)];
      state.activeOwnedInboxId = payload.inbox.id;
    }
    inboxForm.localPart = '';
    saveInboxes();
    await loadMessages();
    setNotice(`Inbox ${record.address} is ready. Store the inbox token if you need another client.`);
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

async function loadMessages() {
  const inbox = currentMessageInbox();
  if (!inbox) {
    state.messages = [];
    state.activeMessage = null;
    state.attachments = [];
    state.source = '';
    return;
  }
  await withLoading(async () => {
    const payload = await api(`/api/inboxes/${inbox.id}/messages`, { headers: currentMessageHeaders(inbox) });
    state.messages = payload.messages || [];
    state.activeMessage = null;
    state.attachments = [];
    state.source = '';
  });
}

async function loadOwnedInboxes() {
  if (!state.session) return;
  await withLoading(async () => {
    const payload = await api('/api/inboxes', { headers: authHeaders() });
    state.ownedInboxes = payload.inboxes || [];
    if (!state.ownedInboxes.some((inbox) => inbox.id === state.activeOwnedInboxId)) {
      state.activeOwnedInboxId = state.ownedInboxes[0]?.id || '';
    }
    if (state.route === 'dashboard') await loadMessages();
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
    const [users, keys] = await Promise.all([
      api('/api/admin/users', { headers: authHeaders() }),
      api('/api/admin/api-keys', { headers: authHeaders() })
    ]);
    state.users = users.users || [];
    state.apiKeys = keys.apiKeys || [];
    if (!state.users.some((user) => user.id === passwordResetForm.userId)) {
      passwordResetForm.userId = state.users.find((user) => user.role === 'member')?.id || state.users[0]?.id || '';
    }
    if (!activeApiKeyOwners.value.some((user) => user.id === keyForm.ownerUserId)) {
      keyForm.ownerUserId = activeApiKeyOwners.value.find((user) => user.role === 'member')?.id || activeApiKeyOwners.value[0]?.id || '';
    }
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
      body: JSON.stringify({ ownerUserId: keyForm.ownerUserId, name: keyForm.name, scopes: [keyForm.scope] })
    });
    revealedKey.value = payload.key;
    keyForm.name = '';
    await loadAdminData();
    setNotice('API key created. Copy the plaintext key now; lists show the prefix only.');
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
  if (route === 'dashboard') loadOwnedInboxes();
}

function messagePreview(message) {
  return message.textBody || message.subject || 'No plain text preview stored for this message.';
}

onMounted(async () => {
  loadSavedState();
  await loadBasics();
  if (isAdmin.value) await loadAdminData();
  if (state.session) await loadOwnedInboxes();
  if (state.activeInboxId) await loadMessages();
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
        <div class="mobile-menu-icon" aria-hidden="true"><span></span><span></span><span></span></div>
      </header>

      <div v-if="state.notice" class="notice-banner rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">{{ state.notice }}</div>
      <div v-if="state.error" class="notice-banner error-banner rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{{ state.error }}</div>

      <section v-if="state.route === 'inbox'" class="inbox-landing">
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
            <div v-if="isPrivateLocked" class="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">Private mode requires a valid login or scoped API key before creating inboxes.</div>
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

      <section v-else-if="state.route === 'docs'" class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.65fr)]">
        <div class="space-y-6">
          <article class="panel-card space-y-3">
            <h2 class="section-title">Overview</h2>
            <p class="section-copy">This API allows creating temporary inboxes and reading incoming messages.</p>
            <p class="section-copy">Local examples use <code>http://127.0.0.1:8787</code> as the base URL.</p>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">Authentication</h2>
            <p class="section-copy">Use an API key in the standard bearer authorization header.</p>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>Authorization: Bearer &lt;API_KEY&gt;</code></pre>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">Create inbox</h2>
            <p class="section-copy">Omit <code>localPart</code> to create a random inbox.</p>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe -X POST http://127.0.0.1:8787/api/inboxes -H "Authorization: Bearer &lt;API_KEY&gt;" -H "Content-Type: application/json" -d "{ \"domain\": \"rdhx.email\" }"</code></pre>
            <p class="section-copy">Provide <code>localPart</code> when you want a custom address.</p>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe -X POST http://127.0.0.1:8787/api/inboxes -H "Authorization: Bearer &lt;API_KEY&gt;" -H "Content-Type: application/json" -d "{ \"localPart\": \"demo\", \"domain\": \"rdhx.email\" }"</code></pre>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">Read messages</h2>
            <p class="section-copy">List messages for an inbox owned by the API key user.</p>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe http://127.0.0.1:8787/api/inboxes/&lt;INBOX_ID&gt;/messages -H "Authorization: Bearer &lt;API_KEY&gt;"</code></pre>
            <p class="section-copy">Read one message by ID.</p>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>curl.exe http://127.0.0.1:8787/api/messages/&lt;MESSAGE_ID&gt; -H "Authorization: Bearer &lt;API_KEY&gt;"</code></pre>
          </article>
        </div>

        <aside class="space-y-6">
          <article class="panel-card space-y-3">
            <h2 class="section-title">Scopes</h2>
            <p class="section-copy"><code>inboxes:write</code> allows creating inboxes and accessing messages for inboxes owned by the API key user.</p>
            <p class="section-copy"><code>inboxes:*</code> is a wildcard accepted anywhere <code>inboxes:write</code> is required.</p>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">Security notes</h2>
            <ul class="space-y-2 text-sm leading-6 text-slate-400">
              <li>Plaintext API key is shown only once.</li>
              <li>Revoked API keys cannot be used.</li>
              <li>Disabled users cannot use API keys.</li>
            </ul>
          </article>

          <article class="panel-card space-y-3">
            <h2 class="section-title">Local dev base URL</h2>
            <pre class="overflow-x-auto rounded-lg bg-black/35 p-4 text-xs leading-6 text-slate-200"><code>http://127.0.0.1:8787</code></pre>
          </article>
        </aside>
      </section>

      <section v-else-if="state.route === 'login'" class="grid gap-6 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <form v-if="!state.session" class="panel-card space-y-4" @submit.prevent="login">
          <div>
            <p class="text-sm uppercase tracking-[0.22em] text-blue-200">Account access</p>
            <h2 class="mt-1 text-2xl font-semibold">Login</h2>
            <p class="section-copy">Sign in to open your dashboard and manage saved inboxes.</p>
          </div>
          <label class="field-label">Username<input v-model="loginForm.username" class="input-field" autocomplete="username" /></label>
          <label class="field-label">Password<input v-model="loginForm.password" class="input-field" type="password" autocomplete="current-password" /></label>
          <button class="primary-button w-full" type="submit">Sign in</button>
          <p class="text-xs text-slate-400">Public mode can create inboxes without login. Private mode is enforced by the Worker API.</p>
        </form>

        <div v-else class="panel-card space-y-4">
          <div>
            <p class="text-sm uppercase tracking-[0.22em] text-blue-200">Signed in</p>
            <h2 class="mt-1 text-2xl font-semibold">{{ state.session.user.username }}</h2>
            <p class="section-copy">You already have an active session.</p>
          </div>
          <button class="primary-button w-full" @click="selectRoute('dashboard')">Open dashboard</button>
        </div>

        <aside class="panel-card space-y-3">
          <h3 class="section-title">Access notes</h3>
          <p class="section-copy">Home and Docs are public. Dashboard, saved inboxes, messages, and admin tools require a valid session.</p>
        </aside>
      </section>

      <section v-else-if="state.route === 'dashboard' || state.route === 'admin-users' || state.route === 'admin-keys'" class="operational-view">
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
            <p class="mt-2">Mode: <span class="font-semibold text-blue-200">{{ state.config.accessMode }}</span></p>
            <p>Retention: {{ state.config.retentionDays }} day message cleanup</p>
            <p class="mt-2 break-words text-slate-400">Domains: {{ domainsText }}</p>
          </div>

          <div class="login-panel rounded-lg border border-white/10 p-4">
            <p class="text-sm text-slate-400">Signed in as</p>
            <p class="mt-2 font-semibold">{{ state.session.user.username }} <span class="status-chip">{{ state.session.user.role }}</span></p>
            <p class="mt-2 text-xs text-slate-400">Internal system information is visible to admins only.</p>
          </div>
        </div>

        <section v-if="state.route === 'dashboard' && state.session" class="operational-mail-panels mb-6">
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
            <div class="mb-4 flex items-center justify-between">
              <h3 class="section-title">Users</h3>
              <button class="secondary-button" @click="loadAdminData">Refresh</button>
            </div>
            <div class="overflow-x-auto">
              <table class="data-table">
                <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th>Action</th></tr></thead>
                <tbody>
                  <tr v-for="user in state.users" :key="user.id">
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
            <label class="field-label text-slate-200">Scope
              <select v-model="keyForm.scope" class="input-field">
                <option value="inboxes:write">inboxes:write</option>
                <option value="inboxes:*">inboxes:*</option>
              </select>
            </label>
            <button class="primary-button w-full" :disabled="!keyForm.ownerUserId">Create key</button>
            <div v-if="revealedKey" class="rounded-xl border border-blue-300/30 bg-blue-300/10 p-3">
              <p class="text-xs uppercase tracking-[0.2em] text-blue-200">Plaintext key shown once</p>
              <code class="mt-2 block break-all text-sm text-white">{{ revealedKey }}</code>
            </div>
          </form>

          <div class="panel-card">
            <div class="mb-4 flex items-center justify-between">
              <h3 class="section-title">API keys</h3>
              <button class="secondary-button" @click="loadAdminData">Refresh</button>
            </div>
            <div class="overflow-x-auto">
              <table class="data-table">
                <thead><tr><th>Name</th><th>Owner</th><th>Prefix</th><th>Status</th><th>Scopes</th><th>Actions</th></tr></thead>
                <tbody>
                  <tr v-for="key in state.apiKeys" :key="key.id">
                    <td>{{ key.name }}</td>
                    <td>{{ key.ownerUsername }}<span v-if="key.ownerStatus && key.ownerStatus !== 'active'" class="text-slate-400"> · {{ key.ownerStatus }}</span></td>
                    <td><code>{{ key.prefix }}</code></td>
                    <td><span class="status-chip">{{ key.status === 'active' ? 'Active' : key.status === 'revoked' ? 'Revoked' : key.status }}</span></td>
                    <td>{{ key.scopes.join(', ') }}</td>
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
