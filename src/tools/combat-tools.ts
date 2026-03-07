import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getPlayerByName, updatePlayerPosition, getPlayerById } from '../models/player.js';
import { updatePlayerStats } from '../models/player.js';
import { resolveCombatRound } from '../game/combat.js';
import { getStatPointsAvailable } from '../game/leveling.js';
import { logEvent } from '../models/event-log.js';
import { DIRECTIONS } from '../types/index.js';
import { isValidChunkCoord } from '../game/world-rules.js';
import { getChunk } from '../models/chunk.js';
import { d20 } from '../game/dice.js';

export function registerCombatTools(server: McpServer): void {
  server.tool(
    'attack_player',
    'Attack another player at your location. One combat round (both sides attack). PvP only. Permadeath!',
    {
      token: z.string().uuid().describe('Your auth token'),
      target_name: z.string().describe('Name of the player to attack'),
    },
    async ({ token, target_name }) => {
      try {
        const player = authenticate(token);
        const target = getPlayerByName(target_name);

        if (!target) return { content: [{ type: 'text', text: `Player "${target_name}" not found or is dead.` }] };
        if (target.id === player.id) return { content: [{ type: 'text', text: 'You cannot attack yourself.' }] };
        if (target.chunk_x !== player.chunk_x || target.chunk_y !== player.chunk_y) {
          return { content: [{ type: 'text', text: `${target_name} is not in your chunk.` }] };
        }
        if ((target.location_id ?? null) !== (player.location_id ?? null)) {
          return { content: [{ type: 'text', text: `${target_name} is not at your exact location.` }] };
        }

        const result = resolveCombatRound(player, target);

        logEvent('combat', player.id, target.id, player.chunk_x, player.chunk_y, player.location_id, {
          attacker_result: result.attacker_result,
          defender_result: result.defender_result,
        });

        const parts = [
          `⚔️ COMBAT: ${player.name} vs ${target.name}`,
          '',
          result.narrative,
          '',
          `${player.name}: ${result.attacker_result.attacker_hp} HP`,
          `${target.name}: ${result.attacker_result.defender_hp} HP`,
        ];

        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'flee',
    'Attempt to flee combat by running to a random adjacent chunk. Requires a dexterity check.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const roll = d20() + Math.floor(player.dexterity / 2);
        const dc = 12;

        if (roll < dc) {
          return { content: [{ type: 'text', text: `You try to flee but stumble! (Roll: ${roll} vs DC ${dc}). You remain here.` }] };
        }

        // Pick a random valid direction
        const dirs = Object.entries(DIRECTIONS).filter(([_, [dx, dy]]) =>
          isValidChunkCoord(player.chunk_x + dx, player.chunk_y + dy)
        );
        if (dirs.length === 0) {
          return { content: [{ type: 'text', text: 'Nowhere to flee!' }] };
        }
        const [dir, [dx, dy]] = dirs[Math.floor(Math.random() * dirs.length)];
        const newX = player.chunk_x + dx;
        const newY = player.chunk_y + dy;
        const chunk = getChunk(newX, newY);

        if (!chunk) {
          return { content: [{ type: 'text', text: `You flee ${dir} but the land beyond is uncharted! You stay put. (Try moving to explore it first.)` }] };
        }

        updatePlayerPosition(player.id, newX, newY, null);
        return { content: [{ type: 'text', text: `You flee ${dir} to ${chunk.name}! (Roll: ${roll} vs DC ${dc})` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'allocate_stats',
    'Spend stat points gained from leveling up. Each level gives 2 points.',
    {
      token: z.string().uuid().describe('Your auth token'),
      strength: z.number().int().min(0).optional().default(0).describe('Points to add to STR'),
      dexterity: z.number().int().min(0).optional().default(0).describe('Points to add to DEX'),
      constitution: z.number().int().min(0).optional().default(0).describe('Points to add to CON'),
      charisma: z.number().int().min(0).optional().default(0).describe('Points to add to CHA'),
      luck: z.number().int().min(0).optional().default(0).describe('Points to add to LCK'),
    },
    async ({ token, strength, dexterity, constitution, charisma, luck }) => {
      try {
        const player = authenticate(token);
        const available = getStatPointsAvailable(player);
        const total = strength + dexterity + constitution + charisma + luck;

        if (total === 0) {
          return { content: [{ type: 'text', text: `You have ${available} stat points to allocate.` }] };
        }
        if (total > available) {
          return { content: [{ type: 'text', text: `Not enough stat points. You have ${available}, trying to spend ${total}.` }] };
        }

        updatePlayerStats(player.id, { strength, dexterity, constitution, charisma, luck });
        const updated = getPlayerById(player.id)!;
        return {
          content: [{
            type: 'text',
            text: `Stats updated! Points remaining: ${available - total}\nSTR ${updated.strength} | DEX ${updated.dexterity} | CON ${updated.constitution} | CHA ${updated.charisma} | LCK ${updated.luck}`
          }]
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
