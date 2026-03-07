import { getDb } from '../db/connection.js';
import type { Player } from '../types/index.js';
import { STARTING_HP, STARTING_GOLD, STARTING_STATS } from '../types/index.js';
import { generateToken, hashPassword, verifyPassword } from '../utils/crypto.js';

export function createPlayer(name: string, password: string): Player {
  const db = getDb();
  const token = generateToken();
  const password_hash = hashPassword(password);

  const stmt = db.prepare(`
    INSERT INTO players (name, token, password_hash, hp, max_hp, strength, dexterity, constitution, charisma, luck, gold)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name, token, password_hash, STARTING_HP, STARTING_HP, STARTING_STATS, STARTING_STATS, STARTING_STATS, STARTING_STATS, STARTING_STATS, STARTING_GOLD);
  return getPlayerById(result.lastInsertRowid as number)!;
}

export function loginPlayer(name: string, password: string): Player | null {
  const db = getDb();
  const player = db.prepare('SELECT * FROM players WHERE name = ?').get(name) as Player | undefined;
  if (!player) return null;
  if (!verifyPassword(password, player.password_hash)) return null;
  if (!player.is_alive) return null;

  // Rotate token on login
  const token = generateToken();
  db.prepare(`UPDATE players SET token = ?, last_active_at = datetime('now') WHERE id = ?`).run(token, player.id);
  return { ...player, token };
}

export function getPlayerByToken(token: string): Player | null {
  const db = getDb();
  const player = db.prepare('SELECT * FROM players WHERE token = ? AND is_alive = 1').get(token) as Player | undefined;
  if (player) {
    db.prepare(`UPDATE players SET last_active_at = datetime('now') WHERE id = ?`).run(player.id);
  }
  return player || null;
}

export function getPlayerById(id: number): Player | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Player | undefined) || null;
}

export function getPlayerByName(name: string): Player | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM players WHERE name = ? AND is_alive = 1').get(name) as Player | undefined) || null;
}

export function isNameTakenByAlive(name: string): boolean {
  const db = getDb();
  return !!db.prepare('SELECT 1 FROM players WHERE name = ? AND is_alive = 1').get(name);
}

export function getPlayersAtChunk(x: number, y: number, locationId: number | null): Player[] {
  const db = getDb();
  if (locationId !== null) {
    return db.prepare('SELECT * FROM players WHERE chunk_x = ? AND chunk_y = ? AND location_id = ? AND is_alive = 1').all(x, y, locationId) as Player[];
  }
  return db.prepare('SELECT * FROM players WHERE chunk_x = ? AND chunk_y = ? AND location_id IS NULL AND is_alive = 1').all(x, y) as Player[];
}

export function updatePlayerPosition(id: number, chunkX: number, chunkY: number, locationId: number | null): void {
  const db = getDb();
  db.prepare('UPDATE players SET chunk_x = ?, chunk_y = ?, location_id = ? WHERE id = ?').run(chunkX, chunkY, locationId, id);
}

export function updatePlayerHp(id: number, hp: number): void {
  const db = getDb();
  db.prepare('UPDATE players SET hp = ? WHERE id = ?').run(hp, id);
}

export function updatePlayerStats(id: number, stats: Partial<Pick<Player, 'strength' | 'dexterity' | 'constitution' | 'charisma' | 'luck'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: number[] = [];
  for (const [key, val] of Object.entries(stats)) {
    if (val !== undefined) {
      sets.push(`${key} = ${key} + ?`);
      values.push(val);
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function addXp(id: number, amount: number): { leveled_up: boolean; new_level: number; stat_points: number } {
  const db = getDb();
  const player = getPlayerById(id)!;
  const newXp = player.xp + amount;
  const xpNeeded = player.level * 100;
  let leveled_up = false;
  let new_level = player.level;
  let stat_points = 0;

  if (newXp >= xpNeeded) {
    new_level = player.level + 1;
    leveled_up = true;
    stat_points = 2;
    db.prepare('UPDATE players SET xp = ?, level = ?, max_hp = max_hp + 10, hp = min(hp + 10, max_hp + 10) WHERE id = ?').run(newXp - xpNeeded, new_level, id);
  } else {
    db.prepare('UPDATE players SET xp = ? WHERE id = ?').run(newXp, id);
  }

  return { leveled_up, new_level, stat_points };
}

export function killPlayer(id: number, causeOfDeath: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE players SET is_alive = 0, died_at = datetime('now'), cause_of_death = ?, hp = 0 WHERE id = ?
  `).run(causeOfDeath, id);
}

export function updatePlayerGold(id: number, gold: number): void {
  const db = getDb();
  db.prepare('UPDATE players SET gold = ? WHERE id = ?').run(gold, id);
}
