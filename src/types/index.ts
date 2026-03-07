export interface Player {
  id: number;
  name: string;
  token: string;
  password_hash: string;
  chunk_x: number;
  chunk_y: number;
  location_id: number | null;
  hp: number;
  max_hp: number;
  strength: number;
  dexterity: number;
  constitution: number;
  charisma: number;
  luck: number;
  xp: number;
  level: number;
  gold: number;
  is_alive: number;
  created_at: string;
  last_active_at: string;
  died_at: string | null;
  cause_of_death: string | null;
}

export interface Chunk {
  x: number;
  y: number;
  name: string;
  description: string;
  terrain_type: string;
  danger_level: number;
  theme_tags: string; // JSON array
  created_by: number;
  created_at: string;
}

export interface Location {
  id: number;
  chunk_x: number;
  chunk_y: number;
  parent_id: number | null;
  name: string;
  description: string;
  location_type: string;
  depth: number;
  is_hidden: number;
  discovery_dc: number;
  is_shop: number;
  required_key_id: number | null;
  created_by: number;
  created_at: string;
}

export type ItemType = 'weapon' | 'armor' | 'consumable' | 'key' | 'misc' | 'currency';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface Item {
  id: number;
  name: string;
  description: string;
  item_type: ItemType;
  damage_bonus: number;
  defense_bonus: number;
  stat_bonuses: string; // JSON
  heal_amount: number;
  value: number;
  owner_id: number | null;
  chunk_x: number | null;
  chunk_y: number | null;
  location_id: number | null;
  is_equipped: number;
  rarity: Rarity;
  is_shop_item: number;
}

export interface Message {
  id: number;
  from_id: number;
  to_id: number | null;
  chunk_x: number;
  chunk_y: number;
  content: string;
  created_at: string;
}

export interface EventLog {
  id: number;
  event_type: string;
  actor_id: number | null;
  target_id: number | null;
  chunk_x: number | null;
  chunk_y: number | null;
  location_id: number | null;
  data: string; // JSON
  created_at: string;
}

export interface Discovery {
  player_id: number;
  location_id: number;
  discovered_at: string;
}

export interface ChunkLock {
  x: number;
  y: number;
  locked_by: number;
  locked_at: string;
}

export type TradeStatus = 'pending' | 'accepted' | 'rejected';

export interface Trade {
  id: number;
  from_id: number;
  to_id: number;
  offer_items: string; // JSON array of item ids
  offer_gold: number;
  request_items: string; // JSON array of item ids
  request_gold: number;
  status: TradeStatus;
  created_at: string;
}

export interface CombatResult {
  attacker_roll: number;
  defender_ac: number;
  hit: boolean;
  damage: number;
  crit: boolean;
  attacker_hp: number;
  defender_hp: number;
  attacker_dead: boolean;
  defender_dead: boolean;
}

export interface DiceResult {
  sides: number;
  roll: number;
}

export const DIRECTIONS: Record<string, [number, number]> = {
  north: [0, 1],
  south: [0, -1],
  east: [1, 0],
  west: [-1, 0],
};

export const MIN_CHUNK_COORD = -99;
export const MAX_CHUNK_COORD = 99;
export const MAX_LOCATION_DEPTH = 10;
export const CHUNK_LOCK_TIMEOUT_MS = 60_000;
export const STARTING_HP = 50;
export const STARTING_GOLD = 50;
export const STARTING_STATS = 5;
