import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getDb } from '../db/connection.js';
import { createItem } from '../models/item.js';
import { getItemsByOwner } from '../models/item.js';
import { getLocationById } from '../models/location.js';
import { updatePlayerGold } from '../models/player.js';
import { logEvent } from '../models/event-log.js';
import { awardCraftItemXp } from '../game/xp-rewards.js';
import { enforceCooldown, COOLDOWNS } from '../server/cooldown.js';
import { MAX_INVENTORY_SIZE } from '../types/index.js';

interface MarketplaceListing {
  listing_id: number;
  item_name: string;
  item_type: string;
  rarity: string;
  price: number;
  seller_name: string;
  chunk_x: number;
  chunk_y: number;
  damage_bonus: number;
  defense_bonus: number;
  heal_amount: number;
  created_at: string;
}

interface PriceCheckRow {
  name: string;
  shop_value: number;
  listing_price: number | null;
}

interface SearchResultRow {
  listing_id: number;
  item_name: string;
  item_description: string;
  item_type: string;
  rarity: string;
  price: number;
  seller_name: string;
  chunk_x: number;
  chunk_y: number;
}

function buildSortClause(sortBy: string): string {
  switch (sortBy) {
    case 'price_asc': return 'pl.price ASC';
    case 'price_desc': return 'pl.price DESC';
    case 'newest': return 'pl.created_at DESC';
    default: return 'pl.created_at DESC';
  }
}

