import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { enforceCooldown, COOLDOWNS } from '../server/cooldown.js';
import { getCompanies, getCompanyByTicker, getSharePrice, tryDistributeDividends } from '../models/company.js';
import { routeExchangeRevenue, STOCK_TRADE_COMMISSION_RATE } from '../game/company-revenue.js';
import {
  getPlayerShares,
  getPlayerSharesForCompany,
  getOrderBook,
  placeBuyOrder,
  placeSellOrder,
  cancelOrder,
  getPlayerOrders,
  getUnclaimedDividends,
  claimDividends,
} from '../models/share.js';
import { calculateDividendYield } from '../game/dividends.js';
import { getDb } from '../db/connection.js';
import {
  MAX_SHARES_PER_ORDER,
  MIN_SHARE_PRICE,
  MAX_SHARE_PRICE,
} from '../types/index.js';

export function registerStockTools(server: McpServer): void {

  // --- stock_market ---
  server.tool(
    'stock_market',
    'View all publicly traded companies with share prices, total shares, and dividend yields.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'stock_market', COOLDOWNS.STOCK_VIEW);
        if (cd !== null) {
          return { content: [{ type: 'text' as const, text: `Please wait ${cd}s before checking the stock market again.` }] };
        }

        const companies = getCompanies();
        if (companies.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No companies are listed on the exchange yet.' }] };
        }

        const lines = companies.map(c => {
          const price = getSharePrice(c.id);
          const yieldPct = (calculateDividendYield(c) * 100).toFixed(1);
          return `${c.ticker} | ${c.name} | Price: ${price}g | Shares: ${c.total_shares} | Yield: ${yieldPct}%`;
        });

        const text = `--- Stock Market ---\n${lines.join('\n')}\n\nUse company_info <ticker> for details. Use buy_shares / sell_shares to trade.`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- company_info ---
  server.tool(
    'company_info',
    'View detailed information about a company including order book summary.',
    {
      token: z.string().uuid().describe('Your auth token'),
      ticker: z.string().min(1).max(10).describe('Company ticker symbol (e.g. MAIL)'),
    },
    async ({ token, ticker }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'company_info', COOLDOWNS.STOCK_VIEW);
        if (cd !== null) {
          return { content: [{ type: 'text' as const, text: `Please wait ${cd}s before checking company info again.` }] };
        }

        const company = getCompanyByTicker(ticker);
        if (!company) {
          return { content: [{ type: 'text' as const, text: `No company found with ticker "${ticker.toUpperCase()}".` }] };
        }

        const price = getSharePrice(company.id);
        const yieldPct = (calculateDividendYield(company) * 100).toFixed(1);
        const book = getOrderBook(company.id, 5);

        const bidSummary = book.bids.length > 0
          ? book.bids.map(b => `  ${b.quantity - b.filled_quantity}x @ ${b.price_per_share}g`).join('\n')
          : '  No bids';
        const askSummary = book.asks.length > 0
          ? book.asks.map(a => `  ${a.quantity - a.filled_quantity}x @ ${a.price_per_share}g`).join('\n')
          : '  No asks';

        const text = [
          `--- ${company.name} (${company.ticker}) ---`,
          company.description,
          `Type: ${company.company_type}`,
          `Share Price: ${price}g | IPO Price: ${company.ipo_price}g`,
          `Total Shares: ${company.total_shares} | IPO Sold: ${company.shares_outstanding ?? 0}/${company.total_shares}`,
          `Dividend Rate: ${(company.dividend_rate * 100).toFixed(0)}% of revenue`,
          `Revenue Accumulated: ${company.revenue_accumulated}g`,
          `Estimated Yield: ${yieldPct}%`,
          `Last Dividend: ${company.last_dividend_at ?? 'Never'}`,
          '',
          'Order Book (top 5):',
          'Bids (buy orders):',
          bidSummary,
          'Asks (sell orders):',
          askSummary,
        ].join('\n');

        return { content: [{ type: 'text' as const, text }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- buy_shares ---
  server.tool(
    'buy_shares',
    'Place a limit buy order for company shares. Gold is deducted upfront; difference refunded if filled at lower price.',
    {
      token: z.string().uuid().describe('Your auth token'),
      ticker: z.string().min(1).max(10).describe('Company ticker symbol'),
      quantity: z.number().int().min(1).max(MAX_SHARES_PER_ORDER).describe('Number of shares to buy (1-1000)'),
      max_price: z.number().int().min(MIN_SHARE_PRICE).max(MAX_SHARE_PRICE).describe('Maximum price per share in gold'),
    },
    async ({ token, ticker, quantity, max_price }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'stock_trade', COOLDOWNS.STOCK_TRADE);
        if (cd !== null) {
          return { content: [{ type: 'text' as const, text: `Please wait ${cd}s before placing another trade.` }] };
        }

        const company = getCompanyByTicker(ticker);
        if (!company) {
          return { content: [{ type: 'text' as const, text: `No company found with ticker "${ticker.toUpperCase()}".` }] };
        }

        const commission = Math.max(1, Math.floor(quantity * max_price * STOCK_TRADE_COMMISSION_RATE));
        const totalCost = quantity * max_price + commission;
        if (player.gold < totalCost) {
          return { content: [{ type: 'text' as const, text: `Insufficient gold. Need ${quantity * max_price}g + ${commission}g commission = ${totalCost}g. You have ${player.gold}g.` }] };
        }

        // Deduct gold + commission upfront
        const db = getDb();
        db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(totalCost, player.id);
        // Commission → Grand Exchange Corp revenue
        routeExchangeRevenue(commission);

        const result = placeBuyOrder(player.id, company.id, quantity, max_price);

        const price = getSharePrice(company.id);
        const statusText = result.filled >= quantity
          ? `Fully filled! Bought ${result.filled} shares.`
          : result.filled > 0
            ? `Partially filled: ${result.filled}/${quantity} shares. Remaining order #${result.orderId} is open.`
            : `Order #${result.orderId} placed. Waiting for sellers at ${max_price}g or less.`;

        return { content: [{ type: 'text' as const, text: `Buy ${company.ticker}: ${statusText} (commission: ${commission}g)\nCurrent price: ${price}g` }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- sell_shares ---
  server.tool(
    'sell_shares',
    'Place a limit sell order for company shares. Shares are reserved until the order fills or is cancelled.',
    {
      token: z.string().uuid().describe('Your auth token'),
      ticker: z.string().min(1).max(10).describe('Company ticker symbol'),
      quantity: z.number().int().min(1).max(MAX_SHARES_PER_ORDER).describe('Number of shares to sell (1-1000)'),
      min_price: z.number().int().min(MIN_SHARE_PRICE).max(MAX_SHARE_PRICE).describe('Minimum price per share in gold'),
    },
    async ({ token, ticker, quantity, min_price }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'stock_trade', COOLDOWNS.STOCK_TRADE);
        if (cd !== null) {
          return { content: [{ type: 'text' as const, text: `Please wait ${cd}s before placing another trade.` }] };
        }

        const company = getCompanyByTicker(ticker);
        if (!company) {
          return { content: [{ type: 'text' as const, text: `No company found with ticker "${ticker.toUpperCase()}".` }] };
        }

        const held = getPlayerSharesForCompany(player.id, company.id);
        if (held < quantity) {
          return { content: [{ type: 'text' as const, text: `Insufficient shares. You hold ${held} ${company.ticker} shares but tried to sell ${quantity}.` }] };
        }

        const result = placeSellOrder(player.id, company.id, quantity, min_price);

        const price = getSharePrice(company.id);
        const statusText = result.filled >= quantity
          ? `Fully filled! Sold ${result.filled} shares.`
          : result.filled > 0
            ? `Partially filled: ${result.filled}/${quantity} shares. Remaining order #${result.orderId} is open.`
            : `Order #${result.orderId} placed. Waiting for buyers at ${min_price}g or more.`;

        return { content: [{ type: 'text' as const, text: `Sell ${company.ticker}: ${statusText}\nCurrent price: ${price}g` }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- my_portfolio ---
  server.tool(
    'my_portfolio',
    'View your share holdings, unrealized P&L, and pending orders.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'my_portfolio', COOLDOWNS.STOCK_VIEW);
        if (cd !== null) {
          return { content: [{ type: 'text' as const, text: `Please wait ${cd}s before checking your portfolio again.` }] };
        }

        const holdings = getPlayerShares(player.id);
        const orders = getPlayerOrders(player.id);
        const unclaimed = getUnclaimedDividends(player.id);

        const holdingLines = holdings.length > 0
          ? holdings.map(h => {
              const currentPrice = getSharePrice(h.company_id);
              const pnl = (currentPrice - h.avg_purchase_price) * h.quantity;
              const pnlStr = pnl >= 0 ? `+${pnl.toFixed(0)}g` : `${pnl.toFixed(0)}g`;
              return `  ${h.ticker} | ${h.quantity} shares | Avg: ${h.avg_purchase_price.toFixed(1)}g | Now: ${currentPrice}g | P&L: ${pnlStr}`;
            }).join('\n')
          : '  No shares held.';

        const orderLines = orders.length > 0
          ? orders.map(o => {
              const remaining = o.quantity - o.filled_quantity;
              return `  #${o.id} ${o.order_type.toUpperCase()} ${remaining}x @ ${o.price_per_share}g (${o.status})`;
            }).join('\n')
          : '  No pending orders.';

        const dividendLines = unclaimed.length > 0
          ? unclaimed.map(d => `  ${d.ticker}: ${d.amount}g`).join('\n')
          : '  None';

        const text = [
          '--- Your Portfolio ---',
          'Holdings:',
          holdingLines,
          '',
          'Pending Orders:',
          orderLines,
          '',
          'Unclaimed Dividends:',
          dividendLines,
        ].join('\n');

        return { content: [{ type: 'text' as const, text }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- cancel_order ---
  server.tool(
    'cancel_order',
    'Cancel an open or partially filled share order. Unfilled gold or shares are refunded.',
    {
      token: z.string().uuid().describe('Your auth token'),
      order_id: z.number().int().describe('The order ID to cancel'),
    },
    async ({ token, order_id }) => {
      try {
        const player = authenticate(token);

        const success = cancelOrder(order_id, player.id);
        if (!success) {
          return { content: [{ type: 'text' as const, text: `Could not cancel order #${order_id}. It may not exist, not be yours, or already be filled/cancelled.` }] };
        }

        return { content: [{ type: 'text' as const, text: `Order #${order_id} cancelled. Unfilled portion has been refunded.` }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- claim_dividends ---
  server.tool(
    'claim_dividends',
    'Claim all pending dividend payouts as gold.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'claim_dividends', COOLDOWNS.DIVIDEND_CLAIM);
        if (cd !== null) {
          return { content: [{ type: 'text' as const, text: `Please wait ${cd}s before claiming dividends again.` }] };
        }

        // Trigger dividend distributions for companies with accumulated revenue
        tryDistributeDividends();
        const totalGold = claimDividends(player.id);
        if (totalGold <= 0) {
          return { content: [{ type: 'text' as const, text: 'No unclaimed dividends available.' }] };
        }

        return { content: [{ type: 'text' as const, text: `Claimed ${totalGold}g in dividends!` }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );

  // --- order_history ---
  server.tool(
    'order_history',
    'View your completed and cancelled share orders.',
    {
      token: z.string().uuid().describe('Your auth token'),
    },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'order_history', COOLDOWNS.STOCK_VIEW);
        if (cd !== null) {
          return { content: [{ type: 'text' as const, text: `Please wait ${cd}s before viewing order history again.` }] };
        }

        const db = getDb();
        const orders = db.prepare(`
          SELECT so.id, c.ticker, so.order_type, so.quantity, so.price_per_share,
                 so.filled_quantity, so.status, so.created_at
          FROM share_orders so
          JOIN companies c ON c.id = so.company_id
          WHERE so.player_id = ? AND so.status IN ('filled', 'cancelled')
          ORDER BY so.created_at DESC
          LIMIT 20
        `).all(player.id) as Array<{
          id: number; ticker: string; order_type: string; quantity: number;
          price_per_share: number; filled_quantity: number; status: string; created_at: string;
        }>;

        if (orders.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No completed or cancelled orders yet.' }] };
        }

        const lines = orders.map(o => {
          const typeStr = o.order_type.toUpperCase();
          return `#${o.id} | ${o.ticker} ${typeStr} ${o.quantity}x @ ${o.price_per_share}g | Filled: ${o.filled_quantity}/${o.quantity} | ${o.status} | ${o.created_at}`;
        });

        const text = `--- Order History (last 20) ---\n${lines.join('\n')}`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text' as const, text: msg }] };
      }
    }
  );
}
