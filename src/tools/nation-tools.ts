import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getChunk } from '../models/chunk.js';
import { getLocationById } from '../models/location.js';
import { getPlayerById } from '../models/player.js';
import { logEvent } from '../models/event-log.js';
import { REVOLT_THRESHOLD, MIN_REVOLT_LEVEL, MAX_POLICY_FEE, MAX_COMBINED_ENTRY_EXIT_FEE } from '../types/index.js';
import { enforceCooldown, COOLDOWNS } from '../server/cooldown.js';
import {
  setImmigrationPolicy,
  setBuildPolicy,
  setExitPolicy,
  setChunkForSale,
  buyChunk,
  demolishLocation,
  getDemolishCost,
  getCitizensCount,
  getRevoltVotes,
  getActiveRevoltVotes,
  castRevoltVote,
  clearRevoltVotes,
  addChunkRevenue,
  getRevoltVotesNeeded,
} from '../models/nation.js';
import { abdicateRule } from '../models/governance.js';

export function registerNationTools(server: McpServer): void {
  server.tool(
    'set_immigration_policy',
    'Set immigration policy for your chunk. Only the ruler can do this.',
    {
      token: z.string().uuid().describe('Your auth token'),
      policy: z.enum(['open', 'selective', 'closed', 'fee']).describe('open=anyone, selective=ruler approves, closed=no entry, fee=pay to enter'),
      fee: z.number().int().min(1).max(MAX_POLICY_FEE).optional().describe('Immigration fee in gold (required when policy="fee")'),
    },
    async ({ token, policy, fee }) => {
      try {
        const player = authenticate(token);
        if (player.chunk_x === 0 && player.chunk_y === 0) {
          return { content: [{ type: 'text', text: 'The Nexus is a free zone — policies cannot be changed here.' }] };
        }
        if (policy === 'fee' && (fee === undefined || fee <= 0)) {
          return { content: [{ type: 'text', text: 'You must specify a fee amount (fee > 0) when using the "fee" policy.' }] };
        }
        const chunk = getChunk(player.chunk_x, player.chunk_y);
        if (!chunk) return { content: [{ type: 'text', text: 'Chunk not found.' }] };
        if (chunk.ruler_id !== player.id) {
          return { content: [{ type: 'text', text: 'You are not the ruler of this chunk.' }] };
        }

        const actualFee = policy === 'fee' ? Math.min(fee ?? 0, MAX_POLICY_FEE) : 0;

        // Cap combined entry + exit fees to prevent fee traps
        const combinedFee = actualFee + chunk.exit_fee;
        if (combinedFee > MAX_COMBINED_ENTRY_EXIT_FEE) {
          const maxAllowed = Math.max(0, MAX_COMBINED_ENTRY_EXIT_FEE - chunk.exit_fee);
          return { content: [{ type: 'text', text: `Combined entry + exit fees cannot exceed ${MAX_COMBINED_ENTRY_EXIT_FEE}g. Current exit fee: ${chunk.exit_fee}g. Max immigration fee allowed: ${maxAllowed}g.` }] };
        }

        setImmigrationPolicy(player.chunk_x, player.chunk_y, policy, actualFee);
        logEvent('policy_change', player.id, null, player.chunk_x, player.chunk_y, null, { type: 'immigration', policy, fee: actualFee });

        const feeText = policy === 'fee' ? ` | Fee: ${actualFee}g` : '';
        return { content: [{ type: 'text', text: `Immigration policy set to "${policy}"${feeText} for ${chunk.name}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'set_build_policy',
    'Set building policy for your chunk. Only the ruler can do this.',
    {
      token: z.string().uuid().describe('Your auth token'),
      policy: z.enum(['free', 'permit', 'fee', 'citizens', 'closed']).describe('free=anyone, permit=ruler approves, fee=pay to build, citizens=only citizens, closed=no building'),
      fee: z.number().int().min(1).max(MAX_POLICY_FEE).optional().describe('Build fee in gold (required when policy="fee")'),
    },
    async ({ token, policy, fee }) => {
      try {
        const player = authenticate(token);
        if (player.chunk_x === 0 && player.chunk_y === 0) {
          return { content: [{ type: 'text', text: 'The Nexus is a free zone — policies cannot be changed here.' }] };
        }
        if (policy === 'fee' && (fee === undefined || fee <= 0)) {
          return { content: [{ type: 'text', text: 'You must specify a fee amount (fee > 0) when using the "fee" policy.' }] };
        }
        const chunk = getChunk(player.chunk_x, player.chunk_y);
        if (!chunk) return { content: [{ type: 'text', text: 'Chunk not found.' }] };
        if (chunk.ruler_id !== player.id) {
          return { content: [{ type: 'text', text: 'You are not the ruler of this chunk.' }] };
        }

        const actualFee = policy === 'fee' ? Math.min(fee ?? 0, MAX_POLICY_FEE) : 0;
        setBuildPolicy(player.chunk_x, player.chunk_y, policy, actualFee);
        logEvent('policy_change', player.id, null, player.chunk_x, player.chunk_y, null, { type: 'build', policy, fee: actualFee });

        const feeText = policy === 'fee' ? ` | Fee: ${actualFee}g` : '';
        return { content: [{ type: 'text', text: `Build policy set to "${policy}"${feeText} for ${chunk.name}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'set_exit_policy',
    'Set exit policy for your chunk. Only the ruler can do this.',
    {
      token: z.string().uuid().describe('Your auth token'),
      policy: z.enum(['free', 'fee', 'locked']).describe('free=can leave, fee=pay to leave, locked=cannot leave (emergency escape available)'),
      fee: z.number().int().min(1).max(MAX_POLICY_FEE).optional().describe('Exit fee in gold (required when policy="fee")'),
    },
    async ({ token, policy, fee }) => {
      try {
        const player = authenticate(token);
        if (player.chunk_x === 0 && player.chunk_y === 0) {
          return { content: [{ type: 'text', text: 'The Nexus is a free zone — policies cannot be changed here.' }] };
        }
        if (policy === 'fee' && (fee === undefined || fee <= 0)) {
          return { content: [{ type: 'text', text: 'You must specify a fee amount (fee > 0) when using the "fee" policy.' }] };
        }
        const chunk = getChunk(player.chunk_x, player.chunk_y);
        if (!chunk) return { content: [{ type: 'text', text: 'Chunk not found.' }] };
        if (chunk.ruler_id !== player.id) {
          return { content: [{ type: 'text', text: 'You are not the ruler of this chunk.' }] };
        }

        const actualFee = policy === 'fee' ? Math.min(fee ?? 0, MAX_POLICY_FEE) : 0;

        // Cap combined entry + exit fees to prevent fee traps
        const combinedFee = chunk.immigration_fee + actualFee;
        if (combinedFee > MAX_COMBINED_ENTRY_EXIT_FEE) {
          const maxAllowed = Math.max(0, MAX_COMBINED_ENTRY_EXIT_FEE - chunk.immigration_fee);
          return { content: [{ type: 'text', text: `Combined entry + exit fees cannot exceed ${MAX_COMBINED_ENTRY_EXIT_FEE}g. Current immigration fee: ${chunk.immigration_fee}g. Max exit fee allowed: ${maxAllowed}g.` }] };
        }

        setExitPolicy(player.chunk_x, player.chunk_y, policy, actualFee);
        logEvent('policy_change', player.id, null, player.chunk_x, player.chunk_y, null, { type: 'exit', policy, fee: actualFee });

        const feeText = policy === 'fee' ? ` | Fee: ${actualFee}g` : '';
        return { content: [{ type: 'text', text: `Exit policy set to "${policy}"${feeText} for ${chunk.name}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'sell_chunk',
    'List your chunk for sale at a USDC price, or delist it.',
    {
      token: z.string().uuid().describe('Your auth token'),
      price: z.number().int().min(0).nullable().describe('Price in USDC cents (null to delist). 100 = $1.00'),
    },
    async ({ token, price }) => {
      try {
        const player = authenticate(token);
        const chunk = getChunk(player.chunk_x, player.chunk_y);
        if (!chunk) return { content: [{ type: 'text', text: 'Chunk not found.' }] };
        if (chunk.ruler_id !== player.id) {
          return { content: [{ type: 'text', text: 'You are not the ruler of this chunk.' }] };
        }

        setChunkForSale(player.chunk_x, player.chunk_y, price);
        logEvent('chunk_sale_listing', player.id, null, player.chunk_x, player.chunk_y, null, { price });

        if (price === null) {
          return { content: [{ type: 'text', text: `${chunk.name} has been delisted from sale.` }] };
        }
        return { content: [{ type: 'text', text: `${chunk.name} is now for sale at $${(price / 100).toFixed(2)} USDC.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'buy_chunk',
    'Buy a chunk that is listed for sale. Transfers ownership and deducts USDC.',
    {
      token: z.string().uuid().describe('Your auth token'),
      chunk_x: z.number().int().describe('Chunk X coordinate'),
      chunk_y: z.number().int().describe('Chunk Y coordinate'),
    },
    async ({ token, chunk_x, chunk_y }) => {
      try {
        const player = authenticate(token);
        const chunk = getChunk(chunk_x, chunk_y);
        if (!chunk) return { content: [{ type: 'text', text: 'Chunk not found.' }] };

        const result = buyChunk(player.id, chunk_x, chunk_y);
        logEvent('chunk_bought', player.id, chunk.ruler_id, chunk_x, chunk_y, null, {
          cost: result.cost,
          tax: result.tax,
        });

        return {
          content: [{
            type: 'text',
            text: `You bought ${chunk.name} for $${(result.cost / 100).toFixed(2)} USDC (tax: $${(result.tax / 100).toFixed(2)}).\nYou are now the ruler of this chunk.`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'demolish',
    'Demolish a location. Owner demolishes free. Ruler pays 50%. Others pay full cost. Owner gets 50% compensation.',
    {
      token: z.string().uuid().describe('Your auth token'),
      location_id: z.number().int().describe('ID of the location to demolish'),
    },
    async ({ token, location_id }) => {
      try {
        const player = authenticate(token);
        const loc = getLocationById(location_id);
        if (!loc) return { content: [{ type: 'text', text: 'Location not found.' }] };
        if (loc.chunk_x !== player.chunk_x || loc.chunk_y !== player.chunk_y) {
          return { content: [{ type: 'text', text: 'That location is not in your current chunk.' }] };
        }

        const chunk = getChunk(loc.chunk_x, loc.chunk_y);
        const isOwner = loc.created_by === player.id;
        const isRuler = chunk?.ruler_id === player.id;

        const previewCost = getDemolishCost(location_id);
        const result = demolishLocation(player.id, location_id, isOwner, isRuler);

        logEvent('demolish', player.id, loc.created_by, loc.chunk_x, loc.chunk_y, location_id, {
          cost: result.cost,
          compensation: result.compensation,
          location_name: loc.name,
        });

        if (isOwner) {
          return { content: [{ type: 'text', text: `You demolished your own "${loc.name}" at no cost.` }] };
        }

        const ownerPlayer = getPlayerById(loc.created_by);
        const ownerName = ownerPlayer?.name || 'unknown';
        return {
          content: [{
            type: 'text',
            text: `You demolished "${loc.name}". Cost: ${result.cost}g.${result.compensation > 0 ? ` Owner (${ownerName}) received ${result.compensation}g compensation.` : ''}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'demolish_cost',
    'Check how much it would cost to demolish a location.',
    {
      token: z.string().uuid().describe('Your auth token'),
      location_id: z.number().int().describe('ID of the location'),
    },
    async ({ token, location_id }) => {
      try {
        authenticate(token);
        const loc = getLocationById(location_id);
        if (!loc) return { content: [{ type: 'text', text: 'Location not found.' }] };

        const fullCost = getDemolishCost(location_id);
        const chunk = getChunk(loc.chunk_x, loc.chunk_y);

        return {
          content: [{
            type: 'text',
            text: `Demolition cost for "${loc.name}":\n  Full cost: ${fullCost}g\n  Ruler cost: ${Math.floor(fullCost * 0.5)}g\n  Owner cost: free\n  Owner compensation: ${Math.floor(fullCost * 0.5)}g\n  Lifetime revenue: ${loc.revenue_total}g`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'revolt',
    'Vote to overthrow the current ruler. If 30% of citizens vote, the ruler is deposed.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const chunk = getChunk(player.chunk_x, player.chunk_y);
        if (!chunk) return { content: [{ type: 'text', text: 'Chunk not found.' }] };
        if (chunk.ruler_id === null) {
          return { content: [{ type: 'text', text: 'This chunk has no ruler to revolt against.' }] };
        }
        if (chunk.ruler_id === player.id) {
          return { content: [{ type: 'text', text: 'You cannot revolt against yourself. Use `abdicate` instead.' }] };
        }
        if (player.level < MIN_REVOLT_LEVEL) {
          return { content: [{ type: 'text', text: `You must be at least level ${MIN_REVOLT_LEVEL} to vote for revolt.` }] };
        }

        const cd = enforceCooldown(player.id, 'revolt', COOLDOWNS.REVOLT);
        if (cd !== null) return { content: [{ type: 'text', text: `Please wait ${cd}s before voting again.` }] };

        castRevoltVote(player.id, player.chunk_x, player.chunk_y);

        // Only count votes from players currently in this chunk
        const votes = getActiveRevoltVotes(player.chunk_x, player.chunk_y);
        const citizens = getCitizensCount(player.chunk_x, player.chunk_y);
        const needed = getRevoltVotesNeeded(citizens);

        if (votes >= needed) {
          const oldRuler = getPlayerById(chunk.ruler_id);
          abdicateRule(chunk.ruler_id, player.chunk_x, player.chunk_y);
          clearRevoltVotes(player.chunk_x, player.chunk_y);

          logEvent('revolt_success', player.id, chunk.ruler_id, player.chunk_x, player.chunk_y, null, {
            votes,
            citizens,
            old_ruler: oldRuler?.name,
          });

          return {
            content: [{
              type: 'text',
              text: `The people have spoken! ${oldRuler?.name || 'The ruler'} has been overthrown!\n${votes}/${citizens} citizens voted (${needed} needed).\n${chunk.name} is now without a ruler. Anyone can claim it.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Your revolt vote has been cast. ${votes}/${needed} votes needed (${citizens} citizens, ${Math.round(REVOLT_THRESHOLD * 100)}% threshold).`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'chunk_info',
    'Get detailed info about a chunk including policies, ruler, and economy.',
    {
      token: z.string().uuid().describe('Your auth token'),
      chunk_x: z.number().int().optional().describe('Chunk X (default: your current chunk)'),
      chunk_y: z.number().int().optional().describe('Chunk Y (default: your current chunk)'),
    },
    async ({ token, chunk_x, chunk_y }) => {
      try {
        const player = authenticate(token);
        const cx = chunk_x ?? player.chunk_x;
        const cy = chunk_y ?? player.chunk_y;
        const chunk = getChunk(cx, cy);
        if (!chunk) return { content: [{ type: 'text', text: 'Chunk not found.' }] };

        const ruler = chunk.ruler_id ? getPlayerById(chunk.ruler_id) : null;
        const citizens = getCitizensCount(cx, cy);
        const revoltVotes = chunk.ruler_id ? getRevoltVotes(cx, cy) : 0;
        const needed = getRevoltVotesNeeded(citizens);

        const parts: string[] = [
          `=== ${chunk.name} (${cx},${cy}) ===`,
          `Terrain: ${chunk.terrain_type} | Danger: ${chunk.danger_level}`,
          ``,
          `--- Governance ---`,
          `Ruler: ${ruler ? ruler.name : 'None'}`,
          `Tax rate: ${chunk.chunk_tax_rate}%`,
          `Citizens: ${citizens}`,
        ];

        if (chunk.ruler_id) {
          parts.push(`Revolt votes: ${revoltVotes}/${needed}`);
        }

        parts.push(
          ``,
          `--- Policies ---`,
          `Immigration: ${chunk.immigration_policy}${chunk.immigration_fee > 0 ? ` (${chunk.immigration_fee}g fee)` : ''}`,
          `Building: ${chunk.build_policy}${chunk.build_fee > 0 ? ` (${chunk.build_fee}g fee)` : ''}`,
          `Exit: ${chunk.exit_policy}${chunk.exit_fee > 0 ? ` (${chunk.exit_fee}g fee)` : ''}`,
          ``,
          `--- Economy ---`,
          `Total revenue: ${chunk.revenue_total}g`,
          `For sale: ${chunk.sale_price !== null ? `$${(chunk.sale_price / 100).toFixed(2)} USDC` : 'No'}`,
        );

        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
