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
