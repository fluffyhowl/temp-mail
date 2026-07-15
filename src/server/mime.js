const DEFAULT_CHARSET = 'utf-8';
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 128 * 1024;

function splitHeaderBody(rawText) {
  const match = /\r?\n\r?\n/.exec(rawText || '');
  if (!match) return { headerText: rawText || '', body: '' };
  return {
    headerText: rawText.slice(0, match.index),
    body: rawText.slice(match.index + match[0].length)
  };
}

function unfoldHeaders(headerText) {
  return String(headerText || '').replace(/\r?\n[\t ]+/g, ' ');
}

export function parseHeaders(rawText) {
  const { headerText, body } = splitHeaderBody(rawText);
  const headers = new Map();
  for (const line of unfoldHeaders(headerText).split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function splitHeaderParam(value) {
  const parts = [];
  let current = '';
  let quote = '';
  for (const char of String(value || '')) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function unquote(value) {
  return String(value || '').trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

function parseHeaderValue(value) {
  const parts = splitHeaderParam(value);
  const type = (parts.shift() || '').toLowerCase();
  const params = new Map();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    params.set(part.slice(0, eq).trim().toLowerCase(), decodeHeaderValue(unquote(part.slice(eq + 1).trim())));
  }
  return { type, params };
}

function bytesFromBinaryString(value) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

function bytesToBinaryString(bytes) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    output += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return output;
}

export function bytesToBase64(bytes) {
  return btoa(bytesToBinaryString(bytes));
}

function base64ToBytes(value) {
  const cleaned = String(value || '').replace(/\s+/g, '');
  if (!cleaned) return new Uint8Array();
  return bytesFromBinaryString(atob(cleaned));
}

function decodeCharset(bytes, charset = DEFAULT_CHARSET) {
  const label = String(charset || DEFAULT_CHARSET).trim().toLowerCase().replace(/^"|"$/g, '') || DEFAULT_CHARSET;
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder(DEFAULT_CHARSET, { fatal: false }).decode(bytes);
  }
}

function decodeQuotedPrintableBytes(value, headerMode = false) {
  const source = String(value || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (headerMode && char === '_') {
      bytes.push(0x20);
      continue;
    }
    if (char === '=' && /^[0-9a-fA-F]{2}$/.test(source.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(bytes);
}

function decodeHeaderValue(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_match, charset, encoding, encoded) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? base64ToBytes(encoded)
        : decodeQuotedPrintableBytes(encoded, true);
      return decodeCharset(bytes, charset);
    } catch {
      return encoded;
    }
  });
}

