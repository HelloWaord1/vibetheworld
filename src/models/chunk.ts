import { getDb } from '../db/connection.js';
import type { Chunk, ChunkLock } from '../types/index.js';
import { CHUNK_LOCK_TIMEOUT_MS } from '../types/index.js';

export function createChunk(x: number, y: number, name: string, description: string, terrainType: string, dangerLevel: number, themeTags: string[], createdBy: number): Chunk {
  const db = getDb();
  db.prepare(`
    INSERT INTO chunks (x, y, name, description, terrain_type, danger_level, theme_tags, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(x, y, name, description, terrainType, dangerLevel, JSON.stringify(themeTags), createdBy);
  return getChunk(x, y)!;
}

export function getChunk(x: number, y: number): Chunk | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM chunks WHERE x = ? AND y = ?').get(x, y) as Chunk | undefined) || null;
}

export function getAdjacentChunks(x: number, y: number): Chunk[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM chunks WHERE
      (x = ? AND y = ?) OR (x = ? AND y = ?) OR (x = ? AND y = ?) OR (x = ? AND y = ?)
  `).all(x, y + 1, x, y - 1, x + 1, y, x - 1, y) as Chunk[];
}

export function acquireLock(x: number, y: number, playerId: number): boolean {
  const db = getDb();
  cleanExpiredLocks();
  try {
    db.prepare('INSERT INTO chunk_locks (x, y, locked_by) VALUES (?, ?, ?)').run(x, y, playerId);
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(x: number, y: number): void {
  const db = getDb();
  db.prepare('DELETE FROM chunk_locks WHERE x = ? AND y = ?').run(x, y);
}

export function getLock(x: number, y: number): ChunkLock | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM chunk_locks WHERE x = ? AND y = ?').get(x, y) as ChunkLock | undefined) || null;
}

export function cleanExpiredLocks(): void {
  const db = getDb();
  const cutoff = new Date(Date.now() - CHUNK_LOCK_TIMEOUT_MS).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('DELETE FROM chunk_locks WHERE locked_at < ?').run(cutoff);
}

export function suggestDangerLevel(x: number, y: number): number {
  return Math.min(10, 1 + Math.floor((Math.abs(x) + Math.abs(y)) / 10));
}
