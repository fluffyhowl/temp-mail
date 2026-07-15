# Temp-Mail

Temp-Mail is a Cloudflare Workers + Vue temporary email application. It provides public temporary inboxes, authenticated member dashboards, admin user/API-key management, inbound email handling through Cloudflare Email Routing, D1-backed persistence, and strict server-side ownership checks.

## Features

- **Public Home inbox**
  - Generate a temporary email address.
  - Open an inbox directly from `/<EMAIL_ADDRESS>`.
  - Read message lists and message details from the Home inbox panel.
  - Refresh the active inbox without switching addresses.

- **Authenticated Dashboard**
  - Member-owned saved inboxes.
  - Message list/detail reading for owned inboxes only.
  - API-key request workflow for members.

- **Admin tools**
  - Manage active/disabled users.
  - Manage active/revoked API keys.
  - Review and approve/reject API-key access requests.
  - Switch Access Mode through admin settings when enabled by backend config.

- **API access**
  - Bearer-token API keys.
  - Single internal permission scope: `inboxes:write`.
  - API keys can create inboxes and read messages only for inboxes owned by the API-key user.
  - Plaintext API keys are shown only once.

- **Security controls**
  - D1-backed sessions and API-key lifecycle.
  - Disabled users cannot log in or use API keys.
  - Revoked API keys cannot be used or reset.
  - Member/API-key inbox access is owner-scoped server-side.
  - Public/private access mode enforcement.
  - Config-only Privacy Lock for admin message inspection.
  - Server-side rate limits.
  - PBKDF2-SHA256 password hashing with Cloudflare Workers-compatible iterations.

## Tech stack

- Cloudflare Workers
- Cloudflare D1
- Cloudflare KV binding placeholder for Worker config compatibility
- Cloudflare Email Routing / Email Workers
- Vue 3
- Vite
- Wrangler

## Repository structure

```text
.
├─ public/                 Static public assets, including favicon.svg
├─ src/frontend/           Vue frontend and CSS
├─ src/server/             Worker API, auth, inbox, email, MIME, and security modules
├─ src/worker/             Cloudflare Worker entrypoint
├─ migrations/             D1 migrations
├─ tests/                  Runtime and static verification scripts
├─ schema.sql              Fresh D1 schema snapshot
├─ wrangler.toml           Cloudflare Worker configuration
└─ README.md
```

## Important security notes before publishing

This repository is intended to be safe for a public GitHub repository when committed through Git.

Do **not** commit or upload these local/generated files:

- `.dev.vars`
- `.env`
- `.env.*`
- `.wrangler/`
- `node_modules/`
- `dist/`
- local SQLite/database dumps
- real API keys, session tokens, JWTs, or admin bootstrap secrets

The current `.gitignore` excludes those local/generated files. If you upload files manually through the GitHub web UI, do not drag those ignored files into the upload.

Secrets must be stored as Cloudflare Worker secrets, not in source code.

## Required Cloudflare resources

1. Cloudflare account with Workers enabled.
2. A D1 database.
3. A verified domain configured for Cloudflare Email Routing.
4. Email Routing rule/catch-all that sends inbound mail to this Worker.
5. Worker secrets:
   - `SESSION_SECRET`
   - `JWT_SECRET`
   - `ADMIN_BOOTSTRAP_SECRET`

## Local setup

Install dependencies:

```powershell
npm install
```

Create local secrets in `.dev.vars`:

```text
SESSION_SECRET=<strong-random-local-secret>
JWT_SECRET=<strong-random-local-secret>
ADMIN_BOOTSTRAP_SECRET=<strong-random-local-secret>
```

Never commit `.dev.vars`.

Run the frontend dev server:

```powershell
npm run dev
```

Run the Worker locally with Wrangler:

```powershell
npm run worker:dev
```

## D1 setup

Create the D1 database:

```powershell
npx wrangler d1 create rdhx-email-db
```

Copy the generated database id into `wrangler.toml` under `[[d1_databases]]`.

For a fresh local database, apply the schema:

```powershell
npx wrangler d1 execute rdhx-email-db --local --file schema.sql
```

For a fresh remote database, apply the schema:

```powershell
npx wrangler d1 execute rdhx-email-db --remote --file schema.sql
```

For an existing database, apply migrations instead:

```powershell
npx wrangler d1 migrations apply rdhx-email-db --local
npx wrangler d1 migrations apply rdhx-email-db --remote
```

The project currently includes migrations through:

```text
migrations/0005_add_attachment_content_id.sql
```

## Seed an active mail domain

`MAIL_DOMAINS` config declares allowed domains, but `/api/domains` uses the D1 `domains` table for active/verified domains. Seed at least one active verified domain locally:

```powershell
npx wrangler d1 execute rdhx-email-db --local --command "INSERT OR REPLACE INTO domains (id, domain, status, is_verified, created_at, updated_at) VALUES ('domain_rdhx_email', 'rdhx.email', 'active', 1, datetime('now'), datetime('now'));"
```

Seed the remote database after the domain is configured and verified in Cloudflare Email Routing:

```powershell
npx wrangler d1 execute rdhx-email-db --remote --command "INSERT OR REPLACE INTO domains (id, domain, status, is_verified, created_at, updated_at) VALUES ('domain_rdhx_email', 'rdhx.email', 'active', 1, datetime('now'), datetime('now'));"
```

For multiple domains, every domain must be:

- configured in Cloudflare DNS,
- enabled and verified in Cloudflare Email Routing,
- present in `MAIL_DOMAINS`, and
- present in the D1 `domains` table with `status='active'` and `is_verified=1`.

When no domain is supplied to `POST /api/inboxes`, the Worker chooses the first active verified configured domain.

## Environment configuration

