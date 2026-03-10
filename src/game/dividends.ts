import { addRevenue, getSharePrice } from '../models/company.js';
import type { Company } from '../types/index.js';

/**
 * Process revenue for a company (e.g., from mail fees, exchange fees, etc.)
 * This increments the company's accumulated revenue which will be
 * distributed as dividends.
 */
export function processCompanyRevenue(companyId: number, amount: number): void {
  if (amount <= 0) return;
  addRevenue(companyId, amount);
}

/**
 * Estimate annual dividend yield based on current revenue rate and share price.
 * Uses revenue_accumulated as a proxy for recent revenue.
 * Returns a decimal (e.g., 0.05 for 5% yield).
 */
export function calculateDividendYield(company: Company): number {
  const sharePrice = getSharePrice(company.id);
  if (sharePrice <= 0 || company.total_shares <= 0) return 0;

  // Estimate: if current accumulated revenue were distributed,
  // what would the per-share payout be relative to share price?
  const dividendPool = company.revenue_accumulated * company.dividend_rate;
  const perShare = dividendPool / company.total_shares;

  if (perShare <= 0) return 0;
  return perShare / sharePrice;
}
