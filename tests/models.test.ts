import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createPlayer, getPlayerByToken, getPlayerByName, loginPlayer, killPlayer, addXp, isNameTakenByAlive } from '../src/models/player.js';
import { getChunk, acquireLock, releaseLock, createChunk } from '../src/models/chunk.js';
import { createLocation, getLocationsInChunk } from '../src/models/location.js';
import { createItem, getItemsByOwner, transferToPlayer, dropAtLocation, getItemsAtLocation } from '../src/models/item.js';

beforeEach(() => {
  resetDb();
  process.env.DATABASE_PATH = ':memory:';
  migrate();
});

afterEach(() => {
  resetDb();
});

describe('player model', () => {
  it('creates a player with correct defaults', () => {
    const player = createPlayer('Hero', 'pass123');
    expect(player.name).toBe('Hero');
    expect(player.hp).toBe(50);
    expect(player.max_hp).toBe(50);
    expect(player.gold).toBe(50);
    expect(player.level).toBe(1);
    expect(player.is_alive).toBe(1);
    expect(player.chunk_x).toBe(0);
    expect(player.chunk_y).toBe(0);
  });

  it('getPlayerByToken returns the player', () => {
    const created = createPlayer('TokenTest', 'pass');
    const found = getPlayerByToken(created.token);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('TokenTest');
  });

  it('getPlayerByName finds alive players', () => {
    createPlayer('FindMe', 'pass');
    const found = getPlayerByName('FindMe');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('FindMe');
  });

  it('loginPlayer rotates token', () => {
    const created = createPlayer('LoginTest', 'pass');
    const loggedIn = loginPlayer('LoginTest', 'pass');
    expect(loggedIn).not.toBeNull();
    expect(loggedIn!.token).not.toBe(created.token);
  });

  it('loginPlayer fails with wrong password', () => {
    createPlayer('WrongPass', 'correct');
    const result = loginPlayer('WrongPass', 'wrong');
    expect(result).toBeNull();
  });

  it('killPlayer marks player as dead', () => {
    const player = createPlayer('DeadMan', 'pass');
    killPlayer(player.id, 'test death');
    const found = getPlayerByToken(player.token);
    expect(found).toBeNull();
  });

  it('dead name can be reused', () => {
    const player = createPlayer('Phoenix', 'pass');
    killPlayer(player.id, 'died');
    expect(isNameTakenByAlive('Phoenix')).toBe(false);
    const newPlayer = createPlayer('Phoenix', 'newpass');
    expect(newPlayer.name).toBe('Phoenix');
    expect(newPlayer.is_alive).toBe(1);
  });

  it('addXp triggers level up', () => {
    const player = createPlayer('XpTest', 'pass');
    const result = addXp(player.id, 100);
    expect(result.leveled_up).toBe(true);
    expect(result.new_level).toBe(2);
    expect(result.stat_points).toBe(2);
  });
});

describe('chunk model', () => {
  it('seed creates The Nexus at 0,0', () => {
    const nexus = getChunk(0, 0);
    expect(nexus).not.toBeNull();
    expect(nexus!.name).toBe('The Nexus');
  });

  it('createChunk creates a chunk', () => {
    createPlayer('CC', 'pass');
    const chunk = createChunk(1, 0, 'East Plains', 'Flat grasslands stretching to the horizon.', 'plains', 2, ['open'], 1);
    expect(chunk.name).toBe('East Plains');
    expect(chunk.x).toBe(1);
    expect(chunk.y).toBe(0);
  });

  it('acquireLock and releaseLock work', () => {
    const player = createPlayer('Locker', 'pass');
    expect(acquireLock(5, 5, player.id)).toBe(true);
    expect(acquireLock(5, 5, player.id)).toBe(false);
    releaseLock(5, 5);
    expect(acquireLock(5, 5, player.id)).toBe(true);
  });
});

describe('location model', () => {
  it('seed creates tavern and shop', () => {
    const locations = getLocationsInChunk(0, 0, null);
    expect(locations.length).toBe(2);
    expect(locations.map(l => l.name)).toContain('The First Pint Tavern');
    expect(locations.map(l => l.name)).toContain('The Curiosity Shop');
  });

  it('shop location has is_shop = 1', () => {
    const locations = getLocationsInChunk(0, 0, null);
    const shop = locations.find(l => l.name === 'The Curiosity Shop');
    expect(shop!.is_shop).toBe(1);
  });

  it('creates sub-locations with depth', () => {
    const player = createPlayer('LocCreator', 'pass');
    const tavern = getLocationsInChunk(0, 0, null).find(l => l.name === 'The First Pint Tavern')!;
    const backRoom = createLocation(0, 0, tavern.id, 'Back Room', 'A dimly lit back room with poker tables.', 'room', false, 10, false, null, player.id);
    expect(backRoom.depth).toBe(2);
    expect(backRoom.parent_id).toBe(tavern.id);
  });
});

describe('item model', () => {
  it('seed creates shop items', () => {
    const shop = getLocationsInChunk(0, 0, null).find(l => l.name === 'The Curiosity Shop')!;
    const items = getItemsAtLocation(0, 0, shop.id);
    expect(items.length).toBeGreaterThanOrEqual(6);
    expect(items.every(i => i.is_shop_item === 1)).toBe(true);
  });

  it('transferToPlayer and getItemsByOwner work', () => {
    const player = createPlayer('ItemTest', 'pass');
    const item = createItem('Test Sword', 'A test sword for testing.', 'weapon', { damage_bonus: 3, value: 10, rarity: 'common' });
    transferToPlayer(item.id, player.id);
    const owned = getItemsByOwner(player.id);
    expect(owned.length).toBe(1);
    expect(owned[0].name).toBe('Test Sword');
  });

  it('dropAtLocation works', () => {
    const player = createPlayer('DropTest', 'pass');
    const item = createItem('Drop Item', 'Will be dropped on the ground.', 'misc', { owner_id: player.id });
    dropAtLocation(item.id, 0, 0, null);
    const ground = getItemsAtLocation(0, 0, null);
    expect(ground.some(i => i.name === 'Drop Item')).toBe(true);
  });
});
