import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getItemsByOwner, getItemById, transferToPlayer, dropAtLocation, equipItem, unequipItem, createItem } from '../models/item.js';
import { updatePlayerHp, updatePlayerGold, getPlayerById } from '../models/player.js';
import { getLocationById } from '../models/location.js';
import { logEvent } from '../models/event-log.js';
import { getDb } from '../db/connection.js';

export function registerInventoryTools(server: McpServer): void {
  server.tool(
    'inventory',
    'View your inventory (items and gold).',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const items = getItemsByOwner(player.id);
        const parts: string[] = [`🎒 Inventory of ${player.name} | Gold: ${player.gold}`];

        if (items.length === 0) {
          parts.push('  (empty)');
        } else {
          for (const item of items) {
            const equipped = item.is_equipped ? ' [EQUIPPED]' : '';
            const stats: string[] = [];
            if (item.damage_bonus) stats.push(`+${item.damage_bonus} dmg`);
            if (item.defense_bonus) stats.push(`+${item.defense_bonus} def`);
            if (item.heal_amount) stats.push(`heals ${item.heal_amount}`);
            const bonuses = JSON.parse(item.stat_bonuses || '{}');
            for (const [k, v] of Object.entries(bonuses)) {
              if (v) stats.push(`+${v} ${k}`);
            }
            parts.push(`  [${item.id}] ${item.name} (${item.item_type}, ${item.rarity})${equipped} ${stats.join(', ')} — ${item.value}g`);
          }
        }

        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'pickup',
    'Pick up a free item from the ground. Cannot pick up shop items — use `buy_item` for those.',
    {
      token: z.string().uuid().describe('Your auth token'),
      item_id: z.number().int().describe('ID of the item to pick up'),
    },
    async ({ token, item_id }) => {
      try {
        const player = authenticate(token);
        const item = getItemById(item_id);
        if (!item) return { content: [{ type: 'text', text: 'Item not found.' }] };
        if (item.owner_id !== null) return { content: [{ type: 'text', text: 'That item belongs to someone.' }] };
        if (item.chunk_x !== player.chunk_x || item.chunk_y !== player.chunk_y) {
          return { content: [{ type: 'text', text: 'That item is not here.' }] };
        }
        if ((item.location_id ?? null) !== player.location_id) {
          return { content: [{ type: 'text', text: 'That item is not in your current location.' }] };
        }
        if (item.is_shop_item) {
          return { content: [{ type: 'text', text: `That item is for sale (${item.value}g). Use \`buy_item\` to purchase it.` }] };
        }

        // Currency items add gold directly
        if (item.item_type === 'currency') {
          updatePlayerGold(player.id, player.gold + item.value);
          getDb().prepare('DELETE FROM items WHERE id = ?').run(item_id);
          return { content: [{ type: 'text', text: `You pick up ${item.name} and gain ${item.value} gold. Total: ${player.gold + item.value}g` }] };
        }

        transferToPlayer(item_id, player.id);
        return { content: [{ type: 'text', text: `You pick up ${item.name}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'buy_item',
    'Buy an item from a shop. You must be in the same location as the item.',
    {
      token: z.string().uuid().describe('Your auth token'),
      item_id: z.number().int().describe('ID of the item to buy'),
    },
    async ({ token, item_id }) => {
      try {
        const player = authenticate(token);
        const item = getItemById(item_id);
        if (!item) return { content: [{ type: 'text', text: 'Item not found.' }] };
        if (item.owner_id !== null) return { content: [{ type: 'text', text: 'That item is not for sale.' }] };
        if (!item.is_shop_item) return { content: [{ type: 'text', text: 'That item is not a shop item. Use `pickup` instead.' }] };
        if (item.chunk_x !== player.chunk_x || item.chunk_y !== player.chunk_y) {
          return { content: [{ type: 'text', text: 'That item is not here.' }] };
        }
        if ((item.location_id ?? null) !== player.location_id) {
          return { content: [{ type: 'text', text: 'That item is not in your current location.' }] };
        }
        if (player.gold < item.value) {
          return { content: [{ type: 'text', text: `Not enough gold. You have ${player.gold}g, need ${item.value}g.` }] };
        }

        updatePlayerGold(player.id, player.gold - item.value);
        // Create a copy for the player (shop item stays in shop)
        const bought = createItem(item.name, item.description, item.item_type as any, {
          damage_bonus: item.damage_bonus,
          defense_bonus: item.defense_bonus,
          stat_bonuses: JSON.parse(item.stat_bonuses || '{}'),
          heal_amount: item.heal_amount,
          value: item.value,
          owner_id: player.id,
          rarity: item.rarity as any,
        });

        logEvent('buy', player.id, null, player.chunk_x, player.chunk_y, player.location_id, { item_name: item.name, cost: item.value });

        return { content: [{ type: 'text', text: `You buy ${item.name} for ${item.value}g. Gold remaining: ${player.gold - item.value}g` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'sell_item',
    'Sell an item from your inventory. You must be in a shop. You get 50% of item value.',
    {
      token: z.string().uuid().describe('Your auth token'),
      item_id: z.number().int().describe('ID of the item to sell'),
    },
    async ({ token, item_id }) => {
      try {
        const player = authenticate(token);
        if (player.location_id === null) {
          return { content: [{ type: 'text', text: 'You must be inside a shop to sell items.' }] };
        }
        const loc = getLocationById(player.location_id);
        if (!loc || !loc.is_shop) {
          return { content: [{ type: 'text', text: 'You must be inside a shop to sell items.' }] };
        }

        const item = getItemById(item_id);
        if (!item || item.owner_id !== player.id) return { content: [{ type: 'text', text: "You don't have that item." }] };
        if (item.item_type === 'currency') return { content: [{ type: 'text', text: "You can't sell currency." }] };

        const sellPrice = Math.floor(item.value / 2);
        updatePlayerGold(player.id, player.gold + sellPrice);
        getDb().prepare('DELETE FROM items WHERE id = ?').run(item_id);

        logEvent('sell', player.id, null, player.chunk_x, player.chunk_y, player.location_id, { item_name: item.name, price: sellPrice });

        return { content: [{ type: 'text', text: `You sell ${item.name} for ${sellPrice}g. Gold: ${player.gold + sellPrice}g` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'drop',
    'Drop an item from your inventory onto the ground.',
    {
      token: z.string().uuid().describe('Your auth token'),
      item_id: z.number().int().describe('ID of the item to drop'),
    },
    async ({ token, item_id }) => {
      try {
        const player = authenticate(token);
        const item = getItemById(item_id);
        if (!item || item.owner_id !== player.id) return { content: [{ type: 'text', text: "You don't have that item." }] };

        dropAtLocation(item_id, player.chunk_x, player.chunk_y, player.location_id);
        return { content: [{ type: 'text', text: `You drop ${item.name} on the ground.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'equip',
    'Equip a weapon or armor from your inventory. Stat bonuses are applied.',
    {
      token: z.string().uuid().describe('Your auth token'),
      item_id: z.number().int().describe('ID of the item to equip'),
    },
    async ({ token, item_id }) => {
      try {
        const player = authenticate(token);
        const item = getItemById(item_id);
        if (!item || item.owner_id !== player.id) return { content: [{ type: 'text', text: "You don't have that item." }] };
        if (item.item_type !== 'weapon' && item.item_type !== 'armor') {
          return { content: [{ type: 'text', text: 'You can only equip weapons and armor.' }] };
        }

        // Unequip existing weapon if equipping a weapon
        if (item.item_type === 'weapon') {
          const items = getItemsByOwner(player.id);
          for (const i of items) {
            if (i.item_type === 'weapon' && i.is_equipped) {
              unequipItem(i.id);
              applyStatBonuses(player.id, i, false);
            }
          }
        }

        equipItem(item_id);
        applyStatBonuses(player.id, item, true);

        const stats: string[] = [];
        if (item.damage_bonus) stats.push(`+${item.damage_bonus} damage`);
        if (item.defense_bonus) stats.push(`+${item.defense_bonus} defense`);
        const bonuses = JSON.parse(item.stat_bonuses || '{}');
        for (const [k, v] of Object.entries(bonuses)) {
          if (v) stats.push(`+${v} ${k}`);
        }
        return { content: [{ type: 'text', text: `You equip ${item.name}. ${stats.join(', ')}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'unequip',
    'Unequip a weapon or armor. Stat bonuses are removed.',
    {
      token: z.string().uuid().describe('Your auth token'),
      item_id: z.number().int().describe('ID of the item to unequip'),
    },
    async ({ token, item_id }) => {
      try {
        const player = authenticate(token);
        const item = getItemById(item_id);
        if (!item || item.owner_id !== player.id) return { content: [{ type: 'text', text: "You don't have that item." }] };
        if (!item.is_equipped) return { content: [{ type: 'text', text: 'That item is not equipped.' }] };

        unequipItem(item_id);
        applyStatBonuses(player.id, item, false);
        return { content: [{ type: 'text', text: `You unequip ${item.name}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'use_item',
    'Use a consumable item (potion, scroll, etc) or a key item.',
    {
      token: z.string().uuid().describe('Your auth token'),
      item_id: z.number().int().describe('ID of the item to use'),
    },
    async ({ token, item_id }) => {
      try {
        const player = authenticate(token);
        const item = getItemById(item_id);
        if (!item || item.owner_id !== player.id) return { content: [{ type: 'text', text: "You don't have that item." }] };
        if (item.item_type !== 'consumable' && item.item_type !== 'key') {
          return { content: [{ type: 'text', text: 'You can only use consumable or key items.' }] };
        }

        if (item.item_type === 'key') {
          return { content: [{ type: 'text', text: `${item.name} — keys are used automatically when you enter a locked location. Keep it in your inventory.` }] };
        }

        const parts: string[] = [`You use ${item.name}.`];

        if (item.heal_amount > 0) {
          const newHp = Math.min(player.max_hp, player.hp + item.heal_amount);
          updatePlayerHp(player.id, newHp);
          parts.push(`Healed ${newHp - player.hp} HP. HP: ${newHp}/${player.max_hp}`);
        }

        // Apply stat bonuses from consumable (temporary effect — permanent add)
        const bonuses = JSON.parse(item.stat_bonuses || '{}');
        if (Object.keys(bonuses).length > 0) {
          applyStatBonuses(player.id, item, true);
          parts.push(`Stat boost: ${Object.entries(bonuses).map(([k, v]) => `+${v} ${k}`).join(', ')}`);
        }

        getDb().prepare('DELETE FROM items WHERE id = ?').run(item_id);

        logEvent('use_item', player.id, null, player.chunk_x, player.chunk_y, player.location_id, { item_name: item.name, heal_amount: item.heal_amount });

        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}

function applyStatBonuses(playerId: number, item: { stat_bonuses: string }, equip: boolean): void {
  const bonuses = JSON.parse(item.stat_bonuses || '{}');
  if (Object.keys(bonuses).length === 0) return;

  const db = getDb();
  const multiplier = equip ? 1 : -1;
  const sets: string[] = [];
  const values: number[] = [];

  for (const [stat, val] of Object.entries(bonuses)) {
    if (['strength', 'dexterity', 'constitution', 'charisma', 'luck'].includes(stat) && typeof val === 'number') {
      sets.push(`${stat} = max(1, ${stat} + ?)`);
      values.push(val * multiplier);
    }
  }

  if (sets.length > 0) {
    values.push(playerId);
    db.prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
}
