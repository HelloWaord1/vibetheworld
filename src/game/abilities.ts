import type { Player } from '../types/index.js';
import { checkCooldown, setCooldown } from '../server/cooldown.js';
import { getPlayerById, updatePlayerHp } from '../models/player.js';
import { getPlayersAtChunk } from '../models/player.js';
import { getDb } from '../db/connection.js';

// --- Ability Definitions ---

export interface Ability {
  name: string;
  description: string;
  stat_requirement: { stat: string; min: number };
  cooldown_ms: number;
  effect: 'buff' | 'heal' | 'damage' | 'utility';
}

export const ABILITIES: readonly Ability[] = [
  {
    name: 'Rage',
    description: 'Next attack deals double damage, but -3 AC for 1 round.',
    stat_requirement: { stat: 'strength', min: 8 },
    cooldown_ms: 30_000,
    effect: 'buff',
  },
  {
    name: 'Stealth',
    description: 'Next attack has +5 to hit (ambush bonus).',
    stat_requirement: { stat: 'dexterity', min: 8 },
    cooldown_ms: 45_000,
    effect: 'buff',
  },
  {
    name: 'Heal',
    description: 'Restore 30% max HP immediately.',
    stat_requirement: { stat: 'constitution', min: 8 },
    cooldown_ms: 60_000,
    effect: 'heal',
  },
  {
    name: 'Inspire',
    description: 'All players in your chunk get +2 to next attack roll.',
    stat_requirement: { stat: 'charisma', min: 8 },
    cooldown_ms: 60_000,
    effect: 'utility',
  },
  {
    name: 'Lucky Strike',
    description: 'Next attack automatically crits if it hits.',
    stat_requirement: { stat: 'luck', min: 8 },
    cooldown_ms: 60_000,
    effect: 'buff',
  },
  {
    name: 'Fortify',
    description: '+5 AC for next 2 incoming attacks.',
    stat_requirement: { stat: 'constitution', min: 10 },
    cooldown_ms: 45_000,
    effect: 'buff',
  },
] as const;

// --- Active Buff System (SQLite-backed) ---

export type BuffType = 'rage' | 'stealth' | 'inspire' | 'lucky_strike' | 'fortify' | 'rage_ac_penalty';

export interface ActiveBuff {
  readonly type: BuffType;
  readonly expiresAt: number;
  readonly charges: number;
  readonly value: number;
}

interface BuffRow {
  player_id: number;
  buff_type: string;
  expires_at: string;
  charges: number;
  value: number;
}

function toEpochMs(sqliteDatetime: string): number {
  return new Date(sqliteDatetime + 'Z').getTime();
}

function toSqliteDatetime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('Z', '').replace('T', ' ').split('.')[0];
}

function rowToBuff(row: BuffRow): ActiveBuff {
  return {
    type: row.buff_type as BuffType,
    expiresAt: toEpochMs(row.expires_at),
    charges: row.charges,
    value: row.value,
  };
}

