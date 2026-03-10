import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createPlayer, getPlayerById, updatePlayerGold } from '../src/models/player.js';
import { createChunk } from '../src/models/chunk.js';
import { createItem } from '../src/models/item.js';
import { calculateTax, applyTax } from '../src/game/tax.js';
import { getPool, getCurrentRate, swapGoldForUsdc, swapUsdcForGold } from '../src/models/liquidity-pool.js';
import { createListing, getListingById, getListingsAtLocation, getListingsBySeller, deleteListing } from '../src/models/player-listing.js';
import { claimChunk, seizeChunk, setTaxRate, abdicateRule, getChunksRuledBy } from '../src/models/governance.js';
import { updatePlayerUsdc } from '../src/models/usdc.js';
import { PLATFORM_TAX_RATE, MAX_CHUNK_TAX_RATE } from '../src/types/index.js';

beforeEach(() => {
  resetDb();
  process.env.DATABASE_PATH = ':memory:';
  migrate();
});

afterEach(() => {
  resetDb();
});

describe('tax system', () => {
  it('calculateTax applies 2.8% platform tax', () => {
    const tax = calculateTax(100, 0, 0);
    expect(tax.platformTax).toBe(2); // floor(100 * 0.028) = 2
    expect(tax.chunkTax).toBe(0);
    expect(tax.netAmount).toBe(98);
    expect(tax.rulerId).toBeNull();
  });

  it('calculateTax applies chunk tax when ruler exists', () => {
    const player = createPlayer('Ruler', 'pass123');
    updatePlayerGold(player.id, 200);
    createChunk(7, 0, 'TaxCalcLand', 'desc', 'plains', 1, [], player.id);
    claimChunk(player.id, 7, 0);
    setTaxRate(player.id, 7, 0, 5);

    const tax = calculateTax(100, 7, 0);
    expect(tax.platformTax).toBe(2); // floor(100 * 0.028)
    expect(tax.chunkTax).toBe(4);    // floor(98 * 0.05)
    expect(tax.netAmount).toBe(94);  // 98 - 4
    expect(tax.rulerId).toBe(player.id);
  });

  it('applyTax credits chunk tax to ruler', () => {
    const ruler = createPlayer('TaxRuler', 'pass123');
    updatePlayerGold(ruler.id, 200);
    createChunk(8, 0, 'ApplyTaxLand', 'desc', 'plains', 1, [], ruler.id);
    claimChunk(ruler.id, 8, 0);
    setTaxRate(ruler.id, 8, 0, 10);

    const rulerAfterClaim = getPlayerById(ruler.id)!;
    const goldAfterClaim = rulerAfterClaim.gold; // creator claims free, so still 200

    const tax = applyTax(1000, 8, 0);
    const updatedRuler = getPlayerById(ruler.id)!;

    // Ruler should receive chunk tax
    // Platform: floor(1000 * 0.028) = 28, after: 972
    // Chunk: floor(972 * 0.10) = 97
    expect(tax.platformTax).toBe(28);
    expect(tax.chunkTax).toBe(97);
    expect(updatedRuler.gold).toBe(goldAfterClaim + 97);
  });

  it('no chunk tax when no ruler', () => {
    const tax = calculateTax(1000, 0, 0);
    expect(tax.chunkTax).toBe(0);
    expect(tax.rulerId).toBeNull();
  });
});

