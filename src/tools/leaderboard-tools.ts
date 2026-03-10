import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import {
  getLeaderboard,
  getPlayerRank,
  isValidCategory,
  type LeaderboardCategory,
  type LeaderboardResult,
  type PlayerRankResult,
} from '../models/leaderboard.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PER_PAGE = 25;
const DEFAULT_PER_PAGE = 10;
const DEFAULT_PAGE = 1;

const CATEGORY_LABELS: Record<LeaderboardCategory, {
  readonly title: string;
  readonly scoreLabel: string;
  readonly scoreSuffix: string;
}> = {
  level: { title: 'LEVEL LEADERBOARD', scoreLabel: 'XP', scoreSuffix: ' xp' },
  wealth: { title: 'WEALTH LEADERBOARD', scoreLabel: 'Gold Value', scoreSuffix: 'g' },
  pve: { title: 'PVE LEADERBOARD', scoreLabel: 'Kills', scoreSuffix: ' kills' },
  pvp: { title: 'PVP LEADERBOARD', scoreLabel: 'Kills', scoreSuffix: ' kills' },
  explorers: { title: 'EXPLORERS LEADERBOARD', scoreLabel: 'Chunks', scoreSuffix: ' chunks' },
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatLeaderboard(
  result: LeaderboardResult,
  playerRank: PlayerRankResult | null,
): string {
  const labels = CATEGORY_LABELS[result.category];
  const lines: string[] = [`=== ${labels.title} ===`, ''];

  if (result.entries.length === 0) {
    lines.push('No players found.');
  } else {
    const maxNameLen = Math.max(...result.entries.map(e => e.player_name.length));

    for (const entry of result.entries) {
      const rankStr = `#${entry.rank}`.padStart(4);
      const nameStr = entry.player_name.padEnd(maxNameLen);
      const levelStr = `(Lv.${entry.level})`;
      const scoreStr = `${entry.score}${labels.scoreSuffix}`;
      lines.push(` ${rankStr}  ${nameStr}  ${levelStr}  ${scoreStr}`);
    }
  }

  lines.push('');

  if (playerRank) {
    lines.push(`Your rank: #${playerRank.rank} (${playerRank.score}${labels.scoreSuffix})`);
  } else {
    lines.push('Your rank: unranked');
  }

  lines.push(`Page ${result.page}/${result.total_pages}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLeaderboardTools(server: McpServer): void {
  server.tool(
    'leaderboard',
    'View leaderboard rankings by category: level, wealth, pve, pvp, or explorers. Paginated.',
    {
      token: z.string().uuid().describe('Your auth token'),
      category: z.string()
        .describe('One of: level, wealth, pve, pvp, explorers')
        .default('level'),
      page: z.number().int().min(1)
        .describe('Page number (default 1)')
        .default(DEFAULT_PAGE),
      per_page: z.number().int().min(1).max(MAX_PER_PAGE)
        .describe('Results per page (default 10, max 25)')
        .default(DEFAULT_PER_PAGE),
    },
    async ({ token, category, page, per_page }) => {
      try {
        const player = authenticate(token);

        const normalizedCategory = category.toLowerCase().trim();
        if (!isValidCategory(normalizedCategory)) {
          return {
            content: [{
              type: 'text',
              text: `Unknown category "${category}". Valid categories: level, wealth, pve, pvp, explorers`,
            }],
          };
        }

        const result = getLeaderboard(normalizedCategory, page, per_page);

        if (page > result.total_pages) {
          return {
            content: [{
              type: 'text',
              text: `Page ${page} exceeds total pages (${result.total_pages}). Try a lower page number.`,
            }],
          };
        }

        const playerRank = getPlayerRank(player.id, normalizedCategory);
        const text = formatLeaderboard(result, playerRank);

        return { content: [{ type: 'text', text }] };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: message }] };
      }
    },
  );
}
