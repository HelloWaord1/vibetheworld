import { describe, it, expect } from 'vitest';
import { d4, d6, d8, d12, d20, roll } from '../src/game/dice.js';

describe('dice', () => {
  it('roll returns value within range', () => {
    for (let i = 0; i < 100; i++) {
      const r = roll(20);
      expect(r.sides).toBe(20);
      expect(r.roll).toBeGreaterThanOrEqual(1);
      expect(r.roll).toBeLessThanOrEqual(20);
    }
  });

  it('d4 returns 1-4', () => {
    for (let i = 0; i < 50; i++) {
      const v = d4();
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(4);
    }
  });

  it('d6 returns 1-6', () => {
    for (let i = 0; i < 50; i++) {
      const v = d6();
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('d20 returns 1-20', () => {
    for (let i = 0; i < 50; i++) {
      const v = d20();
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(20);
    }
  });
});
