import { describe, it, expect } from 'vitest';
import { isValidChunkCoord, suggestDangerLevel } from '../src/game/world-rules.js';

describe('world-rules', () => {
  describe('isValidChunkCoord', () => {
    it('accepts valid coordinates', () => {
      expect(isValidChunkCoord(0, 0)).toBe(true);
      expect(isValidChunkCoord(99, 99)).toBe(true);
      expect(isValidChunkCoord(-99, -99)).toBe(true);
      expect(isValidChunkCoord(-50, 50)).toBe(true);
    });

    it('rejects out of bounds', () => {
      expect(isValidChunkCoord(100, 0)).toBe(false);
      expect(isValidChunkCoord(0, 100)).toBe(false);
      expect(isValidChunkCoord(-100, 0)).toBe(false);
      expect(isValidChunkCoord(0, -100)).toBe(false);
    });
  });

  describe('suggestDangerLevel', () => {
    it('returns 1 at origin', () => {
      expect(suggestDangerLevel(0, 0)).toBe(1);
    });

    it('increases with distance', () => {
      expect(suggestDangerLevel(10, 0)).toBe(2);
      expect(suggestDangerLevel(20, 20)).toBe(5);
      expect(suggestDangerLevel(50, 50)).toBe(10);
    });

    it('caps at 10', () => {
      expect(suggestDangerLevel(99, 99)).toBe(10);
    });

    it('works with negative coords', () => {
      expect(suggestDangerLevel(-10, 0)).toBe(2);
      expect(suggestDangerLevel(-50, -50)).toBe(10);
    });
  });
});
