import { getDb } from '../db/connection.js';
import type { ShareHolding, ShareOrder } from '../types/index.js';

export function getPlayerShares(playerId: number): ShareHolding[] {
  const db = getDb();
  return db.prepare(`
    SELECT s.player_id, s.company_id, s.quantity, s.avg_purchase_price,
           c.name AS company_name, c.ticker
    FROM shares s
    JOIN companies c ON c.id = s.company_id
    WHERE s.player_id = ? AND s.quantity > 0
    ORDER BY c.ticker
  `).all(playerId) as ShareHolding[];
}

export function getPlayerSharesForCompany(playerId: number, companyId: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COALESCE(quantity, 0) as qty FROM shares WHERE player_id = ? AND company_id = ?'
  ).get(playerId, companyId) as { qty: number } | undefined;
  return row?.qty ?? 0;
}

export function getOrderBook(companyId: number, limit = 10): { bids: ShareOrder[]; asks: ShareOrder[] } {
  const db = getDb();
  const bids = db.prepare(`
    SELECT * FROM share_orders
    WHERE company_id = ? AND order_type = 'buy' AND status IN ('open', 'partial')
    ORDER BY price_per_share DESC, created_at ASC
    LIMIT ?
  `).all(companyId, limit) as ShareOrder[];

  const asks = db.prepare(`
    SELECT * FROM share_orders
    WHERE company_id = ? AND order_type = 'sell' AND status IN ('open', 'partial')
    ORDER BY price_per_share ASC, created_at ASC
    LIMIT ?
  `).all(companyId, limit) as ShareOrder[];

  return { bids, asks };
}

function ensureShareRow(db: ReturnType<typeof getDb>, playerId: number, companyId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO shares (player_id, company_id, quantity, avg_purchase_price) VALUES (?, ?, 0, 0)'
  ).run(playerId, companyId);
}

function updateShareHolding(
  db: ReturnType<typeof getDb>,
  playerId: number,
  companyId: number,
  addQuantity: number,
  fillPrice: number
): void {
  ensureShareRow(db, playerId, companyId);
  const current = db.prepare(
    'SELECT quantity, avg_purchase_price FROM shares WHERE player_id = ? AND company_id = ?'
  ).get(playerId, companyId) as { quantity: number; avg_purchase_price: number };

  const newQty = current.quantity + addQuantity;
  let newAvg = current.avg_purchase_price;

  if (addQuantity > 0 && newQty > 0) {
    // Weighted average for buys
    newAvg = ((current.avg_purchase_price * current.quantity) + (fillPrice * addQuantity)) / newQty;
  }

  db.prepare(
    'UPDATE shares SET quantity = ?, avg_purchase_price = ? WHERE player_id = ? AND company_id = ?'
  ).run(newQty, newAvg, playerId, companyId);
}

