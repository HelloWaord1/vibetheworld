import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createPlayer, loginPlayer, isNameTakenByAlive } from '../models/player.js';
import { logEvent } from '../models/event-log.js';

export function registerAuthTools(server: McpServer): void {
  server.tool(
    'register',
    'Register a new character in VibeWorld. Returns a token for authentication.',
    {
      name: z.string().min(2).max(24).describe('Character name (2-24 chars, alphanumeric + _ - space)'),
      password: z.string().min(3).max(64).describe('Password for the account'),
    },
    async ({ name, password }) => {
      try {
        if (isNameTakenByAlive(name)) {
          return { content: [{ type: 'text', text: `Name "${name}" is already taken by a living character. Choose another.` }] };
        }
        const player = createPlayer(name, password);
        logEvent('register', player.id, null, 0, 0, null, { name });
        return {
          content: [{
            type: 'text',
            text: `Welcome to VibeWorld, ${player.name}!\n\nYour token: ${player.token}\n\nYou start at The Nexus (0,0) with ${player.gold} gold.\nUse this token in all subsequent commands.\n\nTip: Use \`look\` to see your surroundings.`
          }]
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Registration failed: ${e.message}` }] };
      }
    }
  );

  server.tool(
    'login',
    'Login to an existing character. Returns a fresh token.',
    {
      name: z.string().describe('Character name'),
      password: z.string().describe('Password'),
    },
    async ({ name, password }) => {
      const player = loginPlayer(name, password);
      if (!player) {
        return { content: [{ type: 'text', text: 'Login failed. Wrong name/password or character is dead.' }] };
      }
      logEvent('login', player.id, null, player.chunk_x, player.chunk_y, player.location_id);
      return {
        content: [{
          type: 'text',
          text: `Welcome back, ${player.name}!\n\nYour token: ${player.token}\nHP: ${player.hp}/${player.max_hp} | Level ${player.level} | Gold: ${player.gold}\nLocation: chunk (${player.chunk_x},${player.chunk_y})`
        }]
      };
    }
  );
}
