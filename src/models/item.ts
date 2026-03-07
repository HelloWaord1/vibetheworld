import { getDb } from '../db/connection.js';
import type { Item, ItemType, Rarity } from '../types/index.js';

export function createItem(
  name: string, description: string, itemType: ItemType,
  opts: {
    damage_bonus?: number; defense_bonus?: number; stat_bonuses?: Record<string, number>;
    heal_amount?: number; value?: number; owner_id?: number | null;
    chunk_x?: number | null; chunk_y?: number | null; location_id?: number | null;
    rarity?: Rarity;
  } = {}
): Item {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO items (name, description, item_type, damage_bonus, defense_bonus, stat_bonuses, heal_amount, value, owner_id, chunk_x, chunk_y, location_id, rarity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, description, itemType,
    opts.damage_bonus || 0, opts.defense_bonus || 0, JSON.stringify(opts.stat_bonuses || {}),
    opts.heal_amount || 0, opts.value || 0,
    opts.owner_id ?? null, opts.chunk_x ?? null, opts.chunk_y ?? null, opts.location_id ?? null,
    opts.rarity || 'common'
  );
  return getItemById(result.lastInsertRowid as number)!;
}

export function getItemById(id: number): Item | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined) || null;
}

export function getItemsByOwner(ownerId: number): Item[] {
  const db = getDb();
  return db.prepare('SELECT * FROM items WHERE owner_id = ?').all(ownerId) as Item[];
}

export function getItemsAtLocation(chunkX: number, chunkY: number, locationId: number | null): Item[] {
  const db = getDb();
  if (locationId !== null) {
    return db.prepare('SELECT * FROM items WHERE chunk_x = ? AND chunk_y = ? AND location_id = ? AND owner_id IS NULL').all(chunkX, chunkY, locationId) as Item[];
  }
  return db.prepare('SELECT * FROM items WHERE chunk_x = ? AND chunk_y = ? AND location_id IS NULL AND owner_id IS NULL').all(chunkX, chunkY) as Item[];
}

export function transferToPlayer(itemId: number, playerId: number): void {
  const db = getDb();
  db.prepare('UPDATE items SET owner_id = ?, chunk_x = NULL, chunk_y = NULL, location_id = NULL, is_equipped = 0 WHERE id = ?').run(playerId, itemId);
}

export function dropAtLocation(itemId: number, chunkX: number, chunkY: number, locationId: number | null): void {
  const db = getDb();
  db.prepare('UPDATE items SET owner_id = NULL, chunk_x = ?, chunk_y = ?, location_id = ?, is_equipped = 0 WHERE id = ?').run(chunkX, chunkY, locationId, itemId);
}

export function equipItem(itemId: number): void {
  const db = getDb();
  db.prepare('UPDATE items SET is_equipped = 1 WHERE id = ?').run(itemId);
}

export function unequipItem(itemId: number): void {
  const db = getDb();
  db.prepare('UPDATE items SET is_equipped = 0 WHERE id = ?').run(itemId);
}

export function getEquippedWeapon(ownerId: number): Item | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM items WHERE owner_id = ? AND is_equipped = 1 AND item_type = 'weapon'").get(ownerId) as Item | undefined) || null;
}

export function getEquippedArmor(ownerId: number): Item[] {
  const db = getDb();
  return db.prepare("SELECT * FROM items WHERE owner_id = ? AND is_equipped = 1 AND item_type = 'armor'").all(ownerId) as Item[];
}
