import { getDb } from '../db/connection.js';
import type { Chunk } from '../types/index.js';
import { MAX_CHUNK_TAX_RATE, MAX_CHUNKS_PER_PLAYER, TRANSFER_RULE_MIN_FEE, TRANSFER_RULE_REVENUE_RATE } from '../types/index.js';

export function claimChunk(playerId: number, x: number, y: number): void {
  if (x === 0 && y === 0) throw new Error('The Nexus cannot be claimed. It belongs to all.');

  const db = getDb();
  const chunk = db.prepare('SELECT * FROM chunks WHERE x = ? AND y = ?').get(x, y) as Chunk | undefined;
  if (!chunk) throw new Error('Chunk not found.');
  if (chunk.ruler_id !== null) throw new Error(`This chunk already has a ruler.`);

  // Check chunk ownership limit
  const ownedCount = (db.prepare('SELECT COUNT(*) as c FROM chunks WHERE ruler_id = ?').get(playerId) as { c: number }).c;
  if (ownedCount >= MAX_CHUNKS_PER_PLAYER) throw new Error(`You already rule ${MAX_CHUNKS_PER_PLAYER} chunks (max).`);

  const player = db.prepare('SELECT gold, id FROM players WHERE id = ?').get(playerId) as { gold: number; id: number };

  // Free for chunk creator, 100g for others
  if (chunk.created_by !== playerId) {
    const cost = 100;
    if (player.gold < cost) throw new Error(`You need ${cost} gold to claim this chunk.`);
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(cost, playerId);
  }

  db.prepare('UPDATE chunks SET ruler_id = ? WHERE x = ? AND y = ?').run(playerId, x, y);
}

export function seizeChunk(playerId: number, x: number, y: number): void {
  if (x === 0 && y === 0) throw new Error('The Nexus cannot be seized. It belongs to all.');

  const db = getDb();
  const chunk = db.prepare('SELECT * FROM chunks WHERE x = ? AND y = ?').get(x, y) as Chunk | undefined;
  if (!chunk) throw new Error('Chunk not found.');
  if (chunk.ruler_id === null) throw new Error('This chunk has no ruler. Use claim_chunk instead.');
  if (chunk.ruler_id === playerId) throw new Error('You already rule this chunk.');

  // Check chunk ownership limit
  const ownedCount = (db.prepare('SELECT COUNT(*) as c FROM chunks WHERE ruler_id = ?').get(playerId) as { c: number }).c;
  if (ownedCount >= MAX_CHUNKS_PER_PLAYER) throw new Error(`You already rule ${MAX_CHUNKS_PER_PLAYER} chunks (max).`);

  // Cost scales with danger + revenue + citizens
  const citizenCount = (db.prepare('SELECT COUNT(*) as c FROM players WHERE chunk_x = ? AND chunk_y = ? AND is_alive = 1').get(x, y) as { c: number }).c;
  const locationCount = (db.prepare('SELECT COUNT(*) as c FROM locations WHERE chunk_x = ? AND chunk_y = ?').get(x, y) as { c: number }).c;
  const cost = 500 + (chunk.danger_level * 100) + Math.floor(chunk.revenue_total / 10) + (citizenCount * 50) + (locationCount * 20);
  const player = db.prepare('SELECT gold FROM players WHERE id = ?').get(playerId) as { gold: number };
  if (player.gold < cost) throw new Error(`You need ${cost} gold to seize this chunk.`);

  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(cost, playerId);
  db.prepare('UPDATE chunks SET ruler_id = ? WHERE x = ? AND y = ?').run(playerId, x, y);
}

export function transferRule(rulerId: number, x: number, y: number, newRulerId: number): { fee: number } {
  const db = getDb();
  const chunk = db.prepare('SELECT * FROM chunks WHERE x = ? AND y = ?').get(x, y) as Chunk | undefined;
  if (!chunk) throw new Error('Chunk not found.');
  if (chunk.ruler_id !== rulerId) throw new Error('You are not the ruler of this chunk.');

  const target = db.prepare('SELECT id, is_alive, chunk_x, chunk_y FROM players WHERE id = ?').get(newRulerId) as { id: number; is_alive: number; chunk_x: number; chunk_y: number } | undefined;
  if (!target || !target.is_alive) throw new Error('Target player not found or dead.');
  if (target.chunk_x !== x || target.chunk_y !== y) throw new Error('Target must be in this chunk to receive rule.');

  // Check target ownership limit
  const targetOwned = (db.prepare('SELECT COUNT(*) as c FROM chunks WHERE ruler_id = ?').get(newRulerId) as { c: number }).c;
  if (targetOwned >= MAX_CHUNKS_PER_PLAYER) throw new Error(`Target already rules ${MAX_CHUNKS_PER_PLAYER} chunks (max).`);

  // Fee: 10% of chunk revenue or minimum 50g
  const fee = Math.max(TRANSFER_RULE_MIN_FEE, Math.floor(chunk.revenue_total * TRANSFER_RULE_REVENUE_RATE));
  const ruler = db.prepare('SELECT gold FROM players WHERE id = ?').get(rulerId) as { gold: number };
  if (ruler.gold < fee) throw new Error(`Transfer costs ${fee}g (10% of chunk revenue, min ${TRANSFER_RULE_MIN_FEE}g). You have ${ruler.gold}g.`);

  const execute = db.transaction(() => {
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(fee, rulerId);
    db.prepare('UPDATE chunks SET ruler_id = ? WHERE x = ? AND y = ?').run(newRulerId, x, y);
  });
  execute();

  return { fee };
}

export function abdicateRule(playerId: number, x: number, y: number): void {
  const db = getDb();
  const chunk = db.prepare('SELECT ruler_id FROM chunks WHERE x = ? AND y = ?').get(x, y) as Pick<Chunk, 'ruler_id'> | undefined;
  if (!chunk) throw new Error('Chunk not found.');
  if (chunk.ruler_id !== playerId) throw new Error('You are not the ruler of this chunk.');

  db.prepare(`
    UPDATE chunks SET ruler_id = NULL, chunk_tax_rate = 0,
      immigration_policy = 'open', immigration_fee = 0,
      build_policy = 'free', build_fee = 0,
      exit_policy = 'free', exit_fee = 0,
      sale_price = NULL
    WHERE x = ? AND y = ?
  `).run(x, y);

  // Clear revolt votes since there's no ruler to revolt against
  db.prepare('DELETE FROM revolt_votes WHERE chunk_x = ? AND chunk_y = ?').run(x, y);
}

export function setTaxRate(playerId: number, x: number, y: number, rate: number): void {
  if (rate < 0 || rate > MAX_CHUNK_TAX_RATE) {
    throw new Error(`Tax rate must be between 0 and ${MAX_CHUNK_TAX_RATE}%.`);
  }
  const db = getDb();
  const chunk = db.prepare('SELECT ruler_id FROM chunks WHERE x = ? AND y = ?').get(x, y) as Pick<Chunk, 'ruler_id'> | undefined;
  if (!chunk) throw new Error('Chunk not found.');
  if (chunk.ruler_id !== playerId) throw new Error('You are not the ruler of this chunk.');

  db.prepare('UPDATE chunks SET chunk_tax_rate = ? WHERE x = ? AND y = ?').run(rate, x, y);
}

export function getChunksRuledBy(playerId: number): Chunk[] {
  const db = getDb();
  return db.prepare('SELECT * FROM chunks WHERE ruler_id = ?').all(playerId) as Chunk[];
}
