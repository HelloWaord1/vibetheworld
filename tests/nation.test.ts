import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createPlayer, getPlayerById, updatePlayerGold, updatePlayerPosition } from '../src/models/player.js';
import { createChunk, getChunk } from '../src/models/chunk.js';
import { createLocation, getLocationById } from '../src/models/location.js';
import { claimChunk, setTaxRate } from '../src/models/governance.js';
import {
  getChunkCount,
  isWorldFull,
  getRandomOpenChunk,
  getCitizensCount,
  setImmigrationPolicy,
  setBuildPolicy,
  setExitPolicy,
  setChunkForSale,
  buyChunk,
  getDemolishCost,
  demolishLocation,
  addChunkRevenue,
  addLocationRevenue,
  getRevoltVotes,
  castRevoltVote,
  clearRevoltVotes,
  getRevoltVotesNeeded,
} from '../src/models/nation.js';
import { updatePlayerUsdc } from '../src/models/usdc.js';
import { DEMOLISH_BASE_COST, REVOLT_THRESHOLD, MIN_REVOLT_VOTES } from '../src/types/index.js';

/** Create a non-Nexus chunk at (1,0) that can be claimed */
function createTestChunk(creatorId: number) {
  return createChunk(1, 0, 'TestLand', 'A test chunk', 'plains', 1, [], creatorId);
}

beforeEach(() => {
  resetDb();
  process.env.DATABASE_PATH = ':memory:';
  migrate();
});

afterEach(() => {
  resetDb();
});

describe('nation model', () => {
  it('getChunkCount returns count of chunks', () => {
    expect(getChunkCount()).toBe(1); // The Nexus
    const p = createPlayer('Builder', 'pass123');
    createChunk(1, 0, 'East', 'desc', 'plains', 1, [], p.id);
    expect(getChunkCount()).toBe(2);
  });

  it('isWorldFull returns false when under limit', () => {
    expect(isWorldFull()).toBe(false);
  });

  it('getRandomOpenChunk returns open chunk', () => {
    const result = getRandomOpenChunk();
    expect(result).not.toBeNull();
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
  });

  it('getRandomOpenChunk excludes closed chunks', () => {
    const ruler = createPlayer('Ruler', 'pass123');
    createTestChunk(ruler.id);
    updatePlayerPosition(ruler.id, 1, 0, null);
    claimChunk(ruler.id, 1, 0);
    setImmigrationPolicy(1, 0, 'closed', 0);
    // Nexus is still open
    setImmigrationPolicy(0, 0, 'closed', 0);

    const result = getRandomOpenChunk();
    expect(result).toBeNull(); // both chunks closed
  });

  it('getCitizensCount counts alive players in chunk', () => {
    const p1 = createPlayer('P1', 'pass123');
    const p2 = createPlayer('P2', 'pass123');
    expect(getCitizensCount(0, 0)).toBe(2);
  });

  it('Nexus cannot be claimed', () => {
    const p = createPlayer('Ruler', 'pass123');
    expect(() => claimChunk(p.id, 0, 0)).toThrow('Nexus cannot be claimed');
  });
});

describe('immigration policy', () => {
  it('setImmigrationPolicy updates chunk', () => {
    const ruler = createPlayer('Ruler', 'pass123');
    createTestChunk(ruler.id);
    claimChunk(ruler.id, 1, 0);

    setImmigrationPolicy(1, 0, 'fee', 50);
    const chunk = getChunk(1, 0);
    expect(chunk.immigration_policy).toBe('fee');
    expect(chunk.immigration_fee).toBe(50);
  });
});

describe('build policy', () => {
  it('setBuildPolicy updates chunk', () => {
    const ruler = createPlayer('Ruler', 'pass123');
    createTestChunk(ruler.id);
    claimChunk(ruler.id, 1, 0);

    setBuildPolicy(1, 0, 'closed', 0);
    const chunk = getChunk(1, 0);
    expect(chunk.build_policy).toBe('closed');
  });
});

describe('exit policy', () => {
  it('setExitPolicy updates chunk', () => {
    const ruler = createPlayer('Ruler', 'pass123');
    createTestChunk(ruler.id);
    claimChunk(ruler.id, 1, 0);

    setExitPolicy(1, 0, 'locked', 0);
    const chunk = getChunk(1, 0);
    expect(chunk.exit_policy).toBe('locked');
  });
});

