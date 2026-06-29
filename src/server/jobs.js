import { HttpError } from './http.js';

function requireDb(env) {
  if (!env.DB) throw new HttpError(500, 'database_not_configured', 'D1 database binding DB is required');
  return env.DB;
}

export async function cleanupExpiredMessages(env, config) {
  const db = requireDb(env);
  const days = config.messageRetentionDays || 1;
  const oldMessages = await db.prepare(`
    SELECT id FROM messages
    WHERE received_at < datetime('now', ?)
  `).bind(`-${days} days`).all();
  const messageIds = oldMessages.results || [];
  for (const row of messageIds) {
    await db.prepare('DELETE FROM attachments WHERE message_id = ?').bind(row.id).run();
    await db.prepare('DELETE FROM messages WHERE id = ?').bind(row.id).run();
  }
  return { messagesDeleted: messageIds.length };
}