function addBuff(playerId: number, buff: ActiveBuff): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO active_buffs (player_id, buff_type, expires_at, charges, value)
     VALUES (?, ?, ?, ?, ?)`
  ).run(playerId, buff.type, toSqliteDatetime(buff.expiresAt), buff.charges, buff.value);
}

// --- Cooldown Keys ---

function abilityCooldownKey(abilityName: string): string {
  return `ability_${abilityName.toLowerCase().replace(/\s+/g, '_')}`;
}

// --- Stat Lookup ---

function getPlayerStat(player: Player, stat: string): number {
  switch (stat) {
    case 'strength': return player.strength;
    case 'dexterity': return player.dexterity;
    case 'constitution': return player.constitution;
    case 'charisma': return player.charisma;
    case 'luck': return player.luck;
    default: return 0;
  }
}

// --- Public API ---

export function getAvailableAbilities(player: Player): Ability[] {
  return ABILITIES.filter(
    ability => getPlayerStat(player, ability.stat_requirement.stat) >= ability.stat_requirement.min
  );
}

export function getAbilityCooldownRemaining(playerId: number, abilityName: string): number | null {
  return checkCooldown(playerId, abilityCooldownKey(abilityName));
}

export function activateAbility(playerId: number, abilityName: string): string {
  const player = getPlayerById(playerId);
  if (!player) return 'Player not found.';

  const ability = ABILITIES.find(
    a => a.name.toLowerCase() === abilityName.toLowerCase()
  );
  if (!ability) return `Unknown ability: "${abilityName}". Use \`abilities\` to see your available abilities.`;

  // Check stat requirement
  const statValue = getPlayerStat(player, ability.stat_requirement.stat);
  if (statValue < ability.stat_requirement.min) {
    return `You need ${ability.stat_requirement.stat.toUpperCase()} ${ability.stat_requirement.min}+ to use ${ability.name}. (Current: ${statValue})`;
  }

  // Check cooldown
  const cdRemaining = checkCooldown(playerId, abilityCooldownKey(ability.name));
  if (cdRemaining !== null) {
    return `${ability.name} is on cooldown for ${cdRemaining} more seconds.`;
  }

  // Set cooldown
  setCooldown(playerId, abilityCooldownKey(ability.name), ability.cooldown_ms);

  const buffExpiry = Date.now() + 120_000; // buffs expire after 2 minutes if not consumed

  // Apply effect based on ability
  switch (ability.name) {
    case 'Rage': {
      addBuff(playerId, { type: 'rage', expiresAt: buffExpiry, charges: 1, value: 2 });
      addBuff(playerId, { type: 'rage_ac_penalty', expiresAt: buffExpiry, charges: 1, value: 3 });
      return 'RAGE activated! Your next attack deals double damage, but your AC is reduced by 3 for the next incoming attack.';
    }
    case 'Stealth': {
      addBuff(playerId, { type: 'stealth', expiresAt: buffExpiry, charges: 1, value: 5 });
      return 'You melt into the shadows. Next attack has +5 to hit.';
    }
    case 'Heal': {
      const fresh = getPlayerById(playerId)!;
      const healAmount = Math.floor(fresh.max_hp * 0.3);
      const newHp = Math.min(fresh.hp + healAmount, fresh.max_hp);
      updatePlayerHp(playerId, newHp);
      return `You channel your vitality. Restored ${newHp - fresh.hp} HP. (${newHp}/${fresh.max_hp})`;
    }
    case 'Inspire': {
      // Apply +2 attack buff to all players in the same chunk
      const nearby = getPlayersAtChunk(player.chunk_x, player.chunk_y, player.location_id);
      let count = 0;
      for (const p of nearby) {
        addBuff(p.id, { type: 'inspire', expiresAt: buffExpiry, charges: 1, value: 2 });
        count++;
      }
      return `You rally your allies! ${count} player(s) in your area gain +2 to their next attack roll.`;
    }
    case 'Lucky Strike': {
      addBuff(playerId, { type: 'lucky_strike', expiresAt: buffExpiry, charges: 1, value: 1 });
      return 'You feel fortune smiling upon you. Your next attack will automatically crit if it hits.';
    }
    case 'Fortify': {
      addBuff(playerId, { type: 'fortify', expiresAt: buffExpiry, charges: 2, value: 5 });
      return 'You brace yourself. +5 AC for the next 2 incoming attacks.';
    }
    default:
      return `Ability "${ability.name}" has no implementation.`;
  }
}

export function getActiveBuffs(playerId: number): ActiveBuff[] {
  const db = getDb();
  const now = toSqliteDatetime(Date.now());

  // Clean expired buffs and return active ones in a single operation
  db.prepare(
    `DELETE FROM active_buffs WHERE player_id = ? AND expires_at <= ?`
  ).run(playerId, now);

  const rows = db.prepare(
    `SELECT player_id, buff_type, expires_at, charges, value
     FROM active_buffs WHERE player_id = ? AND expires_at > ?`
  ).all(playerId, now) as BuffRow[];

  return rows.map(rowToBuff);
}

/**
 * Consume a buff of the given type. Returns the buff data if active, or null.
 * Decrements charges; removes buff when charges reach 0.
 */
export function consumeBuff(playerId: number, buffType: BuffType): ActiveBuff | null {
  const db = getDb();
  const now = toSqliteDatetime(Date.now());

  const row = db.prepare(
    `SELECT player_id, buff_type, expires_at, charges, value
     FROM active_buffs WHERE player_id = ? AND buff_type = ?`
  ).get(playerId, buffType) as BuffRow | undefined;

  if (!row) return null;

  // Check if expired
  if (toEpochMs(row.expires_at) <= Date.now()) {
    db.prepare(
      `DELETE FROM active_buffs WHERE player_id = ? AND buff_type = ?`
    ).run(playerId, buffType);
    return null;
  }

  const buff = rowToBuff(row);

  if (buff.charges <= 1) {
    db.prepare(
      `DELETE FROM active_buffs WHERE player_id = ? AND buff_type = ?`
    ).run(playerId, buffType);
  } else {
    db.prepare(
      `UPDATE active_buffs SET charges = charges - 1 WHERE player_id = ? AND buff_type = ?`
    ).run(playerId, buffType);
  }

  return buff;
}

// --- Buff name display helper ---

export function buffTypeName(type: BuffType): string {
  switch (type) {
    case 'rage': return 'Rage (2x damage)';
    case 'stealth': return 'Stealth (+5 hit)';
    case 'inspire': return 'Inspire (+2 attack)';
    case 'lucky_strike': return 'Lucky Strike (auto-crit)';
    case 'fortify': return 'Fortify (+5 AC)';
    case 'rage_ac_penalty': return 'Rage (-3 AC)';
    default: return type;
  }
}
