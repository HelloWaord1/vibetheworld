import express from 'express';
import { getDb } from '../db/connection.js';
import type { Chunk, Player } from '../types/index.js';
import { authenticate } from './auth.js';
import { getPlayerByName } from '../models/player.js';
import { updatePlayerUsdc, logUsdcTransaction } from '../models/usdc.js';
import { getPool, getCurrentRate } from '../models/liquidity-pool.js';
import { calculateTax } from '../game/tax.js';
import { PLATFORM_TAX_RATE } from '../types/index.js';
import { getLeaderboard, isValidCategory, type LeaderboardCategory } from '../models/leaderboard.js';

export function createHttpServer(): express.Express {
  const app = express();

  app.get('/health', (_req, res) => {
    try {
      const db = getDb();
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', uptime: process.uptime() });
    } catch {
      res.status(503).json({ status: 'error', message: 'Database unavailable' });
    }
  });

  app.get('/api/map', (_req, res) => {
    const db = getDb();
    const chunks = db.prepare('SELECT x, y, name, terrain_type, danger_level FROM chunks').all() as Chunk[];
    res.json({ chunks, total: chunks.length });
  });

  app.get('/api/leaderboard', (req, res) => {
    try {
      const rawCategory = (typeof req.query.category === 'string' ? req.query.category : 'level')
        .toLowerCase().trim();
      const category: LeaderboardCategory = isValidCategory(rawCategory) ? rawCategory : 'level';

      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const perPage = Math.min(25, Math.max(1, parseInt(String(req.query.per_page ?? '10'), 10) || 10));

      const result = getLeaderboard(category, page, perPage);
      res.json(result);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/stats', (_req, res) => {
    const db = getDb();
    const playerCount = (db.prepare('SELECT COUNT(*) as c FROM players').get() as any).c;
    const aliveCount = (db.prepare('SELECT COUNT(*) as c FROM players WHERE is_alive = 1').get() as any).c;
    const chunkCount = (db.prepare('SELECT COUNT(*) as c FROM chunks').get() as any).c;
    const locationCount = (db.prepare('SELECT COUNT(*) as c FROM locations').get() as any).c;
    const itemCount = (db.prepare('SELECT COUNT(*) as c FROM items').get() as any).c;
    res.json({ players: playerCount, alive: aliveCount, chunks: chunkCount, locations: locationCount, items: itemCount });
  });

  // GET /api/exchange — current AMM rate and reserves
  app.get('/api/exchange', (_req, res) => {
    try {
      const pool = getPool();
      const rate = getCurrentRate();
      res.json({
        rate_usdc_per_gold: rate,
        rate_gold_per_usdc: Math.floor(1 / rate),
        gold_reserve: pool.gold_reserve,
        usdc_reserve: pool.usdc_reserve,
        amm_fee: '0.3%',
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /402 — x402-style USDC P2P transfer
  app.post('/402', (req, res) => {
    try {
      const { token, recipient, amount } = req.body;
      if (!token || !recipient || !amount) {
        res.status(400).json({ error: 'Missing required fields: token, recipient, amount' });
        return;
      }
      if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
        res.status(400).json({ error: 'Amount must be a positive integer (USDC cents).' });
        return;
      }

      const sender = authenticate(token);
      const target = getPlayerByName(recipient);
      if (!target) {
        res.status(404).json({ error: `Player "${recipient}" not found.` });
        return;
      }
      if (target.id === sender.id) {
        res.status(400).json({ error: 'Cannot transfer to yourself.' });
        return;
      }

      // Apply platform tax on USDC transfer
      const platformTax = Math.floor(amount * PLATFORM_TAX_RATE);
      const netAmount = amount - platformTax;

      const db = getDb();
      let finalSenderBalance = 0;
      const executeTransfer = db.transaction(() => {
        // Fresh read inside transaction to prevent race condition
        const freshSender = db.prepare('SELECT usdc_balance FROM players WHERE id = ?').get(sender.id) as { usdc_balance: number };
        if (freshSender.usdc_balance < amount) {
          throw new Error(`Insufficient USDC balance. Have ${freshSender.usdc_balance}, need ${amount}.`);
        }
        db.prepare('UPDATE players SET usdc_balance = usdc_balance - ? WHERE id = ?').run(amount, sender.id);
        db.prepare('UPDATE players SET usdc_balance = usdc_balance + ? WHERE id = ?').run(netAmount, target.id);
        logUsdcTransaction(sender.id, target.id, amount, 'p2p_transfer', platformTax, 0, {
          net_received: netAmount,
        });
        finalSenderBalance = freshSender.usdc_balance - amount;
      });

      try {
        executeTransfer();
      } catch (e: any) {
        if (e.message.includes('Insufficient USDC')) {
          res.status(402).json({ error: e.message });
          return;
        }
        throw e;
      }

      res.json({
        status: 'ok',
        from: sender.name,
        to: target.name,
        amount,
        platform_tax: platformTax,
        net_received: netAmount,
        sender_balance: finalSenderBalance,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return app;
}
