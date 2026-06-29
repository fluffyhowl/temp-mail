import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

function tableBody(name) {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([^;]+)\\);`, 'is').exec(schema);
  assert.ok(match, `missing ${name} table`);
  return match[1];
}

for (const table of ['domains', 'users', 'sessions', 'inboxes', 'messages', 'attachments', 'api_keys', 'rate_limits', 'audit_events']) {
  tableBody(table);
}

const inboxes = tableBody('inboxes');
assert.match(inboxes, /status TEXT NOT NULL DEFAULT 'active'/i);
assert.match(inboxes, /disabled_at TEXT/i);
assert.match(inboxes, /deleted_at TEXT/i);
assert.doesNotMatch(inboxes, /expires_at/i, 'permanent inboxes must not have normal expiry');

const messages = tableBody('messages');
assert.match(messages, /received_at TEXT NOT NULL/i);
assert.match(messages, /deleted_at TEXT/i);

const apiKeys = tableBody('api_keys');
assert.match(apiKeys, /key_hash TEXT NOT NULL UNIQUE/i);
assert.match(apiKeys, /key_prefix TEXT NOT NULL UNIQUE/i);
assert.doesNotMatch(apiKeys, /plaintext|secret_key|api_key TEXT/i, 'API key plaintext must not be persisted');

for (const indexName of [
  'idx_messages_cleanup',
  'idx_attachments_cleanup',
  'idx_inboxes_address_status',
  'idx_api_keys_hash',
  'idx_api_keys_prefix_status',
  'idx_rate_limits_bucket_window'
]) {
  assert.match(schema, new RegExp(`CREATE INDEX IF NOT EXISTS ${indexName}`, 'i'), `missing ${indexName}`);
}

console.log('schema verification passed');