function decodeRfc2231Value(value) {
  const text = String(value || '');
  const match = /^([^']*)'[^']*'(.*)$/.exec(text);
  if (!match) return decodeHeaderValue(unquote(text));
  try {
    return decodeURIComponent(match[2].replace(/%/g, '%'));
  } catch {
    return decodeHeaderValue(match[2]);
  }
}

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function cleanTextBody(value) {
  const text = normalizeNewlines(value).trim();
  return text || null;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function htmlToText(html) {
  const text = sanitizeEmailHtml(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|section|article|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return cleanTextBody(decodeHtmlEntities(text));
}

function decodePartBody(body, headers, contentType) {
  const transfer = String(headers.get('content-transfer-encoding') || '').trim().toLowerCase();
  if (transfer === 'base64') return base64ToBytes(body);
  if (transfer === 'quoted-printable') return decodeQuotedPrintableBytes(body);
  return new TextEncoder().encode(body || '');
}

export function sanitizeEmailHtml(html) {
  return String(html || '')
    .replace(/<!doctype[\s\S]*?>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link|base|frame|frameset)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link|base|frame|frameset)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href)\s*=\s*("|')\s*(javascript:|vbscript:|data:text\/html)[\s\S]*?\2/gi, '')
    .replace(/\s+(href|src|xlink:href)\s*=\s*([^\s>]*\s*(?:javascript:|vbscript:|data:text\/html)[^\s>]*)/gi, '');
}

function contentTypeOf(headers) {
  const parsed = parseHeaderValue(headers.get('content-type') || 'text/plain; charset=utf-8');
  return {
    type: parsed.type || 'text/plain',
    params: parsed.params,
    charset: parsed.params.get('charset') || DEFAULT_CHARSET,
    boundary: parsed.params.get('boundary') || ''
  };
}

function dispositionOf(headers) {
  return parseHeaderValue(headers.get('content-disposition') || '');
}

function filenameFrom(headers, contentType, disposition) {
  const filenameStar = disposition.params.get('filename*') || contentType.params.get('name*');
  if (filenameStar) return decodeRfc2231Value(filenameStar);
  return disposition.params.get('filename') || contentType.params.get('name') || 'attachment.bin';
}

function isAttachment(headers, contentType, disposition) {
  return disposition.type === 'attachment' || Boolean(disposition.params.get('filename') || disposition.params.get('filename*') || contentType.params.get('name') || contentType.params.get('name*'));
}

function normalizeContentId(value) {
  return String(value || '').trim().replace(/^<|>$/g, '').toLowerCase() || null;
}

function splitMultipartBody(body, boundary) {
  const marker = `--${boundary}`;
  const sections = String(body || '').split(marker).slice(1);
  const parts = [];
  for (const section of sections) {
    if (section.startsWith('--')) break;
    parts.push(section.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
  }
  return parts;
}

function appendText(result, key, value) {
  const text = cleanTextBody(value);
  if (!text) return;
  result[key] = result[key] ? `${result[key]}\n\n${text}` : text;
}

function parseEntity(rawText, result, depth = 0) {
  if (depth > 20) return;
  const { headers, body } = parseHeaders(rawText);
  const contentType = contentTypeOf(headers);
  const disposition = dispositionOf(headers);

  if (contentType.type.startsWith('multipart/') && contentType.boundary) {
    for (const part of splitMultipartBody(body, contentType.boundary)) parseEntity(part, result, depth + 1);
    return;
  }

  const bytes = decodePartBody(body, headers, contentType);
  const attachment = isAttachment(headers, contentType, disposition);
  if (attachment) {
    if (result.attachments.length >= MAX_ATTACHMENTS || bytes.byteLength > MAX_ATTACHMENT_BYTES) return;
    result.attachments.push({
      filename: filenameFrom(headers, contentType, disposition),
      contentType: contentType.type || 'application/octet-stream',
      contentBase64: bytesToBase64(bytes),
      sizeBytes: bytes.byteLength,
      contentId: normalizeContentId(headers.get('content-id'))
    });
    return;
  }

  if (contentType.type === 'text/plain') {
    appendText(result, 'textBody', decodeCharset(bytes, contentType.charset));
    return;
  }

  if (contentType.type === 'text/html') {
    const html = sanitizeEmailHtml(decodeCharset(bytes, contentType.charset)).trim();
    if (html) result.htmlBody = result.htmlBody ? `${result.htmlBody}<hr>${html}` : html;
    return;
  }

  if (!contentType.type || contentType.type === 'application/octet-stream') {
    appendText(result, 'textBody', decodeCharset(bytes, contentType.charset));
  }
}

export function parseNameAndAddress(value) {
  const text = decodeHeaderValue(String(value || '').trim());
  const match = /^(.*?)\s*<([^>]+)>$/.exec(text);
  if (!match) return { name: null, address: normalizeAddressOnly(text) || null };
  const name = match[1].trim().replace(/^"|"$/g, '') || null;
  return { name, address: normalizeAddressOnly(match[2]) || null };
}

function normalizeAddressOnly(value) {
  const text = String(value || '').trim().toLowerCase();
  const bracket = /<([^>]+)>/.exec(text);
  return bracket ? bracket[1].trim() : text;
}

export function parseMimeMessage(rawText) {
  const source = String(rawText || '');
  const root = parseHeaders(source);
  const result = {
    subject: decodeHeaderValue(root.headers.get('subject') || ''),
    from: parseNameAndAddress(root.headers.get('from') || ''),
    to: parseNameAndAddress(root.headers.get('to') || ''),
    textBody: null,
    htmlBody: null,
    attachments: []
  };
  parseEntity(source, result);
  if (!result.textBody && !result.htmlBody) {
    const fallback = cleanTextBody(root.body);
    if (fallback && !looksLikeRawMime(fallback)) result.textBody = fallback;
  }
  return result;
}

export function looksLikeRawMime(value) {
  const text = String(value || '');
  return /^--[A-Za-z0-9'()+_,.\/:=?-]+/m.test(text)
    || /^Content-Type:/im.test(text)
    || /^Content-Transfer-Encoding:/im.test(text)
    || /\r?\n--[A-Za-z0-9'()+_,.\/:=?-]+/.test(text);
}

export function readableStoredBodies(row) {
  let textBody = row?.text_body || null;
  let htmlBody = row?.html_body ? sanitizeEmailHtml(row.html_body) : null;
  if (looksLikeRawMime(textBody) || (!htmlBody && row?.raw_source && looksLikeRawMime(row.raw_source))) {
    const parsed = parseMimeMessage(row.raw_source || textBody || '');
    textBody = parsed.textBody || null;
    htmlBody = parsed.htmlBody || htmlBody || null;
  }
  if (textBody && looksLikeRawMime(textBody)) textBody = 'No readable body was parsed for this message.';
  if (!textBody && !htmlBody && row?.raw_source && !looksLikeRawMime(row.raw_source)) textBody = cleanTextBody(row.raw_source);
  return { textBody, htmlBody };
}

export function readableMessageText(row) {
  const { textBody, htmlBody } = readableStoredBodies(row);
  const text = cleanTextBody(textBody);
  if (text && text !== 'No readable body was parsed for this message.') return text;
  return htmlToText(htmlBody) || '';
}
