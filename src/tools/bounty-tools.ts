import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getPlayerByName, getPlayerById, updatePlayerGold } from '../models/player.js';
import { enforceCooldown } from '../server/cooldown.js';
import { getDb } from '../db/connection.js';
import {
  createPlayerBounty,
  getActiveBounties,
  getBountyById,
  claimPlayerBounty,
  cancelPlayerBounty,
  getPlayerCreatedBounties,
  getBountiesOnPlayer,
  expireOldBounties,
} from '../models/bounty.js';
import { getBounty } from '../game/bounty.js';
import {
  MIN_BOUNTY_REWARD,
  MAX_BOUNTY_DURATION_HOURS,
  DEFAULT_BOUNTY_DURATION_HOURS,
  BOUNTY_CANCEL_REFUND_RATE,
  BOUNTY_CLAIM_WINDOW_MINUTES,
  BOUNTY_COOLDOWN_MS,
  MAX_BOUNTY_REASON_LENGTH,
} from '../types/bounty-board.js';
import type { PlayerBountyWithNames } from '../types/bounty-board.js';
import { logEvent } from '../models/event-log.js';
import { containsProhibitedContent } from '../utils/content-filter.js';

function formatTimeRemaining(expiresAt: string): string {
  const expiresMs = new Date(expiresAt + 'Z').getTime();
  const nowMs = Date.now();
  const diffMs = expiresMs - nowMs;

  if (diffMs <= 0) return 'Expired';

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBountyLine(b: PlayerBountyWithNames): string {
  const timeLeft = formatTimeRemaining(b.expires_at);
  const reason = b.reason ? ` — "${b.reason}"` : '';
  const poster = b.creator_name;
  return `#${b.id} | ${b.target_name} | ${b.reward}g | by ${poster} | ${timeLeft} left${reason}`;
}

export function registerBountyTools(server: McpServer): void {
  // --- create_bounty ---
  server.tool(
    'create_bounty',
    'Place a bounty on another player. Gold is deducted immediately. Other players can claim it by killing the target.',
    {
      token: z.string().uuid().describe('Your auth token'),
      target: z.string().describe('Name of the player to place a bounty on'),
      reward: z.number().int().min(MIN_BOUNTY_REWARD).describe(`Gold reward (minimum ${MIN_BOUNTY_REWARD}g, deducted from you)`),
      reason: z.string().max(MAX_BOUNTY_REASON_LENGTH).optional().default('').describe('Optional reason for the bounty'),
      anonymous: z.boolean().optional().default(false).describe('Hide your name on the bounty board'),
      duration_hours: z.number().int().min(1).max(MAX_BOUNTY_DURATION_HOURS).optional().default(DEFAULT_BOUNTY_DURATION_HOURS)
        .describe(`Duration in hours (1-${MAX_BOUNTY_DURATION_HOURS}, default ${DEFAULT_BOUNTY_DURATION_HOURS})`),
    },
    async ({ token, target, reward, reason, anonymous, duration_hours }) => {
      try {
        const player = authenticate(token);

        const cd = enforceCooldown(player.id, 'create_bounty', BOUNTY_COOLDOWN_MS);
        if (cd !== null) {
          return { content: [{ type: 'text' as const, text: `Please wait ${cd}s before placing another bounty.` }] };
        }

        // Validate reason content
        if (reason && containsProhibitedContent(reason)) {
          return { content: [{ type: 'text' as const, text: 'Bounty reason contains inappropriate content.' }] };
        }

        const targetPlayer = getPlayerByName(target);
        if (!targetPlayer) {
          return { content: [{ type: 'text' as const, text: `Player "${target}" not found or is dead.` }] };
        }

        if (targetPlayer.id === player.id) {
          return { content: [{ type: 'text' as const, text: 'You cannot place a bounty on yourself.' }] };
        }

        // Re-read player gold from DB to avoid stale data
        const freshPlayer = getPlayerById(player.id);
        if (!freshPlayer || freshPlayer.gold < reward) {
          const currentGold = freshPlayer?.gold ?? 0;
          return { content: [{ type: 'text' as const, text: `Not enough gold. You have ${currentGold}g, need ${reward}g.` }] };
        }

        // Expire old bounties first
        expireOldBounties();

        // Deduct gold and create bounty in a transaction
        const db = getDb();
        const bounty = db.transaction(() => {
          updatePlayerGold(player.id, freshPlayer.gold - reward);
          return createPlayerBounty(player.id, targetPlayer.id, reward, reason, anonymous, duration_hours);
        })();

        logEvent('bounty_created', player.id, targetPlayer.id, player.chunk_x, player.chunk_y, player.location_id, {
          bounty_id: bounty.id,
          reward,
          anonymous,
          duration_hours,
        });

        const anonLabel = anonymous ? ' (anonymous)' : '';
        const lines = [
          `Bounty #${bounty.id} placed on ${targetPlayer.name}!`,
          `Reward: ${reward}g${anonLabel}`,
          `Duration: ${duration_hours} hours`,
          reason ? `Reason: "${reason}"` : '',
          `${reward}g deducted from your balance.`,
        ].filter(Boolean);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- claim_bounty ---
  server.tool(
    'claim_bounty',
    'Claim a bounty after killing the target. You must have killed the target within the last 10 minutes.',
    {
      token: z.string().uuid().describe('Your auth token'),
      bounty_id: z.number().int().describe('ID of the bounty to claim'),
    },
    async ({ token, bounty_id }) => {
      try {
        const player = authenticate(token);

        // Expire old bounties first
        expireOldBounties();

        const bounty = getBountyById(bounty_id);

        if (!bounty) {
          return { content: [{ type: 'text' as const, text: `Bounty #${bounty_id} not found.` }] };
        }

        if (bounty.status !== 'active') {
          return { content: [{ type: 'text' as const, text: `Bounty #${bounty_id} is no longer active (status: ${bounty.status}).` }] };
        }

        if (new Date(bounty.expires_at + 'Z').getTime() <= Date.now()) {
          return { content: [{ type: 'text' as const, text: `Bounty #${bounty_id} has expired.` }] };
        }

        if (bounty.creator_id === player.id) {
          return { content: [{ type: 'text' as const, text: 'You cannot claim your own bounty. Use cancel_bounty to get a partial refund.' }] };
        }

        // Check event_log for recent pvp kill of the target by this player
        const db = getDb();
        const recentKill = db.prepare(`
          SELECT id FROM event_log
          WHERE event_type = 'kill'
            AND actor_id = ?
            AND target_id = ?
            AND created_at >= datetime('now', '-${BOUNTY_CLAIM_WINDOW_MINUTES} minutes')
          ORDER BY created_at DESC
          LIMIT 1
        `).get(player.id, bounty.target_id) as { id: number } | undefined;

        if (!recentKill) {
          return { content: [{ type: 'text' as const, text: `You haven't killed ${bounty.target_name} in the last ${BOUNTY_CLAIM_WINDOW_MINUTES} minutes. Kill the target first, then claim.` }] };
        }

        // Claim the bounty: award gold and update status
        const freshPlayer = getPlayerById(player.id);
        if (!freshPlayer) {
          return { content: [{ type: 'text' as const, text: 'Could not verify your player data.' }] };
        }

        const newGold = Math.min(freshPlayer.gold + bounty.reward, 10_000_000);
        db.transaction(() => {
          updatePlayerGold(player.id, newGold);
          claimPlayerBounty(bounty_id, player.id);
        })();

        logEvent('bounty_claimed', player.id, bounty.target_id, player.chunk_x, player.chunk_y, player.location_id, {
          bounty_id,
          reward: bounty.reward,
          creator_id: bounty.creator_id,
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Bounty #${bounty_id} claimed! You received ${bounty.reward}g for eliminating ${bounty.target_name}.`,
          }],
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- cancel_bounty ---
  server.tool(
    'cancel_bounty',
    'Cancel a bounty you created. You get an 80% refund (20% penalty).',
    {
      token: z.string().uuid().describe('Your auth token'),
      bounty_id: z.number().int().describe('ID of the bounty to cancel'),
    },
    async ({ token, bounty_id }) => {
      try {
        const player = authenticate(token);

        const bounty = getBountyById(bounty_id);

        if (!bounty) {
          return { content: [{ type: 'text' as const, text: `Bounty #${bounty_id} not found.` }] };
        }

        if (bounty.creator_id !== player.id) {
          return { content: [{ type: 'text' as const, text: 'You can only cancel bounties you created.' }] };
        }

        if (bounty.status !== 'active') {
          return { content: [{ type: 'text' as const, text: `Bounty #${bounty_id} is no longer active (status: ${bounty.status}).` }] };
        }

        const refund = Math.floor(bounty.reward * BOUNTY_CANCEL_REFUND_RATE);
        const penalty = bounty.reward - refund;

        const freshPlayer = getPlayerById(player.id);
        if (!freshPlayer) {
          return { content: [{ type: 'text' as const, text: 'Could not verify your player data.' }] };
        }

        const newGold = Math.min(freshPlayer.gold + refund, 10_000_000);
        const db = getDb();
        db.transaction(() => {
          updatePlayerGold(player.id, newGold);
          cancelPlayerBounty(bounty_id);
        })();

        logEvent('bounty_cancelled', player.id, bounty.target_id, player.chunk_x, player.chunk_y, player.location_id, {
          bounty_id,
          reward: bounty.reward,
          refund,
          penalty,
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Bounty #${bounty_id} cancelled. Refunded ${refund}g (${penalty}g penalty).`,
          }],
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- my_bounties ---
  server.tool(
    'my_bounties',
    'View bounties you placed and bounties on your head.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);

        // Expire old bounties first
        expireOldBounties();

        const created = getPlayerCreatedBounties(player.id);
        const onMe = getBountiesOnPlayer(player.id);

        const parts: string[] = [];

        // Bounties I created
        parts.push('=== BOUNTIES YOU PLACED ===');
        if (created.length === 0) {
          parts.push('None.');
        } else {
          for (const b of created) {
            const statusLabel = b.status === 'active'
              ? `ACTIVE (${formatTimeRemaining(b.expires_at)} left)`
              : b.status.toUpperCase();
            const claimerNote = b.claimer_name ? ` — claimed by ${b.claimer_name}` : '';
            parts.push(`#${b.id} | ${b.target_name} | ${b.reward}g | ${statusLabel}${claimerNote}`);
          }
        }

        parts.push('');

        // System bounty (from PvP kills, stored in bounties table)
        const systemBounty = getBounty(player.id);
        parts.push('=== SYSTEM BOUNTY ===');
        if (systemBounty && systemBounty.amount > 0) {
          parts.push(`System Bounty: ${systemBounty.amount}g (from PvP kills)`);
        } else {
          parts.push('None.');
        }

        parts.push('');

        // Player-created bounties on me
        parts.push('=== BOUNTIES ON YOUR HEAD ===');
        if (onMe.length === 0) {
          parts.push('None. You are safe... for now.');
        } else {
          const activeOnMe = onMe.filter(b => b.status === 'active');
          const totalReward = activeOnMe.reduce((sum, b) => sum + b.reward, 0);
          for (const b of onMe) {
            const statusLabel = b.status === 'active'
              ? `ACTIVE (${formatTimeRemaining(b.expires_at)} left)`
              : b.status.toUpperCase();
            parts.push(`#${b.id} | ${b.reward}g | by ${b.creator_name} | ${statusLabel}`);
          }
          if (activeOnMe.length > 0) {
            parts.push(`\nTotal active bounty on you: ${totalReward}g`);
          }
        }

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- bounty_board ---
  server.tool(
    'bounty_board',
    'View the public bounty board. Lists all active player bounties sorted by reward.',
    {
      token: z.string().uuid().describe('Your auth token'),
      min_reward: z.number().int().optional().describe('Filter: only show bounties with at least this reward'),
    },
    async ({ token, min_reward }) => {
      try {
        authenticate(token);

        expireOldBounties();

        const bounties = getActiveBounties(min_reward ?? undefined);

        if (bounties.length === 0) {
          const filterNote = min_reward ? ` above ${min_reward}g` : '';
          return { content: [{ type: 'text' as const, text: `No active bounties${filterNote}. The realm is at peace... for now.` }] };
        }

        const lines = ['=== BOUNTY BOARD ===', ''];
        for (const b of bounties) {
          lines.push(formatBountyLine(b));
        }

        const totalReward = bounties.reduce((sum, b) => sum + b.reward, 0);
        lines.push('');
        lines.push(`${bounties.length} active bounties | Total reward pool: ${totalReward}g`);
        lines.push('');
        lines.push('Use create_bounty to place a bounty, or claim_bounty after killing a target.');

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );
}
