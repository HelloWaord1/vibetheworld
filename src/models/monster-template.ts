import { getDb } from '../db/connection.js';
import type { MonsterTemplate } from '../types/index.js';
import { MAX_MONSTER_TEMPLATES_PER_LOCATION } from '../types/index.js';

export function createMonsterTemplate(data: {
  name: string;
  description: string;
  monster_type: string;
  base_hp: number;
  base_strength: number;
  base_dexterity: number;
  base_constitution: number;
  base_damage_bonus: number;
  base_defense_bonus: number;
  min_danger_level: number;
  max_danger_level: number;
  xp_reward: number;
  gold_min: number;
  gold_max: number;
  loot_table: string;
  chunk_x: number;
  chunk_y: number;
  location_id: number | null;
  created_by: number;
}): MonsterTemplate {
  const db = getDb();

  const count = countTemplatesAtLocation(data.chunk_x, data.chunk_y, data.location_id);
  if (count >= MAX_MONSTER_TEMPLATES_PER_LOCATION) {
    throw new Error(`Maximum of ${MAX_MONSTER_TEMPLATES_PER_LOCATION} monster templates per location reached.`);
  }

  const result = db.prepare(`
    INSERT INTO monster_templates (
      name, description, monster_type,
      base_hp, base_strength, base_dexterity, base_constitution,
      base_damage_bonus, base_defense_bonus,
      min_danger_level, max_danger_level,
      xp_reward, gold_min, gold_max, loot_table,
      chunk_x, chunk_y, location_id, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, data.description, data.monster_type,
    data.base_hp, data.base_strength, data.base_dexterity, data.base_constitution,
    data.base_damage_bonus, data.base_defense_bonus,
    data.min_danger_level, data.max_danger_level,
    data.xp_reward, data.gold_min, data.gold_max, data.loot_table,
    data.chunk_x, data.chunk_y, data.location_id, data.created_by
  );

  return getTemplateById(result.lastInsertRowid as number)!;
}

export function getTemplateById(id: number): MonsterTemplate | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM monster_templates WHERE id = ?').get(id) as MonsterTemplate | undefined) || null;
}

export function getTemplatesAtLocation(x: number, y: number, locationId: number | null): MonsterTemplate[] {
  const db = getDb();
  if (locationId !== null) {
    return db.prepare('SELECT * FROM monster_templates WHERE chunk_x = ? AND chunk_y = ? AND location_id = ?')
      .all(x, y, locationId) as MonsterTemplate[];
  }
  return db.prepare('SELECT * FROM monster_templates WHERE chunk_x = ? AND chunk_y = ? AND location_id IS NULL')
    .all(x, y) as MonsterTemplate[];
}

export function getTemplatesInChunk(x: number, y: number): MonsterTemplate[] {
  const db = getDb();
  return db.prepare('SELECT * FROM monster_templates WHERE chunk_x = ? AND chunk_y = ?')
    .all(x, y) as MonsterTemplate[];
}

export function getTemplatesByCreator(playerId: number): MonsterTemplate[] {
  const db = getDb();
  return db.prepare('SELECT * FROM monster_templates WHERE created_by = ? ORDER BY created_at DESC')
    .all(playerId) as MonsterTemplate[];
}

export function countTemplatesAtLocation(x: number, y: number, locationId: number | null): number {
  const db = getDb();
  if (locationId !== null) {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM monster_templates WHERE chunk_x = ? AND chunk_y = ? AND location_id = ?')
      .get(x, y, locationId) as { cnt: number };
    return row.cnt;
  }
  const row = db.prepare('SELECT COUNT(*) as cnt FROM monster_templates WHERE chunk_x = ? AND chunk_y = ? AND location_id IS NULL')
    .get(x, y) as { cnt: number };
  return row.cnt;
}
