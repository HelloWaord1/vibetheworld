import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate } from '../server/auth.js';
import { enforceCooldown, COOLDOWNS } from '../server/cooldown.js';
import { getDb } from '../db/connection.js';
import { logEvent } from '../models/event-log.js';
import {
  getWorldBank, getNationalBank, createNationalBank,
  getLocalBank, createLocalBank, setLocalBankRates,
  getPlayerBankAccount, deposit, withdraw, getLocalBanksInChunk,
} from '../models/bank.js';
import {
  takeLoan, repayLoan, getPlayerLoans, getLoanById,
  calculateInterestDue, encodeNcbId, getBankLoansIssued,
} from '../models/loan.js';
import { getChunk } from '../models/chunk.js';
import { getLocationById } from '../models/location.js';
import { getPlayerShares } from '../models/share.js';
import { getSharePrice } from '../models/company.js';
import {
  NCB_CREATION_COST, NCB_INITIAL_LOAN, LOCAL_BANK_CREATION_COST,
  LOCAL_BANK_INITIAL_LOAN, MAX_PLAYER_LOANS, MAX_GOLD,
} from '../types/index.js';

export function registerBankTools(server: McpServer): void {
  registerWorldBankInfo(server);
  registerOpenNationalBank(server);
  registerOpenLocalBank(server);
  registerBankDeposit(server);
  registerBankWithdraw(server);
  registerTakeLoan(server);
  registerRepayLoan(server);
  registerMyFinances(server);
  registerBankInfo(server);
  registerListBanks(server);
  registerSetBankRates(server);
}


