import { ENCOUNTER_CHANCE_PER_DANGER, DUNGEON_ENCOUNTER_CHANCE } from '../types/index.js';
import { getTemplatesAtLocation, getTemplatesInChunk } from '../models/monster-template.js';
import { spawnMonster } from '../models/active-monster.js';
import type { ActiveMonster } from '../types/index.js';

export function rollEncounter(dangerLevel: number): boolean {
  const chance = Math.min(0.8, dangerLevel * ENCOUNTER_CHANCE_PER_DANGER);
  return Math.random() < chance;
}

export function rollDungeonEncounter(): boolean {
  return Math.random() < DUNGEON_ENCOUNTER_CHANCE;
}

export function spawnRandomEncounter(
  x: number,
  y: number,
  locationId: number | null,
  dangerLevel: number
): ActiveMonster | null {
  // Try location-specific templates first, then chunk-wide
  let templates = getTemplatesAtLocation(x, y, locationId);
  if (templates.length === 0) {
    templates = getTemplatesInChunk(x, y);
  }
  if (templates.length === 0) return null;

  // Filter by danger level range
  const eligible = templates.filter(
    t => dangerLevel >= t.min_danger_level && dangerLevel <= t.max_danger_level
  );
  if (eligible.length === 0) return null;

  const template = eligible[Math.floor(Math.random() * eligible.length)];
  return spawnMonster(template.id, x, y, locationId, dangerLevel);
}
