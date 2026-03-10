import { getDb } from '../db/connection.js';
import type { Chunk, ImmigrationPolicy, BuildPolicy, ExitPolicy } from '../types/index.js';
import { MAX_CHUNKS, DEMOLISH_BASE_COST, MAX_DEMOLISH_COST, PLATFORM_TAX_RATE, REVOLT_VOTE_EXPIRY_MS, REVOLT_THRESHOLD, MIN_REVOLT_VOTES } from '../types/index.js';

export function getChunkCount(): number {
  const db = getDb();
  const result = db.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number };
  return result.c;
}

export function isWorldFull(): boolean {
  return getChunkCount() >= MAX_CHUNKS;
}

export function getRandomOpenChunk(): { x: number; y: number } | null {
  const db = getDb();
  const chunk = db.prepare(`
    SELECT x, y FROM chunks
    WHERE immigration_policy IN ('open', 'fee')
      AND exit_policy != 'locked'
    ORDER BY RANDOM() LIMIT 1
  `).get() as { x: number; y: number } | undefined;
  return chunk || null;
}

export function getCitizensCount(chunkX: number, chunkY: number): number {
  const db = getDb();
  const result = db.prepare(
    'SELECT COUNT(*) as c FROM players WHERE chunk_x = ? AND chunk_y = ? AND is_alive = 1'
  ).get(chunkX, chunkY) as { c: number };
  return result.c;
}

export function setImmigrationPolicy(chunkX: number, chunkY: number, policy: ImmigrationPolicy, fee: number): void {
  const db = getDb();
  db.prepare('UPDATE chunks SET immigration_policy = ?, immigration_fee = ? WHERE x = ? AND y = ?')
    .run(policy, fee, chunkX, chunkY);
}

export function setBuildPolicy(chunkX: number, chunkY: number, policy: BuildPolicy, fee: number): void {
  const db = getDb();
  db.prepare('UPDATE chunks SET build_policy = ?, build_fee = ? WHERE x = ? AND y = ?')
    .run(policy, fee, chunkX, chunkY);
}

export function setExitPolicy(chunkX: number, chunkY: number, policy: ExitPolicy, fee: number): void {
  const db = getDb();
  db.prepare('UPDATE chunks SET exit_policy = ?, exit_fee = ? WHERE x = ? AND y = ?')
    .run(policy, fee, chunkX, chunkY);
}

export function setChunkForSale(chunkX: number, chunkY: number, priceUsdc: number | null): void {
  const db = getDb();
  db.prepare('UPDATE chunks SET sale_price = ? WHERE x = ? AND y = ?')
    .run(priceUsdc, chunkX, chunkY);
}

export function buyChunk(buyerId: number, chunkX: number, chunkY: number): { cost: number; tax: number } {
  const db = getDb();
  const chunk = db.prepare('SELECT * FROM chunks WHERE x = ? AND y = ?').get(chunkX, chunkY) as Chunk | undefined;
  if (!chunk) throw new Error('Chunk not found.');
  if (chunk.sale_price === null) throw new Error('This chunk is not for sale.');
  if (chunk.ruler_id === buyerId) throw new Error('You already own this chunk.');

  const buyer = db.prepare('SELECT usdc_balance FROM players WHERE id = ?').get(buyerId) as { usdc_balance: number };
  if (buyer.usdc_balance < chunk.sale_price) throw new Error(`Not enough USDC. Need ${chunk.sale_price}, have ${buyer.usdc_balance}.`);

  const tax = Math.floor(chunk.sale_price * PLATFORM_TAX_RATE);
  const sellerReceives = chunk.sale_price - tax;

  const execute = db.transaction(() => {
    // Deduct from buyer
    db.prepare('UPDATE players SET usdc_balance = usdc_balance - ? WHERE id = ?').run(chunk.sale_price, buyerId);

    // Pay seller (old ruler)
    if (chunk.ruler_id !== null) {
      db.prepare('UPDATE players SET usdc_balance = usdc_balance + ? WHERE id = ?').run(sellerReceives, chunk.ruler_id);
    }

    // Transfer ownership, remove from sale, reset all policies to defaults
    db.prepare(`UPDATE chunks SET ruler_id = ?, sale_price = NULL,
      immigration_policy = 'open', immigration_fee = 0,
      build_policy = 'free', build_fee = 0,
      exit_policy = 'free', exit_fee = 0,
      chunk_tax_rate = 0
      WHERE x = ? AND y = ?`).run(buyerId, chunkX, chunkY);
  });
  execute();

  return { cost: chunk.sale_price, tax };
}

export function getDemolishCost(locationId: number): number {
  const db = getDb();
  // Aggregate revenue from location + all descendants (recursive CTE)
  const result = db.prepare(`
    WITH RECURSIVE tree AS (
      SELECT id, revenue_total FROM locations WHERE id = ?
      UNION ALL
      SELECT l.id, l.revenue_total FROM locations l JOIN tree t ON l.parent_id = t.id
    )
    SELECT COALESCE(SUM(revenue_total), 0) as total FROM tree
  `).get(locationId) as { total: number } | undefined;
  if (!result) return DEMOLISH_BASE_COST;
  return Math.min((result.total * 2) + DEMOLISH_BASE_COST, MAX_DEMOLISH_COST);
}

