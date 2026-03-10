import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { claimChunk, seizeChunk, transferRule, abdicateRule, setTaxRate, getChunksRuledBy } from '../models/governance.js';
import { getPlayerByName } from '../models/player.js';
import { logEvent } from '../models/event-log.js';
import { MAX_CHUNK_TAX_RATE } from '../types/index.js';
import { enforceCooldown, COOLDOWNS } from '../server/cooldown.js';

export function registerGovernanceTools(server: McpServer): void {
  server.tool(
    'claim_chunk',
    'Claim rulership of an unruled chunk. Free if you created it, 100g otherwise.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        if (player.location_id !== null) {
          return { content: [{ type: 'text', text: 'Exit the location first — you must be at chunk level.' }] };
        }
        const cd = enforceCooldown(player.id, 'claim_seize', COOLDOWNS.CLAIM_SEIZE);
        if (cd !== null) return { content: [{ type: 'text', text: `Please wait ${cd}s before claiming/seizing again.` }] };
        claimChunk(player.id, player.chunk_x, player.chunk_y);
        logEvent('claim_chunk', player.id, null, player.chunk_x, player.chunk_y, null, {});
        return { content: [{ type: 'text', text: `👑 You now rule chunk (${player.chunk_x},${player.chunk_y})! Use set_chunk_tax to set a tax rate (0-${MAX_CHUNK_TAX_RATE}%).` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'seize_chunk',
    'Seize control of a ruled chunk by force. Costs 500g + (danger_level × 100g).',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        if (player.location_id !== null) {
          return { content: [{ type: 'text', text: 'Exit the location first — you must be at chunk level.' }] };
        }
        const cd = enforceCooldown(player.id, 'claim_seize', COOLDOWNS.CLAIM_SEIZE);
        if (cd !== null) return { content: [{ type: 'text', text: `Please wait ${cd}s before claiming/seizing again.` }] };
        seizeChunk(player.id, player.chunk_x, player.chunk_y);
        logEvent('seize_chunk', player.id, null, player.chunk_x, player.chunk_y, null, {});
        return { content: [{ type: 'text', text: `⚔️ You seized control of chunk (${player.chunk_x},${player.chunk_y})!` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'transfer_rule',
    'Transfer rulership of your current chunk to another player.',
    {
      token: z.string().uuid().describe('Your auth token'),
      to: z.string().describe('Name of the player to transfer rule to'),
    },
    async ({ token, to }) => {
      try {
        const player = authenticate(token);
        const target = getPlayerByName(to);
        if (!target) return { content: [{ type: 'text', text: `Player "${to}" not found.` }] };

        const result = transferRule(player.id, player.chunk_x, player.chunk_y, target.id);
        logEvent('transfer_rule', player.id, target.id, player.chunk_x, player.chunk_y, null, { fee: result.fee });
        return { content: [{ type: 'text', text: `👑 Transferred rule of (${player.chunk_x},${player.chunk_y}) to ${target.name}. Transfer fee: ${result.fee}g.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'abdicate',
    'Give up rulership of your current chunk.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        abdicateRule(player.id, player.chunk_x, player.chunk_y);
        logEvent('abdicate', player.id, null, player.chunk_x, player.chunk_y, null, {});
        return { content: [{ type: 'text', text: `You abdicate rule of chunk (${player.chunk_x},${player.chunk_y}). Tax rate reset to 0%.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'set_chunk_tax',
    `Set the tax rate for your current chunk (0-${MAX_CHUNK_TAX_RATE}%). You receive the chunk tax from all gold transactions here.`,
    {
      token: z.string().uuid().describe('Your auth token'),
      rate: z.number().int().min(0).max(MAX_CHUNK_TAX_RATE).describe('Tax rate percentage (0-15)'),
    },
    async ({ token, rate }) => {
      try {
        const player = authenticate(token);
        setTaxRate(player.id, player.chunk_x, player.chunk_y, rate);
        logEvent('set_tax', player.id, null, player.chunk_x, player.chunk_y, null, { rate });
        return { content: [{ type: 'text', text: `📜 Tax rate for (${player.chunk_x},${player.chunk_y}) set to ${rate}%.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'my_chunks',
    'View all chunks you rule.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const chunks = getChunksRuledBy(player.id);
        if (chunks.length === 0) {
          return { content: [{ type: 'text', text: 'You do not rule any chunks.' }] };
        }
        const parts = ['👑 Your chunks:'];
        for (const c of chunks) {
          parts.push(`  (${c.x},${c.y}) ${c.name} — tax: ${c.chunk_tax_rate}%, terrain: ${c.terrain_type}`);
        }
        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
