import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getDb } from '../db/connection.js';
import { getPlayerByName } from '../models/player.js';
import { enforceCooldown } from '../server/cooldown.js';
import { validateContent } from '../utils/content-filter.js';

const REPORT_COOLDOWN = 30_000;
const AUTO_HIDE_THRESHOLD = 3;

function requireAdmin(playerId: number): void {
  const db = getDb();
  const admin = db.prepare(
    'SELECT 1 FROM admin_roles WHERE player_id = ?',
  ).get(playerId);
  if (!admin) throw new Error('You do not have admin privileges.');
}

function isMuted(playerId: number): boolean {
  const db = getDb();
  const mute = db.prepare(
    'SELECT expires_at FROM player_mutes WHERE player_id = ?',
  ).get(playerId) as { expires_at: string } | undefined;

  if (!mute) return false;

  const expiresAt = new Date(mute.expires_at + 'Z').getTime();
  if (expiresAt <= Date.now()) {
    db.prepare('DELETE FROM player_mutes WHERE player_id = ?').run(playerId);
    return false;
  }
  return true;
}

export function checkMuted(playerId: number): void {
  if (isMuted(playerId)) {
    throw new Error('You are muted and cannot send messages.');
  }
}

export function registerAdminTools(server: McpServer): void {
  // ---------- Player Tools ----------

  server.tool(
    'report',
    'Report a player, chunk, or message for rule violations.',
    {
      token: z.string().uuid().describe('Your auth token'),
      target_type: z.enum(['player', 'chunk', 'message']).describe('What you are reporting'),
      target_id: z.string().min(1).describe('ID or name of the target'),
      reason: z.string().min(3).max(500).describe('Reason for the report'),
    },
    async ({ token, target_type, target_id, reason }) => {
      try {
        const player = authenticate(token);
        validateContent(reason, 'reason');

        const cd = enforceCooldown(player.id, 'report', REPORT_COOLDOWN);
        if (cd !== null) {
          return { content: [{ type: 'text', text: `Please wait ${cd}s before filing another report.` }] };
        }

        const db = getDb();

        // Prevent duplicate reports from same player on same target
        const existing = db.prepare(
          `SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'`,
        ).get(player.id, target_type, target_id);
        if (existing) {
          return { content: [{ type: 'text', text: 'You already have a pending report for this target.' }] };
        }

        db.prepare(
          `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)`,
        ).run(player.id, target_type, target_id, reason);

        // Auto-hide content at threshold
        const reportCount = db.prepare(
          `SELECT COUNT(*) as cnt FROM reports WHERE target_type = ? AND target_id = ? AND status = 'pending'`,
        ).get(target_type, target_id) as { cnt: number };

        let autoHideNote = '';
        if (reportCount.cnt >= AUTO_HIDE_THRESHOLD) {
          autoHideNote = ' Content has been flagged for admin review due to multiple reports.';
        }

        return {
          content: [{
            type: 'text',
            text: `Report filed against ${target_type} "${target_id}". Thank you.${autoHideNote}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );

  server.tool(
    'block_player',
    'Block a player. Their messages, whispers, mail, and trades will be hidden from you.',
    {
      token: z.string().uuid().describe('Your auth token'),
      player_name: z.string().min(1).describe('Name of the player to block'),
    },
    async ({ token, player_name }) => {
      try {
        const player = authenticate(token);
        const target = getPlayerByName(player_name);
        if (!target) return { content: [{ type: 'text', text: `Player "${player_name}" not found.` }] };
        if (target.id === player.id) return { content: [{ type: 'text', text: 'You cannot block yourself.' }] };

        const db = getDb();
        const alreadyBlocked = db.prepare(
          'SELECT 1 FROM player_blocks WHERE blocker_id = ? AND blocked_id = ?',
        ).get(player.id, target.id);
        if (alreadyBlocked) {
          return { content: [{ type: 'text', text: `${target.name} is already blocked.` }] };
        }

        db.prepare(
          'INSERT INTO player_blocks (blocker_id, blocked_id) VALUES (?, ?)',
        ).run(player.id, target.id);

        return { content: [{ type: 'text', text: `Blocked ${target.name}. You will no longer see their messages.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );

  server.tool(
    'unblock_player',
    'Unblock a previously blocked player.',
    {
      token: z.string().uuid().describe('Your auth token'),
      player_name: z.string().min(1).describe('Name of the player to unblock'),
    },
    async ({ token, player_name }) => {
      try {
        const player = authenticate(token);
        const target = getPlayerByName(player_name);
        if (!target) return { content: [{ type: 'text', text: `Player "${player_name}" not found.` }] };

        const db = getDb();
        const result = db.prepare(
          'DELETE FROM player_blocks WHERE blocker_id = ? AND blocked_id = ?',
        ).run(player.id, target.id);

        if (result.changes === 0) {
          return { content: [{ type: 'text', text: `${target.name} is not blocked.` }] };
        }

        return { content: [{ type: 'text', text: `Unblocked ${target.name}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );

  // ---------- Admin Tools ----------

  server.tool(
    'admin_ban',
    'Ban a player. Requires admin privileges.',
    {
      token: z.string().uuid().describe('Your auth token'),
      player_name: z.string().min(1).describe('Name of player to ban'),
      reason: z.string().max(500).default('').describe('Reason for the ban'),
      duration_hours: z.number().positive().optional().describe('Ban duration in hours (omit for permanent)'),
    },
    async ({ token, player_name, reason, duration_hours }) => {
      try {
        const player = authenticate(token);
        requireAdmin(player.id);

        const target = getPlayerByName(player_name);
        if (!target) return { content: [{ type: 'text', text: `Player "${player_name}" not found.` }] };
        if (target.id === player.id) return { content: [{ type: 'text', text: 'You cannot ban yourself.' }] };

        const db = getDb();
        const expiresAt = duration_hours
          ? new Date(Date.now() + duration_hours * 60 * 60 * 1000)
              .toISOString().replace('Z', '').replace('T', ' ').split('.')[0]
          : null;

        db.prepare(
          `INSERT OR REPLACE INTO player_bans (player_id, banned_by, reason, expires_at) VALUES (?, ?, ?, ?)`,
        ).run(target.id, player.id, reason, expiresAt);

        const durationText = duration_hours
          ? `for ${duration_hours} hours`
          : 'permanently';

        return {
          content: [{
            type: 'text',
            text: `Banned ${target.name} ${durationText}.${reason ? ` Reason: ${reason}` : ''}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );

  server.tool(
    'admin_unban',
    'Unban a player. Requires admin privileges.',
    {
      token: z.string().uuid().describe('Your auth token'),
      player_name: z.string().min(1).describe('Name of player to unban'),
    },
    async ({ token, player_name }) => {
      try {
        const player = authenticate(token);
        requireAdmin(player.id);

        const target = getPlayerByName(player_name);
        if (!target) return { content: [{ type: 'text', text: `Player "${player_name}" not found.` }] };

        const db = getDb();
        const result = db.prepare(
          'DELETE FROM player_bans WHERE player_id = ?',
        ).run(target.id);

        if (result.changes === 0) {
          return { content: [{ type: 'text', text: `${target.name} is not banned.` }] };
        }

        return { content: [{ type: 'text', text: `Unbanned ${target.name}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );

  server.tool(
    'admin_mute',
    'Mute a player so they cannot say, whisper, or mail. Requires admin privileges.',
    {
      token: z.string().uuid().describe('Your auth token'),
      player_name: z.string().min(1).describe('Name of player to mute'),
      duration_hours: z.number().positive().describe('Mute duration in hours'),
      reason: z.string().max(500).default('').describe('Reason for the mute'),
    },
    async ({ token, player_name, duration_hours, reason }) => {
      try {
        const player = authenticate(token);
        requireAdmin(player.id);

        const target = getPlayerByName(player_name);
        if (!target) return { content: [{ type: 'text', text: `Player "${player_name}" not found.` }] };
        if (target.id === player.id) return { content: [{ type: 'text', text: 'You cannot mute yourself.' }] };

        const db = getDb();
        const expiresAt = new Date(Date.now() + duration_hours * 60 * 60 * 1000)
          .toISOString().replace('Z', '').replace('T', ' ').split('.')[0];

        db.prepare(
          `INSERT OR REPLACE INTO player_mutes (player_id, muted_by, reason, expires_at) VALUES (?, ?, ?, ?)`,
        ).run(target.id, player.id, reason, expiresAt);

        return {
          content: [{
            type: 'text',
            text: `Muted ${target.name} for ${duration_hours} hours.${reason ? ` Reason: ${reason}` : ''}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );

  server.tool(
    'admin_rename_chunk',
    'Rename a chunk to fix offensive names. Requires admin privileges.',
    {
      token: z.string().uuid().describe('Your auth token'),
      chunk_x: z.number().int().describe('Chunk X coordinate'),
      chunk_y: z.number().int().describe('Chunk Y coordinate'),
      new_name: z.string().min(1).max(100).describe('New name for the chunk'),
    },
    async ({ token, chunk_x, chunk_y, new_name }) => {
      try {
        const player = authenticate(token);
        requireAdmin(player.id);
        validateContent(new_name, 'chunk name');

        const db = getDb();
        const chunk = db.prepare(
          'SELECT name FROM chunks WHERE x = ? AND y = ?',
        ).get(chunk_x, chunk_y) as { name: string } | undefined;

        if (!chunk) {
          return { content: [{ type: 'text', text: `No chunk exists at (${chunk_x}, ${chunk_y}).` }] };
        }

        const oldName = chunk.name;
        db.prepare(
          'UPDATE chunks SET name = ? WHERE x = ? AND y = ?',
        ).run(new_name, chunk_x, chunk_y);

        return {
          content: [{
            type: 'text',
            text: `Renamed chunk at (${chunk_x}, ${chunk_y}) from "${oldName}" to "${new_name}".`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );

  server.tool(
    'admin_reset_policies',
    'Reset a chunk\'s policies to defaults (free entry/exit, 0% tax). Requires admin privileges.',
    {
      token: z.string().uuid().describe('Your auth token'),
      chunk_x: z.number().int().describe('Chunk X coordinate'),
      chunk_y: z.number().int().describe('Chunk Y coordinate'),
    },
    async ({ token, chunk_x, chunk_y }) => {
      try {
        const player = authenticate(token);
        requireAdmin(player.id);

        const db = getDb();
        const chunk = db.prepare(
          'SELECT name FROM chunks WHERE x = ? AND y = ?',
        ).get(chunk_x, chunk_y) as { name: string } | undefined;

        if (!chunk) {
          return { content: [{ type: 'text', text: `No chunk exists at (${chunk_x}, ${chunk_y}).` }] };
        }

        db.prepare(`
          UPDATE chunks SET
            immigration_policy = 'open',
            immigration_fee = 0,
            build_policy = 'free',
            build_fee = 0,
            exit_policy = 'free',
            exit_fee = 0,
            chunk_tax_rate = 0
          WHERE x = ? AND y = ?
        `).run(chunk_x, chunk_y);

        return {
          content: [{
            type: 'text',
            text: `Reset policies for "${chunk.name}" at (${chunk_x}, ${chunk_y}) to defaults.`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );

  server.tool(
    'admin_review_reports',
    'List pending reports. Requires admin privileges.',
    {
      token: z.string().uuid().describe('Your auth token'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max reports to show'),
    },
    async ({ token, limit }) => {
      try {
        const player = authenticate(token);
        requireAdmin(player.id);

        const db = getDb();
        const reports = db.prepare(`
          SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
                 p.name as reporter_name
          FROM reports r
          JOIN players p ON p.id = r.reporter_id
          WHERE r.status = 'pending'
          ORDER BY r.created_at DESC
          LIMIT ?
        `).all(limit) as Array<{
          id: number;
          target_type: string;
          target_id: string;
          reason: string;
          status: string;
          created_at: string;
          reporter_name: string;
        }>;

        if (reports.length === 0) {
          return { content: [{ type: 'text', text: 'No pending reports.' }] };
        }

        const lines = reports.map(r =>
          `#${r.id} [${r.target_type}] "${r.target_id}" - reported by ${r.reporter_name}: ${r.reason} (${r.created_at})`,
        );

        return {
          content: [{
            type: 'text',
            text: `Pending reports (${reports.length}):\n${lines.join('\n')}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    },
  );
}
