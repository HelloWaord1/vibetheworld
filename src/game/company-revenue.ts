/**
 * Routes service fees to their respective stock market companies.
 * Zero-emission model: no gold is created, only redistributed.
 */

import { getDb } from '../db/connection.js';

/** Company tickers for revenue routing */
const COMPANY_TICKERS = {
  MAIL: 'MAIL',
  EXCHANGE: 'EXCH',
  BANK: 'WBNK',
  TELEPORT: 'TELE',
} as const;

/** Add revenue to a company by ticker. Silently skips if company doesn't exist yet. */
export function addCompanyRevenue(ticker: string, amount: number): void {
  if (amount <= 0) return;
  const db = getDb();
  db.prepare(
    'UPDATE companies SET revenue_accumulated = revenue_accumulated + ? WHERE ticker = ?'
  ).run(amount, ticker);
}

/** Route mail delivery fee to Imperial Mail Co. */
export function routeMailRevenue(amount: number): void {
  addCompanyRevenue(COMPANY_TICKERS.MAIL, amount);
}

/** Route marketplace/trading fees to Grand Exchange Corp. */
export function routeExchangeRevenue(amount: number): void {
  addCompanyRevenue(COMPANY_TICKERS.EXCHANGE, amount);
}

/** Route bank interest income to World Reserve Bank Corp. */
export function routeBankRevenue(amount: number): void {
  addCompanyRevenue(COMPANY_TICKERS.BANK, amount);
}

/** Route teleport fees to Nexus Teleport Guild. */
export function routeTeleportRevenue(amount: number): void {
  addCompanyRevenue(COMPANY_TICKERS.TELEPORT, amount);
}

/** Mail delivery fee constant */
export const MAIL_DELIVERY_FEE = 5;

/** Stock trade commission rate (1% of trade value) */
export const STOCK_TRADE_COMMISSION_RATE = 0.01;
