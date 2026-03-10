import { getDb } from '../db/connection.js';
import type { Company } from '../types/index.js';

export function getCompanies(): Company[] {
  const db = getDb();
  return db.prepare('SELECT * FROM companies ORDER BY id').all() as Company[];
}

export function getCompanyById(id: number): Company | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Company | undefined) ?? null;
}

export function getCompanyByTicker(ticker: string): Company | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker.toUpperCase()) as Company | undefined) ?? null;
}

export function addRevenue(companyId: number, amount: number): void {
  if (amount <= 0) return;
  const db = getDb();
  db.prepare(
    'UPDATE companies SET revenue_accumulated = revenue_accumulated + ? WHERE id = ?'
  ).run(amount, companyId);
}

export function distributeDividends(companyId: number): { perShare: number; totalDistributed: number } {
  const db = getDb();

  const result = db.transaction(() => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as Company | undefined;
    if (!company) throw new Error('Company not found.');
    if (company.revenue_accumulated <= 0) {
      return { perShare: 0, totalDistributed: 0 };
    }

    const dividendPool = Math.floor(company.revenue_accumulated * company.dividend_rate);
    if (dividendPool <= 0) {
      return { perShare: 0, totalDistributed: 0 };
    }

    // Get total outstanding shares held by players
    const sharesRow = db.prepare(
      'SELECT COALESCE(SUM(quantity), 0) as total FROM shares WHERE company_id = ?'
    ).get(companyId) as { total: number };

    if (sharesRow.total <= 0) {
      // No shareholders, move revenue to treasury instead
      db.prepare(
        'UPDATE companies SET treasury = treasury + ?, revenue_accumulated = 0, last_dividend_at = datetime(\'now\') WHERE id = ?'
      ).run(dividendPool, companyId);
      return { perShare: 0, totalDistributed: 0 };
    }

    const perShare = dividendPool / sharesRow.total;

    // Record dividend event
    const insertDividend = db.prepare(
      'INSERT INTO dividend_history (company_id, total_amount, per_share_amount) VALUES (?, ?, ?)'
    );
    const dividendResult = insertDividend.run(companyId, dividendPool, perShare);
    const dividendId = dividendResult.lastInsertRowid as number;

    // Create unclaimed dividend entries for each shareholder
    const shareholders = db.prepare(
      'SELECT player_id, quantity FROM shares WHERE company_id = ? AND quantity > 0'
    ).all(companyId) as Array<{ player_id: number; quantity: number }>;

    const insertClaim = db.prepare(
      'INSERT INTO dividend_claims (player_id, dividend_id, amount, claimed_at) VALUES (?, ?, ?, ?)'
    );

    let totalDistributed = 0;
    for (const holder of shareholders) {
      const amount = Math.floor(perShare * holder.quantity);
      if (amount > 0) {
        // Store unclaimed: claimed_at is NULL-like sentinel; we use a placeholder
        // Actually, dividend_claims tracks claimed dividends. We need unclaimed tracking.
        // Let's use the dividend_history + shares to compute unclaimed instead.
        totalDistributed += amount;
      }
    }

    // Reset accumulated revenue and update timestamp
    db.prepare(
      'UPDATE companies SET revenue_accumulated = revenue_accumulated - ?, last_dividend_at = datetime(\'now\') WHERE id = ?'
    ).run(dividendPool, companyId);

    return { perShare, totalDistributed };
  })();

  return result;
}

export function getSharePrice(companyId: number): number {
  const db = getDb();

  // Last filled order price
  const lastTrade = db.prepare(`
    SELECT price_per_share FROM share_orders
    WHERE company_id = ? AND filled_quantity > 0
    ORDER BY id DESC LIMIT 1
  `).get(companyId) as { price_per_share: number } | undefined;

  if (lastTrade) return lastTrade.price_per_share;

  // Fallback to IPO price
  const company = db.prepare('SELECT ipo_price FROM companies WHERE id = ?').get(companyId) as { ipo_price: number } | undefined;
  return company?.ipo_price ?? 10;
}

export function tryDistributeDividends(): void {
  const db = getDb();
  const companies = db.prepare(
    `SELECT id FROM companies WHERE revenue_accumulated > 0`
  ).all() as Array<{ id: number }>;

  for (const { id } of companies) {
    distributeDividends(id);
  }
}