describe('AMM liquidity pool', () => {
  it('initial pool has correct reserves', () => {
    const pool = getPool();
    expect(pool.gold_reserve).toBe(500000);
    expect(pool.usdc_reserve).toBe(5000);
  });

  it('initial rate is ~0.01 USDC per gold (100 gold = 1 USDC)', () => {
    const rate = getCurrentRate();
    expect(rate).toBeCloseTo(0.01, 4);
  });

  it('swapGoldForUsdc returns correct USDC and updates reserves', () => {
    const player = createPlayer('Swapper', 'pass123');
    updatePlayerGold(player.id, 10000);

    const result = swapGoldForUsdc(player.id, 1000, 10000);
    expect(result.usdcReceived).toBeGreaterThan(0);
    expect(result.usdcReceived).toBeLessThan(11); // slippage from AMM

    const pool = getPool();
    expect(pool.gold_reserve).toBe(501000);
    expect(pool.usdc_reserve).toBe(5000 - result.usdcReceived);

    const updated = getPlayerById(player.id)!;
    expect(updated.gold).toBe(9000);
    expect(updated.usdc_balance).toBe(result.usdcReceived);
  });

  it('swapUsdcForGold returns correct gold and updates reserves', () => {
    const player = createPlayer('UsdcSwap', 'pass123');
    updatePlayerUsdc(player.id, 100);

    const result = swapUsdcForGold(player.id, 10, 100);
    expect(result.goldReceived).toBeGreaterThan(0);

    const pool = getPool();
    expect(pool.usdc_reserve).toBe(5010);
    expect(pool.gold_reserve).toBe(500000 - result.goldReceived);

    const updated = getPlayerById(player.id)!;
    expect(updated.usdc_balance).toBe(90);
    expect(updated.gold).toBe(250 + result.goldReceived);
  });

  it('rejects swap with insufficient balance', () => {
    const player = createPlayer('Broke', 'pass123');
    expect(() => swapGoldForUsdc(player.id, 1000, 50)).toThrow('Not enough gold');
  });

  it('AMM constant product preserves invariant approximately', () => {
    const poolBefore = getPool();
    const kBefore = poolBefore.gold_reserve * poolBefore.usdc_reserve;

    const player = createPlayer('AMMTest', 'pass123');
    updatePlayerGold(player.id, 5000);
    swapGoldForUsdc(player.id, 1000, 5000);

    const poolAfter = getPool();
    const kAfter = poolAfter.gold_reserve * poolAfter.usdc_reserve;

    // k should increase slightly due to fee
    expect(kAfter).toBeGreaterThanOrEqual(kBefore);
  });
});

describe('player listings', () => {
  it('creates and retrieves a listing', () => {
    const seller = createPlayer('Seller', 'pass123');
    const item = createItem('Magic Sword', 'Glows blue', 'weapon', { owner_id: seller.id, value: 50 });
    const listing = createListing(seller.id, item.id, 100, 0, 0, null);

    expect(listing.price).toBe(100);
    expect(listing.seller_id).toBe(seller.id);
    expect(listing.item_id).toBe(item.id);

    const found = getListingById(listing.id);
    expect(found).not.toBeNull();
    expect(found!.price).toBe(100);
  });

  it('getListingsAtLocation filters by location', () => {
    const seller = createPlayer('ShopOwner', 'pass123');
    const item1 = createItem('Sword1', 'desc', 'weapon', { owner_id: seller.id, value: 10 });
    const item2 = createItem('Sword2', 'desc', 'weapon', { owner_id: seller.id, value: 20 });

    createListing(seller.id, item1.id, 50, 0, 0, null);
    createListing(seller.id, item2.id, 75, 1, 0, null);

    const atNexus = getListingsAtLocation(0, 0, null);
    expect(atNexus.length).toBe(1);
    expect(atNexus[0].price).toBe(50);
  });

  it('getListingsBySeller returns seller listings', () => {
    const seller = createPlayer('MultiSeller', 'pass123');
    const item1 = createItem('Item1', 'desc', 'misc', { owner_id: seller.id, value: 5 });
    const item2 = createItem('Item2', 'desc', 'misc', { owner_id: seller.id, value: 10 });

    createListing(seller.id, item1.id, 30, 0, 0, null);
    createListing(seller.id, item2.id, 60, 0, 0, null);

    const listings = getListingsBySeller(seller.id);
    expect(listings.length).toBe(2);
  });

  it('deleteListing removes the listing', () => {
    const seller = createPlayer('Delister', 'pass123');
    const item = createItem('Gone', 'desc', 'misc', { owner_id: seller.id, value: 5 });
    const listing = createListing(seller.id, item.id, 25, 0, 0, null);

    deleteListing(listing.id);
    expect(getListingById(listing.id)).toBeNull();
  });

  it('item_id is unique in listings', () => {
    const seller = createPlayer('UniqueTest', 'pass123');
    const item = createItem('UniqueItem', 'desc', 'misc', { owner_id: seller.id, value: 5 });
    createListing(seller.id, item.id, 25, 0, 0, null);

    expect(() => createListing(seller.id, item.id, 50, 0, 0, null)).toThrow();
  });
});

