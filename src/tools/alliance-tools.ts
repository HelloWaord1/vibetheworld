import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { enforceCooldown, COOLDOWNS } from '../server/cooldown.js';
import { validateContent } from '../utils/content-filter.js';
import { getPlayerByName, updatePlayerGold } from '../models/player.js';
import { getDb } from '../db/connection.js';
import {
  createAlliance,
  getAlliance,
  getAllianceByPlayerId,
  addMember,
  removeMember,
  updateRole,
  disbandAlliance,
  depositToTreasury,
  getMemberRole,
  getPlayerAllianceId,
  getPlayerPendingInvite,
  getPlayerPendingInvites,
  hasPlayerAnyMembership,
  getActiveMemberCount,
  listAlliances,
} from '../models/alliance.js';
import {
  ALLIANCE_CREATION_COST,
  MAX_GOLD,
} from '../types/index.js';

const textReply = (text: string) =>
  ({ content: [{ type: 'text' as const, text }] });

const sanitized = (s: string) => s.replace(/[\x00-\x1f]/g, '');

export function registerAllianceTools(server: McpServer): void {
  // ---------- create_alliance ----------
  server.tool(
    'create_alliance',
    'Create an alliance. Costs 500 gold. You become the leader.',
    {
      token: z.string().uuid().describe('Your auth token'),
      name: z.string().min(2).max(30).transform(sanitized)
        .describe('Alliance name (2-30 characters)'),
      tag: z.string().min(2).max(5).transform(s => sanitized(s).toUpperCase())
        .describe('Alliance tag (2-5 characters, displayed as uppercase)'),
    },
    async ({ token, name, tag }) => {
      try {
        const player = authenticate(token);

        validateContent(name, 'alliance name');
        validateContent(tag, 'alliance tag');

        const cd = enforceCooldown(player.id, 'create_alliance', COOLDOWNS.CREATE_ALLIANCE);
        if (cd !== null) return textReply(`Please wait ${cd}s before creating another alliance.`);

        if (player.gold < ALLIANCE_CREATION_COST) {
          return textReply(`You need ${ALLIANCE_CREATION_COST} gold to create an alliance. You have ${player.gold}g.`);
        }

        const alliance = createAlliance(name, tag, player.id);
        updatePlayerGold(player.id, player.gold - ALLIANCE_CREATION_COST);

        return textReply(
          `Alliance [${alliance.tag}] "${alliance.name}" created! (ID: ${alliance.id})\n` +
          `Cost: ${ALLIANCE_CREATION_COST}g. You are the leader.`,
        );
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- invite_to_alliance ----------
  server.tool(
    'invite_to_alliance',
    'Invite a player to your alliance. Requires leader or officer role.',
    {
      token: z.string().uuid().describe('Your auth token'),
      player_name: z.string().min(1).describe('Name of the player to invite'),
    },
    async ({ token, player_name }) => {
      try {
        const player = authenticate(token);

        const cd = enforceCooldown(player.id, 'alliance_invite', COOLDOWNS.ALLIANCE_INVITE);
        if (cd !== null) return textReply(`Please wait ${cd}s before sending another invite.`);

        const myAllianceId = getPlayerAllianceId(player.id);
        if (myAllianceId === null) return textReply('You are not in an alliance.');

        const myRole = getMemberRole(myAllianceId, player.id);
        if (myRole !== 'leader' && myRole !== 'officer') {
          return textReply('Only the leader or officers can invite players.');
        }

        const target = getPlayerByName(player_name);
        if (!target) return textReply(`Player "${player_name}" not found.`);
        if (target.id === player.id) return textReply('You cannot invite yourself.');

        if (hasPlayerAnyMembership(target.id)) {
          return textReply('That player is already in an alliance.');
        }

        if (getPlayerPendingInvite(target.id, myAllianceId)) {
          return textReply('That player already has a pending invite to your alliance.');
        }

        const alliance = getAlliance(myAllianceId);
        if (!alliance) return textReply('Alliance not found.');

        const memberCount = getActiveMemberCount(myAllianceId);
        if (memberCount >= alliance.max_members) {
          return textReply(`Alliance is full (${memberCount}/${alliance.max_members}).`);
        }

        addMember(myAllianceId, target.id, 'invited');

        return textReply(`Invited ${target.name} to [${alliance.tag}] ${alliance.name}.`);
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- accept_alliance ----------
  server.tool(
    'accept_alliance',
    'Accept a pending alliance invitation.',
    {
      token: z.string().uuid().describe('Your auth token'),
      alliance_id: z.number().int().positive().describe('Alliance ID to join'),
    },
    async ({ token, alliance_id }) => {
      try {
        const player = authenticate(token);

        if (hasPlayerAnyMembership(player.id)) {
          return textReply('You are already in an alliance. Leave it first.');
        }

        if (!getPlayerPendingInvite(player.id, alliance_id)) {
          return textReply('You do not have a pending invite to this alliance.');
        }

        const alliance = getAlliance(alliance_id);
        if (!alliance) return textReply('Alliance not found.');

        const memberCount = getActiveMemberCount(alliance_id);
        if (memberCount >= alliance.max_members) {
          return textReply(`Alliance is full (${memberCount}/${alliance.max_members}).`);
        }

        updateRole(alliance_id, player.id, 'member');

        return textReply(`You joined [${alliance.tag}] ${alliance.name}!`);
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- leave_alliance ----------
  server.tool(
    'leave_alliance',
    'Leave your current alliance. Leader cannot leave (must disband or transfer).',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);

        const myAllianceId = getPlayerAllianceId(player.id);
        if (myAllianceId === null) return textReply('You are not in an alliance.');

        const alliance = getAlliance(myAllianceId);
        if (!alliance) return textReply('Alliance not found.');

        if (alliance.leader_id === player.id) {
          return textReply('The leader cannot leave. Disband the alliance or transfer leadership first.');
        }

        removeMember(myAllianceId, player.id);

        return textReply(`You left [${alliance.tag}] ${alliance.name}.`);
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- alliance_info ----------
  server.tool(
    'alliance_info',
    'View alliance details: name, tag, level, members, treasury.',
    {
      token: z.string().uuid().describe('Your auth token'),
      alliance_id: z.number().int().positive().optional()
        .describe('Alliance ID (defaults to your alliance)'),
    },
    async ({ token, alliance_id }) => {
      try {
        const player = authenticate(token);

        let alliance;
        if (alliance_id) {
          alliance = getAlliance(alliance_id);
        } else {
          alliance = getAllianceByPlayerId(player.id);
        }

        if (!alliance) {
          if (alliance_id) return textReply('Alliance not found.');

          const invites = getPlayerPendingInvites(player.id);
          if (invites.length === 0) {
            return textReply('You are not in an alliance and have no pending invites.');
          }
          const inviteLines = invites.map(
            inv => `  [${inv.alliance_tag}] ${inv.alliance_name} (ID: ${inv.alliance_id})`,
          );
          return textReply(
            `You are not in an alliance.\n\nPending invites:\n${inviteLines.join('\n')}`,
          );
        }

        const memberLines = alliance.members.map(
          m => `  ${m.player_name} [${m.role}] (joined ${m.joined_at})`,
        );

        const text = [
          `Alliance: [${alliance.tag}] ${alliance.name} (ID: ${alliance.id})`,
          `Level: ${alliance.level}`,
          `Treasury: ${alliance.treasury}g`,
          `Members (${alliance.members.length}/${alliance.max_members}):`,
          ...memberLines,
          `Created: ${alliance.created_at}`,
        ].join('\n');

        return textReply(text);
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- alliance_chat ----------
  server.tool(
    'alliance_chat',
    'Send a message visible only to your alliance members.',
    {
      token: z.string().uuid().describe('Your auth token'),
      message: z.string().min(1).max(500).transform(sanitized)
        .describe('Message to send to alliance'),
    },
    async ({ token, message }) => {
      try {
        const player = authenticate(token);

        validateContent(message, 'message');

        const cd = enforceCooldown(player.id, 'alliance_chat', COOLDOWNS.ALLIANCE_CHAT);
        if (cd !== null) return textReply(`Please wait ${cd}s before sending another alliance message.`);

        const myAllianceId = getPlayerAllianceId(player.id);
        if (myAllianceId === null) return textReply('You are not in an alliance.');

        const db = getDb();
        db.prepare(`
          INSERT INTO messages (from_id, to_id, chunk_x, chunk_y, content, message_type, alliance_id)
          VALUES (?, NULL, ?, ?, ?, 'alliance', ?)
        `).run(player.id, player.chunk_x, player.chunk_y, message, myAllianceId);

        const alliance = getAlliance(myAllianceId);
        const tag = alliance?.tag ?? '???';

        return textReply(`[${tag}] ${player.name}: ${message}`);
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- alliance_deposit ----------
  server.tool(
    'alliance_deposit',
    'Deposit gold into your alliance treasury.',
    {
      token: z.string().uuid().describe('Your auth token'),
      amount: z.number().int().positive().describe('Amount of gold to deposit'),
    },
    async ({ token, amount }) => {
      try {
        const player = authenticate(token);

        const myAllianceId = getPlayerAllianceId(player.id);
        if (myAllianceId === null) return textReply('You are not in an alliance.');

        if (player.gold < amount) {
          return textReply(`You don't have enough gold. You have ${player.gold}g.`);
        }

        const alliance = getAlliance(myAllianceId);
        if (!alliance) return textReply('Alliance not found.');

        if (alliance.treasury + amount > MAX_GOLD) {
          return textReply(`Alliance treasury would exceed the ${MAX_GOLD.toLocaleString()}g cap.`);
        }

        updatePlayerGold(player.id, player.gold - amount);
        const updated = depositToTreasury(myAllianceId, amount);

        return textReply(
          `Deposited ${amount}g into [${updated.tag}] ${updated.name} treasury.\n` +
          `Your gold: ${player.gold - amount}g | Treasury: ${updated.treasury}g`,
        );
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- kick_member ----------
  server.tool(
    'kick_member',
    'Kick a member from your alliance. Requires leader or officer role.',
    {
      token: z.string().uuid().describe('Your auth token'),
      player_name: z.string().min(1).describe('Name of the player to kick'),
    },
    async ({ token, player_name }) => {
      try {
        const player = authenticate(token);

        const myAllianceId = getPlayerAllianceId(player.id);
        if (myAllianceId === null) return textReply('You are not in an alliance.');

        const myRole = getMemberRole(myAllianceId, player.id);
        if (myRole !== 'leader' && myRole !== 'officer') {
          return textReply('Only the leader or officers can kick members.');
        }

        const target = getPlayerByName(player_name);
        if (!target) return textReply(`Player "${player_name}" not found.`);
        if (target.id === player.id) return textReply('You cannot kick yourself.');

        const targetRole = getMemberRole(myAllianceId, target.id);
        if (targetRole === null) return textReply('That player is not in your alliance.');
        if (targetRole === 'leader') return textReply('You cannot kick the leader.');

        if (myRole === 'officer' && targetRole === 'officer') {
          return textReply('Officers cannot kick other officers. Only the leader can.');
        }

        removeMember(myAllianceId, target.id);

        return textReply(`Kicked ${target.name} from the alliance.`);
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- disband_alliance ----------
  server.tool(
    'disband_alliance',
    'Disband your alliance. Leader only. Treasury gold is returned to the leader.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);

        const myAllianceId = getPlayerAllianceId(player.id);
        if (myAllianceId === null) return textReply('You are not in an alliance.');

        const alliance = getAlliance(myAllianceId);
        if (!alliance) return textReply('Alliance not found.');

        const treasuryReturned = disbandAlliance(myAllianceId, player.id);

        if (treasuryReturned > 0) {
          const newGold = Math.min(player.gold + treasuryReturned, MAX_GOLD);
          updatePlayerGold(player.id, newGold);
        }

        return textReply(
          `Alliance [${alliance.tag}] "${alliance.name}" has been disbanded.` +
          (treasuryReturned > 0 ? ` ${treasuryReturned}g returned to you.` : ''),
        );
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );

  // ---------- alliance_list ----------
  server.tool(
    'alliance_list',
    'List all alliances in the world.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        authenticate(token);
        const alliances = listAlliances();

        if (alliances.length === 0) {
          return textReply('No alliances exist yet.');
        }

        const lines = alliances.map(
          a => `  [${a.tag}] ${a.name} (ID: ${a.id}) - ${a.member_count} members, led by ${a.leader_name}`,
        );

        return textReply(`Alliances:\n${lines.join('\n')}`);
      } catch (e: any) {
        return textReply(e.message);
      }
    },
  );
}
