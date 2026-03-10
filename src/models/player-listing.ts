import { getDb } from '../db/connection.js';
import type { PlayerListing } from '../types/index.js';

export function createListing(sellerId: number, itemId: number, price: number, chunkX: number, chunkY: number, locationId: number | null): PlayerListing {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO player_listings (seller_id, item_id, price, chunk_x, chunk_y, location_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sellerId, itemId, price, chunkX, chunkY, locationId);
  return db.prepare('SELECT * FROM player_listings WHERE id = ?').get(result.lastInsertRowid) as PlayerListing;
}

export function getListingById(id: number): PlayerListing | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM player_listings WHERE id = ?').get(id) as PlayerListing | undefined) || null;
}

export function getListingsAtLocation(chunkX: number, chunkY: number, locationId: number | null): PlayerListing[] {
  const db = getDb();
  if (locationId !== null) {
    return db.prepare('SELECT * FROM player_listings WHERE chunk_x = ? AND chunk_y = ? AND location_id = ?').all(chunkX, chunkY, locationId) as PlayerListing[];
  }
  return db.prepare('SELECT * FROM player_listings WHERE chunk_x = ? AND chunk_y = ? AND location_id IS NULL').all(chunkX, chunkY) as PlayerListing[];
}

export function getListingsBySeller(playerId: number): PlayerListing[] {
  const db = getDb();
  return db.prepare('SELECT * FROM player_listings WHERE seller_id = ?').all(playerId) as PlayerListing[];
}

export function deleteListing(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM player_listings WHERE id = ?').run(id);
}

export function getListingByItemId(itemId: number): PlayerListing | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM player_listings WHERE item_id = ?').get(itemId) as PlayerListing | undefined) || null;
}
