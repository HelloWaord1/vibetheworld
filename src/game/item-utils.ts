export const RARITY_MULTIPLIER: Record<string, number> = {
  common: 1.0,
  uncommon: 1.3,
  rare: 1.7,
  epic: 2.2,
  legendary: 3.0,
};

export function scaleByRarity(baseValue: number, rarity: string): number {
  return Math.floor(baseValue * (RARITY_MULTIPLIER[rarity] ?? 1.0));
}
