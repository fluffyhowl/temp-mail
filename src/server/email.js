import { HttpError } from './http.js';
import { SIZE_LIMITS, assertTextSize, normalizeEmailAddress } from './security.js';

const MAX_RAW_BYTES = SIZE_LIMITS.rawEmailBytes;
const MAX_ATTACHMENT_BYTES = SIZE_LIMITS.attachmentBytes;
const MAX_ATTACHMENTS = SIZE_LIMITS.attachmentsPerMessage;

function requireDb(env) {
  if (!env.DB) throw new HttpError(500, 'database_not_configured', 'D1 database binding DB is required');
  return env.DB;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function normalizeAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  const bracket = /<([^>]+)>/.exec(text);
  return bracket ? bracket[1].trim() : text;
}

function splitAddress(address) {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return null;
  return { localPart: normalized.slice(0, at), domain: normalized.slice(at + 1), address: normalized };
}

function bytesToText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function readRawMessage(message) {
  if (message.raw) {
    const buffer = await new Response(message.raw).arrayBuffer();
    return new Uint8Array(buffer.slice(0, MAX_RAW_BYTES));
  }
  const text = [
    `From: ${message.from || ''}`,
    `To: ${message.to || ''}`,
    `Subject: ${message.headers?.get?.('subject') || ''}`,
    '',
    ''
  ].join('\r\n');
  return new TextEncoder().encode(text);
}

function unfoldHeaders(headerText) {
  return headerText.replace(/\r?\n[\t ]+/g, ' ');
}

function parseHeaders(rawText) {
  const split = /\r?\n\r?\n/.exec(rawText);
  const headerText = split ? rawText.slice(0, split.index) : rawText;
  const body = split ? rawText.slice(split.index + split[0].length) : '';
  const headers = new Map();
  for (const line of unfoldHeaders(headerText).split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function parseNameAndAddress(value) {
  const text = String(value || '').trim();
  const match = /^(.*?)\s*<([^>]+)>$/.exec(text);
  if (!match) return { name: null, address: normalizeAddress(text) || null };
  const name = match[1].trim().replace(/^"|"$/g, '') || null;
  return { name, address: normalizeAddress(match[2]) || null };
}

function parseAttachmentParts(rawText) {
  const contentType = /^content-type:\s*multipart\/[^;]+;\s*boundary="?([^";\r\n]+)"?/im.exec(rawText);
  if (!contentType) return [];
  const boundary = contentType[1];
  return rawText
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => parseHeaders(part.trim()))
    .filter((part) => /attachment/i.test(part.headers.get('content-disposition') || ''))
    .slice(0, MAX_ATTACHMENTS)
    .map((part) => {
      const disposition = part.headers.get('content-disposition') || '';
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || 'attachment.bin';
      const encoded = /base64/i.test(part.headers.get('content-transfer-encoding') || '');
      const cleaned = encoded ? part.body.replace(/\s+/g, '') : btoa(part.body.slice(0, MAX_ATTACHMENT_BYTES));
      const sizeBytes = encoded ? Math.floor((cleaned.length * 3) / 4) : part.body.length;
      if (sizeBytes > MAX_ATTACHMENT_BYTES) return null;
      return {
        filename,
        contentType: part.headers.get('content-type') || 'application/octet-stream',
        contentBase64: cleaned,
        sizeBytes
      };
    })
    .filter(Boolean);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function findInbox(db, recipient, config) {
  const parsed = splitAddress(recipient);
  if (parsed) normalizeEmailAddress(parsed.address);
  if (!parsed || !config.mailDomains.includes(parsed.domain)) {
    throw new HttpError(550, 'recipient_domain_not_configured', 'Recipient domain is not configured for this Worker');
  }
  const row = await db.prepare(`
    SELECT inboxes.id, inboxes.address, inboxes.status, inboxes.deleted_at, domains.status AS domain_status
    FROM inboxes JOIN domains ON domains.id = inboxes.domain_id
    WHERE lower(inboxes.local_part) = ? AND lower(domains.domain) = ?
  `).bind(parsed.localPart, parsed.domain).first();
  if (!row || row.status !== 'active' || row.deleted_at || row.domain_status !== 'active') {
    throw new HttpError(550, 'inbox_unavailable', 'Recipient inbox is unknown, disabled, or deleted');
  }
  return row;
}

async function storeAttachments(db, messageId, attachments) {
  for (const attachment of attachments) {
    await db.prepare(`
      INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, content_base64, content_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      makeId('att'),
      messageId,
      attachment.filename,
      attachment.contentType,
      attachment.sizeBytes,
      attachment.contentBase64,
      await sha256Hex(attachment.contentBase64)
    ).run();
  }
}

export async function handleInboundEmail(message, env, config) {
  const db = requireDb(env);
  const recipient = message.to || message.headers?.get?.('to');
  let inbox;
  try {
    inbox = await findInbox(db, recipient, config);
  } catch (error) {
    message.setReject?.(error.message || 'Recipient rejected');
    throw error;
  }

  const rawBytes = await readRawMessage(message);
  const rawText = bytesToText(rawBytes);
  const parsed = parseHeaders(rawText);
  assertTextSize(parsed.body || '', SIZE_LIMITS.messageBodyBytes, 'message_too_large');
  const from = parseNameAndAddress(parsed.headers.get('from') || message.from || '');
  const subject = parsed.headers.get('subject') || message.headers?.get?.('subject') || '';
  const attachments = parseAttachmentParts(rawText);
  const id = makeId('msg');
  await db.prepare(`
    INSERT INTO messages (id, inbox_id, provider_message_id, from_name, from_address, to_address, subject, text_body, html_body, raw_source, size_bytes, has_attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    inbox.id,
    message.headers?.get?.('message-id') || null,
    from.name,
    from.address,
    inbox.address,
    subject,
    parsed.body || null,
    null,
    rawText,
    rawBytes.byteLength,
    attachments.length > 0 ? 1 : 0
  ).run();
  await storeAttachments(db, id, attachments);
  await db.prepare("UPDATE inboxes SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(inbox.id).run();
  return { id, inboxId: inbox.id, attachmentsStored: attachments.length };
}
