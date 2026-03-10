import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createPlayer } from '../src/models/player.js';
import { xpToNextLevel, getStatPointsAvailable } from '../src/game/leveling.js';
import type { Player } from '../src/types/index.js';

beforeEach(() => {
  resetDb();
  process.env.DATABASE_PATH = ':memory:';
  migrate();
});

afterEach(() => {
  resetDb();
});

describe('leveling', () => {
  it('xpToNextLevel at level 1 is 100', () => {
    const player = createPlayer('LevelTest', 'password');
    expect(xpToNextLevel(player)).toBe(100);
  });

  it('getStatPointsAvailable starts at 0 for level 1', () => {
    const player = createPlayer('StatTest', 'password');
    expect(getStatPointsAvailable(player)).toBe(0);
  });

  it('getStatPointsAvailable returns 2 after level up', () => {
    const player = createPlayer('StatTest2', 'password');
    // Simulate level 2 with no spent points
    const fakePlayer: Player = { ...player, level: 2 };
    expect(getStatPointsAvailable(fakePlayer)).toBe(2);
  });
});
