import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const frontendDir = join(root, 'src', 'frontend');
const serverDir = join(root, 'src', 'server');
const readmePath = join(root, 'README.md');

function walk(dir, predicate = () => true) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path, predicate));
    else if (predicate(path)) out.push(path);
  }
  return out;
}

function read(path) {
  return readFileSync(path, 'utf8');
}

const textFile = (path) => /\.(vue|js|css|html|md|toml|sql)$/i.test(path);
const frontendFiles = walk(frontendDir, textFile);
assert.ok(frontendFiles.length > 0, 'frontend files must exist');

const emojiPattern = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const emoticonPattern = /(^|\s)(:\)|:-\)|:\(|:-\(|;\)|;-\)|:D|:-D|<3)(\s|$)/;
for (const file of frontendFiles) {
  const content = read(file);
  assert.doesNotMatch(content, emojiPattern, `emoji found in ${relative(root, file)}`);
  assert.doesNotMatch(content, emoticonPattern, `emoticon found in ${relative(root, file)}`);
}

const appVue = read(join(frontendDir, 'App.vue'));
assert.match(appVue, /<svg\b/i, 'frontend must render SVG icons');
assert.match(appVue, /iconPath\(/, 'frontend must use icon paths instead of emoji icons');
assert.doesNotMatch(appVue, /v-html=/i, 'email HTML must not be rendered with unrestricted v-html');
assert.match(appVue, /sandbox="allow-popups allow-popups-to-escape-sandbox"/, 'email HTML iframe must remain sandboxed for safe user-clicked links');
assert.doesNotMatch(appVue, /allow-scripts/i, 'email iframe must not enable scripts');
assert.match(appVue, /docsSections\s*=\s*computed/, 'Docs must be generated from documented sections');
assert.match(appVue, /copyCodeBlock\(/, 'Docs code blocks must have copy buttons');
assert.match(appVue, /navigator\.clipboard\.writeText/, 'Docs copy buttons must use Clipboard API');
assert.match(appVue, /<button class="docs-copy-button"[^>]+aria-label="Copy code"/, 'Docs copy buttons need accessible labels');
assert.doesNotMatch(appVue, /Step 1 \?/, 'Docs must not show broken Step 1 heading');
assert.doesNotMatch(appVue, /Step 2 \?/, 'Docs must not show broken Step 2 heading');
assert.doesNotMatch(appVue, /Step 3 \?/, 'Docs must not show broken Step 3 heading');
assert.doesNotMatch(appVue, /localhost|127\.0\.0\.1|http:\/\/127\.0\.0\.1:8787|http:\/\/localhost/i, 'Docs must not hardcode local-only URLs');
assert.doesNotMatch(appVue, /rdhx_[A-Za-z0-9_-]{12,}/, 'Docs must not contain real-looking API keys');
for (const requiredDocsText of [
  'Step 1 \\u2014 Create an email',
  'Step 2 \\u2014 List messages',
  'Step 3 \\u2014 Read one message',
  'Optional \\u2014 Read safe HTML',
  'Optional \\u2014 Download attachments',
  'GET /api/messages/<MESSAGE_ID>/html',
  'GET /api/messages/<MESSAGE_ID>/raw'
]) {
  assert.ok(appVue.includes(requiredDocsText), `Docs missing ${requiredDocsText}`);
}

const runtimeFiles = [
  ...walk(join(root, 'src'), textFile),
  join(root, 'package.json'),
  join(root, 'wrangler.toml')
];
const runtimeText = runtimeFiles.map((file) => read(file)).join('\n');
assert.doesNotMatch(runtimeText, /captcha/i, 'captcha must not be implemented in runtime code/config');
const authText = read(join(serverDir, 'auth.js'));
assert.doesNotMatch(authText, /btoa\s*\(/, 'passwords must not use btoa');
assert.doesNotMatch(runtimeText, /sessionStorage/i, 'frontend sessionStorage must not be a security boundary');

const serverText = walk(serverDir, (path) => path.endsWith('.js')).map((file) => read(file)).join('\n');
assert.match(serverText, /requireRole\(/, 'server must enforce roles');
assert.match(serverText, /verifyApiKey\(|requireInboxAccess\(/, 'server must enforce API key or inbox message authorization');

const docs = read(readmePath);
for (const required of [
  'npm test',
  'npm run build',
  'npm run verify:schema',
  'npm run verify:static',
  'npx wrangler d1 execute rdhx-email-db --local --file schema.sql',
  'ACCESS_MODE = "public"',
  'MESSAGE_RETENTION_DAYS = "1"',
  'Email Routing',
  'Worker secrets'
]) {
  assert.ok(docs.includes(required), `README missing ${required}`);
}

assert.ok(existsSync(join(root, 'schema.sql')), 'schema.sql must exist');
console.log('static verification passed');
