import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { createChunk, getChunk, releaseLock, getLock, getAdjacentChunks } from '../models/chunk.js';
import { createLocation } from '../models/location.js';
import { getLocationById } from '../models/location.js';
import { updatePlayerPosition } from '../models/player.js';
import { logEvent } from '../models/event-log.js';
import { isValidChunkCoord } from '../game/world-rules.js';

export function registerChunkTools(server: McpServer): void {
  server.tool(
    'submit_chunk',
    'Submit a newly generated chunk. You must hold the creation lock (from a `move` to an empty chunk).',
    {
      token: z.string().uuid().describe('Your auth token'),
      x: z.number().int().min(-99).max(99).describe('Chunk X coordinate'),
      y: z.number().int().min(-99).max(99).describe('Chunk Y coordinate'),
      name: z.string().min(2).max(100).describe('Chunk name'),
      description: z.string().min(10).max(2000).describe('Chunk description'),
      terrain_type: z.string().min(2).max(50).describe('Terrain type (e.g. forest, desert, city)'),
      danger_level: z.number().int().min(1).max(10).describe('Danger level 1-10'),
      theme_tags: z.array(z.string()).max(10).optional().default([]).describe('Theme tags'),
    },
    async ({ token, x, y, name, description, terrain_type, danger_level, theme_tags }) => {
      try {
        const player = authenticate(token);

        if (!isValidChunkCoord(x, y)) {
          return { content: [{ type: 'text', text: 'Invalid coordinates (must be -99 to 99).' }] };
        }

        // Check lock ownership
        const lock = getLock(x, y);
        if (!lock || lock.locked_by !== player.id) {
          return { content: [{ type: 'text', text: 'You do not hold the creation lock for this chunk. Move to it first.' }] };
        }

        // Check not already exists
        if (getChunk(x, y)) {
          releaseLock(x, y);
          return { content: [{ type: 'text', text: 'This chunk already exists.' }] };
        }

        // Check adjacency (must be adjacent to an existing chunk, or be 0,0)
        if (!(x === 0 && y === 0)) {
          const adjacent = getAdjacentChunks(x, y);
          if (adjacent.length === 0) {
            releaseLock(x, y);
            return { content: [{ type: 'text', text: 'Chunk must be adjacent to an existing chunk.' }] };
          }
        }

        const chunk = createChunk(x, y, name, description, terrain_type, danger_level, theme_tags, player.id);
        releaseLock(x, y);

        // Move player to new chunk
        updatePlayerPosition(player.id, x, y, null);

        logEvent('chunk_created', player.id, null, x, y, null, { name, terrain_type, danger_level });

        return {
          content: [{
            type: 'text',
            text: `✨ Chunk created: ${chunk.name} (${x},${y})\n${chunk.description}\nTerrain: ${chunk.terrain_type} | Danger: ${'⚠️'.repeat(chunk.danger_level)}\n\nYou have moved to this new chunk.`
          }]
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Failed: ${e.message}` }] };
      }
    }
  );

  server.tool(
    'submit_location',
    'Create a new sub-location inside your current chunk. Others will be able to enter it.',
    {
      token: z.string().uuid().describe('Your auth token'),
      parent_id: z.number().int().nullable().optional().default(null).describe('Parent location ID (null for chunk-level)'),
      name: z.string().min(2).max(100).describe('Location name'),
      description: z.string().min(10).max(2000).describe('Location description'),
      location_type: z.string().min(2).max(50).optional().default('room').describe('Type (tavern, shop, dungeon, room, etc)'),
      is_hidden: z.boolean().optional().default(false).describe('Whether this location is hidden'),
      discovery_dc: z.number().int().min(1).max(30).optional().default(10).describe('DC to discover (if hidden)'),
      is_shop: z.boolean().optional().default(false).describe('Whether this is a shop (items require buying)'),
      required_key_id: z.number().int().nullable().optional().default(null).describe('Item ID of key required to enter (null = no key needed)'),
    },
    async ({ token, parent_id, name, description, location_type, is_hidden, discovery_dc, is_shop, required_key_id }) => {
      try {
        const player = authenticate(token);

        // If parent_id specified, validate it
        if (parent_id !== null) {
          const parent = getLocationById(parent_id);
          if (!parent) return { content: [{ type: 'text', text: 'Parent location not found.' }] };
          if (parent.chunk_x !== player.chunk_x || parent.chunk_y !== player.chunk_y) {
            return { content: [{ type: 'text', text: 'Parent location must be in your current chunk.' }] };
          }
          // Player must be in the parent location
          if (player.location_id !== parent_id) {
            return { content: [{ type: 'text', text: 'You must be inside the parent location to create a sub-location.' }] };
          }
        } else {
          // Must be at chunk level (not inside a location)
          if (player.location_id !== null) {
            return { content: [{ type: 'text', text: 'You must be at chunk level (outside) to create a top-level location. Use `exit` first, or specify a parent_id.' }] };
          }
        }

        const loc = createLocation(
          player.chunk_x, player.chunk_y, parent_id,
          name, description, location_type,
          is_hidden, discovery_dc, is_shop, required_key_id, player.id
        );

        logEvent('location_created', player.id, null, player.chunk_x, player.chunk_y, loc.id, { name, location_type, is_hidden });

        return {
          content: [{
            type: 'text',
            text: `📍 Location created: ${loc.name} [${loc.id}]\n${loc.description}\nType: ${loc.location_type} | Depth: ${loc.depth}${loc.is_hidden ? ` | Hidden (DC ${loc.discovery_dc})` : ''}\n\nOther players can now enter this location.`
          }]
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Failed: ${e.message}` }] };
      }
    }
  );
}
