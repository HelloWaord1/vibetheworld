import { getDb } from '../db/connection.js';
import type { PlayerBounty, PlayerBountyWithNames } from '../types/bounty-board.js';

export function createPlayerBounty(
  creatorId: number,
  targetId: number,
  reward: number,
  reason: string,
  isAnonymous: boolean,
  durationHours: number
): PlayerBounty {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO player_bounties (creator_id, target_id, reward, reason, is_anonymous, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
  `).run(creatorId, targetId, reward, reason, isAnonymous ? 1 : 0, durationHours);

  return db.prepare('SELECT * FROM player_bounties WHERE id = ?').get(result.lastInsertRowid) as PlayerBounty;
}

export function getActiveBounties(minReward?: number): readonly PlayerBountyWithNames[] {
  const db = getDb();
  const baseQuery = `
    SELECT pb.*,
      CASE WHEN pb.is_anonymous = 1 THEN 'Anonymous' ELSE pc.name END as creator_name,
      pt.name as target_name,
      NULL as claimer_name
    FROM player_bounties pb
    JOIN players pc ON pc.id = pb.creator_id
    JOIN players pt ON pt.id = pb.target_id
    WHERE pb.status = 'active'
      AND pb.expires_at > datetime('now')
  `;

  if (minReward !== undefined && minReward > 0) {
    return db.prepare(`${baseQuery} AND pb.reward >= ? ORDER BY pb.reward DESC`)
      .all(minReward) as PlayerBountyWithNames[];
  }

  return db.prepare(`${baseQuery} ORDER BY pb.reward DESC`)
    .all() as PlayerBountyWithNames[];
}

export function getBountyById(id: number): PlayerBountyWithNames | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT pb.*,
      CASE WHEN pb.is_anonymous = 1 THEN 'Anonymous' ELSE pc.name END as creator_name,
      pt.name as target_name,
      pcl.name as claimer_name
    FROM player_bounties pb
    JOIN players pc ON pc.id = pb.creator_id
    JOIN players pt ON pt.id = pb.target_id
    LEFT JOIN players pcl ON pcl.id = pb.claimed_by
    WHERE pb.id = ?
  `).get(id) as PlayerBountyWithNames | undefined;

  return row ?? null;
}

export function claimPlayerBounty(bountyId: number, claimerId: number): PlayerBounty {
  const db = getDb();
  db.prepare(`
    UPDATE player_bounties
    SET status = 'claimed', claimed_by = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(claimerId, bountyId);

  return db.prepare('SELECT * FROM player_bounties WHERE id = ?').get(bountyId) as PlayerBounty;
}

export function cancelPlayerBounty(bountyId: number): PlayerBounty {
  const db = getDb();
  db.prepare(`
    UPDATE player_bounties
    SET status = 'cancelled', completed_at = datetime('now')
    WHERE id = ?
  `).run(bountyId);

  return db.prepare('SELECT * FROM player_bounties WHERE id = ?').get(bountyId) as PlayerBounty;
}

export function getPlayerCreatedBounties(playerId: number): readonly PlayerBountyWithNames[] {
  const db = getDb();
  return db.prepare(`
    SELECT pb.*,
      CASE WHEN pb.is_anonymous = 1 THEN 'Anonymous' ELSE pc.name END as creator_name,
      pt.name as target_name,
      pcl.name as claimer_name
    FROM player_bounties pb
    JOIN players pc ON pc.id = pb.creator_id
    JOIN players pt ON pt.id = pb.target_id
    LEFT JOIN players pcl ON pcl.id = pb.claimed_by
    WHERE pb.creator_id = ?
    ORDER BY pb.created_at DESC
    LIMIT 20
  `).all(playerId) as PlayerBountyWithNames[];
}

export function getBountiesOnPlayer(playerId: number): readonly PlayerBountyWithNames[] {
  const db = getDb();
  return db.prepare(`
    SELECT pb.*,
      CASE WHEN pb.is_anonymous = 1 THEN 'Anonymous' ELSE pc.name END as creator_name,
      pt.name as target_name,
      pcl.name as claimer_name
    FROM player_bounties pb
    JOIN players pc ON pc.id = pb.creator_id
    JOIN players pt ON pt.id = pb.target_id
    LEFT JOIN players pcl ON pcl.id = pb.claimed_by
    WHERE pb.target_id = ?
    ORDER BY pb.created_at DESC
    LIMIT 20
  `).all(playerId) as PlayerBountyWithNames[];
}

export function getActiveBountiesOnPlayer(playerId: number): readonly PlayerBounty[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM player_bounties
    WHERE target_id = ? AND status = 'active' AND expires_at > datetime('now')
    ORDER BY reward DESC
  `).all(playerId) as PlayerBounty[];
}

export function expireOldBounties(): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE player_bounties
    SET status = 'expired', completed_at = datetime('now')
    WHERE status = 'active' AND expires_at <= datetime('now')
  `).run();

  return result.changes;
}
