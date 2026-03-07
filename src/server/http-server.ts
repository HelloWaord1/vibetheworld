import express from 'express';
import { getDb } from '../db/connection.js';
import type { Chunk, Player } from '../types/index.js';

export function createHttpServer(): express.Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/api/map', (_req, res) => {
    const db = getDb();
    const chunks = db.prepare('SELECT x, y, name, terrain_type, danger_level FROM chunks').all() as Chunk[];
    res.json({ chunks, total: chunks.length });
  });

  app.get('/api/leaderboard', (_req, res) => {
    const db = getDb();
    const players = db.prepare(`
      SELECT name, level, xp, gold, is_alive,
        strength + dexterity + constitution + charisma + luck as total_stats
      FROM players
      ORDER BY level DESC, xp DESC
      LIMIT 50
    `).all();
    res.json({ players });
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

  return app;
}
