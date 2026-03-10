import { getDb } from '../db/connection.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeaderboardCategory = 'level' | 'wealth' | 'pve' | 'pvp' | 'explorers';

export interface LeaderboardEntry {
  readonly rank: number;
  readonly player_name: string;
  readonly score: number;
  readonly level: number;
}

export interface LeaderboardResult {
  readonly category: LeaderboardCategory;
  readonly entries: readonly LeaderboardEntry[];
  readonly total_players: number;
  readonly page: number;
  readonly total_pages: number;
}

export interface PlayerRankResult {
  readonly rank: number;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// Internal row types (DB results)
// ---------------------------------------------------------------------------

interface RawLeaderboardRow {
  readonly name: string;
  readonly score: number;
  readonly level: number;
}

interface CountRow {
  readonly total: number;
}

interface RankRow {
  readonly rank: number;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// SQL per category
// ---------------------------------------------------------------------------

const CATEGORY_QUERIES: Record<LeaderboardCategory, {
  readonly select: string;
  readonly count: string;
  readonly rank: string;
}> = {
  level: {
    select: `
      SELECT name, level, xp AS score
      FROM players WHERE is_alive = 1
      ORDER BY level DESC, xp DESC
      LIMIT ? OFFSET ?
    `,
    count: `SELECT COUNT(*) AS total FROM players WHERE is_alive = 1`,
    rank: `
      SELECT rank, score FROM (
        SELECT id, xp AS score,
          ROW_NUMBER() OVER (ORDER BY level DESC, xp DESC) AS rank
        FROM players WHERE is_alive = 1
      ) WHERE id = ?
    `,
  },
  wealth: {
    select: `
      SELECT name, level, (gold + usdc_balance * 100) AS score
      FROM players WHERE is_alive = 1
      ORDER BY (gold + usdc_balance * 100) DESC
      LIMIT ? OFFSET ?
    `,
    count: `SELECT COUNT(*) AS total FROM players WHERE is_alive = 1`,
    rank: `
      SELECT rank, score FROM (
        SELECT id, (gold + usdc_balance * 100) AS score,
          ROW_NUMBER() OVER (ORDER BY (gold + usdc_balance * 100) DESC) AS rank
        FROM players WHERE is_alive = 1
      ) WHERE id = ?
    `,
  },
  pve: {
    select: `
      SELECT name, level, total_monsters_killed AS score
      FROM players WHERE is_alive = 1
      ORDER BY total_monsters_killed DESC
      LIMIT ? OFFSET ?
    `,
    count: `SELECT COUNT(*) AS total FROM players WHERE is_alive = 1`,
    rank: `
      SELECT rank, score FROM (
        SELECT id, total_monsters_killed AS score,
          ROW_NUMBER() OVER (ORDER BY total_monsters_killed DESC) AS rank
        FROM players WHERE is_alive = 1
      ) WHERE id = ?
    `,
  },
  pvp: {
    select: `
      SELECT name, level, total_pvp_kills AS score
      FROM players WHERE is_alive = 1
      ORDER BY total_pvp_kills DESC
      LIMIT ? OFFSET ?
    `,
    count: `SELECT COUNT(*) AS total FROM players WHERE is_alive = 1`,
    rank: `
      SELECT rank, score FROM (
        SELECT id, total_pvp_kills AS score,
          ROW_NUMBER() OVER (ORDER BY total_pvp_kills DESC) AS rank
        FROM players WHERE is_alive = 1
      ) WHERE id = ?
    `,
  },
  explorers: {
    select: `
      SELECT p.name, p.level, COUNT(DISTINCT e.chunk_x || ',' || e.chunk_y) AS score
      FROM players p
      JOIN event_log e ON e.actor_id = p.id AND e.event_type = 'chunk_explore'
      WHERE p.is_alive = 1
      GROUP BY p.id
      ORDER BY score DESC
      LIMIT ? OFFSET ?
    `,
    count: `
      SELECT COUNT(*) AS total FROM (
        SELECT 1
        FROM players p
        JOIN event_log e ON e.actor_id = p.id AND e.event_type = 'chunk_explore'
        WHERE p.is_alive = 1
        GROUP BY p.id
      )
    `,
    rank: `
      SELECT rank, score FROM (
        SELECT p.id, COUNT(DISTINCT e.chunk_x || ',' || e.chunk_y) AS score,
          ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT e.chunk_x || ',' || e.chunk_y) DESC) AS rank
        FROM players p
        JOIN event_log e ON e.actor_id = p.id AND e.event_type = 'chunk_explore'
        WHERE p.is_alive = 1
        GROUP BY p.id
      ) WHERE id = ?
    `,
  },
};

// ---------------------------------------------------------------------------
// Valid categories set (for input validation)
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set<string>(['level', 'wealth', 'pve', 'pvp', 'explorers']);

export function isValidCategory(value: string): value is LeaderboardCategory {
  return VALID_CATEGORIES.has(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getLeaderboard(
  category: LeaderboardCategory,
  page: number,
  perPage: number,
): LeaderboardResult {
  const db = getDb();
  const queries = CATEGORY_QUERIES[category];

  const offset = (page - 1) * perPage;

  const rows = db.prepare(queries.select).all(perPage, offset) as readonly RawLeaderboardRow[];
  const countResult = db.prepare(queries.count).get() as CountRow;
  const totalPlayers = countResult.total;
  const totalPages = Math.max(1, Math.ceil(totalPlayers / perPage));

  const entries: readonly LeaderboardEntry[] = rows.map((row, index) => ({
    rank: offset + index + 1,
    player_name: row.name,
    score: row.score,
    level: row.level,
  }));

  return {
    category,
    entries,
    total_players: totalPlayers,
    page,
    total_pages: totalPages,
  };
}

export function getPlayerRank(
  playerId: number,
  category: LeaderboardCategory,
): PlayerRankResult | null {
  const db = getDb();
  const queries = CATEGORY_QUERIES[category];

  const row = db.prepare(queries.rank).get(playerId) as RankRow | undefined;
  if (!row) return null;

  return { rank: row.rank, score: row.score };
}
