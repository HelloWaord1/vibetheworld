import { getDb } from '../db/connection.js';
import type { Location } from '../types/index.js';
import { MAX_LOCATION_DEPTH } from '../types/index.js';

export function createLocation(
  chunkX: number, chunkY: number, parentId: number | null,
  name: string, description: string, locationType: string,
  isHidden: boolean, discoveryDc: number,
  isShop: boolean, requiredKeyId: number | null,
  createdBy: number
): Location {
  const db = getDb();

  let depth = 1;
  if (parentId !== null) {
    const parent = getLocationById(parentId);
    if (!parent) throw new Error('Parent location not found');
    if (parent.chunk_x !== chunkX || parent.chunk_y !== chunkY) throw new Error('Parent must be in the same chunk');
    depth = parent.depth + 1;
    if (depth > MAX_LOCATION_DEPTH) throw new Error(`Max location depth (${MAX_LOCATION_DEPTH}) exceeded`);
  }

  const result = db.prepare(`
    INSERT INTO locations (chunk_x, chunk_y, parent_id, name, description, location_type, depth, is_hidden, discovery_dc, is_shop, required_key_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chunkX, chunkY, parentId, name, description, locationType, depth, isHidden ? 1 : 0, discoveryDc, isShop ? 1 : 0, requiredKeyId, createdBy);

  return getLocationById(result.lastInsertRowid as number)!;
}

export function getLocationById(id: number): Location | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as Location | undefined) || null;
}

export function getLocationsInChunk(chunkX: number, chunkY: number, parentId: number | null): Location[] {
  const db = getDb();
  if (parentId === null) {
    return db.prepare('SELECT * FROM locations WHERE chunk_x = ? AND chunk_y = ? AND parent_id IS NULL').all(chunkX, chunkY) as Location[];
  }
  return db.prepare('SELECT * FROM locations WHERE chunk_x = ? AND chunk_y = ? AND parent_id = ?').all(chunkX, chunkY, parentId) as Location[];
}

export function getChildLocations(locationId: number): Location[] {
  const db = getDb();
  return db.prepare('SELECT * FROM locations WHERE parent_id = ?').all(locationId) as Location[];
}
