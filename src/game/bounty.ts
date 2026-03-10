import { getDb } from '../db/connection.js';
import type { Bounty } from '../types/index.js';
import { BOUNTY_PER_KILL, BOUNTY_DECAY_HOURS } from '../types/index.js';
import { getPlayerById, updatePlayerGold } from '../models/player.js';
import { createPlayerBounty } from '../models/bounty.js';
import { withdrawFromWRB } from '../models/bank.js';

export function addBounty(killerId: number): { newBounty: number } {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM bounties WHERE player_id = ?').get(killerId) as Bounty | undefined;

  // Try to withdraw bounty amount from WRB
  const bountyAmount = withdrawFromWRB(BOUNTY_PER_KILL);
  if (bountyAmount <= 0) {
    // WRB can't afford bounty, no bounty added
    return { newBounty: existing ? existing.amount : 0 };
  }

  const newAmount = existing ? existing.amount + bountyAmount : bountyAmount;

  if (existing) {
    db.prepare(`
      UPDATE bounties SET amount = ?, kills_since_reset = kills_since_reset + 1, last_kill_at = datetime('now')
      WHERE player_id = ?
    `).run(newAmount, killerId);
  } else {
    db.prepare(`
      INSERT INTO bounties (player_id, amount, kills_since_reset, last_kill_at)
      VALUES (?, ?, 1, datetime('now'))
    `).run(killerId, bountyAmount);
  }

  // Auto-post to bounty board as system bounty (if bounty is significant)
  if (newAmount >= BOUNTY_PER_KILL) {
    try {
      createPlayerBounty(
        0, // system creator (player id 0)
        killerId, // target is the killer
        bountyAmount, // reward for this kill
        'Wanted for murder', // auto-generated reason
        false, // not anonymous
        48 // 48 hours duration
      );
    } catch {
      // ignore if system player doesn't exist
    }
  }

  return { newBounty: newAmount };
}

export function claimBounty(victimId: number, claimerId: number): { bountyAmount: number } {
  const db = getDb();
  const bounty = db.prepare('SELECT * FROM bounties WHERE player_id = ?').get(victimId) as Bounty | undefined;

  if (!bounty || bounty.amount <= 0) return { bountyAmount: 0 };

  const amount = bounty.amount;

  // Award gold to claimer
  const claimer = getPlayerById(claimerId);
  if (claimer) {
    updatePlayerGold(claimerId, Math.min(claimer.gold + amount, 10_000_000));
  }

  // Reset victim's bounty
  db.prepare('DELETE FROM bounties WHERE player_id = ?').run(victimId);

  return { bountyAmount: amount };
}

export function getBounty(playerId: number): Bounty | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM bounties WHERE player_id = ?').get(playerId) as Bounty | undefined) || null;
}

export function getTopBounties(limit: number = 10): Array<Bounty & { player_name: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT b.*, p.name as player_name
    FROM bounties b
    JOIN players p ON p.id = b.player_id AND p.is_alive = 1
    WHERE b.amount > 0
    ORDER BY b.amount DESC
    LIMIT ?
  `).all(limit) as Array<Bounty & { player_name: string }>;
}

export function decayBounties(): void {
  const db = getDb();
  db.prepare(`
    UPDATE bounties
    SET amount = amount / 2
    WHERE last_kill_at < datetime('now', '-${BOUNTY_DECAY_HOURS} hours')
      AND amount > 0
  `).run();

  // Clean up zero-amount bounties
  db.prepare('DELETE FROM bounties WHERE amount <= 0').run();
}
