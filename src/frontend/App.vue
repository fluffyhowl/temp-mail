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
  activeInboxId: '',
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
const isPrivateLocked = computed(() => state.config.accessMode === 'private' && !state.session);
const activeInbox = computed(() => state.inboxes.find((inbox) => inbox.id === state.activeInboxId) || null);
const domainsText = computed(() => state.domains.length ? state.domains.join(', ') : 'No active domains loaded');

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
  state.error = error?.message || String(error);
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

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.session?.token) headers.Authorization = `Bearer ${state.session.token}`;
  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Request failed with ${response.status}`);
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
    setNotice(`Signed in as ${session.user.username}`);
    if (session.user.role === 'admin') await loadAdminData();
  });
}

async function logout() {
  await withLoading(async () => {
    if (state.session?.token) await api('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    state.session = null;
    state.users = [];
    state.apiKeys = [];
    localStorage.removeItem(TOKEN_KEY);
    setNotice('Signed out. Local session token removed.');
  });
}

async function createInbox() {
  await withLoading(async () => {
    const body = { domain: inboxForm.domain || state.domains[0] };
    if (inboxForm.mode === 'custom') body.localPart = inboxForm.localPart;
    const payload = await api('/api/inboxes', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    const record = { ...payload.inbox, inboxToken: payload.inboxToken };
    state.inboxes = [record, ...state.inboxes.filter((inbox) => inbox.id !== record.id)];
    state.activeInboxId = record.id;
    inboxForm.localPart = '';
    saveInboxes();
    await loadMessages();
    setNotice(`Inbox ${record.address} is ready. Store the inbox token if you need another client.`);
  });
}

async function loadMessages() {
  if (!activeInbox.value) return;
  await withLoading(async () => {
    const token = activeInbox.value.inboxToken;
    const payload = await api(`/api/inboxes/${activeInbox.value.id}/messages`, { headers: token ? { 'x-inbox-token': token } : authHeaders() });
    state.messages = payload.messages || [];
    state.activeMessage = null;
    state.attachments = [];
    state.source = '';
  });
}

async function openMessage(message) {
  await withLoading(async () => {
    const token = activeInbox.value?.inboxToken;
    const payload = await api(`/api/messages/${message.id}`, { headers: token ? { 'x-inbox-token': token } : authHeaders() });
    state.activeMessage = payload.message;
    state.attachments = payload.attachments || [];
    state.source = '';
  });
}

async function loadSource() {
  if (!state.activeMessage) return;
  await withLoading(async () => {
    const token = activeInbox.value?.inboxToken;
    const response = await fetch(`/api/messages/${state.activeMessage.id}/source`, { headers: token ? { 'x-inbox-token': token } : authHeaders() });
    if (!response.ok) throw new Error(`Source request failed with ${response.status}`);
    state.source = await response.text();
  });
}

async function deleteMessage(message) {
  await withLoading(async () => {
    const token = activeInbox.value?.inboxToken;
    await api(`/api/messages/${message.id}`, { method: 'DELETE', headers: token ? { 'x-inbox-token': token } : authHeaders() });
    await loadMessages();
    setNotice('Message deleted from this inbox.');
  });
}

async function downloadAttachment(attachment) {
  if (!state.activeMessage) return;
  await withLoading(async () => {
    const token = activeInbox.value?.inboxToken;
    const response = await fetch(`/api/messages/${state.activeMessage.id}/attachments/${attachment.id}`, {
      headers: token ? { 'x-inbox-token': token } : authHeaders()
    });
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
    passwordResetForm.userId = passwordResetForm.userId || state.users.find((user) => user.role === 'member')?.id || state.users[0]?.id || '';
    keyForm.ownerUserId = keyForm.ownerUserId || state.users.find((user) => user.role === 'member')?.id || state.users[0]?.id || '';
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
  await withLoading(async () => {
    await api(`/api/admin/users/${user.id}/disable`, { method: 'POST', headers: authHeaders() });
    await loadAdminData();
    setNotice(`${user.username} is disabled and active sessions are revoked.`);
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
  if (route.startsWith('admin') && !isAdmin.value) return;
  state.route = route;
  if (route.startsWith('admin')) loadAdminData();
}

function messagePreview(message) {
  return message.textBody || message.subject || 'No plain text preview stored for this message.';
}

onMounted(async () => {
  loadSavedState();
  await loadBasics();
  if (isAdmin.value) await loadAdminData();
  if (state.activeInboxId) await loadMessages();
});
</script>

<template>
  <main class="min-h-screen bg-slate-950 text-slate-100">
    <div class="mx-auto grid min-h-screen max-w-7xl lg:grid-cols-[280px_1fr]">
      <aside class="border-b border-white/10 bg-slate-950/95 p-6 lg:border-b-0 lg:border-r">
        <div class="flex items-center gap-3">
          <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500 text-white" aria-hidden="true">
            <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="iconPath('inbox')" /></svg>
          </div>
          <div>
            <p class="text-sm uppercase tracking-[0.24em] text-blue-200">RDHX</p>
            <h1 class="text-xl font-semibold">Email Console</h1>
          </div>
        </div>

        <div class="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
          <p class="font-medium text-white">Backend authority</p>
          <p class="mt-2">Mode: <span class="font-semibold text-blue-200">{{ state.config.accessMode }}</span></p>
          <p>Retention: {{ state.config.retentionDays }} day message cleanup</p>
          <p class="mt-2 break-words text-slate-400">Domains: {{ domainsText }}</p>
        </div>

        <nav class="mt-6 space-y-2" aria-label="Primary navigation">
          <button class="nav-button" :class="{ active: state.route === 'inbox' }" @click="selectRoute('inbox')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="iconPath('mail')" /></svg>
            Inbox dashboard
          </button>
          <button class="nav-button" :class="{ active: state.route === 'status' }" @click="selectRoute('status')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="iconPath('status')" /></svg>
            Status and settings
          </button>
          <button v-if="isAdmin" class="nav-button" :class="{ active: state.route === 'admin-users' }" @click="selectRoute('admin-users')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="iconPath('users')" /></svg>
            Admin users
          </button>
          <button v-if="isAdmin" class="nav-button" :class="{ active: state.route === 'admin-keys' }" @click="selectRoute('admin-keys')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="iconPath('key')" /></svg>
            Admin API keys
          </button>
        </nav>

        <section class="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div v-if="state.session" class="space-y-3">
            <p class="text-sm text-slate-400">Signed in as</p>
            <p class="font-semibold">{{ state.session.user.username }} <span class="status-chip">{{ state.session.user.role }}</span></p>
            <button class="secondary-button w-full" @click="logout">Sign out</button>
          </div>
          <form v-else class="space-y-3" @submit.prevent="login">
            <div class="flex items-center gap-2 text-sm font-medium text-white">
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="iconPath('lock')" /></svg>
              Private login
            </div>
            <label class="field-label">Username<input v-model="loginForm.username" class="input-field" autocomplete="username" /></label>
            <label class="field-label">Password<input v-model="loginForm.password" class="input-field" type="password" autocomplete="current-password" /></label>
            <button class="primary-button w-full" type="submit">Sign in</button>
            <p class="text-xs text-slate-400">Public mode can create inboxes without login. Private mode is enforced by the Worker API.</p>
          </form>
        </section>
      </aside>

      <section class="min-w-0 p-6 lg:p-8">
        <div class="mb-6 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm uppercase tracking-[0.22em] text-blue-200">Permanent inboxes</p>
            <h2 class="mt-1 text-2xl font-semibold">Mail operations dashboard</h2>
          </div>
          <div class="text-sm text-slate-300">{{ state.health?.ok ? 'API health: online' : 'API health: checking' }}</div>
        </div>

        <div v-if="state.notice" class="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">{{ state.notice }}</div>
        <div v-if="state.error" class="mb-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{{ state.error }}</div>

        <section v-if="state.route === 'inbox'" class="grid gap-6 xl:grid-cols-[360px_1fr]">
          <div class="space-y-6">
            <form class="panel-card space-y-4" @submit.prevent="createInbox">
              <div>
                <h3 class="section-title">Create inbox</h3>
                <p class="section-copy">Use a random local part or reserve a custom permanent address. The backend decides whether login is required.</p>
              </div>
              <div v-if="isPrivateLocked" class="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">Private mode requires a valid login or scoped API key before creating inboxes.</div>
              <label class="field-label text-slate-200">Mode
                <select v-model="inboxForm.mode" class="input-field"><option value="random">Random inbox</option><option value="custom">Custom local part</option></select>
              </label>
              <label v-if="inboxForm.mode === 'custom'" class="field-label text-slate-200">Local part<input v-model="inboxForm.localPart" class="input-field" placeholder="team-intake" /></label>
              <label class="field-label text-slate-200">Domain<select v-model="inboxForm.domain" class="input-field"><option v-for="domain in state.domains" :key="domain" :value="domain">{{ domain }}</option></select></label>
              <button class="primary-button w-full" type="submit" :disabled="state.loading">Create permanent inbox</button>
            </form>

            <div class="panel-card">
              <div class="mb-3 flex items-center justify-between"><h3 class="section-title">Saved inboxes</h3><button class="secondary-button" @click="loadMessages">Refresh</button></div>
              <div v-if="!state.inboxes.length" class="empty-state">No inboxes saved in this browser. Create one to start monitoring inbound messages.</div>
              <button v-for="inbox in state.inboxes" :key="inbox.id" class="inbox-row" :class="{ active: inbox.id === state.activeInboxId }" @click="state.activeInboxId = inbox.id; loadMessages()">
                <span class="font-medium">{{ inbox.address }}</span>
                <span class="text-xs text-slate-400">{{ inbox.status }} · {{ inbox.lastMessageAt || 'no messages yet' }}</span>
              </button>
            </div>
          </div>

          <div class="grid min-w-0 gap-6 xl:grid-cols-[minmax(260px,0.9fr)_minmax(320px,1.1fr)]">
            <div class="panel-card min-w-0">
              <div class="mb-4 flex items-center justify-between"><h3 class="section-title">Messages</h3><span class="status-chip">{{ state.messages.length }} loaded</span></div>
              <div v-if="!activeInbox" class="empty-state">Select or create an inbox to load messages.</div>
              <div v-else-if="!state.messages.length" class="empty-state">No messages stored for {{ activeInbox.address }}. Inbound mail appears here after Email Routing delivers it.</div>
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
                  <p class="mt-1 text-xs text-slate-500">Received {{ state.activeMessage.receivedAt }} · {{ state.activeMessage.sizeBytes || 0 }} bytes</p>
                </div>
                <p class="whitespace-pre-wrap rounded-xl bg-slate-950/70 p-4 text-sm leading-6 text-slate-200">{{ state.activeMessage.textBody || 'No plain text body stored.' }}</p>
                <div v-if="state.attachments.length" class="space-y-2"><p class="text-sm font-medium">Attachments</p><button v-for="item in state.attachments" :key="item.id" class="block w-full rounded-lg border border-white/10 p-3 text-left text-sm text-blue-200 hover:bg-blue-300/10" @click="downloadAttachment(item)">{{ item.filename }} · {{ item.size_bytes || item.sizeBytes }} bytes</button></div>
                <div class="flex flex-wrap gap-2"><button class="secondary-button" @click="loadSource"><svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="iconPath('source')" /></svg>View source</button><button class="danger-button" @click="deleteMessage(state.activeMessage)">Delete message</button></div>
                <pre v-if="state.source" class="max-h-72 overflow-auto rounded-xl bg-black p-4 text-xs text-slate-300">{{ state.source }}</pre>
              </div>
            </article>
          </div>
        </section>

        <section v-else-if="state.route === 'admin-users' && isAdmin" class="grid gap-6 xl:grid-cols-[360px_1fr]">
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
                    <td><button class="danger-button" :disabled="user.status !== 'active'" @click="disableUser(user)">Disable</button></td>
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
                <option v-for="user in state.users" :key="user.id" :value="user.id">{{ user.username }} · {{ user.role }}</option>
              </select>
            </label>
            <label class="field-label text-slate-200">Name<input v-model="keyForm.name" class="input-field" placeholder="mail automation" /></label>
            <label class="field-label text-slate-200">Scope
              <select v-model="keyForm.scope" class="input-field">
                <option value="inboxes:write">inboxes:write</option>
                <option value="inboxes:*">inboxes:*</option>
              </select>
            </label>
            <button class="primary-button w-full">Create key</button>
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
                    <td>{{ key.ownerUsername }}</td>
                    <td><code>{{ key.prefix }}</code></td>
                    <td>{{ key.status }}</td>
                    <td>{{ key.scopes.join(', ') }}</td>
                    <td class="space-x-2">
                      <button class="secondary-button" @click="resetApiKey(key)">Reset</button>
                      <button class="danger-button" :disabled="key.status !== 'active'" @click="revokeApiKey(key)">Revoke</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section v-else class="panel-card space-y-5">
          <div><h3 class="section-title">Status and settings</h3><p class="section-copy">This frontend stores only local session and inbox convenience state. Authorization, roles, API key hashing, and private mode decisions remain in the Worker API.</p></div>
          <dl class="grid gap-4 md:grid-cols-2"><div class="metric-card"><dt>Access mode</dt><dd>{{ state.config.accessMode }}</dd></div><div class="metric-card"><dt>Health</dt><dd>{{ state.health?.ok ? 'online' : 'unknown' }}</dd></div><div class="metric-card"><dt>Active domains</dt><dd>{{ state.domains.length }}</dd></div><div class="metric-card"><dt>Saved local inboxes</dt><dd>{{ state.inboxes.length }}</dd></div></dl>
          <div class="rounded-xl border border-white/10 bg-slate-950/60 p-4 text-sm text-slate-300"><p class="font-medium text-white">Security note</p><p class="mt-2">Admin navigation is hidden for non-admin sessions to reduce clutter. The server still returns 401 or 403 for admin APIs when a non-admin token calls them.</p></div>
        </section>
      </section>
    </div>
  </main>
</template>
