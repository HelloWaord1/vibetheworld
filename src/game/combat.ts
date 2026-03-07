import { d20, d6 } from './dice.js';
import type { Player, CombatResult } from '../types/index.js';
import { getEquippedWeapon, getEquippedArmor, getItemsByOwner, dropAtLocation } from '../models/item.js';
import { killPlayer, updatePlayerHp, addXp, updatePlayerGold } from '../models/player.js';
import { createItem } from '../models/item.js';
import { logEvent } from '../models/event-log.js';

function getWeaponBonus(playerId: number): number {
  const weapon = getEquippedWeapon(playerId);
  return weapon ? weapon.damage_bonus : 0;
}

function getArmorBonus(playerId: number): number {
  const armor = getEquippedArmor(playerId);
  return armor.reduce((sum, a) => sum + a.defense_bonus, 0);
}

export function resolveCombatRound(attacker: Player, defender: Player): { attacker_result: CombatResult; defender_result: CombatResult; narrative: string } {
  const atkWeaponBonus = getWeaponBonus(attacker.id);
  const defWeaponBonus = getWeaponBonus(defender.id);
  const atkArmorBonus = getArmorBonus(attacker.id);
  const defArmorBonus = getArmorBonus(defender.id);

  // Initiative
  const atkInit = d20() + Math.floor(attacker.dexterity / 2);
  const defInit = d20() + Math.floor(defender.dexterity / 2);
  const attackerFirst = atkInit >= defInit;

  const [first, second] = attackerFirst ? [attacker, defender] : [defender, attacker];
  const [firstWB, secondWB] = attackerFirst ? [atkWeaponBonus, defWeaponBonus] : [defWeaponBonus, atkWeaponBonus];
  const [_firstAB, secondAB] = attackerFirst ? [atkArmorBonus, defArmorBonus] : [defArmorBonus, atkArmorBonus];
  const [firstAB2, _secondAB2] = attackerFirst ? [atkArmorBonus, defArmorBonus] : [defArmorBonus, atkArmorBonus];

  let firstHp = first.hp;
  let secondHp = second.hp;
  const parts: string[] = [];

  // First strike
  const r1 = resolveAttack(first, second, firstWB, secondAB, secondHp);
  secondHp = r1.defender_hp;
  parts.push(`${first.name} rolls ${r1.attacker_roll} vs AC ${r1.defender_ac}: ${r1.hit ? (r1.crit ? 'CRITICAL HIT' : 'Hit') : 'Miss'}${r1.hit ? ` for ${r1.damage} damage` : ''}`);

  let secondResult: CombatResult;
  if (secondHp > 0) {
    // Second strike
    secondResult = resolveAttack(second, first, secondWB, firstAB2, firstHp);
    firstHp = secondResult.defender_hp;
    parts.push(`${second.name} rolls ${secondResult.attacker_roll} vs AC ${secondResult.defender_ac}: ${secondResult.hit ? (secondResult.crit ? 'CRITICAL HIT' : 'Hit') : 'Miss'}${secondResult.hit ? ` for ${secondResult.damage} damage` : ''}`);
  } else {
    secondResult = { attacker_roll: 0, defender_ac: 0, hit: false, damage: 0, crit: false, attacker_hp: secondHp, defender_hp: firstHp, attacker_dead: secondHp <= 0, defender_dead: false };
  }

  // Update HPs
  const atkHp = attackerFirst ? firstHp : secondHp;
  const defHp = attackerFirst ? secondHp : firstHp;
  updatePlayerHp(attacker.id, Math.max(0, atkHp));
  updatePlayerHp(defender.id, Math.max(0, defHp));

  // Handle deaths
  if (defHp <= 0) {
    handleDeath(defender, attacker);
    parts.push(`${defender.name} has been SLAIN by ${attacker.name}! Permadeath.`);
  }
  if (atkHp <= 0) {
    handleDeath(attacker, defender);
    parts.push(`${attacker.name} has been SLAIN by ${defender.name}! Permadeath.`);
  }

  const attacker_result: CombatResult = {
    attacker_roll: attackerFirst ? r1.attacker_roll : secondResult.attacker_roll,
    defender_ac: attackerFirst ? r1.defender_ac : secondResult.defender_ac,
    hit: attackerFirst ? r1.hit : secondResult.hit,
    damage: attackerFirst ? r1.damage : secondResult.damage,
    crit: attackerFirst ? r1.crit : secondResult.crit,
    attacker_hp: Math.max(0, atkHp),
    defender_hp: Math.max(0, defHp),
    attacker_dead: atkHp <= 0,
    defender_dead: defHp <= 0,
  };

  const defender_result: CombatResult = {
    attacker_roll: attackerFirst ? secondResult.attacker_roll : r1.attacker_roll,
    defender_ac: attackerFirst ? secondResult.defender_ac : r1.defender_ac,
    hit: attackerFirst ? secondResult.hit : r1.hit,
    damage: attackerFirst ? secondResult.damage : r1.damage,
    crit: attackerFirst ? secondResult.crit : r1.crit,
    attacker_hp: Math.max(0, defHp),
    defender_hp: Math.max(0, atkHp),
    attacker_dead: defHp <= 0,
    defender_dead: atkHp <= 0,
  };

  return {
    attacker_result,
    defender_result,
    narrative: parts.join('\n'),
  };
}

function resolveAttack(
  attacker: Player, defender: Player,
  weaponBonus: number, armorBonus: number, defenderHp: number
): CombatResult {
  const attackRoll = d20() + Math.floor(attacker.strength / 2) + weaponBonus;
  const ac = 10 + Math.floor(defender.constitution / 3) + armorBonus;
  const hit = attackRoll >= ac;

  let damage = 0;
  let crit = false;

  if (hit) {
    damage = d6() + Math.floor(attacker.strength / 3) + weaponBonus;
    const critRoll = d20();
    if (critRoll <= Math.floor(attacker.luck / 2)) {
      crit = true;
      damage *= 2;
    }
    defenderHp -= damage;
  }

  return {
    attacker_roll: attackRoll,
    defender_ac: ac,
    hit,
    damage,
    crit,
    attacker_hp: attacker.hp,
    defender_hp: Math.max(0, defenderHp),
    attacker_dead: false,
    defender_dead: defenderHp <= 0,
  };
}

function handleDeath(victim: Player, killer: Player): void {
  killPlayer(victim.id, `Slain by ${killer.name}`);

  // Drop all items
  const items = getItemsByOwner(victim.id);
  for (const item of items) {
    dropAtLocation(item.id, victim.chunk_x, victim.chunk_y, victim.location_id);
  }

  // Drop gold as item
  if (victim.gold > 0) {
    createItem('Gold Pouch', `A pouch containing ${victim.gold} gold, dropped by ${victim.name}.`, 'currency', {
      value: victim.gold,
      chunk_x: victim.chunk_x,
      chunk_y: victim.chunk_y,
      location_id: victim.location_id,
    });
    updatePlayerGold(victim.id, 0);
  }

  // XP reward
  const xpGain = victim.level * 50;
  const levelResult = addXp(killer.id, xpGain);

  logEvent('kill', killer.id, victim.id, victim.chunk_x, victim.chunk_y, victim.location_id, {
    xp_gained: xpGain,
    leveled_up: levelResult.leveled_up,
    new_level: levelResult.new_level,
  });
}
