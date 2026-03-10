import { getDb } from '../db/connection.js';
import type { Party, PartyMember, PartyMemberInfo, PartyMemberStatus } from '../types/index.js';
import { MAX_PARTY_SIZE } from '../types/index.js';

export function createParty(leaderId: number): Party {
  const db = getDb();

  const existing = getPartyByPlayerId(leaderId);
  if (existing) {
    throw new Error('You are already in a party. Leave it first.');
  }

  const result = db.prepare(
    'INSERT INTO parties (leader_id) VALUES (?)'
  ).run(leaderId);

  const partyId = result.lastInsertRowid as number;

  db.prepare(
    "INSERT INTO party_members (party_id, player_id, status) VALUES (?, ?, 'active')"
  ).run(partyId, leaderId);

  return db.prepare('SELECT * FROM parties WHERE id = ?').get(partyId) as Party;
}

export function getParty(partyId: number): Party | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM parties WHERE id = ?').get(partyId) as Party | undefined) ?? null;
}

export function getPartyByPlayerId(playerId: number): Party | null {
  const db = getDb();
  const membership = db.prepare(
    "SELECT party_id FROM party_members WHERE player_id = ? AND status = 'active'"
  ).get(playerId) as { party_id: number } | undefined;

  if (!membership) return null;
  return getParty(membership.party_id);
}

export function getPartyMembers(partyId: number): PartyMemberInfo[] {
  const db = getDb();
  const party = getParty(partyId);
  if (!party) return [];

  const rows = db.prepare(`
    SELECT
      pm.player_id,
      p.name AS player_name,
      pm.status,
      p.hp,
      p.max_hp,
      p.level,
      p.chunk_x,
      p.chunk_y,
      p.location_id,
      CASE WHEN pa.leader_id = pm.player_id THEN 1 ELSE 0 END AS is_leader
    FROM party_members pm
    JOIN players p ON p.id = pm.player_id
    JOIN parties pa ON pa.id = pm.party_id
    WHERE pm.party_id = ?
    ORDER BY
      CASE WHEN pa.leader_id = pm.player_id THEN 0 ELSE 1 END,
      pm.joined_at ASC
  `).all(partyId) as Array<Omit<PartyMemberInfo, 'is_leader'> & { is_leader: number }>;

  return rows.map(row => ({ ...row, is_leader: row.is_leader === 1 }));
}

export function getActivePartyMembers(partyId: number): PartyMemberInfo[] {
  return getPartyMembers(partyId).filter(m => m.status === 'active');
}

export function getActivePartyMembersInChunk(
  partyId: number,
  chunkX: number,
  chunkY: number,
): PartyMemberInfo[] {
  return getActivePartyMembers(partyId).filter(
    m => m.chunk_x === chunkX && m.chunk_y === chunkY
  );
}

export function addMember(partyId: number, playerId: number, status: PartyMemberStatus = 'invited'): void {
  const db = getDb();

  const party = getParty(partyId);
  if (!party) throw new Error('Party not found.');

  const existingParty = getPartyByPlayerId(playerId);
  if (existingParty) {
    throw new Error('That player is already in a party.');
  }

  const existingInvite = db.prepare(
    "SELECT 1 FROM party_members WHERE party_id = ? AND player_id = ?"
  ).get(partyId, playerId);
  if (existingInvite) {
    throw new Error('That player already has a pending invite to this party.');
  }

  const activeCount = getActivePartyMembers(partyId).length;
  const pendingCount = getPartyMembers(partyId).filter(m => m.status === 'invited').length;
  if (activeCount + pendingCount >= MAX_PARTY_SIZE) {
    throw new Error(`Party is full (max ${MAX_PARTY_SIZE} members).`);
  }

  db.prepare(
    'INSERT INTO party_members (party_id, player_id, status) VALUES (?, ?, ?)'
  ).run(partyId, playerId, status);
}

export function acceptInvite(partyId: number, playerId: number): void {
  const db = getDb();

  const invite = db.prepare(
    "SELECT 1 FROM party_members WHERE party_id = ? AND player_id = ? AND status = 'invited'"
  ).get(partyId, playerId);
  if (!invite) {
    throw new Error('No pending party invite found.');
  }

  // Check if player joined another party since the invite
  const existingParty = getPartyByPlayerId(playerId);
  if (existingParty) {
    // Clean up the stale invite
    db.prepare('DELETE FROM party_members WHERE party_id = ? AND player_id = ?').run(partyId, playerId);
    throw new Error('You are already in a party. Leave it first.');
  }

  const activeCount = getActivePartyMembers(partyId).length;
  if (activeCount >= MAX_PARTY_SIZE) {
    db.prepare('DELETE FROM party_members WHERE party_id = ? AND player_id = ?').run(partyId, playerId);
    throw new Error(`Party is full (max ${MAX_PARTY_SIZE} members).`);
  }

  db.prepare(
    "UPDATE party_members SET status = 'active' WHERE party_id = ? AND player_id = ?"
  ).run(partyId, playerId);
}

export function removeMember(partyId: number, playerId: number): void {
  const db = getDb();

  const result = db.prepare(
    'DELETE FROM party_members WHERE party_id = ? AND player_id = ?'
  ).run(partyId, playerId);

  if (result.changes === 0) {
    throw new Error('Player is not in this party.');
  }
}

export function disbandParty(partyId: number, leaderId: number): void {
  const db = getDb();

  const party = getParty(partyId);
  if (!party) throw new Error('Party not found.');

  if (party.leader_id !== leaderId) {
    throw new Error('Only the party leader can disband the party.');
  }

  db.prepare('DELETE FROM party_members WHERE party_id = ?').run(partyId);
  db.prepare('DELETE FROM parties WHERE id = ?').run(partyId);
}

export function isInSameParty(player1Id: number, player2Id: number): boolean {
  const party1 = getPartyByPlayerId(player1Id);
  if (!party1) return false;

  const party2 = getPartyByPlayerId(player2Id);
  if (!party2) return false;

  return party1.id === party2.id;
}

export function getPlayerPendingPartyInvites(
  playerId: number,
): Array<{ party_id: number; leader_name: string; member_count: number; created_at: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT
      pm.party_id,
      p.name AS leader_name,
      (SELECT COUNT(*) FROM party_members WHERE party_id = pm.party_id AND status = 'active') AS member_count,
      pa.created_at
    FROM party_members pm
    JOIN parties pa ON pa.id = pm.party_id
    JOIN players p ON p.id = pa.leader_id
    WHERE pm.player_id = ? AND pm.status = 'invited'
    ORDER BY pm.joined_at DESC
  `).all(playerId) as Array<{ party_id: number; leader_name: string; member_count: number; created_at: string }>;
}
