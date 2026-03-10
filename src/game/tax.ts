import { getDb } from '../db/connection.js';
import { PLATFORM_TAX_RATE, MAX_CHUNK_TAX_RATE, MAX_GOLD } from '../types/index.js';
import type { TaxBreakdown, Chunk } from '../types/index.js';

export function getChunkTaxInfo(chunkX: number, chunkY: number): { taxRate: number; rulerId: number | null } {
  const db = getDb();
  const chunk = db.prepare('SELECT ruler_id, chunk_tax_rate FROM chunks WHERE x = ? AND y = ?').get(chunkX, chunkY) as Pick<Chunk, 'ruler_id' | 'chunk_tax_rate'> | undefined;
  if (!chunk) return { taxRate: 0, rulerId: null };
  return { taxRate: Math.min(chunk.chunk_tax_rate, MAX_CHUNK_TAX_RATE), rulerId: chunk.ruler_id };
}

export function calculateTax(amount: number, chunkX: number, chunkY: number): TaxBreakdown {
  const platformTax = Math.floor(amount * PLATFORM_TAX_RATE);
  const afterPlatform = amount - platformTax;

  const { taxRate, rulerId } = getChunkTaxInfo(chunkX, chunkY);
  const chunkTax = rulerId !== null && taxRate > 0
    ? Math.floor(afterPlatform * (taxRate / 100))
    : 0;

  const netAmount = afterPlatform - chunkTax;

  return { platformTax, chunkTax, rulerId, netAmount };
}

export function applyTax(amount: number, chunkX: number, chunkY: number): TaxBreakdown {
  const breakdown = calculateTax(amount, chunkX, chunkY);
  const db = getDb();

  // Platform tax: gold flows to World Reserve Bank (zero-emission model)
  if (breakdown.platformTax > 0) {
    db.prepare(
      'UPDATE world_bank SET reserves = min(reserves + ?, ?) WHERE id = 1'
    ).run(breakdown.platformTax, MAX_GOLD);
  }

  // Chunk tax: gold goes to ruler
  if (breakdown.chunkTax > 0 && breakdown.rulerId !== null) {
    db.prepare('UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?').run(breakdown.chunkTax, breakdown.rulerId);
  }

  return breakdown;
}
