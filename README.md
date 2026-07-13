# RDHX Email deployment and security guide

RDHX Email is a Cloudflare Workers temporary mail provider with permanent inbox addresses, one-day message retention, D1 storage, and server-side auth/API-key enforcement.

## Abuse controls

- No captcha is required or implemented. Abuse control is handled by server-side validation, D1-backed rate limits, admin disable controls, and message size caps.
- Rate limits are stored in the D1 `rate_limits` table for login, inbox creation, API key use, and message-heavy endpoints.
- Admin and private CORS origins must be explicit origins. Do not configure `CORS_PRIVATE_ORIGINS=*` or `CORS_ADMIN_ORIGINS=*`; startup validation rejects those values.
- Frontend code must not contain secrets, admin credentials, or API key plaintext. Secrets are Worker secrets only.

## Limits and validation

- Usernames: 3-32 lowercase letters, numbers, dots, underscores, or hyphens.
- Domains and addresses are validated server-side before use.
- JSON request bodies are capped at 16 KiB.
- Raw inbound email is capped at 512 KiB.
- Stored message body text is capped at 256 KiB.
- Attachments are capped at 128 KiB each and five attachments per message.

## Cloudflare setup

1. Create a D1 database and copy its database id into `wrangler.toml`:

   ```powershell
   npx wrangler d1 create rdhx-email-db
   ```

2. Apply the schema locally and remotely:

   ```powershell
   npx wrangler d1 execute rdhx-email-db --local --file schema.sql
   npx wrangler d1 execute rdhx-email-db --remote --file schema.sql
   ```

3. Create KV only if future deployment changes move large raw mail or attachment blobs out of D1. This task keeps the current app D1-only, so no KV secret or frontend key is needed.

4. Configure Cloudflare Email Routing manually in the dashboard:
   - Add and verify the receiving domain.
   - Enable Email Routing for the zone.
   - Add a catch-all or explicit destination route that sends mail to this Worker.
   - Keep accepted domains synchronized with `MAIL_DOMAINS` and the D1 `domains` table.
   - For multiple domains, every domain must have DNS/Email Routing configured and a matching `domains` row with `status='active'` and `is_verified=1`. When no domain is supplied to `POST /api/inboxes`, the Worker uses the first active verified domain in `MAIL_DOMAINS` order.

5. Configure Worker secrets. Use strong random values; never place these in frontend files:

   ```powershell
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put ADMIN_BOOTSTRAP_SECRET
   ```

6. Configure environment variables in `wrangler.toml` or the Cloudflare dashboard:

   ```toml
   ACCESS_MODE = "public" # or "private"
   PRIVACY_LOCK = "false" # config-only; true disables admin inbox/message inspection
   MAIL_DOMAINS = "rdhx.email"
   MESSAGE_RETENTION_DAYS = "1"
   CORS_PUBLIC_ORIGINS = "*"
   CORS_PRIVATE_ORIGINS = "https://app.rdhx.email"
   CORS_ADMIN_ORIGINS = "https://admin.rdhx.email"
   RATE_LIMIT_LOGIN_PER_MINUTE = "5"
   RATE_LIMIT_INBOX_CREATE_PER_MINUTE = "20"
   RATE_LIMIT_API_PER_MINUTE = "120"
   RATE_LIMIT_MESSAGE_READ_PER_MINUTE = "60"
   ```

   `ACCESS_MODE` is the fallback until an admin saves the D1-backed `app_settings.access_mode` value from the app. `PRIVACY_LOCK` is config-only; there is no UI or API toggle for it.

7. Build and deploy:

   ```powershell
   npm install
   npm test
   npm run build
   npx wrangler deploy
   ```

## Local verification suite

Run this sequence before deployment or after any security-sensitive change:

```powershell
npm install
npm test
npm run verify:schema
npm run verify:static
npm run build
npx wrangler d1 execute rdhx-email-db --local --file schema.sql
npm run verify
```

`npm test` executes runtime Worker/API assertions for config loading, admin auth, roles, API keys, public/private inbox creation, invalid password rejection, private unauthenticated rejection, revoked API key rejection, inbox-token message authorization, inbound email storage, and cleanup that deletes messages while keeping inbox rows. `npm run verify:schema` validates D1 schema invariants. `npm run verify:static` checks the SVG/no-emoji UI rule, no captcha implementation, no `btoa` password handling, and docs/env sanity.

## Admin bootstrap

After deploy, create the first admin by calling `/api/auth/bootstrap-admin` with `x-admin-bootstrap-secret`. The bootstrap secret must stay server-side and should be rotated or removed after the first admin exists.

## Retention

`MESSAGE_RETENTION_DAYS=1` is the default and recommended value. Scheduled cleanup deletes old messages and attachments only; it does not delete permanent inbox address rows.
