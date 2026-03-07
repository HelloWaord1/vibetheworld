import { getDb } from '../db/connection.js';
import type { Discovery } from '../types/index.js';

export function hasDiscovered(playerId: number, locationId: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM discoveries WHERE player_id = ? AND location_id = ?').get(playerId, locationId);
  return !!row;
}

export function recordDiscovery(playerId: number, locationId: number): Discovery {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO discoveries (player_id, location_id) VALUES (?, ?)').run(playerId, locationId);
  return db.prepare('SELECT * FROM discoveries WHERE player_id = ? AND location_id = ?').get(playerId, locationId) as Discovery;
}

export function getPlayerDiscoveries(playerId: number): Discovery[] {
  const db = getDb();
  return db.prepare('SELECT * FROM discoveries WHERE player_id = ?').all(playerId) as Discovery[];
}