describe('chunk sales', () => {
  it('setChunkForSale lists chunk', () => {
    const p = createPlayer('P', 'pass123');
    createTestChunk(p.id);
    setChunkForSale(1, 0, 1000);
    const chunk = getChunk(1, 0);
    expect(chunk.sale_price).toBe(1000);
  });

  it('setChunkForSale with null delists', () => {
    const p = createPlayer('P', 'pass123');
    createTestChunk(p.id);
    setChunkForSale(1, 0, 1000);
    setChunkForSale(1, 0, null);
    const chunk = getChunk(1, 0);
    expect(chunk.sale_price).toBeNull();
  });

  it('buyChunk transfers ownership', () => {
    const seller = createPlayer('Seller', 'pass123');
    createTestChunk(seller.id);
    claimChunk(seller.id, 1, 0);
    setChunkForSale(1, 0, 500);

    const buyer = createPlayer('Buyer', 'pass123');
    updatePlayerUsdc(buyer.id, 1000);

    const result = buyChunk(buyer.id, 1, 0);
    expect(result.cost).toBe(500);
    expect(result.tax).toBeGreaterThan(0);

    const chunk = getChunk(1, 0);
    expect(chunk.ruler_id).toBe(buyer.id);
    expect(chunk.sale_price).toBeNull();
  });

  it('buyChunk rejects if not for sale', () => {
    const p = createPlayer('P', 'pass123');
    createTestChunk(p.id);
    const buyer = createPlayer('Buyer', 'pass123');
    updatePlayerUsdc(buyer.id, 1000);
    expect(() => buyChunk(buyer.id, 1, 0)).toThrow('not for sale');
  });

  it('buyChunk rejects if insufficient USDC', () => {
    const seller = createPlayer('Seller', 'pass123');
    createTestChunk(seller.id);
    claimChunk(seller.id, 1, 0);
    setChunkForSale(1, 0, 500);

    const buyer = createPlayer('Buyer', 'pass123');
    updatePlayerUsdc(buyer.id, 100);
    expect(() => buyChunk(buyer.id, 1, 0)).toThrow('Not enough USDC');
  });
});

describe('demolition', () => {
  it('getDemolishCost returns base cost for location with no revenue', () => {
    const p = createPlayer('Builder', 'pass123');
    const loc = createLocation(0, 0, null, 'Test Place', 'A test place', 'room', false, 10, false, null, p.id);
    expect(getDemolishCost(loc.id)).toBe(DEMOLISH_BASE_COST);
  });

  it('getDemolishCost scales with revenue', () => {
    const p = createPlayer('Builder', 'pass123');
    const loc = createLocation(0, 0, null, 'Rich Place', 'A wealthy place', 'shop', false, 10, true, null, p.id);
    addLocationRevenue(loc.id, 1000);
    expect(getDemolishCost(loc.id)).toBe(1000 * 2 + DEMOLISH_BASE_COST);
  });

  it('owner demolishes for free', () => {
    const owner = createPlayer('Owner', 'pass123');
    const loc = createLocation(0, 0, null, 'My Place', 'My own place', 'room', false, 10, false, null, owner.id);

    const result = demolishLocation(owner.id, loc.id, true, false);
    expect(result.cost).toBe(0);
    expect(result.compensation).toBe(0);
  });

  it('ruler pays 50% to demolish', () => {
    const owner = createPlayer('Owner', 'pass123');
    const ruler = createPlayer('Ruler', 'pass123');
    updatePlayerGold(ruler.id, 5000);
    createTestChunk(ruler.id);
    claimChunk(ruler.id, 1, 0);

    const loc = createLocation(1, 0, null, 'Target', 'A target place', 'room', false, 10, false, null, owner.id);
    addLocationRevenue(loc.id, 500);
    const fullCost = getDemolishCost(loc.id); // 500*2 + 500 = 1500

    const result = demolishLocation(ruler.id, loc.id, false, true);
    expect(result.cost).toBe(Math.floor(fullCost * 0.5)); // 750
    expect(result.compensation).toBe(Math.floor(fullCost * 0.5)); // 750
  });

  it('non-owner non-ruler pays full cost', () => {
    const owner = createPlayer('Owner', 'pass123');
    const vandal = createPlayer('Vandal', 'pass123');
    updatePlayerGold(vandal.id, 5000);

    const loc = createLocation(0, 0, null, 'Target', 'desc', 'room', false, 10, false, null, owner.id);
    const fullCost = getDemolishCost(loc.id);

    const result = demolishLocation(vandal.id, loc.id, false, false);
    expect(result.cost).toBe(fullCost);
    expect(result.compensation).toBe(Math.floor(fullCost * 0.5));
  });

  it('demolish rejects if insufficient gold', () => {
    const owner = createPlayer('Owner', 'pass123');
    const broke = createPlayer('Broke', 'pass123');
    updatePlayerGold(broke.id, 0);

    const loc = createLocation(0, 0, null, 'Target', 'desc', 'room', false, 10, false, null, owner.id);
    expect(() => demolishLocation(broke.id, loc.id, false, false)).toThrow('Demolition costs');
  });

  it('getDemolishCost aggregates child location revenue', () => {
    const p = createPlayer('Builder', 'pass123');
    const parent = createLocation(0, 0, null, 'Mall', 'A big mall with shops', 'building', false, 10, false, null, p.id);
    const child1 = createLocation(0, 0, parent.id, 'Coffee Shop', 'Serves real coffee', 'shop', false, 10, true, null, p.id);
    const child2 = createLocation(0, 0, parent.id, 'Bookstore', 'Sells books', 'shop', false, 10, true, null, p.id);

    addLocationRevenue(parent.id, 100);
    addLocationRevenue(child1.id, 500);
    addLocationRevenue(child2.id, 300);

    // Total revenue = 100 + 500 + 300 = 900
    // Cost = 900 * 2 + 500 base = 2300
    expect(getDemolishCost(parent.id)).toBe(900 * 2 + DEMOLISH_BASE_COST);
  });

  it('demolish deletes all descendants recursively', () => {
    const owner = createPlayer('Owner', 'pass123');
    const vandal = createPlayer('Vandal', 'pass123');
    updatePlayerGold(vandal.id, 50000);

    const parent = createLocation(0, 0, null, 'Complex', 'A big complex', 'building', false, 10, false, null, owner.id);
    const child = createLocation(0, 0, parent.id, 'Room', 'A room inside', 'room', false, 10, false, null, owner.id);
    const grandchild = createLocation(0, 0, child.id, 'Closet', 'A closet inside a room', 'room', false, 10, false, null, owner.id);

    demolishLocation(vandal.id, parent.id, false, false);

    expect(getLocationById(parent.id)).toBeNull();
    expect(getLocationById(child.id)).toBeNull();
    expect(getLocationById(grandchild.id)).toBeNull();
  });
});