export function demolishLocation(actorId: number, locationId: number, isOwner: boolean, isRuler: boolean): { cost: number; compensation: number } {
  const db = getDb();
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId) as any;
  if (!loc) throw new Error('Location not found.');

  const fullCost = getDemolishCost(locationId);

  if (isOwner) {
    // Owner demolishes for free — relocate players, clean up items, then delete
    const ownerDemolish = db.transaction(() => {
      db.prepare(`
        WITH RECURSIVE tree AS (
          SELECT id FROM locations WHERE id = ?
          UNION ALL
          SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
        )
        UPDATE players SET location_id = NULL
        WHERE location_id IN (SELECT id FROM tree)
      `).run(locationId);
      db.prepare(`
        WITH RECURSIVE tree AS (
          SELECT id FROM locations WHERE id = ?
          UNION ALL
          SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
        )
        DELETE FROM items WHERE location_id IN (SELECT id FROM tree) AND owner_id IS NULL
      `).run(locationId);
      db.prepare(`
        WITH RECURSIVE tree AS (
          SELECT id FROM locations WHERE id = ?
          UNION ALL
          SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
        )
        DELETE FROM player_listings WHERE location_id IN (SELECT id FROM tree)
      `).run(locationId);
      db.prepare(`
        WITH RECURSIVE tree AS (
          SELECT id FROM locations WHERE id = ?
          UNION ALL
          SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
        )
        DELETE FROM locations WHERE id IN (SELECT id FROM tree)
      `).run(locationId);
    });
    ownerDemolish();
    return { cost: 0, compensation: 0 };
  }

  const cost = isRuler ? Math.floor(fullCost * 0.5) : fullCost;
  const compensation = Math.floor(fullCost * 0.5);

  const player = db.prepare('SELECT gold FROM players WHERE id = ?').get(actorId) as { gold: number };
  if (player.gold < cost) throw new Error(`Demolition costs ${cost}g. You have ${player.gold}g.`);

  const execute = db.transaction(() => {
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(cost, actorId);
    // Compensate owner
    db.prepare('UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?').run(compensation, loc.created_by);

    // Relocate players in demolished locations to chunk level
    db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT id FROM locations WHERE id = ?
        UNION ALL
        SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
      )
      UPDATE players SET location_id = NULL
      WHERE location_id IN (SELECT id FROM tree)
    `).run(locationId);

    // Delete items in demolished locations (they would be orphaned)
    db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT id FROM locations WHERE id = ?
        UNION ALL
        SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
      )
      DELETE FROM items WHERE location_id IN (SELECT id FROM tree) AND owner_id IS NULL
    `).run(locationId);

    // Remove player listings for items in demolished locations
    db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT id FROM locations WHERE id = ?
        UNION ALL
        SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
      )
      DELETE FROM player_listings WHERE location_id IN (SELECT id FROM tree)
    `).run(locationId);

    // Delete location and all descendants (recursive)
    db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT id FROM locations WHERE id = ?
        UNION ALL
        SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
      )
      DELETE FROM locations WHERE id IN (SELECT id FROM tree)
    `).run(locationId);
  });
  execute();

  return { cost, compensation };
}

export function addChunkRevenue(chunkX: number, chunkY: number, amount: number): void {
  const db = getDb();
  db.prepare('UPDATE chunks SET revenue_total = revenue_total + ? WHERE x = ? AND y = ?').run(amount, chunkX, chunkY);
}

export function addLocationRevenue(locationId: number, amount: number): void {
  const db = getDb();
  db.prepare('UPDATE locations SET revenue_total = revenue_total + ? WHERE id = ?').run(amount, locationId);
}

export function getRevoltVotes(chunkX: number, chunkY: number): number {
  const db = getDb();
  const result = db.prepare(
    'SELECT COUNT(*) as c FROM revolt_votes WHERE chunk_x = ? AND chunk_y = ?'
  ).get(chunkX, chunkY) as { c: number };
  return result.c;
}

/** Count only revolt votes from players currently living in this chunk, alive, and voted within 24h */
export function getActiveRevoltVotes(chunkX: number, chunkY: number): number {
  const db = getDb();
  // Clean up expired votes first
  const expirySeconds = Math.floor(REVOLT_VOTE_EXPIRY_MS / 1000);
  db.prepare(`
    DELETE FROM revolt_votes
    WHERE chunk_x = ? AND chunk_y = ?
      AND created_at < datetime('now', '-' || ? || ' seconds')
  `).run(chunkX, chunkY, expirySeconds);

  const result = db.prepare(`
    SELECT COUNT(*) as c FROM revolt_votes rv
    JOIN players p ON rv.player_id = p.id
    WHERE rv.chunk_x = ? AND rv.chunk_y = ?
      AND p.chunk_x = ? AND p.chunk_y = ?
      AND p.is_alive = 1
  `).get(chunkX, chunkY, chunkX, chunkY) as { c: number };
  return result.c;
}

export function castRevoltVote(playerId: number, chunkX: number, chunkY: number): void {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO revolt_votes (player_id, chunk_x, chunk_y) VALUES (?, ?, ?)')
    .run(playerId, chunkX, chunkY);
}

export function clearRevoltVotes(chunkX: number, chunkY: number): void {
  const db = getDb();
  db.prepare('DELETE FROM revolt_votes WHERE chunk_x = ? AND chunk_y = ?').run(chunkX, chunkY);
}

/** Calculate votes needed for revolt: whichever is lower of
 *  51% of citizens (ceil) or MIN_REVOLT_VOTES absolute threshold.
 *  This makes revolt possible in small chunks (1-2 citizens). */
export function getRevoltVotesNeeded(citizens: number): number {
  const percentageBased = Math.ceil(citizens * REVOLT_THRESHOLD);
  return Math.min(percentageBased, MIN_REVOLT_VOTES);
}
