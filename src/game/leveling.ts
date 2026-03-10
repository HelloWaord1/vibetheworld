import type { Player } from '../types/index.js';
import { STARTING_STATS } from '../types/index.js';
import { getEquippedStatBonuses } from '../models/item.js';

export function xpToNextLevel(player: Player): number {
  return player.level * 100 - player.xp;
}

export function getStatPointsAvailable(player: Player): number {
  // Players get 2 stat points per level above 1, minus what they've already spent.
  // Item stat bonuses modify player stats directly in the DB on equip/unequip,
  // so we must subtract equipped item bonuses to get the true manually-spent total.
  const totalEarned = (player.level - 1) * 2;
  const itemBonuses = getEquippedStatBonuses(player.id);
  const totalSpent =
    (player.strength - STARTING_STATS - itemBonuses.strength) +
    (player.dexterity - STARTING_STATS - itemBonuses.dexterity) +
    (player.constitution - STARTING_STATS - itemBonuses.constitution) +
    (player.charisma - STARTING_STATS - itemBonuses.charisma) +
    (player.luck - STARTING_STATS - itemBonuses.luck);
  return Math.max(0, totalEarned - totalSpent);
}
