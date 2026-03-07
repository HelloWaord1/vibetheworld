import type { Player } from '../types/index.js';

export function xpToNextLevel(player: Player): number {
  return player.level * 100 - player.xp;
}

export function getStatPointsAvailable(player: Player): number {
  // Players get 2 stat points per level above 1, minus what they've already spent
  const totalEarned = (player.level - 1) * 2;
  const baseStats = 5; // STARTING_STATS
  const totalSpent = (player.strength - baseStats) + (player.dexterity - baseStats) +
    (player.constitution - baseStats) + (player.charisma - baseStats) + (player.luck - baseStats);
  return Math.max(0, totalEarned - totalSpent);
}
