import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getPlayerByName, getPlayerById } from '../models/player.js';
import { getItemsByOwner, getItemById } from '../models/item.js';
import { getChunk } from '../models/chunk.js';
import { getDb } from '../db/connection.js';
import { getStatPointsAvailable, xpToNextLevel } from '../game/leveling.js';
import { getPendingTradesForPlayer } from '../models/trade.js';
import type { Chunk, Player } from '../types/index.js';

export function registerInfoTools(server: McpServer): void {
  server.tool(
    'stats',
    'View your character stats, level, XP, and available stat points.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const statPoints = getStatPointsAvailable(player);
        const xpNeeded = xpToNextLevel(player);
        const trades = getPendingTradesForPlayer(player.id);

        const chunk = getChunk(player.chunk_x, player.chunk_y);
        const parts = [
          `📊 ${player.name} — Level ${player.level}`,
          `HP: ${player.hp}/${player.max_hp}`,
          `XP: ${player.xp}/${player.level * 100} (${xpNeeded} to next level)`,
          `Gold: ${player.gold}`,
          '',
          `STR: ${player.strength} | DEX: ${player.dexterity} | CON: ${player.constitution}`,
          `CHA: ${player.charisma} | LCK: ${player.luck}`,
          statPoints > 0 ? `\n⭐ ${statPoints} stat points available! Use \`allocate_stats\`.` : '',
          '',
          `Location: ${chunk?.name || 'Unknown'} (${player.chunk_x},${player.chunk_y})`,
          trades.length > 0 ? `\n📦 ${trades.length} pending trade(s)` : '',
        ];

        return { content: [{ type: 'text', text: parts.filter(Boolean).join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'inspect',
    'Inspect a player or item for details.',
    {
      token: z.string().uuid().describe('Your auth token'),
      target: z.string().describe('Player name or item ID (prefix with # for items, e.g. #5)'),
    },
    async ({ token, target }) => {
      try {
        const player = authenticate(token);

        // Item inspection
        if (target.startsWith('#')) {
          const itemId = parseInt(target.slice(1));
          if (isNaN(itemId)) return { content: [{ type: 'text', text: 'Invalid item ID.' }] };
          const item = getItemById(itemId);
          if (!item) return { content: [{ type: 'text', text: 'Item not found.' }] };

          const parts = [
            `🔍 ${item.name} [${item.id}]`,
            item.description,
            `Type: ${item.item_type} | Rarity: ${item.rarity}`,
            `Value: ${item.value}g`,
          ];
          if (item.damage_bonus) parts.push(`Damage: +${item.damage_bonus}`);
          if (item.defense_bonus) parts.push(`Defense: +${item.defense_bonus}`);
          if (item.heal_amount) parts.push(`Heals: ${item.heal_amount} HP`);
          const bonuses = JSON.parse(item.stat_bonuses || '{}');
          if (Object.keys(bonuses).length > 0) {
            parts.push(`Stat bonuses: ${Object.entries(bonuses).map(([k, v]) => `+${v} ${k}`).join(', ')}`);
          }

          return { content: [{ type: 'text', text: parts.join('\n') }] };
        }

        // Player inspection
        const targetPlayer = getPlayerByName(target);
        if (!targetPlayer) return { content: [{ type: 'text', text: `Player "${target}" not found.` }] };

        const equipped = getItemsByOwner(targetPlayer.id).filter(i => i.is_equipped);
        const parts = [
          `🔍 ${targetPlayer.name} — Level ${targetPlayer.level}`,
          `HP: ${targetPlayer.hp}/${targetPlayer.max_hp}`,
          `Location: (${targetPlayer.chunk_x},${targetPlayer.chunk_y})`,
        ];
        if (equipped.length > 0) {
          parts.push(`\nEquipped:`);
          for (const item of equipped) {
            parts.push(`  ${item.name} (${item.item_type})`);
          }
        }

        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'map',
    'View a map of explored chunks around you.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const db = getDb();
        const chunks = db.prepare('SELECT x, y, name, terrain_type, danger_level FROM chunks').all() as Chunk[];

        if (chunks.length === 0) {
          return { content: [{ type: 'text', text: 'No chunks explored yet.' }] };
        }

        // Find bounds
        const minX = Math.max(0, player.chunk_x - 5);
        const maxX = Math.min(99, player.chunk_x + 5);
        const minY = Math.max(0, player.chunk_y - 5);
        const maxY = Math.min(99, player.chunk_y + 5);

        const lines: string[] = [`🗺️ Map (you are at ${player.chunk_x},${player.chunk_y})`, ''];

        for (let y = maxY; y >= minY; y--) {
          let row = `${String(y).padStart(2)}: `;
          for (let x = minX; x <= maxX; x++) {
            const chunk = chunks.find(c => c.x === x && c.y === y);
            if (x === player.chunk_x && y === player.chunk_y) {
              row += '[@]';
            } else if (chunk) {
              row += `[${chunk.terrain_type.charAt(0).toUpperCase()}]`;
            } else {
              row += ' . ';
            }
          }
          lines.push(row);
        }

        // Legend
        lines.push('');
        lines.push('Legend: [@]=You  [C]=city  [F]=forest  [D]=desert  etc.  .=unexplored');

        // List nearby chunks
        const nearby = chunks.filter(c => Math.abs(c.x - player.chunk_x) <= 5 && Math.abs(c.y - player.chunk_y) <= 5);
        if (nearby.length > 0) {
          lines.push('');
          lines.push('Nearby chunks:');
          for (const c of nearby) {
            lines.push(`  (${c.x},${c.y}) ${c.name} — ${c.terrain_type}, danger ${c.danger_level}`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
