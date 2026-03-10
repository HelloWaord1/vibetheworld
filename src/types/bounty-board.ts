export type BountyStatus = 'active' | 'claimed' | 'cancelled' | 'expired';

export interface PlayerBounty {
  id: number;
  creator_id: number;
  target_id: number;
  reward: number;
  reason: string;
  status: BountyStatus;
  claimed_by: number | null;
  is_anonymous: number;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

export interface PlayerBountyWithNames extends PlayerBounty {
  creator_name: string;
  target_name: string;
  claimer_name: string | null;
}

export const MIN_BOUNTY_REWARD = 50;
export const MAX_BOUNTY_DURATION_HOURS = 168;
export const DEFAULT_BOUNTY_DURATION_HOURS = 48;
export const BOUNTY_CANCEL_REFUND_RATE = 0.80;
export const BOUNTY_CLAIM_WINDOW_MINUTES = 10;
export const BOUNTY_COOLDOWN_MS = 60_000;
export const MAX_BOUNTY_REASON_LENGTH = 200;
