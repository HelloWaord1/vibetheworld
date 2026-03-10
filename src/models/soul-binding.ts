import { getDb } from '../db/connection.js';
import type { SoulBinding } from '../types/index.js';
import { SOUL_BIND_DURATION_HOURS } from '../types/index.js';

export function getActiveSoulBinding(playerId: number): SoulBinding | null {
  const db = getDb();
  const binding = db.prepare(
    `SELECT * FROM soul_bindings WHERE player_id = ? AND expires_at > datetime('now')`
  ).get(playerId) as SoulBinding | undefined;
  return binding ?? null;
}

export function createSoulBinding(playerId: number, tavernLocationId: number, chunkX: number, chunkY: number): SoulBinding {
  const db = getDb();
  // Remove any existing binding
  db.prepare('DELETE FROM soul_bindings WHERE player_id = ?').run(playerId);
  
  const result = db.prepare(
    `INSERT INTO soul_bindings (player_id, tavern_location_id, tavern_chunk_x, tavern_chunk_y, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+${SOUL_BIND_DURATION_HOURS} hours'))`
  ).run(playerId, tavernLocationId, chunkX, chunkY);
  
  return db.prepare('SELECT * FROM soul_bindings WHERE id = ?').get(result.lastInsertRowid) as SoulBinding;
}

export function removeSoulBinding(playerId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM soul_bindings WHERE player_id = ?').run(playerId);
}

export function cleanupExpiredBindings(): number {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM soul_bindings WHERE expires_at <= datetime('now')`
  ).run();
  return result.changes;
}