describe('governance', () => {
  it('creator claims chunk for free', () => {
    const creator = createPlayer('Creator', 'pass123');
    // The Nexus was created by user 0, so creator (id=1) is not the creator
    // Let's create a new chunk by the player
    createChunk(1, 0, 'East', 'East lands', 'plains', 1, [], creator.id);

    claimChunk(creator.id, 1, 0);
    const chunks = getChunksRuledBy(creator.id);
    expect(chunks.length).toBe(1);
    expect(chunks[0].x).toBe(1);

    // Gold should be unchanged (free for creator)
    const updated = getPlayerById(creator.id)!;
    expect(updated.gold).toBe(250);
  });

  it('non-creator pays 100g to claim', () => {
    const creator = createPlayer('ChunkMaker', 'pass123');
    const claimer = createPlayer('Claimer', 'pass123');
    updatePlayerGold(claimer.id, 200);
    createChunk(2, 0, 'Far East', 'desc', 'desert', 2, [], creator.id);

    claimChunk(claimer.id, 2, 0);
    const updated = getPlayerById(claimer.id)!;
    expect(updated.gold).toBe(100); // 200 - 100
  });

  it('seize costs 500 + danger*100 + revenue/10 + citizens*50 + locations*20', () => {
    const ruler = createPlayer('OldRuler', 'pass123');
    const challenger = createPlayer('Challenger', 'pass123');
    updatePlayerGold(challenger.id, 5000);
    createChunk(3, 0, 'Danger Zone', 'desc', 'volcanic', 5, [], ruler.id);
    claimChunk(ruler.id, 3, 0);

    seizeChunk(challenger.id, 3, 0);
    const chunks = getChunksRuledBy(challenger.id);
    expect(chunks.length).toBe(1);

    const updated = getPlayerById(challenger.id)!;
    // Cost = 500 + 5*100 + 0 revenue + 0 citizens + 0 locations = 1000
    expect(updated.gold).toBe(4000);
  });

  it('setTaxRate validates range', () => {
    const ruler = createPlayer('TaxSetter', 'pass123');
    updatePlayerGold(ruler.id, 200);
    createChunk(4, 0, 'TaxLand', 'desc', 'plains', 1, [], ruler.id);
    claimChunk(ruler.id, 4, 0);

    setTaxRate(ruler.id, 4, 0, 10);
    const chunks = getChunksRuledBy(ruler.id);
    expect(chunks[0].chunk_tax_rate).toBe(10);

    expect(() => setTaxRate(ruler.id, 4, 0, 20)).toThrow();
    expect(() => setTaxRate(ruler.id, 4, 0, -1)).toThrow();
  });

  it('abdicate removes ruler and resets tax', () => {
    const ruler = createPlayer('Abdicator', 'pass123');
    updatePlayerGold(ruler.id, 200);
    createChunk(5, 0, 'AbdicateLand', 'desc', 'plains', 1, [], ruler.id);
    claimChunk(ruler.id, 5, 0);
    setTaxRate(ruler.id, 5, 0, 8);

    abdicateRule(ruler.id, 5, 0);
    const chunks = getChunksRuledBy(ruler.id);
    expect(chunks.length).toBe(0);
  });

  it('cannot claim already-ruled chunk', () => {
    const ruler = createPlayer('FirstRuler', 'pass123');
    updatePlayerGold(ruler.id, 200);
    const rival = createPlayer('Rival', 'pass123');
    updatePlayerGold(rival.id, 200);
    createChunk(6, 0, 'ContestedLand', 'desc', 'plains', 1, [], ruler.id);
    claimChunk(ruler.id, 6, 0);

    expect(() => claimChunk(rival.id, 6, 0)).toThrow('already has a ruler');
  });
});