function registerListBanks(server: McpServer): void {
  server.tool(
    'list_banks',
    'List all banks in your current chunk. Shows local banks, NCB if present, and WRB summary.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'list_banks', 5000);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const db = getDb();
        const lines: string[] = ['=== Banking Directory ===', ''];

        // World Reserve Bank summary
        const wb = getWorldBank();
        lines.push('--- World Reserve Bank ---');
        lines.push(`Federal Rate: ${(wb.federal_rate * 100).toFixed(1)}%`);
        lines.push(`Total Reserves: ${wb.reserves}g`);
        lines.push('');

        // National Central Bank in current chunk
        const ncb = getNationalBank(player.chunk_x, player.chunk_y);
        if (ncb) {
          const ruler = db.prepare('SELECT name FROM players WHERE id = ?').get(ncb.ruler_id) as { name: string } | undefined;
          const ncbLendingRate = wb.federal_rate + ncb.markup;
          lines.push('--- National Central Bank (This Chunk) ---');
          lines.push(`Ruler: ${ruler?.name ?? 'Unknown'}`);
          lines.push(`Reserves: ${ncb.reserves}g`);
          lines.push(`Lending Rate: ${(ncbLendingRate * 100).toFixed(1)}%`);
          lines.push(`Total Deposits: ${ncb.total_deposits}g`);
          lines.push(`Total Lent: ${ncb.total_lent}g`);
          lines.push('');
        } else {
          lines.push('--- National Central Bank ---');
          lines.push('No NCB in this chunk.');
          lines.push('');
        }

        // Local banks in current chunk
        const localBanks = getLocalBanksInChunk(player.chunk_x, player.chunk_y);
        if (localBanks.length > 0) {
          lines.push('--- Local Banks (This Chunk) ---');
          for (const bank of localBanks) {
            const owner = db.prepare('SELECT name FROM players WHERE id = ?').get(bank.owner_id) as { name: string } | undefined;
            const location = db.prepare('SELECT name FROM locations WHERE id = ?').get(bank.location_id) as { name: string } | undefined;
            lines.push(`Bank #${bank.id}: ${bank.name}`);
            lines.push(`  Owner: ${owner?.name ?? 'Unknown'}`);
            lines.push(`  Location: ${location?.name ?? 'Unknown'} (${bank.chunk_x}, ${bank.chunk_y})`);
            lines.push(`  Deposit Rate: ${(bank.deposit_rate * 100).toFixed(1)}%`);
            lines.push(`  Lending Rate: ${(bank.lending_rate * 100).toFixed(1)}%`);
            lines.push(`  Reserves: ${bank.reserves}g`);
            lines.push('');
          }
        } else {
          lines.push('--- Local Banks ---');
          lines.push('No local banks in this chunk.');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerWorldBankInfo(server: McpServer): void {
  server.tool(
    'world_bank_info',
    'View the World Reserve Bank status: federal rate, reserves, total lent, number of NCBs.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'world_bank_info', COOLDOWNS.BANK_VIEW);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const wb = getWorldBank();
        const db = getDb();
        const ncbCount = (db.prepare('SELECT COUNT(*) as c FROM national_banks').get() as { c: number }).c;

        const text = [
          `=== World Reserve Bank ===`,
          `Federal Rate: ${(wb.federal_rate * 100).toFixed(1)}%`,
          `Reserves: ${wb.reserves}g`,
          `Total Lent: ${wb.total_lent}g`,
          `Revenue Accumulated: ${wb.revenue_accumulated}g`,
          `National Central Banks: ${ncbCount}`,
          `Last Rate Change: ${wb.last_rate_change}`,
        ].join('\n');

        return { content: [{ type: 'text' as const, text }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerOpenNationalBank(server: McpServer): void {
  server.tool(
    'open_national_bank',
    'Chunk ruler creates a National Central Bank for their territory. Costs 1000g. Borrows 10,000g from WRB.',
    {
      token: z.string().uuid().describe('Your auth token'),
      markup: z.number().min(0.01).max(0.15).describe('NCB markup rate (0.01-0.15)'),
    },
    async ({ token, markup }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'open_national_bank', COOLDOWNS.OPEN_BANK);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const chunk = getChunk(player.chunk_x, player.chunk_y);
        if (!chunk) return { content: [{ type: 'text' as const, text: 'You are not in a valid chunk.' }] };
        if (chunk.ruler_id !== player.id) {
          return { content: [{ type: 'text' as const, text: 'Only the chunk ruler can open a National Central Bank.' }] };
        }

        const existing = getNationalBank(player.chunk_x, player.chunk_y);
        if (existing) {
          return { content: [{ type: 'text' as const, text: 'A National Central Bank already exists in this chunk.' }] };
        }

        if (player.gold < NCB_CREATION_COST) {
          return { content: [{ type: 'text' as const, text: `You need ${NCB_CREATION_COST}g to open an NCB. You have ${player.gold}g.` }] };
        }

        const db = getDb();
        const ncb = db.transaction(() => {
          // Deduct creation cost → flows to WRB (zero-emission)
          db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(NCB_CREATION_COST, player.id);
          db.prepare('UPDATE world_bank SET reserves = reserves + ? WHERE id = 1').run(NCB_CREATION_COST);

          // Create NCB with custom markup
          const newNcb = createNationalBank(player.chunk_x, player.chunk_y, player.id);
          db.prepare('UPDATE national_banks SET markup = ? WHERE chunk_x = ? AND chunk_y = ?')
            .run(markup, player.chunk_x, player.chunk_y);

          // Borrow initial funds from WRB
          const wb = getWorldBank();
          const ncbId = encodeNcbId(player.chunk_x, player.chunk_y);
          takeLoan('national_bank', ncbId, 'world_bank', 1, NCB_INITIAL_LOAN, wb.federal_rate, 30);

          return { ...newNcb, markup };
        })();

        logEvent('ncb_opened', player.id, null, player.chunk_x, player.chunk_y, player.location_id, {
          markup, initial_loan: NCB_INITIAL_LOAN,
        });

        const wb = getWorldBank();
        const lendingRate = ((wb.federal_rate + markup) * 100).toFixed(1);

        return {
          content: [{
            type: 'text' as const,
            text: [
              `National Central Bank opened in ${chunk.name}!`,
              `Creation cost: ${NCB_CREATION_COST}g`,
              `Initial loan from WRB: ${NCB_INITIAL_LOAN}g at ${(wb.federal_rate * 100).toFixed(1)}%`,
              `NCB Markup: ${(markup * 100).toFixed(1)}%`,
              `Lending rate to local banks: ${lendingRate}%`,
              `Reserves: ${NCB_INITIAL_LOAN}g`,
            ].join('\n'),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerOpenLocalBank(server: McpServer): void {
  server.tool(
    'open_local_bank',
    'Open a local bank at your current location. Must be in a chunk with NCB. Costs 500g.',
    {
      token: z.string().uuid().describe('Your auth token'),
      name: z.string().min(3).max(30).describe('Bank name (3-30 characters)'),
      deposit_rate: z.number().min(0.01).max(0.10).describe('Interest paid to depositors (0.01-0.10)'),
      lending_rate: z.number().min(0.05).max(0.25).describe('Interest charged on loans (0.05-0.25)'),
    },
    async ({ token, name, deposit_rate, lending_rate }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'open_local_bank', COOLDOWNS.OPEN_BANK);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        if (!player.location_id) {
          return { content: [{ type: 'text' as const, text: 'You must be at a location to open a bank.' }] };
        }

        const location = getLocationById(player.location_id);
        if (!location) return { content: [{ type: 'text' as const, text: 'Location not found.' }] };
        if (location.created_by !== player.id) {
          return { content: [{ type: 'text' as const, text: 'You can only open a bank at a location you created.' }] };
        }

        const ncb = getNationalBank(player.chunk_x, player.chunk_y);
        if (!ncb) {
          return { content: [{ type: 'text' as const, text: 'No National Central Bank exists in this chunk. The chunk ruler must open one first.' }] };
        }

        const wb = getWorldBank();
        const ncbLendingRate = wb.federal_rate + ncb.markup;
        if (lending_rate < ncbLendingRate) {
          return {
            content: [{
              type: 'text' as const,
              text: `Lending rate must be >= NCB lending rate of ${(ncbLendingRate * 100).toFixed(1)}%.`,
            }],
          };
        }

        if (player.gold < LOCAL_BANK_CREATION_COST) {
          return { content: [{ type: 'text' as const, text: `You need ${LOCAL_BANK_CREATION_COST}g. You have ${player.gold}g.` }] };
        }

        const db = getDb();
        const bank = db.transaction(() => {
          // Creation cost → flows to WRB (zero-emission)
          db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(LOCAL_BANK_CREATION_COST, player.id);
          db.prepare('UPDATE world_bank SET reserves = reserves + ? WHERE id = 1').run(LOCAL_BANK_CREATION_COST);

          const newBank = createLocalBank(player.id, player.location_id!, player.chunk_x, player.chunk_y, name);
          db.prepare('UPDATE local_banks SET deposit_rate = ?, lending_rate = ? WHERE id = ?')
            .run(deposit_rate, lending_rate, newBank.id);

          // Borrow initial funds from NCB
          const ncbId = encodeNcbId(player.chunk_x, player.chunk_y);
          takeLoan('local_bank', newBank.id, 'national_bank', ncbId, LOCAL_BANK_INITIAL_LOAN, ncbLendingRate, 30);

          return { ...newBank, deposit_rate, lending_rate };
        })();

        logEvent('local_bank_opened', player.id, null, player.chunk_x, player.chunk_y, player.location_id, {
          bank_id: bank.id, name, deposit_rate, lending_rate,
        });

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Local bank "${name}" opened!`,
              `Bank ID: ${bank.id}`,
              `Location: ${location.name}`,
              `Creation cost: ${LOCAL_BANK_CREATION_COST}g`,
              `Initial loan from NCB: ${LOCAL_BANK_INITIAL_LOAN}g at ${(ncbLendingRate * 100).toFixed(1)}%`,
              `Deposit rate: ${(deposit_rate * 100).toFixed(1)}%`,
              `Lending rate: ${(lending_rate * 100).toFixed(1)}%`,
              `Reserves: ${LOCAL_BANK_INITIAL_LOAN}g`,
            ].join('\n'),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerBankDeposit(server: McpServer): void {
  server.tool(
    'bank_deposit',
    'Deposit gold into a local bank. Must be at the same location.',
    {
      token: z.string().uuid().describe('Your auth token'),
      bank_id: z.number().int().describe('Local bank ID'),
      amount: z.number().int().min(1).max(1000000).describe('Gold to deposit'),
    },
    async ({ token, bank_id, amount }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'bank_deposit', COOLDOWNS.BANK_DEPOSIT);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const bank = getLocalBank(bank_id);
        if (!bank) return { content: [{ type: 'text' as const, text: 'Bank not found.' }] };
        if (player.location_id !== bank.location_id) {
          return { content: [{ type: 'text' as const, text: 'You must be at the bank\'s location to deposit.' }] };
        }

        const account = deposit(player.id, bank_id, amount);

        logEvent('bank_deposit', player.id, null, player.chunk_x, player.chunk_y, player.location_id, {
          bank_id, amount,
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Deposited ${amount}g into ${bank.name}. Account balance: ${account.balance}g.`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerBankWithdraw(server: McpServer): void {
  server.tool(
    'bank_withdraw',
    'Withdraw gold from a local bank. Bank must have reserves.',
    {
      token: z.string().uuid().describe('Your auth token'),
      bank_id: z.number().int().describe('Local bank ID'),
      amount: z.number().int().min(1).max(1000000).describe('Gold to withdraw'),
    },
    async ({ token, bank_id, amount }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'bank_withdraw', COOLDOWNS.BANK_WITHDRAW);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const bank = getLocalBank(bank_id);
        if (!bank) return { content: [{ type: 'text' as const, text: 'Bank not found.' }] };
        if (player.location_id !== bank.location_id) {
          return { content: [{ type: 'text' as const, text: 'You must be at the bank\'s location to withdraw.' }] };
        }

        const account = withdraw(player.id, bank_id, amount);

        logEvent('bank_withdraw', player.id, null, player.chunk_x, player.chunk_y, player.location_id, {
          bank_id, amount,
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Withdrew ${amount}g from ${bank.name}. Account balance: ${account.balance}g.`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerTakeLoan(server: McpServer): void {
  server.tool(
    'take_loan',
    'Borrow gold from a local bank. Interest charged at the bank\'s lending rate. Max 3 active loans.',
    {
      token: z.string().uuid().describe('Your auth token'),
      bank_id: z.number().int().describe('Local bank ID'),
      amount: z.number().int().min(100).max(100000).describe('Gold to borrow'),
      term_days: z.number().int().min(1).max(30).describe('Loan term in days'),
    },
    async ({ token, bank_id, amount, term_days }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'take_loan', COOLDOWNS.TAKE_LOAN);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const bank = getLocalBank(bank_id);
        if (!bank) return { content: [{ type: 'text' as const, text: 'Bank not found.' }] };

        // Check max active loans
        const activeLoans = getPlayerLoans(player.id).filter(l => l.status === 'active');
        if (activeLoans.length >= MAX_PLAYER_LOANS) {
          return { content: [{ type: 'text' as const, text: `You already have ${MAX_PLAYER_LOANS} active loans (max).` }] };
        }

        const loan = takeLoan('player', player.id, 'local_bank', bank_id, amount, bank.lending_rate, term_days);

        logEvent('loan_taken', player.id, null, player.chunk_x, player.chunk_y, player.location_id, {
          loan_id: loan.id, bank_id, amount, rate: bank.lending_rate, term_days,
        });

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Loan approved! Loan #${loan.id}`,
              `Amount: ${amount}g from ${bank.name}`,
              `Interest rate: ${(bank.lending_rate * 100).toFixed(1)}%`,
              `Term: ${term_days} days`,
              `Gold credited to your wallet.`,
            ].join('\n'),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerRepayLoan(server: McpServer): void {
  server.tool(
    'repay_loan',
    'Make a payment on an active loan. Interest is paid first, then principal.',
    {
      token: z.string().uuid().describe('Your auth token'),
      loan_id: z.number().int().describe('Loan ID'),
      amount: z.number().int().min(1).max(1000000).describe('Gold to pay'),
    },
    async ({ token, loan_id, amount }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'repay_loan', COOLDOWNS.REPAY_LOAN);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const loan = getLoanById(loan_id);
        if (!loan) return { content: [{ type: 'text' as const, text: 'Loan not found.' }] };

        const result = repayLoan(loan_id, amount, player.id);

        logEvent('loan_repaid', player.id, null, player.chunk_x, player.chunk_y, player.location_id, {
          loan_id, amount, interest_paid: result.interestPaid, principal_paid: result.principalPaid,
        });

        const status = result.remaining <= 0 ? 'PAID IN FULL!' : `Remaining: ${result.remaining}g`;

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Loan #${loan_id} payment processed.`,
              `Interest paid: ${result.interestPaid}g`,
              `Principal paid: ${result.principalPaid}g`,
              status,
            ].join('\n'),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerMyFinances(server: McpServer): void {
  server.tool(
    'my_finances',
    'View your bank accounts, active loans, and total net worth.',
    { token: z.string().uuid().describe('Your auth token') },
    async ({ token }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'my_finances', COOLDOWNS.BANK_VIEW);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const db = getDb();
        const accounts = db.prepare(
          `SELECT ba.*, lb.name as bank_name, lb.deposit_rate
           FROM bank_accounts ba
           JOIN local_banks lb ON ba.bank_id = lb.id
           WHERE ba.player_id = ?`
        ).all(player.id) as Array<{
          id: number; balance: number; interest_accrued: number;
          bank_name: string; deposit_rate: number; bank_id: number;
        }>;

        const loans = getPlayerLoans(player.id).filter(l => l.status === 'active');

        const lines: string[] = [`=== Your Finances ===`, `Gold on hand: ${player.gold}g`, ''];

        let totalDeposits = 0;
        if (accounts.length > 0) {
          lines.push('--- Bank Accounts ---');
          for (const acc of accounts) {
            totalDeposits += acc.balance;
            lines.push(
              `  ${acc.bank_name} (Bank #${acc.bank_id}): ${acc.balance}g (interest earned: ${acc.interest_accrued}g, rate: ${(acc.deposit_rate * 100).toFixed(1)}%)`
            );
          }
          lines.push('');
        }

        let totalOwed = 0;
        if (loans.length > 0) {
          lines.push('--- Active Loans ---');
          for (const loan of loans) {
            const interestDue = calculateInterestDue(loan);
            totalOwed += loan.balance_remaining + interestDue;
            lines.push(
              `  Loan #${loan.id}: ${loan.balance_remaining}g remaining (${(loan.interest_rate * 100).toFixed(1)}%, interest due: ${interestDue}g, term: ${loan.term_days}d)`
            );
          }
          lines.push('');
        }

        // Stock portfolio value
        const holdings = getPlayerShares(player.id);
        let stockPortfolioValue = 0;
        let totalShareCount = 0;
        if (holdings.length > 0) {
          lines.push('--- Stock Portfolio ---');
          for (const holding of holdings) {
            const currentPrice = getSharePrice(holding.company_id);
            const holdingValue = holding.quantity * currentPrice;
            stockPortfolioValue += holdingValue;
            totalShareCount += holding.quantity;
            lines.push(
              `  ${holding.ticker}: ${holding.quantity} shares @ ${currentPrice}g = ${holdingValue}g (avg cost: ${Math.floor(holding.avg_purchase_price)}g)`
            );
          }
          lines.push(`  Total: ${stockPortfolioValue}g (${totalShareCount} shares across ${holdings.length} companies)`);
          lines.push('');
        }

        const netWorth = player.gold + totalDeposits + stockPortfolioValue - totalOwed;
        lines.push(`Stock portfolio: ${stockPortfolioValue}g (${totalShareCount} shares across ${holdings.length} companies)`);
        lines.push(`Net worth: ${netWorth}g (gold: ${player.gold}g + deposits: ${totalDeposits}g + stocks: ${stockPortfolioValue}g - owed: ${totalOwed}g)`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerBankInfo(server: McpServer): void {
  server.tool(
    'bank_info',
    'View details of a local bank: name, owner, rates, deposits, reserves, loans.',
    {
      token: z.string().uuid().describe('Your auth token'),
      bank_id: z.number().int().describe('Local bank ID'),
    },
    async ({ token, bank_id }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'bank_info', COOLDOWNS.BANK_VIEW);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const bank = getLocalBank(bank_id);
        if (!bank) return { content: [{ type: 'text' as const, text: 'Bank not found.' }] };

        const db = getDb();
        const owner = db.prepare('SELECT name FROM players WHERE id = ?').get(bank.owner_id) as { name: string } | undefined;
        const activeLoans = getBankLoansIssued('local_bank', bank_id).filter(l => l.status === 'active');
        const totalLoanBalance = activeLoans.reduce((sum, l) => sum + l.balance_remaining, 0);
        const accountCount = (db.prepare('SELECT COUNT(*) as c FROM bank_accounts WHERE bank_id = ?').get(bank_id) as { c: number }).c;

        const location = getLocationById(bank.location_id);

        const text = [
          `=== ${bank.name} ===`,
          `Bank ID: ${bank.id}`,
          `Owner: ${owner?.name ?? 'Unknown'}`,
          `Location: ${location?.name ?? 'Unknown'} (${bank.chunk_x}, ${bank.chunk_y})`,
          `Deposit rate: ${(bank.deposit_rate * 100).toFixed(1)}%`,
          `Lending rate: ${(bank.lending_rate * 100).toFixed(1)}%`,
          `Reserves: ${bank.reserves}g`,
          `Total deposits: ${bank.total_deposits}g`,
          `Active loans: ${activeLoans.length} (${totalLoanBalance}g outstanding)`,
          `Depositor accounts: ${accountCount}`,
        ].join('\n');

        return { content: [{ type: 'text' as const, text }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}

function registerSetBankRates(server: McpServer): void {
  server.tool(
    'set_bank_rates',
    'Change your bank\'s deposit and lending rates. Lending rate must be >= NCB rate.',
    {
      token: z.string().uuid().describe('Your auth token'),
      bank_id: z.number().int().describe('Your bank ID'),
      deposit_rate: z.number().min(0.01).max(0.10).describe('New deposit rate'),
      lending_rate: z.number().min(0.05).max(0.25).describe('New lending rate'),
    },
    async ({ token, bank_id, deposit_rate, lending_rate }) => {
      try {
        const player = authenticate(token);
        const cd = enforceCooldown(player.id, 'set_bank_rates', COOLDOWNS.SET_BANK_RATES);
        if (cd !== null) return { content: [{ type: 'text' as const, text: `Please wait ${cd}s.` }] };

        const bank = getLocalBank(bank_id);
        if (!bank) return { content: [{ type: 'text' as const, text: 'Bank not found.' }] };
        if (bank.owner_id !== player.id) {
          return { content: [{ type: 'text' as const, text: 'You do not own this bank.' }] };
        }

        const ncb = getNationalBank(bank.chunk_x, bank.chunk_y);
        if (!ncb) return { content: [{ type: 'text' as const, text: 'NCB not found for this chunk.' }] };

        const wb = getWorldBank();
        const ncbLendingRate = wb.federal_rate + ncb.markup;
        if (lending_rate < ncbLendingRate) {
          return {
            content: [{
              type: 'text' as const,
              text: `Lending rate must be >= NCB lending rate of ${(ncbLendingRate * 100).toFixed(1)}%.`,
            }],
          };
        }

        setLocalBankRates(bank_id, player.id, deposit_rate, lending_rate);

        return {
          content: [{
            type: 'text' as const,
            text: `Bank rates updated.\nDeposit rate: ${(deposit_rate * 100).toFixed(1)}%\nLending rate: ${(lending_rate * 100).toFixed(1)}%`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: e.message }] };
      }
    }
  );
}