`wrangler.toml` contains non-secret runtime variables. Adjust these before production deploy:

```toml
ACCESS_MODE = "public" # public or private
PRIVACY_LOCK = "false" # true blocks admin inbox/message inspection
MAIL_DOMAINS = "rdhx.email"
MESSAGE_RETENTION_DAYS = "1"
CORS_PUBLIC_ORIGINS = "https://your-domain.example"
CORS_PRIVATE_ORIGINS = "https://your-domain.example"
CORS_ADMIN_ORIGINS = "https://your-domain.example"
RATE_LIMIT_LOGIN_PER_MINUTE = "5"
RATE_LIMIT_INBOX_CREATE_PER_MINUTE = "20"
RATE_LIMIT_API_PER_MINUTE = "120"
```

Notes:

- `ACCESS_MODE` can be `public` or `private`.
- `PRIVACY_LOCK` is config-only. There is no UI toggle.
- Keep private/admin CORS origins explicit. Do not use `*` for private/admin origins.
- `MAIL_DOMAINS` is a comma-separated allowlist of domains owned/configured by you.

## Worker secrets

Set production secrets through Wrangler. Use the interactive prompts and do not paste secret values into source files.

```powershell
npx wrangler secret put SESSION_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_BOOTSTRAP_SECRET
```

Optional checks:

```powershell
npx wrangler secret list
npx wrangler whoami
```

## Build, test, and verify

Run this before deploy:

```powershell
npm test
npm run verify:schema
npm run verify:static
npm run build
```

Or run the combined verification command:

```powershell
npm run verify
```

What the checks cover:

- config and router behavior,
- admin auth and bootstrap behavior,
- user disable/enable behavior,
- API key lifecycle,
- API-key request workflow,
- public/private inbox behavior,
- inbox/message ownership enforcement,
- inbound email storage/parsing,
- schema invariants,
- static frontend/docs sanity checks.

## Deploy

Build and deploy:

```powershell
npm run build
npx wrangler deploy
```

Or use the package script:

```powershell
npm run deploy
```

After deploy:

1. Confirm the Worker URL or custom domain opens the Vue app.
2. Confirm `/api/health` returns OK.
3. Confirm `/api/config` returns expected public config.
4. Confirm `/api/domains` returns at least one active verified domain.
5. Confirm Email Routing delivers inbound mail to the Worker.

## Bootstrap the first admin

Create the first admin only after deploying secrets and schema.

PowerShell example:

```powershell
$BootstrapSecret = Read-Host 'ADMIN_BOOTSTRAP_SECRET'
$Body = @{
  username = 'admin'
  password = '<temporary-strong-password>'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri 'https://your-domain.example/api/auth/bootstrap-admin' `
  -Headers @{ 'x-admin-bootstrap-secret' = $BootstrapSecret } `
  -ContentType 'application/json' `
  -Body $Body
```

After the first admin exists:

- sign in through the Login page,
- create named admin/member users as needed,
- rotate or remove the bootstrap secret if your operational process allows it.

## API quick start

Use API keys with the standard bearer header:

```text
Authorization: Bearer <API_KEY>
```

Create a random inbox:

```powershell
$BaseUrl = 'https://your-domain.example'
$Headers = @{ Authorization = 'Bearer <API_KEY>' }

Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/api/inboxes" `
  -Headers $Headers `
  -ContentType 'application/json' `
  -Body '{}'
```

Create a custom local part with an automatic domain:

```powershell
$Body = @{ localPart = 'demo' } | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/api/inboxes" `
  -Headers $Headers `
  -ContentType 'application/json' `
  -Body $Body
```

List messages by address:

```powershell
$Address = [uri]::EscapeDataString('<EMAIL_ADDRESS>')
Invoke-RestMethod -Uri "$BaseUrl/api/messages?address=$Address" -Headers $Headers
```

Read one message:

```powershell
Invoke-RestMethod -Uri "$BaseUrl/api/messages/<MESSAGE_ID>" -Headers $Headers
```

Discover configured active domains:

```powershell
Invoke-RestMethod -Uri "$BaseUrl/api/domains"
```

## Public/private access behavior

- Public mode allows intentional public inbox creation and reading through Home/API.
- Private mode requires authenticated sessions or API keys for protected behavior.
- Member users can only list/read inboxes they own.
- API-key users can only list/read inboxes owned by the key owner.
- Admin global inspection remains admin-only and is blocked when Privacy Lock is enabled.

## Email Routing notes

Cloudflare Email Routing must be configured outside this repository:

1. Add the receiving domain to Cloudflare.
2. Enable Email Routing for the zone.
3. Verify required DNS records.
4. Create a route or catch-all for the domain.
5. Route matching mail to the deployed Worker.
6. Keep the D1 `domains` table synchronized with active verified domains.

## Retention and cleanup

`MESSAGE_RETENTION_DAYS=1` is the recommended default. The scheduled Worker cleanup deletes expired messages and attachments while keeping inbox address rows.

The Worker has a daily cron trigger in `wrangler.toml`:

```toml
[triggers]
crons = ["0 0 * * *"]
```

## Public GitHub checklist

Before pushing to a public repository:

```powershell
git status --short
git ls-files | Select-String -Pattern '\.dev\.vars|\.env|\.wrangler|node_modules|dist'
npm test
npm run verify:schema
npm run verify:static
npm run build
```

Also confirm manually:

- no `.dev.vars` or `.env` file is staged,
- no real API keys are in README, tests, or docs,
- `wrangler.toml` contains only non-secret config and placeholder/resource IDs,
- Cloudflare secrets are set with `wrangler secret put`,
- the `domains` table contains only domains you own and control.

## License

Add your preferred license before publishing if you want others to reuse the code. If no license is added, the repository is public-source but not automatically open-source licensed.
