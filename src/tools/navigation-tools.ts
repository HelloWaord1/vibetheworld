import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getChunk, getAdjacentChunks, acquireLock, suggestDangerLevel } from '../models/chunk.js';
import { getLocationsInChunk, getLocationById, getChildLocations } from '../models/location.js';
import { getPlayersAtChunk, updatePlayerPosition } from '../models/player.js';
import { getItemsAtLocation, getItemsByOwner } from '../models/item.js';
import { tryDiscover } from '../game/discovery.js';
import { DIRECTIONS } from '../types/index.js';
import { isValidChunkCoord } from '../game/world-rules.js';
import { getDb } from '../db/connection.js';

export function registerNavigationTools(server: McpServer): void {
  server.tool(
    'look',
    'Look around your current location. Shows description, players, items, exits.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const chunk = getChunk(player.chunk_x, player.chunk_y);
        if (!chunk) return { content: [{ type: 'text', text: 'Error: You are in a void. This should not happen.' }] };

        const parts: string[] = [];

        if (player.location_id) {
          const loc = getLocationById(player.location_id);
          if (loc) {
            parts.push(`📍 ${loc.name} (inside ${chunk.name} @ ${chunk.x},${chunk.y})`);
            parts.push(loc.description);
            parts.push(`Type: ${loc.location_type} | Depth: ${loc.depth}`);

            // Sub-locations
            const children = getChildLocations(loc.id);
            const visible = children.filter(c => {
              if (!c.is_hidden) return true;
              const disc = tryDiscover(player, c);
              return disc.success;
            });
            if (visible.length > 0) {
              parts.push(`\nPlaces here:`);
              for (const c of visible) {
                parts.push(`  [${c.id}] ${c.name} (${c.location_type})`);
              }
            }
          }
        } else {
          parts.push(`🗺️ ${chunk.name} (${chunk.x},${chunk.y})`);
          parts.push(chunk.description);
          parts.push(`Terrain: ${chunk.terrain_type} | Danger: ${'⚠️'.repeat(chunk.danger_level)}`);

          // Locations at chunk level
          const locations = getLocationsInChunk(chunk.x, chunk.y, null);
          const visible = locations.filter(loc => {
            if (!loc.is_hidden) return true;
            const disc = tryDiscover(player, loc);
            return disc.success;
          });
          if (visible.length > 0) {
            parts.push(`\nPlaces:`);
            for (const loc of visible) {
              parts.push(`  [${loc.id}] ${loc.name} (${loc.location_type})`);
            }
          }

          // Adjacent directions
          const adjacent = getAdjacentChunks(chunk.x, chunk.y);
          const exits: string[] = [];
          for (const [dir, [dx, dy]] of Object.entries(DIRECTIONS)) {
            const adj = adjacent.find(a => a.x === chunk.x + dx && a.y === chunk.y + dy);
            if (adj) {
              exits.push(`${dir}: ${adj.name}`);
            } else {
              const nx = chunk.x + dx;
              const ny = chunk.y + dy;
              if (isValidChunkCoord(nx, ny)) exits.push(`${dir}: Unexplored`);
            }
          }
          if (exits.length > 0) {
            parts.push(`\nDirections:\n  ${exits.join('\n  ')}`);
          }
        }

        // Other players
        const players = getPlayersAtChunk(player.chunk_x, player.chunk_y, player.location_id)
          .filter(p => p.id !== player.id);
        if (players.length > 0) {
          parts.push(`\nPeople here:\n  ${players.map(p => `${p.name} (Lv${p.level})`).join(', ')}`);
        }

        // Items on ground / for sale
        const items = getItemsAtLocation(player.chunk_x, player.chunk_y, player.location_id);
        if (items.length > 0) {
          const shopItems = items.filter(i => i.is_shop_item);
          const groundItems = items.filter(i => !i.is_shop_item);
          if (shopItems.length > 0) {
            parts.push(`\nFor sale:`);
            for (const item of shopItems) {
              parts.push(`  [${item.id}] ${item.name} (${item.item_type}, ${item.rarity}) — ${item.value}g`);
            }
          }
          if (groundItems.length > 0) {
            parts.push(`\nItems on ground:`);
            for (const item of groundItems) {
              parts.push(`  [${item.id}] ${item.name} (${item.item_type}${item.value > 0 ? `, ${item.value}g` : ''})`);
            }
          }
        }

        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'move',
    'Move to an adjacent chunk (north/south/east/west). If the chunk does not exist, you will be asked to generate it.',
    {
      token: z.string().uuid().describe('Your auth token'),
      direction: z.enum(['north', 'south', 'east', 'west']).describe('Direction to move'),
    },
    async ({ token, direction }) => {
      try {
        const player = authenticate(token);

        // Must exit locations first
        if (player.location_id !== null) {
          return { content: [{ type: 'text', text: 'You must exit your current location first. Use `exit` to leave.' }] };
        }

        const [dx, dy] = DIRECTIONS[direction];
        const newX = player.chunk_x + dx;
        const newY = player.chunk_y + dy;

        if (!isValidChunkCoord(newX, newY)) {
          return { content: [{ type: 'text', text: `You cannot go ${direction}. The world ends here (-99 to 99 range).` }] };
        }

        const existing = getChunk(newX, newY);
        if (existing) {
          updatePlayerPosition(player.id, newX, newY, null);
          return { content: [{ type: 'text', text: `You travel ${direction} to ${existing.name} (${newX},${newY}).\n\n${existing.description}\nTerrain: ${existing.terrain_type} | Danger: ${'⚠️'.repeat(existing.danger_level)}` }] };
        }

        // Chunk doesn't exist — try to acquire lock
        const locked = acquireLock(newX, newY, player.id);
        const adjacent = getAdjacentChunks(newX, newY);
        const dangerSuggestion = suggestDangerLevel(newX, newY);

        const adjacentInfo = adjacent.map(a => `  (${a.x},${a.y}) ${a.name} — ${a.terrain_type}, danger ${a.danger_level}, tags: ${a.theme_tags}`).join('\n');

        if (locked) {
          return {
            content: [{
              type: 'text',
              text: `🌍 GENERATION NEEDED — Chunk (${newX},${newY}) does not exist yet!\n\nYou have acquired the creation lock. Generate a description for this chunk and submit it with \`submit_chunk\`.\n\nSuggested danger level: ${dangerSuggestion}\n\nAdjacent chunks for context:\n${adjacentInfo || '  None (you are at the frontier)'}\n\nRequirements:\n- Name (2-100 chars)\n- Description (10-2000 chars)\n- Terrain type\n- Danger level (1-10, suggested: ${dangerSuggestion})\n- Theme tags (optional array)\n\nCoordinates: x=${newX}, y=${newY}`
            }]
          };
        } else {
          return { content: [{ type: 'text', text: `Chunk (${newX},${newY}) is being generated by another player. Try again in a moment.` }] };
        }
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'enter',
    'Enter a location (tavern, shop, dungeon, etc). Use the location ID from `look`.',
    {
      token: z.string().uuid().describe('Your auth token'),
      location_id: z.number().int().describe('ID of the location to enter'),
    },
    async ({ token, location_id }) => {
      try {
        const player = authenticate(token);
        const loc = getLocationById(location_id);
        if (!loc) return { content: [{ type: 'text', text: 'Location not found.' }] };
        if (loc.chunk_x !== player.chunk_x || loc.chunk_y !== player.chunk_y) {
          return { content: [{ type: 'text', text: 'That location is not in your current chunk.' }] };
        }

        // Check parent chain
        if (player.location_id === null && loc.parent_id !== null) {
          return { content: [{ type: 'text', text: 'You must enter the parent location first.' }] };
        }
        if (player.location_id !== null && loc.parent_id !== player.location_id) {
          return { content: [{ type: 'text', text: 'That location is not accessible from here. It may be inside another place.' }] };
        }

        // Hidden check
        if (loc.is_hidden) {
          const disc = tryDiscover(player, loc);
          if (!disc.success) {
            return { content: [{ type: 'text', text: `You search but find nothing special. (Roll: ${disc.roll} vs DC ${disc.dc})` }] };
          }
        }

        // Key check
        if (loc.required_key_id !== null) {
          const playerItems = getItemsByOwner(player.id);
          const hasKey = playerItems.some(i => i.id === loc.required_key_id || (i.item_type === 'key' && i.name === 'Skeleton Key'));
          if (!hasKey) {
            return { content: [{ type: 'text', text: `This location is locked. You need the right key to enter.` }] };
          }
        }

        updatePlayerPosition(player.id, player.chunk_x, player.chunk_y, loc.id);
        return { content: [{ type: 'text', text: `You enter ${loc.name}.\n\n${loc.description}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'exit',
    'Exit your current location, going up one level.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        if (player.location_id === null) {
          return { content: [{ type: 'text', text: 'You are already outside. Use `move` to travel to another chunk.' }] };
        }
        const loc = getLocationById(player.location_id);
        const parentId = loc?.parent_id ?? null;
        updatePlayerPosition(player.id, player.chunk_x, player.chunk_y, parentId);

        if (parentId) {
          const parent = getLocationById(parentId);
          return { content: [{ type: 'text', text: `You exit to ${parent?.name || 'the previous area'}.` }] };
        }
        const chunk = getChunk(player.chunk_x, player.chunk_y);
        return { content: [{ type: 'text', text: `You step outside into ${chunk?.name || 'the open'}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