export function placeBuyOrder(
  playerId: number,
  companyId: number,
  quantity: number,
  pricePerShare: number
): { filled: number; orderId: number } {
  const db = getDb();

  return db.transaction(() => {
    // Insert the buy order
    const result = db.prepare(`
      INSERT INTO share_orders (player_id, company_id, order_type, quantity, price_per_share)
      VALUES (?, ?, 'buy', ?, ?)
    `).run(playerId, companyId, quantity, pricePerShare);
    const orderId = result.lastInsertRowid as number;

    let remaining = quantity;
    let totalFilled = 0;

    // Match against open sell orders (lowest price first)
    const asks = db.prepare(`
      SELECT * FROM share_orders
      WHERE company_id = ? AND order_type = 'sell' AND status IN ('open', 'partial')
        AND price_per_share <= ?
      ORDER BY price_per_share ASC, created_at ASC
    `).all(companyId, pricePerShare) as ShareOrder[];

    for (const ask of asks) {
      if (remaining <= 0) break;

      const askRemaining = ask.quantity - ask.filled_quantity;
      const fillQty = Math.min(remaining, askRemaining);
      const fillPrice = ask.price_per_share; // Fill at ask price

      // Update the ask order
      const newAskFilled = ask.filled_quantity + fillQty;
      const askStatus = newAskFilled >= ask.quantity ? 'filled' : 'partial';
      db.prepare(
        'UPDATE share_orders SET filled_quantity = ?, status = ? WHERE id = ?'
      ).run(newAskFilled, askStatus, ask.id);

      // Transfer shares: seller loses, buyer gains
      updateShareHolding(db, playerId, companyId, fillQty, fillPrice);

      // Refund buyer difference if buy price > ask price
      const priceDiff = pricePerShare - fillPrice;
      if (priceDiff > 0) {
        db.prepare(
          'UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?'
        ).run(priceDiff * fillQty, playerId);
      }

      // Pay seller
      db.prepare(
        'UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?'
      ).run(fillPrice * fillQty, ask.player_id);

      remaining -= fillQty;
      totalFilled += fillQty;
    }

    // IPO: fill remaining quantity from company treasury at ipo_price
    if (remaining > 0) {
      const company = db.prepare(
        'SELECT total_shares, shares_outstanding, ipo_price, treasury FROM companies WHERE id = ?'
      ).get(companyId) as { total_shares: number; shares_outstanding: number; ipo_price: number; treasury: number } | undefined;

      if (company && pricePerShare >= company.ipo_price) {
        const unsoldShares = company.total_shares - company.shares_outstanding;
        if (unsoldShares > 0) {
          const ipoFillQty = Math.min(remaining, unsoldShares);
          const ipoFillPrice = company.ipo_price;

          // Give shares to buyer at IPO price
          updateShareHolding(db, playerId, companyId, ipoFillQty, ipoFillPrice);

          // Credit company treasury with proceeds
          db.prepare(
            'UPDATE companies SET treasury = treasury + ?, shares_outstanding = shares_outstanding + ? WHERE id = ?'
          ).run(ipoFillPrice * ipoFillQty, ipoFillQty, companyId);

          // Refund buyer the difference between their max_price and ipo_price
          const ipoPriceDiff = pricePerShare - ipoFillPrice;
          if (ipoPriceDiff > 0) {
            db.prepare(
              'UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?'
            ).run(ipoPriceDiff * ipoFillQty, playerId);
          }

          remaining -= ipoFillQty;
          totalFilled += ipoFillQty;
        }
      }
    }

    // Update buy order status
    const buyStatus = totalFilled >= quantity ? 'filled' : totalFilled > 0 ? 'partial' : 'open';
    db.prepare(
      'UPDATE share_orders SET filled_quantity = ?, status = ? WHERE id = ?'
    ).run(totalFilled, buyStatus, orderId);

    return { filled: totalFilled, orderId };
  })();
}

export function placeSellOrder(
  playerId: number,
  companyId: number,
  quantity: number,
  pricePerShare: number
): { filled: number; orderId: number } {
  const db = getDb();

  return db.transaction(() => {
    // Reserve shares by deducting from holdings
    ensureShareRow(db, playerId, companyId);
    const holding = db.prepare(
      'SELECT quantity FROM shares WHERE player_id = ? AND company_id = ?'
    ).get(playerId, companyId) as { quantity: number };

    if (holding.quantity < quantity) {
      throw new Error(`Insufficient shares. You have ${holding.quantity} but tried to sell ${quantity}.`);
    }

    // Deduct shares upfront (reserved for the order)
    db.prepare(
      'UPDATE shares SET quantity = quantity - ? WHERE player_id = ? AND company_id = ?'
    ).run(quantity, playerId, companyId);

    // Insert sell order
    const result = db.prepare(`
      INSERT INTO share_orders (player_id, company_id, order_type, quantity, price_per_share)
      VALUES (?, ?, 'sell', ?, ?)
    `).run(playerId, companyId, quantity, pricePerShare);
    const orderId = result.lastInsertRowid as number;

    let remaining = quantity;
    let totalFilled = 0;

    // Match against open buy orders (highest price first)
    const bids = db.prepare(`
      SELECT * FROM share_orders
      WHERE company_id = ? AND order_type = 'buy' AND status IN ('open', 'partial')
        AND price_per_share >= ?
        AND id != ?
      ORDER BY price_per_share DESC, created_at ASC
    `).all(companyId, pricePerShare, orderId) as ShareOrder[];

    for (const bid of bids) {
      if (remaining <= 0) break;

      const bidRemaining = bid.quantity - bid.filled_quantity;
      const fillQty = Math.min(remaining, bidRemaining);
      const fillPrice = bid.price_per_share; // Fill at bid price

      // Update the bid order
      const newBidFilled = bid.filled_quantity + fillQty;
      const bidStatus = newBidFilled >= bid.quantity ? 'filled' : 'partial';
      db.prepare(
        'UPDATE share_orders SET filled_quantity = ?, status = ? WHERE id = ?'
      ).run(newBidFilled, bidStatus, bid.id);

      // Transfer shares to buyer
      updateShareHolding(db, bid.player_id, companyId, fillQty, fillPrice);

      // Refund buyer difference if bid price > sell price
      const priceDiff = bid.price_per_share - pricePerShare;
      if (priceDiff > 0) {
        // Buyer already paid bid price, refund the difference
        // Actually, buyer paid upfront at their bid price already. No refund needed
        // since we fill at bid price (buyer's price).
      }

      // Pay seller at the fill price (bid price)
      db.prepare(
        'UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?'
      ).run(fillPrice * fillQty, playerId);

      remaining -= fillQty;
      totalFilled += fillQty;
    }

    // Return unfilled shares back to seller if order fully matched won't happen
    // Shares stay reserved for open/partial orders

    // Update sell order status
    const sellStatus = totalFilled >= quantity ? 'filled' : totalFilled > 0 ? 'partial' : 'open';
    db.prepare(
      'UPDATE share_orders SET filled_quantity = ?, status = ? WHERE id = ?'
    ).run(totalFilled, sellStatus, orderId);

    // If fully filled, the reserved shares are already gone (transferred to buyers)
    // If partially filled, remaining shares stay reserved in the order
    // No additional adjustment needed

    return { filled: totalFilled, orderId };
  })();
}

