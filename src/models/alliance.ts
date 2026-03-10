import { getDb } from '../db/connection.js';
import type { Alliance, AllianceWithMembers, AllianceRole } from '../types/index.js';

export function createAlliance(
  name: string,
  tag: string,
  leaderId: number,
): Alliance {
  const db = getDb();

  const existing = getPlayerAllianceId(leaderId);
  if (existing !== null) {
    throw new Error('You are already in an alliance. Leave it first.');
  }

  const result = db.prepare(`
    INSERT INTO alliances (name, tag, leader_id) VALUES (?, ?, ?)
  `).run(name, tag, leaderId);

  const allianceId = result.lastInsertRowid as number;

  db.prepare(`
    INSERT INTO alliance_members (alliance_id, player_id, role)
    VALUES (?, ?, 'leader')
  `).run(allianceId, leaderId);

  return db.prepare('SELECT * FROM alliances WHERE id = ?')
    .get(allianceId) as Alliance;
}

export function getAlliance(id: number): AllianceWithMembers | null {
  const db = getDb();

  const alliance = db.prepare('SELECT * FROM alliances WHERE id = ?')
    .get(id) as Alliance | undefined;
  if (!alliance) return null;

  const members = db.prepare(`
    SELECT am.player_id, p.name AS player_name, am.role, am.joined_at
    FROM alliance_members am
    JOIN players p ON p.id = am.player_id
    WHERE am.alliance_id = ? AND am.role != 'invited'
    ORDER BY
      CASE am.role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END,
      am.joined_at ASC
  `).all(id) as AllianceWithMembers['members'];

  return { ...alliance, members };
}

export function getAllianceByPlayerId(playerId: number): AllianceWithMembers | null {
  const allianceId = getPlayerAllianceId(playerId);
  if (allianceId === null) return null;
  return getAlliance(allianceId);
}

export function getMembers(
  allianceId: number,
): Array<{ player_id: number; player_name: string; role: AllianceRole; joined_at: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT am.player_id, p.name AS player_name, am.role, am.joined_at
    FROM alliance_members am
    JOIN players p ON p.id = am.player_id
    WHERE am.alliance_id = ? AND am.role != 'invited'
    ORDER BY
      CASE am.role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END,
      am.joined_at ASC
  `).all(allianceId) as Array<{ player_id: number; player_name: string; role: AllianceRole; joined_at: string }>;
}

export function addMember(
  allianceId: number,
  playerId: number,
  role: AllianceRole = 'member',
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO alliance_members (alliance_id, player_id, role)
    VALUES (?, ?, ?)
  `).run(allianceId, playerId, role);
}

export function removeMember(allianceId: number, playerId: number): void {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM alliance_members WHERE alliance_id = ? AND player_id = ?',
  ).run(allianceId, playerId);

  if (result.changes === 0) {
    throw new Error('Player is not a member of this alliance.');
  }
}

export function updateRole(
  allianceId: number,
  playerId: number,
  newRole: AllianceRole,
): void {
  const db = getDb();
  const result = db.prepare(
    'UPDATE alliance_members SET role = ? WHERE alliance_id = ? AND player_id = ?',
  ).run(newRole, allianceId, playerId);

  if (result.changes === 0) {
    throw new Error('Player is not a member of this alliance.');
  }
}

export function disbandAlliance(id: number, leaderId: number): number {
  const db = getDb();

  const alliance = db.prepare('SELECT * FROM alliances WHERE id = ?')
    .get(id) as Alliance | undefined;
  if (!alliance) throw new Error('Alliance not found.');

  if (alliance.leader_id !== leaderId) {
    throw new Error('Only the leader can disband the alliance.');
  }

  const treasuryToReturn = alliance.treasury;

  db.prepare('DELETE FROM alliance_members WHERE alliance_id = ?').run(id);
  db.prepare('DELETE FROM alliances WHERE id = ?').run(id);

  return treasuryToReturn;
}

export function depositToTreasury(allianceId: number, amount: number): Alliance {
  const db = getDb();

  db.prepare(
    'UPDATE alliances SET treasury = treasury + ? WHERE id = ?',
  ).run(amount, allianceId);

  return db.prepare('SELECT * FROM alliances WHERE id = ?')
    .get(allianceId) as Alliance;
}

export function getMemberRole(
  allianceId: number,
  playerId: number,
): AllianceRole | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT role FROM alliance_members WHERE alliance_id = ? AND player_id = ?',
  ).get(allianceId, playerId) as { role: AllianceRole } | undefined;
  return row?.role ?? null;
}

export function getPlayerAllianceId(playerId: number): number | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT alliance_id FROM alliance_members WHERE player_id = ? AND role != 'invited'",
  ).get(playerId) as { alliance_id: number } | undefined;
  return row?.alliance_id ?? null;
}

export function getPlayerPendingInvite(
  playerId: number,
  allianceId: number,
): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM alliance_members WHERE alliance_id = ? AND player_id = ? AND role = 'invited'",
  ).get(allianceId, playerId);
  return !!row;
}

export function getPlayerPendingInvites(
  playerId: number,
): Array<{ alliance_id: number; alliance_name: string; alliance_tag: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT am.alliance_id, a.name AS alliance_name, a.tag AS alliance_tag
    FROM alliance_members am
    JOIN alliances a ON a.id = am.alliance_id
    WHERE am.player_id = ? AND am.role = 'invited'
    ORDER BY am.joined_at DESC
  `).all(playerId) as Array<{ alliance_id: number; alliance_name: string; alliance_tag: string }>;
}

export function hasPlayerAnyMembership(playerId: number): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM alliance_members WHERE player_id = ? AND role != 'invited'",
  ).get(playerId);
  return !!row;
}

export function getActiveMemberCount(allianceId: number): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM alliance_members WHERE alliance_id = ? AND role != 'invited'",
  ).get(allianceId) as { cnt: number };
  return row.cnt;
}

export function listAlliances(): Array<Alliance & { member_count: number; leader_name: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT a.*, p.name AS leader_name,
      (SELECT COUNT(*) FROM alliance_members WHERE alliance_id = a.id AND role != 'invited') AS member_count
    FROM alliances a
    JOIN players p ON p.id = a.leader_id
    ORDER BY member_count DESC, a.created_at ASC
    LIMIT 50
  `).all() as Array<Alliance & { member_count: number; leader_name: string }>;
}
