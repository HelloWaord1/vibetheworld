import { getDb } from '../db/connection.js';
import type { UsdcTransaction, UsdcTransactionType } from '../types/index.js';

export function updatePlayerUsdc(playerId: number, amount: number): void {
  const db = getDb();
  db.prepare('UPDATE players SET usdc_balance = ? WHERE id = ?').run(amount, playerId);
}

export function logUsdcTransaction(
  fromId: number | null,
  toId: number | null,
  amount: number,
  transactionType: UsdcTransactionType,
  platformTax: number,
  chunkTax: number,
  metadata: Record<string, unknown> = {}
): UsdcTransaction {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO usdc_transactions (from_id, to_id, amount, transaction_type, platform_tax, chunk_tax, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(fromId, toId, amount, transactionType, platformTax, chunkTax, JSON.stringify(metadata));
  return db.prepare('SELECT * FROM usdc_transactions WHERE id = ?').get(result.lastInsertRowid) as UsdcTransaction;
}
