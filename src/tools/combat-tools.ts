import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getPlayerByName, updatePlayerPosition, getPlayerById, updatePlayerGold, updatePlayerHp } from '../models/player.js';
import { updatePlayerStats } from '../models/player.js';
import { addChunkRevenue } from '../models/nation.js';
import { resolveCombatRound } from '../game/combat.js';
import { getStatPointsAvailable } from '../game/leveling.js';
import { logEvent } from '../models/event-log.js';
import { DIRECTIONS, EMERGENCY_ESCAPE_COST, SPAWN_IMMUNITY_SECONDS } from '../types/index.js';
import { isValidChunkCoord } from '../game/world-rules.js';
import { getChunk } from '../models/chunk.js';
import { getLocationById } from '../models/location.js';
import { d20 } from '../game/dice.js';
import { getDb } from '../db/connection.js';
import { enforceCooldown, setCooldown, COOLDOWNS } from '../server/cooldown.js';
import { addXp } from '../models/player.js';

const COMBAT_LOCK_DURATION_MS = 10_000; // 10 seconds

const ARENA_KNOCKOUT_GOLD_PENALTY = 0.15; // 15% gold loss
const ARENA_RESPAWN_HP_FRACTION = 0.25; // 25% max HP

function handleArenaOutcome(
  attacker: { id: number; name: string; chunk_x: number; chunk_y: number; location_id: number | null },
  defender: { id: number; name: string; level: number; chunk_x: number; chunk_y: number; location_id: number | null },
  result: { attacker_result: { attacker_hp: number; defender_hp: number; attacker_dead: boolean; defender_dead: boolean }; narrative: string; bountyGained: number; bountyClaimed: number }
): string {
  const atkHp = result.attacker_result.attacker_hp;
  const defHp = result.attacker_result.defender_hp;
  const parts = [
    `ARENA COMBAT: ${attacker.name} vs ${defender.name}`,
    '',
    result.narrative,
    '',
    `${attacker.name}: ${atkHp} HP`,
    `${defender.name}: ${defHp} HP`,
  ];

  // Handle defender knockout
  if (defHp <= 0) {
    const fresh = getPlayerById(defender.id)!;
    const goldLost = Math.floor(fresh.gold * ARENA_KNOCKOUT_GOLD_PENALTY);
    const newGold = fresh.gold - goldLost;
    const respawnHp = Math.max(1, Math.floor(fresh.max_hp * ARENA_RESPAWN_HP_FRACTION));

    updatePlayerGold(defender.id, newGold);
    updatePlayerHp(defender.id, respawnHp);

    // Winner gets XP + gold
    const xpGain = defender.level * 25;
    addXp(attacker.id, xpGain);
    if (goldLost > 0) {
      const attackerFresh = getPlayerById(attacker.id)!;
      updatePlayerGold(attacker.id, Math.min(attackerFresh.gold + goldLost, 10_000_000));
    }

    parts.push('');
    parts.push(`${defender.name} is knocked out in the arena! (No permadeath)`);
    parts.push(`${defender.name} respawns with ${respawnHp} HP, loses ${goldLost}g.`);
    parts.push(`${attacker.name} gains +${xpGain} XP and ${goldLost}g.`);
  }

  // Handle attacker knockout
  if (atkHp <= 0) {
    const fresh = getPlayerById(attacker.id)!;
    const goldLost = Math.floor(fresh.gold * ARENA_KNOCKOUT_GOLD_PENALTY);
    const newGold = fresh.gold - goldLost;
    const respawnHp = Math.max(1, Math.floor(fresh.max_hp * ARENA_RESPAWN_HP_FRACTION));

    updatePlayerGold(attacker.id, newGold);
    updatePlayerHp(attacker.id, respawnHp);

    // Defender gets XP + gold for self-defense kill
    const attackerPlayer = getPlayerById(attacker.id)!;
    const xpGain = attackerPlayer.level * 25;
    addXp(defender.id, xpGain);
    if (goldLost > 0) {
      const defenderFresh = getPlayerById(defender.id)!;
      updatePlayerGold(defender.id, Math.min(defenderFresh.gold + goldLost, 10_000_000));
    }

    parts.push('');
    parts.push(`${attacker.name} is knocked out in the arena! (No permadeath)`);
    parts.push(`${attacker.name} respawns with ${respawnHp} HP, loses ${goldLost}g.`);
    parts.push(`${defender.name} gains +${xpGain} XP and ${goldLost}g.`);
  }

  // If both alive, set combat lock
  if (atkHp > 0 && defHp > 0) {
    setCooldown(attacker.id, 'combat_lock', COMBAT_LOCK_DURATION_MS);
    setCooldown(defender.id, 'combat_lock', COMBAT_LOCK_DURATION_MS);
  }

  return parts.join('\n');
}

