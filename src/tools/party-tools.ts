import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getPlayerByName, getPlayerById } from '../models/player.js';
import {
  createParty,
  getPartyByPlayerId,
  getPartyMembers,
  addMember,
  acceptInvite,
  removeMember,
  disbandParty,
  getPlayerPendingPartyInvites,
} from '../models/party.js';

function formatMemberLine(m: {
  player_name: string;
  status: string;
  hp: number;
  max_hp: number;
  level: number;
  chunk_x: number;
  chunk_y: number;
  location_id: number | null;
  is_leader: number | boolean;
}): string {
  const role = m.is_leader ? ' [Leader]' : '';
  const statusTag = m.status === 'invited' ? ' (invited)' : '';
  const hpBar = `${m.hp}/${m.max_hp} HP`;
  const loc = m.location_id !== null
    ? `(${m.chunk_x},${m.chunk_y}) loc:${m.location_id}`
    : `(${m.chunk_x},${m.chunk_y})`;
  return `  ${m.player_name}${role}${statusTag} - Lv${m.level} | ${hpBar} | ${loc}`;
}

export function registerPartyTools(server: McpServer): void {
  server.tool(
    'create_party',
    'Create a new adventuring party. You become the leader. Max 1 party at a time.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);

        const party = createParty(player.id);

        return {
          content: [{
            type: 'text',
            text: [
              `Party created! (ID: ${party.id})`,
              `You are the party leader.`,
              `Use \`invite_party\` to invite nearby players.`,
            ].join('\n'),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'invite_party',
    'Invite a player to your party. They must be in the same chunk.',
    {
      token: z.string().uuid().describe('Your auth token'),
      player_name: z.string().describe('Name of the player to invite'),
    },
    async ({ token, player_name }) => {
      try {
        const player = authenticate(token);

        const party = getPartyByPlayerId(player.id);
        if (!party) {
          return { content: [{ type: 'text', text: 'You are not in a party. Use `create_party` first.' }] };
        }
        if (party.leader_id !== player.id) {
          return { content: [{ type: 'text', text: 'Only the party leader can invite players.' }] };
        }

        const target = getPlayerByName(player_name);
        if (!target) {
          return { content: [{ type: 'text', text: `Player "${player_name}" not found.` }] };
        }
        if (target.id === player.id) {
          return { content: [{ type: 'text', text: 'You cannot invite yourself.' }] };
        }
        if (target.chunk_x !== player.chunk_x || target.chunk_y !== player.chunk_y) {
          return { content: [{ type: 'text', text: `${target.name} is not in your chunk. Party invites require same chunk.` }] };
        }

        addMember(party.id, target.id, 'invited');

        return {
          content: [{
            type: 'text',
            text: `Invited ${target.name} to your party. They must use \`accept_party\` to join.`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'accept_party',
    'Accept a pending party invite.',
    {
      token: z.string().uuid().describe('Your auth token'),
      party_id: z.number().int().describe('ID of the party to join'),
    },
    async ({ token, party_id }) => {
      try {
        const player = authenticate(token);

        acceptInvite(party_id, player.id);

        const members = getPartyMembers(party_id);
        const lines = ['You joined the party!', '', 'Party members:'];
        for (const m of members) {
          lines.push(formatMemberLine(m));
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'leave_party',
    'Leave your current party. If you are the leader, the party is disbanded.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);

        const party = getPartyByPlayerId(player.id);
        if (!party) {
          return { content: [{ type: 'text', text: 'You are not in a party.' }] };
        }

        if (party.leader_id === player.id) {
          disbandParty(party.id, player.id);
          return { content: [{ type: 'text', text: 'You left the party. As the leader, the party has been disbanded.' }] };
        }

        removeMember(party.id, player.id);
        return { content: [{ type: 'text', text: 'You left the party.' }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'party_status',
    'Show party members with HP, level, and location. Critical for healers!',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);

        const party = getPartyByPlayerId(player.id);
        if (!party) {
          // Check for pending invites
          const invites = getPlayerPendingPartyInvites(player.id);
          if (invites.length > 0) {
            const inviteLines = invites.map(
              inv => `  Party ${inv.party_id} (led by ${inv.leader_name}, ${inv.member_count} members)`
            );
            return {
              content: [{
                type: 'text',
                text: [
                  'You are not in a party.',
                  '',
                  'Pending invites:',
                  ...inviteLines,
                  '',
                  'Use `accept_party <party_id>` to join.',
                ].join('\n'),
              }],
            };
          }
          return { content: [{ type: 'text', text: 'You are not in a party. Use `create_party` to start one.' }] };
        }

        const leader = getPlayerById(party.leader_id);
        const members = getPartyMembers(party.id);
        const activeMembers = members.filter(m => m.status === 'active');
        const invitedMembers = members.filter(m => m.status === 'invited');

        const lines = [
          `--- Party ${party.id} (Leader: ${leader?.name ?? 'Unknown'}) ---`,
          `Active members: ${activeMembers.length}`,
          '',
        ];

        for (const m of activeMembers) {
          lines.push(formatMemberLine(m));
        }

        if (invitedMembers.length > 0) {
          lines.push('');
          lines.push('Pending invites:');
          for (const m of invitedMembers) {
            lines.push(formatMemberLine(m));
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'disband_party',
    'Disband your party (leader only). All members are removed.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);

        const party = getPartyByPlayerId(player.id);
        if (!party) {
          return { content: [{ type: 'text', text: 'You are not in a party.' }] };
        }

        disbandParty(party.id, player.id);
        return { content: [{ type: 'text', text: 'Party disbanded. All members have been removed.' }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
