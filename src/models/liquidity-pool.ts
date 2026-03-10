import { getDb } from '../db/connection.js';
import type { LiquidityPool } from '../types/index.js';
import { MIN_GOLD_SWAP, MIN_USDC_SWAP } from '../types/index.js';
import { logUsdcTransaction } from './usdc.js';

const AMM_FEE = 0.997; // 0.3% fee

export function getPool(): LiquidityPool {
  const db = getDb();
  return db.prepare('SELECT * FROM liquidity_pool WHERE id = 1').get() as LiquidityPool;
}

export function getCurrentRate(): number {
  const pool = getPool();
  return pool.usdc_reserve / pool.gold_reserve;
}

function updatePool(goldReserve: number, usdcReserve: number): void {
  const db = getDb();
  db.prepare(`UPDATE liquidity_pool SET gold_reserve = ?, usdc_reserve = ?, last_updated_at = datetime('now') WHERE id = 1`)
    .run(goldReserve, usdcReserve);
}

export function swapGoldForUsdc(playerId: number, goldAmount: number, _playerGold: number, minOutput: number = 0): { usdcReceived: number; newRate: number } {
  const db = getDb();

  if (goldAmount <= 0) throw new Error('Amount must be positive.');
  if (goldAmount < MIN_GOLD_SWAP) throw new Error(`Minimum swap is ${MIN_GOLD_SWAP} gold.`);

  // All reads and writes inside transaction to prevent race conditions
  let usdcOut = 0;
  let newGoldReserve = 0;
  let newUsdcReserve = 0;

  const execute = db.transaction(() => {
    const freshPlayer = db.prepare('SELECT gold, usdc_balance FROM players WHERE id = ?').get(playerId) as { gold: number; usdc_balance: number };
    if (goldAmount > freshPlayer.gold) throw new Error(`Not enough gold. Have ${freshPlayer.gold}, need ${goldAmount}.`);

    const pool = db.prepare('SELECT * FROM liquidity_pool WHERE id = 1').get() as LiquidityPool;

    const inputWithFee = goldAmount * AMM_FEE;
    usdcOut = Math.floor((inputWithFee * pool.usdc_reserve) / (pool.gold_reserve + inputWithFee));
    if (usdcOut <= 0) throw new Error('Trade too small — no USDC output.');
    if (usdcOut >= pool.usdc_reserve) throw new Error('Insufficient pool liquidity.');
    if (usdcOut < minOutput) throw new Error(`Slippage too high. Expected at least ${minOutput} USDC, would receive ${usdcOut}.`);

    newGoldReserve = pool.gold_reserve + goldAmount;
    newUsdcReserve = pool.usdc_reserve - usdcOut;

    updatePool(newGoldReserve, newUsdcReserve);
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(goldAmount, playerId);
    db.prepare('UPDATE players SET usdc_balance = usdc_balance + ? WHERE id = ?').run(usdcOut, playerId);

    logUsdcTransaction(null, playerId, usdcOut, 'swap_gold_to_usdc', 0, 0, {
      gold_spent: goldAmount,
      usdc_received: usdcOut,
      rate: newUsdcReserve / newGoldReserve,
    });
  });
  execute();

  return { usdcReceived: usdcOut, newRate: newUsdcReserve / newGoldReserve };
}

export function swapUsdcForGold(playerId: number, usdcAmount: number, _playerUsdcBalance: number, minOutput: number = 0): { goldReceived: number; newRate: number } {
  const db = getDb();

  if (usdcAmount <= 0) throw new Error('Amount must be positive.');
  if (usdcAmount < MIN_USDC_SWAP) throw new Error(`Minimum swap is ${MIN_USDC_SWAP} USDC.`);

  let goldOut = 0;
  let newUsdcReserve = 0;
  let newGoldReserve = 0;

  const execute = db.transaction(() => {
    const freshPlayer = db.prepare('SELECT gold, usdc_balance FROM players WHERE id = ?').get(playerId) as { gold: number; usdc_balance: number };
    if (usdcAmount > freshPlayer.usdc_balance) throw new Error(`Not enough USDC. Have ${freshPlayer.usdc_balance}, need ${usdcAmount}.`);

    const pool = db.prepare('SELECT * FROM liquidity_pool WHERE id = 1').get() as LiquidityPool;

    const inputWithFee = usdcAmount * AMM_FEE;
    goldOut = Math.floor((inputWithFee * pool.gold_reserve) / (pool.usdc_reserve + inputWithFee));
    if (goldOut <= 0) throw new Error('Trade too small — no gold output.');
    if (goldOut >= pool.gold_reserve) throw new Error('Insufficient pool liquidity.');
    if (goldOut < minOutput) throw new Error(`Slippage too high. Expected at least ${minOutput} gold, would receive ${goldOut}.`);

    newUsdcReserve = pool.usdc_reserve + usdcAmount;
    newGoldReserve = pool.gold_reserve - goldOut;

    updatePool(newGoldReserve, newUsdcReserve);
    db.prepare('UPDATE players SET usdc_balance = usdc_balance - ? WHERE id = ?').run(usdcAmount, playerId);
    db.prepare('UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?').run(goldOut, playerId);

    logUsdcTransaction(playerId, null, usdcAmount, 'swap_usdc_to_gold', 0, 0, {
      usdc_spent: usdcAmount,
      gold_received: goldOut,
      rate: newUsdcReserve / newGoldReserve,
    });
  });
  execute();

  return { goldReceived: goldOut, newRate: newUsdcReserve / newGoldReserve };
}