export function cancelOrder(orderId: number, playerId: number): boolean {
  const db = getDb();

  return db.transaction(() => {
    const order = db.prepare(
      'SELECT * FROM share_orders WHERE id = ? AND player_id = ?'
    ).get(orderId, playerId) as ShareOrder | undefined;

    if (!order) return false;
    if (order.status === 'filled' || order.status === 'cancelled') return false;

    const unfilled = order.quantity - order.filled_quantity;

    if (order.order_type === 'buy') {
      // Refund gold for unfilled portion
      const refund = unfilled * order.price_per_share;
      db.prepare(
        'UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?'
      ).run(refund, playerId);
    } else {
      // Return reserved shares for unfilled portion
      ensureShareRow(db, playerId, order.company_id);
      db.prepare(
        'UPDATE shares SET quantity = quantity + ? WHERE player_id = ? AND company_id = ?'
      ).run(unfilled, playerId, order.company_id);
    }

    db.prepare(
      'UPDATE share_orders SET status = \'cancelled\' WHERE id = ?'
    ).run(orderId);

    return true;
  })();
}

export function getPlayerOrders(playerId: number): ShareOrder[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM share_orders
    WHERE player_id = ? AND status IN ('open', 'partial')
    ORDER BY created_at DESC
  `).all(playerId) as ShareOrder[];
}

export function getUnclaimedDividends(playerId: number): Array<{ companyId: number; ticker: string; amount: number }> {
  const db = getDb();

  // Find all dividends where this player held shares but hasn't claimed yet
  // A player is eligible for a dividend if they held shares at the time of distribution
  // We track this via dividend_history + shares. For simplicity, we check if the player
  // currently holds shares and hasn't claimed the dividend yet.
  const rows = db.prepare(`
    SELECT dh.id as dividend_id, dh.company_id, c.ticker, dh.per_share_amount,
           COALESCE(s.quantity, 0) as held_quantity
    FROM dividend_history dh
    JOIN companies c ON c.id = dh.company_id
    LEFT JOIN shares s ON s.company_id = dh.company_id AND s.player_id = ?
    WHERE dh.id NOT IN (
      SELECT dividend_id FROM dividend_claims WHERE player_id = ?
    )
    AND COALESCE(s.quantity, 0) > 0
  `).all(playerId, playerId) as Array<{
    dividend_id: number;
    company_id: number;
    ticker: string;
    per_share_amount: number;
    held_quantity: number;
  }>;

  return rows.map(r => ({
    companyId: r.company_id,
    ticker: r.ticker,
    amount: Math.floor(r.per_share_amount * r.held_quantity),
  })).filter(r => r.amount > 0);
}

export function claimDividends(playerId: number): number {
  const db = getDb();

  return db.transaction(() => {
    const unclaimed = db.prepare(`
      SELECT dh.id as dividend_id, dh.company_id, dh.per_share_amount,
             COALESCE(s.quantity, 0) as held_quantity
      FROM dividend_history dh
      LEFT JOIN shares s ON s.company_id = dh.company_id AND s.player_id = ?
      WHERE dh.id NOT IN (
        SELECT dividend_id FROM dividend_claims WHERE player_id = ?
      )
      AND COALESCE(s.quantity, 0) > 0
    `).all(playerId, playerId) as Array<{
      dividend_id: number;
      company_id: number;
      per_share_amount: number;
      held_quantity: number;
    }>;

    let totalGold = 0;

    const insertClaim = db.prepare(
      'INSERT INTO dividend_claims (player_id, dividend_id, amount) VALUES (?, ?, ?)'
    );

    for (const row of unclaimed) {
      const amount = Math.floor(row.per_share_amount * row.held_quantity);
      if (amount <= 0) continue;

      insertClaim.run(playerId, row.dividend_id, amount);
      totalGold += amount;
    }

    if (totalGold > 0) {
      db.prepare(
        'UPDATE players SET gold = min(gold + ?, 10000000) WHERE id = ?'
      ).run(totalGold, playerId);
    }

    return totalGold;
  })();
}
