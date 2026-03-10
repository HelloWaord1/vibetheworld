import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { getPool, getCurrentRate, swapGoldForUsdc, swapUsdcForGold } from '../models/liquidity-pool.js';
import { getDb } from '../db/connection.js';
import { enforceCooldown, COOLDOWNS } from '../server/cooldown.js';

export function registerExchangeTools(server: McpServer): void {
  server.tool(
    'exchange_rate',
    'View the current gold<>USDC exchange rate and pool reserves.',
    {},
    async () => {
      try {
        const pool = getPool();
        const rate = getCurrentRate();
        const goldPerUsdc = Math.floor(1 / rate);
        return {
          content: [{
            type: 'text',
            text: [
              `💱 Exchange Rate`,
              `1 USDC = ~${goldPerUsdc} gold`,
              `1 gold = ~${rate.toFixed(6)} USDC`,
              ``,
              `Pool reserves:`,
              `  Gold: ${pool.gold_reserve.toLocaleString()}`,
              `  USDC: ${pool.usdc_reserve.toLocaleString()}`,
              ``,
              `AMM fee: 0.3%`,
            ].join('\n'),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'swap_gold',
    'Exchange gold for USDC via the AMM liquidity pool. Set min_output to protect against price slippage.',
    {
      token: z.string().uuid().describe('Your auth token'),
      amount: z.number().int().positive().describe('Amount of gold to exchange'),
      min_output: z.number().int().min(0).optional().default(0).describe('Minimum USDC to receive (slippage protection). 0 = no limit.'),
    },
    async ({ token, amount, min_output }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'swap', COOLDOWNS.SWAP);
        if (cd !== null) return { content: [{ type: 'text', text: `Please wait ${cd}s before swapping again.` }] };
        const { usdcReceived, newRate } = swapGoldForUsdc(player.id, amount, player.gold, min_output);
        return {
          content: [{
            type: 'text',
            text: `💱 Swapped ${amount} gold → ${usdcReceived} USDC\nNew rate: 1 gold = ~${newRate.toFixed(6)} USDC\nYour USDC balance: ${player.usdc_balance + usdcReceived}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'swap_usdc',
    'Exchange USDC for gold via the AMM liquidity pool. Set min_output to protect against price slippage.',
    {
      token: z.string().uuid().describe('Your auth token'),
      amount: z.number().positive().describe('Amount of USDC to exchange (decimals allowed, e.g. 0.5)'),
      min_output: z.number().int().min(0).optional().default(0).describe('Minimum gold to receive (slippage protection). 0 = no limit.'),
    },
    async ({ token, amount, min_output }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'swap', COOLDOWNS.SWAP);
        if (cd !== null) return { content: [{ type: 'text', text: `Please wait ${cd}s before swapping again.` }] };
        const { goldReceived, newRate } = swapUsdcForGold(player.id, amount, player.usdc_balance, min_output);
        return {
          content: [{
            type: 'text',
            text: `💱 Swapped ${amount} USDC → ${goldReceived} gold\nNew rate: 1 gold = ~${newRate.toFixed(6)} USDC\nYour gold: ${player.gold + goldReceived}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'set_wallet',
    'Set your BSC/TRC20 wallet address for USDC withdrawals.',
    {
      token: z.string().uuid().describe('Your auth token'),
      address: z.string().describe('Your wallet address (0x... or T...)'),
    },
    async ({ token, address }) => {
      try {
        const player = authenticate(token);
        if (!address.match(/^(0x[a-fA-F0-9]{40}|T[a-zA-Z0-9]{33})$/)) {
          return { content: [{ type: 'text', text: 'Invalid wallet address. Must be BSC (0x...) or TRC20 (T...) format.' }] };
        }
        const db = getDb();
        db.prepare('UPDATE players SET wallet_address = ? WHERE id = ?').run(address, player.id);
        return { content: [{ type: 'text', text: `Wallet set to ${address}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );
}