describe('revolt', () => {
  it('castRevoltVote and getRevoltVotes work', () => {
    const p = createPlayer('Citizen', 'pass123');
    castRevoltVote(p.id, 0, 0);
    expect(getRevoltVotes(0, 0)).toBe(1);
  });

  it('castRevoltVote is idempotent', () => {
    const p = createPlayer('Citizen', 'pass123');
    castRevoltVote(p.id, 0, 0);
    castRevoltVote(p.id, 0, 0);
    expect(getRevoltVotes(0, 0)).toBe(1);
  });

  it('clearRevoltVotes removes all votes', () => {
    const p1 = createPlayer('C1', 'pass123');
    const p2 = createPlayer('C2', 'pass123');
    castRevoltVote(p1.id, 0, 0);
    castRevoltVote(p2.id, 0, 0);
    expect(getRevoltVotes(0, 0)).toBe(2);

    clearRevoltVotes(0, 0);
    expect(getRevoltVotes(0, 0)).toBe(0);
  });

  it('revolt threshold is 51% of citizens', () => {
    expect(REVOLT_THRESHOLD).toBe(0.51);
  });

  it('getRevoltVotesNeeded uses min of percentage and absolute minimum', () => {
    // 1 citizen: ceil(1 * 0.51) = 1, min(1, 3) = 1
    expect(getRevoltVotesNeeded(1)).toBe(1);
    // 2 citizens: ceil(2 * 0.51) = 2, min(2, 3) = 2
    expect(getRevoltVotesNeeded(2)).toBe(2);
    // 5 citizens: ceil(5 * 0.51) = 3, min(3, 3) = 3
    expect(getRevoltVotesNeeded(5)).toBe(3);
    // 10 citizens: ceil(10 * 0.51) = 6, min(6, 3) = 3
    expect(getRevoltVotesNeeded(10)).toBe(3);
    // 100 citizens: ceil(100 * 0.51) = 51, min(51, 3) = 3
    expect(getRevoltVotesNeeded(100)).toBe(3);
  });

  it('MIN_REVOLT_VOTES is 3', () => {
    expect(MIN_REVOLT_VOTES).toBe(3);
  });
});

describe('revenue tracking', () => {
  it('addChunkRevenue increments chunk revenue', () => {
    addChunkRevenue(0, 0, 100);
    addChunkRevenue(0, 0, 200);
    const chunk = getChunk(0, 0);
    expect(chunk.revenue_total).toBe(300);
  });

  it('addLocationRevenue increments location revenue', () => {
    const p = createPlayer('Builder', 'pass123');
    const loc = createLocation(0, 0, null, 'Shop', 'A shop', 'shop', false, 10, true, null, p.id);
    addLocationRevenue(loc.id, 150);
    // Read via getDemolishCost which uses revenue_total
    expect(getDemolishCost(loc.id)).toBe(150 * 2 + DEMOLISH_BASE_COST);
  });
});
