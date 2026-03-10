import { addXp } from '../models/player.js';
import { XP_EXPLORE_NEW_CHUNK, XP_DISCOVER_LOCATION, XP_CRAFT_LOCATION, XP_CRAFT_ITEM } from '../types/index.js';

export function awardExploreXp(playerId: number): { xp: number; leveled_up: boolean; new_level: number } {
  const result = addXp(playerId, XP_EXPLORE_NEW_CHUNK);
  return { xp: XP_EXPLORE_NEW_CHUNK, ...result };
}

export function awardDiscoveryXp(playerId: number): { xp: number; leveled_up: boolean; new_level: number } {
  const result = addXp(playerId, XP_DISCOVER_LOCATION);
  return { xp: XP_DISCOVER_LOCATION, ...result };
}

export function awardCraftLocationXp(playerId: number): { xp: number; leveled_up: boolean; new_level: number } {
  const result = addXp(playerId, XP_CRAFT_LOCATION);
  return { xp: XP_CRAFT_LOCATION, ...result };
}

export function awardCraftItemXp(playerId: number): { xp: number; leveled_up: boolean; new_level: number } {
  const result = addXp(playerId, XP_CRAFT_ITEM);
  return { xp: XP_CRAFT_ITEM, ...result };
}
