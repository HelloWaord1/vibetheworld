import type { DiceResult } from '../types/index.js';

export function roll(sides: number): DiceResult {
  return { sides, roll: Math.floor(Math.random() * sides) + 1 };
}

export function d4(): number { return roll(4).roll; }
export function d6(): number { return roll(6).roll; }
export function d8(): number { return roll(8).roll; }
export function d12(): number { return roll(12).roll; }
export function d20(): number { return roll(20).roll; }
