import { getDb } from '../db/connection.js';
import type { ActiveMonster } from '../types/index.js';
import { MONSTER_STAT_SCALE, MONSTER_DESPAWN_MINUTES, MAX_SPAWN_MONSTER_AC, MONSTER_ENGAGE_TIMEOUT_SECONDS } from '../types/index.js';
import { getTemplateById } from './monster-template.js';

/** Sqrt-based scaling: gentler curve at high danger levels.
 *  danger 1 = x1.0, danger 5 ~= x1.4, danger 10 ~= x1.6 */
function scalestat(base: number, dangerLevel: number): number {
  return Math.floor(base * (1 + Math.sqrt(dangerLevel - 1) * MONSTER_STAT_SCALE));
}

export function spawnMonster(
  templateId: number,
  chunkX: number,
  chunkY: number,
  locationId: number | null,
  dangerLevel: number
): ActiveMonster {
  const db = getDb();
  const template = getTemplateById(templateId);
  if (!template) throw new Error('Monster template not found.');

  const hp = scalestat(template.base_hp, dangerLevel);
  const strength = scalestat(template.base_strength, dangerLevel);
  const dexterity = scalestat(template.base_dexterity, dangerLevel);
  const constitution = scalestat(template.base_constitution, dangerLevel);
  const damagebonus = scalestat(template.base_damage_bonus, dangerLevel);
  let defensebonus = scalestat(template.base_defense_bonus, dangerLevel);

  // Cap AC so freshly spawned monsters are hittable by low-level players
  // AC formula: 10 + floor(constitution / 3) + defense_bonus
  const computedAc = 10 + Math.floor(constitution / 3) + defensebonus;
  if (computedAc > MAX_SPAWN_MONSTER_AC) {
    defensebonus = Math.max(0, MAX_SPAWN_MONSTER_AC - 10 - Math.floor(constitution / 3));
  }

  const result = db.prepare(`
    INSERT INTO active_monsters (
      template_id, chunk_x, chunk_y, location_id,
      hp, max_hp, strength, dexterity, constitution,
      damage_bonus, defense_bonus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    templateId, chunkX, chunkY, locationId,
    hp, hp, strength, dexterity, constitution,
    damagebonus, defensebonus
  );

  return getActiveMonster(result.lastInsertRowid as number)!;
}

export function getActiveMonster(id: number): ActiveMonster | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM active_monsters WHERE id = ?').get(id) as ActiveMonster | undefined) || null;
}

export function getMonstersAtLocation(x: number, y: number, locationId: number | null): ActiveMonster[] {
  const db = getDb();
  if (locationId !== null) {
    return db.prepare('SELECT * FROM active_monsters WHERE chunk_x = ? AND chunk_y = ? AND location_id = ?')
      .all(x, y, locationId) as ActiveMonster[];
  }
  return db.prepare('SELECT * FROM active_monsters WHERE chunk_x = ? AND chunk_y = ? AND location_id IS NULL')
    .all(x, y) as ActiveMonster[];
}

export function updateMonsterHp(id: number, hp: number): void {
  const db = getDb();
  db.prepare('UPDATE active_monsters SET hp = ? WHERE id = ?').run(Math.max(0, hp), id);
}

export function engageMonster(monsterId: number, playerId: number): void {
  const db = getDb();
  db.prepare("UPDATE active_monsters SET engaged_by = ?, engaged_at = datetime('now') WHERE id = ?").run(playerId, monsterId);
}

export function disengageMonster(monsterId: number): void {
  const db = getDb();
  db.prepare('UPDATE active_monsters SET engaged_by = NULL, engaged_at = NULL WHERE id = ?').run(monsterId);
}

export function killMonster(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM active_monsters WHERE id = ?').run(id);
}

export function despawnExpiredMonsters(): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM active_monsters
    WHERE spawned_at < datetime('now', '-${MONSTER_DESPAWN_MINUTES} minutes')
  `).run();
  return result.changes;
}

/** Auto-disengage monsters whose engagement has timed out (player AFK/disconnected). */
export function expireStaleEngagements(): void {
  const db = getDb();
  db.prepare(
    `UPDATE active_monsters SET engaged_by = NULL, engaged_at = NULL
     WHERE engaged_by IS NOT NULL
       AND engaged_at < datetime('now', '-${MONSTER_ENGAGE_TIMEOUT_SECONDS} seconds')`
  ).run();
}

export function getEngagedMonster(playerId: number): ActiveMonster | null {
  const db = getDb();
  const monster = db.prepare('SELECT * FROM active_monsters WHERE engaged_by = ?').get(playerId) as ActiveMonster | undefined;
  if (!monster) return null;

  // Auto-disengage if engagement has timed out
  if (monster.engaged_at) {
    const engagedAtMs = new Date(monster.engaged_at + 'Z').getTime();
    const nowMs = Date.now();
    if (nowMs - engagedAtMs > MONSTER_ENGAGE_TIMEOUT_SECONDS * 1000) {
      disengageMonster(monster.id);
      return null;
    }
  }

  return monster;
}