export function registerCombatTools(server: McpServer): void {
  server.tool(
    'attack_player',
    'Attack another player at your location. One combat round (both sides attack). PvP only. Permadeath!',
    {
      token: z.string().uuid().describe('Your auth token'),
      target_name: z.string().describe('Name of the player to attack'),
    },
    async ({ token, target_name }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'attack', COOLDOWNS.ATTACK);
        if (cd !== null) return { content: [{ type: 'text', text: `Please wait ${cd}s before attacking again.` }] };
        const target = getPlayerByName(target_name);

        if (!target) return { content: [{ type: 'text', text: `Player "${target_name}" not found or is dead.` }] };
        if (target.id === player.id) return { content: [{ type: 'text', text: 'You cannot attack yourself.' }] };
        if (target.chunk_x !== player.chunk_x || target.chunk_y !== player.chunk_y) {
          return { content: [{ type: 'text', text: `${target_name} is not in your chunk.` }] };
        }
        if ((target.location_id ?? null) !== (player.location_id ?? null)) {
          return { content: [{ type: 'text', text: `${target_name} is not at your exact location.` }] };
        }

        // Spawn immunity: cannot attack players within SPAWN_IMMUNITY_SECONDS of creation
        const targetAge = (Date.now() - new Date(target.created_at).getTime()) / 1000;
        if (targetAge < SPAWN_IMMUNITY_SECONDS) {
          const remaining = Math.ceil(SPAWN_IMMUNITY_SECONDS - targetAge);
          return { content: [{ type: 'text', text: `${target.name} has spawn protection for ${remaining} more seconds.` }] };
        }

        // Nexus (0,0) is a safe zone — no PvP
        if (player.chunk_x === 0 && player.chunk_y === 0) {
          return { content: [{ type: 'text', text: 'The Nexus is a safe zone. No combat is allowed here.' }] };
        }

        // Check if both players are in an arena (no permadeath)
        const isArena = player.location_id !== null && (() => {
          const loc = getLocationById(player.location_id!);
          return loc !== null && loc.location_type === 'arena';
        })();

        const result = resolveCombatRound(player, target, { skipDeath: isArena });

        logEvent('combat', player.id, target.id, player.chunk_x, player.chunk_y, player.location_id, {
          attacker_result: result.attacker_result,
          defender_result: result.defender_result,
          arena: isArena,
        });

        const atkHp = result.attacker_result.attacker_hp;
        const defHp = result.attacker_result.defender_hp;

        // Arena override: replace permadeath with knockout
        if (isArena) {
          const arenaResult = handleArenaOutcome(player, target, result);
          return { content: [{ type: 'text', text: arenaResult }] };
        }

        // Set combat lock on both players if both are alive (pursuit mechanic)
        if (atkHp > 0 && defHp > 0) {
          setCooldown(player.id, 'combat_lock', COMBAT_LOCK_DURATION_MS);
          setCooldown(target.id, 'combat_lock', COMBAT_LOCK_DURATION_MS);
        }

        const parts = [
          `COMBAT: ${player.name} vs ${target.name}`,
          '',
          result.narrative,
          '',
          `${player.name}: ${atkHp} HP`,
          `${target.name}: ${defHp} HP`,
        ];

        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'flee',
    'Attempt to flee combat by running to a random adjacent chunk. Requires a dexterity check.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);

        // Check exit policy — locked borders require emergency escape fee
        const currentChunk = getChunk(player.chunk_x, player.chunk_y);
        if (currentChunk && currentChunk.ruler_id !== null && currentChunk.ruler_id !== player.id) {
          if (currentChunk.exit_policy === 'locked') {
            const freshP = getPlayerById(player.id)!;
            if (freshP.gold < EMERGENCY_ESCAPE_COST) {
              return { content: [{ type: 'text', text: `Locked borders — fleeing costs ${EMERGENCY_ESCAPE_COST}g (you have ${freshP.gold}g). Use \`revolt\` to overthrow the ruler.` }] };
            }
            const db = getDb();
            db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(EMERGENCY_ESCAPE_COST, player.id);
            if (currentChunk.ruler_id) {
              db.prepare('UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?').run(Math.floor(EMERGENCY_ESCAPE_COST / 2), currentChunk.ruler_id);
            }
          }
        }

        const roll = d20() + Math.floor(player.dexterity / 2);
        const dc = 12;

        if (roll < dc) {
          return { content: [{ type: 'text', text: `You try to flee but stumble! (Roll: ${roll} vs DC ${dc}). You remain here.` }] };
        }

        // Pick a random valid direction
        const dirs = Object.entries(DIRECTIONS).filter(([_, [dx, dy]]) =>
          isValidChunkCoord(player.chunk_x + dx, player.chunk_y + dy)
        );
        if (dirs.length === 0) {
          return { content: [{ type: 'text', text: 'Nowhere to flee!' }] };
        }
        const [dir, [dx, dy]] = dirs[Math.floor(Math.random() * dirs.length)];
        const newX = player.chunk_x + dx;
        const newY = player.chunk_y + dy;
        const chunk = getChunk(newX, newY);

        if (!chunk) {
          return { content: [{ type: 'text', text: `You flee ${dir} but the land beyond is uncharted! You stay put. (Try moving to explore it first.)` }] };
        }

        // Exit fee on flee (but don't block — already passed the locked check)
        if (currentChunk && currentChunk.exit_policy === 'fee' && currentChunk.exit_fee > 0 &&
            currentChunk.ruler_id !== null && currentChunk.ruler_id !== player.id) {
          const freshPlayer = getPlayerById(player.id)!;
          if (freshPlayer.gold >= currentChunk.exit_fee) {
            const db = getDb();
            db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(currentChunk.exit_fee, player.id);
            if (currentChunk.ruler_id) {
              db.prepare('UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?').run(currentChunk.exit_fee, currentChunk.ruler_id);
            }
            addChunkRevenue(player.chunk_x, player.chunk_y, currentChunk.exit_fee);
          }
          // If they can't pay exit fee, still let them flee (life > gold)
        }

        updatePlayerPosition(player.id, newX, newY, null);
        return { content: [{ type: 'text', text: `You flee ${dir} to ${chunk.name}! (Roll: ${roll} vs DC ${dc})` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'allocate_stats',
    'Spend stat points gained from leveling up. Each level gives 2 points.',
    {
      token: z.string().uuid().describe('Your auth token'),
      strength: z.number().int().min(0).optional().default(0).describe('Points to add to STR'),
      dexterity: z.number().int().min(0).optional().default(0).describe('Points to add to DEX'),
      constitution: z.number().int().min(0).optional().default(0).describe('Points to add to CON'),
      charisma: z.number().int().min(0).optional().default(0).describe('Points to add to CHA'),
      luck: z.number().int().min(0).optional().default(0).describe('Points to add to LCK'),
    },
    async ({ token, strength, dexterity, constitution, charisma, luck }) => {
      try {
        const player = authenticate(token);
        const available = getStatPointsAvailable(player);
        const total = strength + dexterity + constitution + charisma + luck;

        if (total === 0) {
          return { content: [{ type: 'text', text: `You have ${available} stat points to allocate.` }] };
        }
        if (total > available) {
          return { content: [{ type: 'text', text: `Not enough stat points. You have ${available}, trying to spend ${total}.` }] };
        }

        updatePlayerStats(player.id, { strength, dexterity, constitution, charisma, luck });
        const updated = getPlayerById(player.id)!;
        return {
          content: [{
            type: 'text',
            text: `Stats updated! Points remaining: ${available - total}\nSTR ${updated.strength} | DEX ${updated.dexterity} | CON ${updated.constitution} | CHA ${updated.charisma} | LCK ${updated.luck}`
          }]
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
