import { getDb } from '../db/connection.js';
import type { EventLog } from '../types/index.js';

export function logEvent(
  eventType: string,
  actorId: number | null,
  targetId: number | null,
  chunkX: number | null,
  chunkY: number | null,
  locationId: number | null,
  data: Record<string, unknown> = {}
): EventLog {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO event_log (event_type, actor_id, target_id, chunk_x, chunk_y, location_id, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(eventType, actorId, targetId, chunkX, chunkY, locationId, JSON.stringify(data));
  return db.prepare('SELECT * FROM event_log WHERE id = ?').get(result.lastInsertRowid) as EventLog;
}

export function getRecentEvents(chunkX: number, chunkY: number, limit = 10): EventLog[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM event_log WHERE chunk_x = ? AND chunk_y = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(chunkX, chunkY, limit) as EventLog[];
}
