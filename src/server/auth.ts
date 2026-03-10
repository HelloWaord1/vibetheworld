import { getPlayerByToken } from '../models/player.js';
import { getDb } from '../db/connection.js';
import type { Player } from '../types/index.js';

export function authenticate(token: string): Player {
  const player = getPlayerByToken(token);
  if (!player) throw new Error('Invalid or expired token. Please login again.');
  if (!player.is_alive) throw new Error('This character is dead. Register a new character.');

  // Check if player is banned
  const db = getDb();
  const ban = db.prepare(
    `SELECT expires_at FROM player_bans WHERE player_id = ?`,
  ).get(player.id) as { expires_at: string | null } | undefined;

  if (ban) {
    if (ban.expires_at === null) {
      throw new Error('Your account has been permanently banned.');
    }
    const expiresAt = new Date(ban.expires_at + 'Z').getTime();
    if (expiresAt > Date.now()) {
      throw new Error(`Your account is banned until ${ban.expires_at} UTC.`);
    }
    // Ban has expired, remove it
    db.prepare('DELETE FROM player_bans WHERE player_id = ?').run(player.id);
  }

  return player;
}