export function registerMarketplaceTools(server: McpServer): void {
  server.tool(
    'marketplace',
    'Browse ALL player listings across the entire world. Filter by item category and sort by price or date.',
    {
      token: z.string().uuid().describe('Your auth token'),
      category: z.enum(['weapon', 'armor', 'consumable', 'key', 'misc', 'all']).optional().default('all').describe('Filter by item type'),
      sort_by: z.enum(['price_asc', 'price_desc', 'newest']).optional().default('newest').describe('Sort order'),
      limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results (1-100)'),
    },
    async ({ token, category, sort_by, limit }) => {
      try {
        authenticate(token);
        const db = getDb();

        const categoryFilter = category === 'all' ? '' : 'AND i.item_type = ?';
        const orderClause = buildSortClause(sort_by);

        const query = `
          SELECT
            pl.id AS listing_id,
            i.name AS item_name,
            i.item_type,
            i.rarity,
            pl.price,
            p.name AS seller_name,
            pl.chunk_x,
            pl.chunk_y,
            i.damage_bonus,
            i.defense_bonus,
            i.heal_amount,
            pl.created_at
          FROM player_listings pl
          JOIN items i ON pl.item_id = i.id
          JOIN players p ON pl.seller_id = p.id AND p.is_alive = 1
          WHERE 1=1 ${categoryFilter}
          ORDER BY ${orderClause}
          LIMIT ?
        `;

        const params: (string | number)[] = [];
        if (category !== 'all') params.push(category);
        params.push(limit);

        const rows = db.prepare(query).all(...params) as MarketplaceListing[];

        if (rows.length === 0) {
          return { content: [{ type: 'text', text: 'No listings found. The marketplace is empty.' }] };
        }

        const header = `Marketplace (${rows.length} listing${rows.length !== 1 ? 's' : ''})`;
        const divider = '-'.repeat(70);
        const lines = [header, divider];

        for (const row of rows) {
          const stats: string[] = [];
          if (row.damage_bonus > 0) stats.push(`+${row.damage_bonus} dmg`);
          if (row.defense_bonus > 0) stats.push(`+${row.defense_bonus} def`);
          if (row.heal_amount > 0) stats.push(`heals ${row.heal_amount}`);
          const statsStr = stats.length > 0 ? ` [${stats.join(', ')}]` : '';
          lines.push(
            `  #${row.listing_id} | ${row.item_name} (${row.item_type}, ${row.rarity})${statsStr}`
          );
          lines.push(
            `    Price: ${row.price}g | Seller: ${row.seller_name} | Location: (${row.chunk_x}, ${row.chunk_y})`
          );
        }

        lines.push(divider);
        lines.push('Use `buy_listing` with the listing ID to purchase. You must be in the same chunk and location as the seller.');

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'price_check',
    'Check the value range for an item type. Shows shop price, current listings range, and average listing price.',
    {
      token: z.string().uuid().describe('Your auth token'),
      item_name: z.string().min(1).describe('Item name to search for'),
    },
    async ({ token, item_name }) => {
      try {
        authenticate(token);
        const db = getDb();

        // Get shop prices for items matching the name
        const shopItems = db.prepare(`
          SELECT DISTINCT name, value AS shop_value
          FROM items
          WHERE name LIKE ? AND is_shop_item = 1
        `).all(`%${item_name}%`) as { name: string; shop_value: number }[];

        // Get listing prices for items matching the name
        const listingRows = db.prepare(`
          SELECT
            i.name,
            pl.price AS listing_price
          FROM player_listings pl
          JOIN items i ON pl.item_id = i.id
          JOIN players p ON pl.seller_id = p.id AND p.is_alive = 1
          WHERE i.name LIKE ?
        `).all(`%${item_name}%`) as PriceCheckRow[];

        if (shopItems.length === 0 && listingRows.length === 0) {
          return { content: [{ type: 'text', text: `No items found matching "${item_name}".` }] };
        }

        const lines: string[] = [`Price Check: "${item_name}"`, '-'.repeat(50)];

        if (shopItems.length > 0) {
          lines.push('Shop prices:');
          for (const si of shopItems) {
            lines.push(`  ${si.name}: ${si.shop_value}g (sell-back ~${Math.floor(si.shop_value / 2)}g)`);
          }
        } else {
          lines.push('No shop items found with that name.');
        }

        if (listingRows.length > 0) {
          const prices = listingRows.map(r => r.listing_price).filter((p): p is number => p !== null);
          const minPrice = Math.min(...prices);
          const maxPrice = Math.max(...prices);
          const avgPrice = Math.floor(prices.reduce((s, p) => s + p, 0) / prices.length);

          lines.push('');
          lines.push(`Player listings (${prices.length} active):`);
          lines.push(`  Lowest:  ${minPrice}g`);
          lines.push(`  Highest: ${maxPrice}g`);
          lines.push(`  Average: ${avgPrice}g`);

          // Group by distinct item names
          const nameSet = new Set(listingRows.map(r => r.name));
          if (nameSet.size > 1) {
            lines.push(`  Matching items: ${[...nameSet].join(', ')}`);
          }
        } else {
          lines.push('');
          lines.push('No player listings found for this item.');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'search_items',
    'Search items by keyword across all player listings. Searches item names and descriptions.',
    {
      token: z.string().uuid().describe('Your auth token'),
      query: z.string().min(1).describe('Search keyword'),
    },
    async ({ token, query }) => {
      try {
        authenticate(token);
        const db = getDb();

        const rows = db.prepare(`
          SELECT
            pl.id AS listing_id,
            i.name AS item_name,
            i.description AS item_description,
            i.item_type,
            i.rarity,
            pl.price,
            p.name AS seller_name,
            pl.chunk_x,
            pl.chunk_y
          FROM player_listings pl
          JOIN items i ON pl.item_id = i.id
          JOIN players p ON pl.seller_id = p.id AND p.is_alive = 1
          WHERE i.name LIKE ? OR i.description LIKE ?
          ORDER BY pl.price ASC
          LIMIT 20
        `).all(`%${query}%`, `%${query}%`) as SearchResultRow[];

        if (rows.length === 0) {
          return { content: [{ type: 'text', text: `No listings found matching "${query}".` }] };
        }

        const lines: string[] = [`Search results for "${query}" (${rows.length} found)`, '-'.repeat(60)];

        for (const row of rows) {
          lines.push(`  #${row.listing_id} | ${row.item_name} (${row.item_type}, ${row.rarity}) — ${row.price}g`);
          lines.push(`    ${row.item_description}`);
          lines.push(`    Seller: ${row.seller_name} @ (${row.chunk_x}, ${row.chunk_y})`);
        }

        lines.push('-'.repeat(60));
        lines.push('Use `buy_listing` with the listing ID to purchase.');

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'craft_item',
    'Craft a new item at a forge, workshop, or laboratory. Cost: 50g base + bonuses. Max bonuses scale with your level.',
    {
      token: z.string().uuid().describe('Your auth token'),
      name: z.string().min(1).max(100).describe('Name for the crafted item'),
      description: z.string().min(1).max(500).describe('Description of the item'),
      item_type: z.enum(['weapon', 'armor', 'consumable', 'misc']).describe('Type of item to craft'),
      damage_bonus: z.number().int().min(0).max(5).optional().default(0).describe('Damage bonus (0-5)'),
      defense_bonus: z.number().int().min(0).max(5).optional().default(0).describe('Defense bonus (0-5)'),
      heal_amount: z.number().int().min(0).max(50).optional().default(0).describe('Heal amount for consumables (0-50)'),
      value: z.number().int().min(0).optional().default(0).describe('Base value in gold'),
    },
    async ({ token, name, description, item_type, damage_bonus, defense_bonus, heal_amount, value }) => {
      try {
        const player = authenticate(token);

        const cd = enforceCooldown(player.id, 'craft', COOLDOWNS.CRAFT);
        if (cd !== null) {
          return { content: [{ type: 'text', text: `Please wait ${cd}s before crafting again.` }] };
        }

        // Check location type
        if (player.location_id === null) {
          return { content: [{ type: 'text', text: 'You must be inside a forge, workshop, or laboratory to craft items. Use `look` to find one nearby.' }] };
        }

        const loc = getLocationById(player.location_id);
        if (!loc) {
          return { content: [{ type: 'text', text: 'Current location not found.' }] };
        }

        const validCraftTypes = ['forge', 'workshop', 'laboratory'];
        if (!validCraftTypes.includes(loc.location_type)) {
          return { content: [{ type: 'text', text: `You cannot craft here. "${loc.name}" is a ${loc.location_type}. You need a forge, workshop, or laboratory.` }] };
        }

        // Max bonuses scale with level: floor(level/2) + 1
        const maxBonus = Math.floor(player.level / 2) + 1;
        if (damage_bonus > maxBonus) {
          return { content: [{ type: 'text', text: `Your level (${player.level}) allows max damage bonus of ${maxBonus}. Requested: ${damage_bonus}.` }] };
        }
        if (defense_bonus > maxBonus) {
          return { content: [{ type: 'text', text: `Your level (${player.level}) allows max defense bonus of ${maxBonus}. Requested: ${defense_bonus}.` }] };
        }

        // Calculate cost
        const cost = 50 + (damage_bonus * 20) + (defense_bonus * 20) + (heal_amount * 2);
        if (player.gold < cost) {
          return { content: [{ type: 'text', text: `Not enough gold. Crafting cost: ${cost}g (50 base + ${damage_bonus * 20}g dmg + ${defense_bonus * 20}g def + ${heal_amount * 2}g heal). You have ${player.gold}g.` }] };
        }

        // Check inventory space
        if (getItemsByOwner(player.id).length >= MAX_INVENTORY_SIZE) {
          return { content: [{ type: 'text', text: `Inventory full (${MAX_INVENTORY_SIZE} items max). Drop something first.` }] };
        }

        // Determine rarity based on total bonuses
        const totalBonus = damage_bonus + defense_bonus + Math.floor(heal_amount / 10);
        let rarity: 'common' | 'uncommon' | 'rare' | 'epic' = 'common';
        if (totalBonus >= 8) rarity = 'epic';
        else if (totalBonus >= 5) rarity = 'rare';
        else if (totalBonus >= 2) rarity = 'uncommon';

        // Deduct gold
        updatePlayerGold(player.id, player.gold - cost);

        // Create the item
        const craftedValue = value > 0 ? value : cost;
        const item = createItem(name, description, item_type, {
          damage_bonus,
          defense_bonus,
          heal_amount,
          value: craftedValue,
          owner_id: player.id,
          rarity,
        });

        // Award XP
        const xpResult = awardCraftItemXp(player.id);

        logEvent('craft_item', player.id, null, player.chunk_x, player.chunk_y, player.location_id, {
          item_id: item.id, item_name: name, cost, rarity,
        });

        const stats: string[] = [];
        if (damage_bonus > 0) stats.push(`+${damage_bonus} dmg`);
        if (defense_bonus > 0) stats.push(`+${defense_bonus} def`);
        if (heal_amount > 0) stats.push(`heals ${heal_amount}`);
        const statsStr = stats.length > 0 ? ` | Stats: ${stats.join(', ')}` : '';

        const levelUpNote = xpResult.leveled_up ? `\nLevel up! You are now level ${xpResult.new_level}!` : '';

        return {
          content: [{
            type: 'text',
            text: [
              `Crafted: ${item.name} (${item_type}, ${rarity}) [ID: ${item.id}]`,
              `Cost: ${cost}g | Value: ${craftedValue}g${statsStr}`,
              `+${xpResult.xp} XP${levelUpNote}`,
              `Gold remaining: ${player.gold - cost}g`,
            ].join('\n'),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
