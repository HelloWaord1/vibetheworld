import { getDb } from '../db/connection.js';
import type { Trade } from '../types/index.js';

export function createTrade(fromId: number, toId: number, offerItems: number[], offerGold: number, requestItems: number[], requestGold: number): Trade {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO trades (from_id, to_id, offer_items, offer_gold, request_items, request_gold)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(fromId, toId, JSON.stringify(offerItems), offerGold, JSON.stringify(requestItems), requestGold);
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(result.lastInsertRowid) as Trade;
}

export function getTradeById(id: number): Trade | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as Trade | undefined) || null;
}

export function getPendingTradesForPlayer(playerId: number): Trade[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM trades WHERE (from_id = ? OR to_id = ?) AND status = 'pending'
    ORDER BY created_at DESC
  `).all(playerId, playerId) as Trade[];
}

export function updateTradeStatus(id: number, status: 'accepted' | 'rejected'): void {
  const db = getDb();
  db.prepare('UPDATE trades SET status = ? WHERE id = ?').run(status, id);
}
