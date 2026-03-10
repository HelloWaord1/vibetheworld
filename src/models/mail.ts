import { getDb } from '../db/connection.js';
import type { Mail, MailWithSender } from '../types/index.js';
import { MAX_INBOX_SIZE, MAX_GOLD } from '../types/index.js';

/**
 * Enforce the per-player inbox cap by deleting the oldest messages
 * that exceed MAX_INBOX_SIZE for the given player.
 */
function enforceInboxCap(playerId: number): void {
  const db = getDb();
  // Delete oldest mails beyond the cap (gold on unread overflow mails is lost)
  db.prepare(`
    DELETE FROM mail WHERE id IN (
      SELECT id FROM mail
      WHERE to_id = ?
      ORDER BY created_at DESC
      LIMIT -1 OFFSET ?
    )
  `).run(playerId, MAX_INBOX_SIZE);
}

export function sendMail(
  fromId: number,
  toId: number,
  subject: string,
  body: string,
  goldAttached: number = 0,
): Mail {
  const db = getDb();

  const insertAndCap = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO mail (from_id, to_id, subject, body, gold_attached)
      VALUES (?, ?, ?, ?, ?)
    `).run(fromId, toId, subject, body, goldAttached);

    enforceInboxCap(toId);

    return db.prepare('SELECT * FROM mail WHERE id = ?')
      .get(result.lastInsertRowid) as Mail;
  });

  return insertAndCap();
}

export function getInbox(
  playerId: number,
  page: number = 1,
): MailWithSender[] {
  const db = getDb();
  const offset = (page - 1) * 20;

  return db.prepare(`
    SELECT m.*, p.name AS sender_name
    FROM mail m
    JOIN players p ON p.id = m.from_id
    WHERE m.to_id = ?
    ORDER BY m.created_at DESC
    LIMIT 20 OFFSET ?
  `).all(playerId, offset) as MailWithSender[];
}

export function getMailById(
  mailId: number,
  playerId: number,
): MailWithSender | null {
  const db = getDb();
  const mail = db.prepare(`
    SELECT m.*, p.name AS sender_name
    FROM mail m
    JOIN players p ON p.id = m.from_id
    WHERE m.id = ? AND m.to_id = ?
  `).get(mailId, playerId) as MailWithSender | undefined;

  return mail ?? null;
}

export function markRead(mailId: number): void {
  const db = getDb();
  db.prepare('UPDATE mail SET is_read = 1 WHERE id = ?').run(mailId);
}

export function deleteMail(mailId: number, playerId: number): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM mail WHERE id = ? AND to_id = ?'
  ).run(mailId, playerId);

  return result.changes > 0;
}

export function getUnreadCount(playerId: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM mail WHERE to_id = ? AND is_read = 0'
  ).get(playerId) as { count: number };

  return row.count;
}

export function getInboxCount(playerId: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM mail WHERE to_id = ?'
  ).get(playerId) as { count: number };

  return row.count;
}

/**
 * Transfer gold attached to a mail to the recipient.
 * Only processes on first read (when mail was previously unread).
 * Returns the amount of gold transferred.
 */
export function claimMailGold(
  mailId: number,
  recipientId: number,
  goldAttached: number,
): number {
  if (goldAttached <= 0) return 0;

  const db = getDb();
  const player = db.prepare('SELECT gold FROM players WHERE id = ?')
    .get(recipientId) as { gold: number } | undefined;

  if (!player) return 0;

  const newGold = Math.min(player.gold + goldAttached, MAX_GOLD);
  db.prepare('UPDATE players SET gold = ? WHERE id = ?').run(newGold, recipientId);

  return goldAttached;
}
