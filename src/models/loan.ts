import { getDb } from '../db/connection.js';
import type { Loan, BorrowerType, LenderType } from '../types/index.js';
import { MAX_GOLD } from '../types/index.js';
import { routeBankRevenue } from '../game/company-revenue.js';

export function takeLoan(
  borrowerType: BorrowerType,
  borrowerId: number,
  lenderType: LenderType,
  lenderId: number,
  principal: number,
  interestRate: number,
  termDays: number
): Loan {
  if (principal <= 0) throw new Error('Loan principal must be positive.');
  if (interestRate <= 0) throw new Error('Interest rate must be positive.');
  if (termDays <= 0) throw new Error('Term days must be positive.');

  const db = getDb();

  const result = db.transaction(() => {
    // Check lender has sufficient reserves and deduct
    deductLenderReserves(db, lenderType, lenderId, principal);

    // Credit borrower
    creditBorrower(db, borrowerType, borrowerId, principal);

    // Track lender total_lent
    updateLenderTotalLent(db, lenderType, lenderId, principal);

    // Create loan record
    const insertResult = db.prepare(`
      INSERT INTO loans (borrower_type, borrower_id, lender_type, lender_id, principal, interest_rate, balance_remaining, term_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(borrowerType, borrowerId, lenderType, lenderId, principal, interestRate, principal, termDays);

    return db.prepare('SELECT * FROM loans WHERE id = ?').get(insertResult.lastInsertRowid) as Loan;
  })();

  return result;
}

function deductLenderReserves(
  db: ReturnType<typeof getDb>, lenderType: LenderType, lenderId: number, amount: number
): void {
  if (lenderType === 'world_bank') {
    const wb = db.prepare('SELECT reserves FROM world_bank WHERE id = 1').get() as { reserves: number };
    if (wb.reserves < amount) throw new Error('World Reserve Bank has insufficient reserves.');
    db.prepare('UPDATE world_bank SET reserves = reserves - ? WHERE id = 1').run(amount);
  } else if (lenderType === 'national_bank') {
    // lenderId is encoded as chunkX * 1000000 + (chunkY + 100000) for composite key
    const { chunkX, chunkY } = decodeNcbId(lenderId);
    const ncb = db.prepare(
      'SELECT reserves FROM national_banks WHERE chunk_x = ? AND chunk_y = ?'
    ).get(chunkX, chunkY) as { reserves: number } | undefined;
    if (!ncb) throw new Error('National bank not found.');
    if (ncb.reserves < amount) throw new Error('National bank has insufficient reserves.');
    db.prepare(
      'UPDATE national_banks SET reserves = reserves - ? WHERE chunk_x = ? AND chunk_y = ?'
    ).run(amount, chunkX, chunkY);
  } else if (lenderType === 'local_bank') {
    const lb = db.prepare('SELECT reserves FROM local_banks WHERE id = ?').get(lenderId) as { reserves: number } | undefined;
    if (!lb) throw new Error('Local bank not found.');
    if (lb.reserves < amount) throw new Error('Local bank has insufficient reserves.');
    db.prepare('UPDATE local_banks SET reserves = reserves - ? WHERE id = ?').run(amount, lenderId);
  }
}

function creditBorrower(
  db: ReturnType<typeof getDb>, borrowerType: BorrowerType, borrowerId: number, amount: number
): void {
  if (borrowerType === 'player') {
    db.prepare('UPDATE players SET gold = min(gold + ?, ?) WHERE id = ?').run(amount, MAX_GOLD, borrowerId);
  } else if (borrowerType === 'national_bank') {
    const { chunkX, chunkY } = decodeNcbId(borrowerId);
    db.prepare(
      'UPDATE national_banks SET reserves = reserves + ? WHERE chunk_x = ? AND chunk_y = ?'
    ).run(amount, chunkX, chunkY);
  } else if (borrowerType === 'local_bank') {
    db.prepare('UPDATE local_banks SET reserves = reserves + ? WHERE id = ?').run(amount, borrowerId);
  }
}

function updateLenderTotalLent(
  db: ReturnType<typeof getDb>, lenderType: LenderType, lenderId: number, amount: number
): void {
  if (lenderType === 'world_bank') {
    db.prepare('UPDATE world_bank SET total_lent = total_lent + ? WHERE id = 1').run(amount);
  } else if (lenderType === 'national_bank') {
    const { chunkX, chunkY } = decodeNcbId(lenderId);
    db.prepare(
      'UPDATE national_banks SET total_lent = total_lent + ? WHERE chunk_x = ? AND chunk_y = ?'
    ).run(amount, chunkX, chunkY);
  } else if (lenderType === 'local_bank') {
    db.prepare('UPDATE local_banks SET total_lent = total_lent + ? WHERE id = ?').run(amount, lenderId);
  }
}

/** Encode NCB composite key (chunkX, chunkY) into a single integer for loan records. */
export function encodeNcbId(chunkX: number, chunkY: number): number {
  return chunkX * 1_000_000 + (chunkY + 100_000);
}

/** Decode NCB composite key from single integer. */
export function decodeNcbId(encoded: number): { chunkX: number; chunkY: number } {
  const chunkX = Math.floor(encoded / 1_000_000);
  const chunkY = (encoded % 1_000_000) - 100_000;
  return { chunkX, chunkY };
}

export function repayLoan(
  loanId: number, amount: number, payerId: number
): { remaining: number; interestPaid: number; principalPaid: number } {
  if (amount <= 0) throw new Error('Repayment amount must be positive.');
  const db = getDb();

  const result = db.transaction(() => {
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId) as Loan | undefined;
    if (!loan) throw new Error('Loan not found.');
    if (loan.status !== 'active') throw new Error(`Loan is already ${loan.status}.`);

    // Verify payer matches borrower
    if (loan.borrower_type === 'player' && loan.borrower_id !== payerId) {
      throw new Error('You are not the borrower on this loan.');
    }

    // Check payer has enough gold
    const payer = db.prepare('SELECT gold FROM players WHERE id = ?').get(payerId) as { gold: number } | undefined;
    if (!payer) throw new Error('Payer not found.');
    if (payer.gold < amount) throw new Error(`Insufficient gold. You have ${payer.gold}g.`);

    // Calculate interest due
    const interestDue = calculateInterestDue(loan);

    // Apply payment: interest first, then principal
    let remaining = amount;
    let interestPaid = 0;
    let principalPaid = 0;

    if (remaining >= interestDue) {
      interestPaid = interestDue;
      remaining -= interestDue;
    } else {
      interestPaid = remaining;
      remaining = 0;
    }

    const principalOwed = loan.balance_remaining;
    if (remaining >= principalOwed) {
      principalPaid = principalOwed;
      remaining = remaining - principalOwed;
      // Loan fully paid — refund overpayment by reducing amount deducted
    } else {
      principalPaid = remaining;
      remaining = 0;
    }

    const totalDeducted = interestPaid + principalPaid;
    const newBalance = principalOwed - principalPaid;
    const newStatus = newBalance <= 0 ? 'paid' : 'active';

    // Deduct from payer
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(totalDeducted, payerId);

    // Credit lender reserves + revenue (interest)
    creditLenderRepayment(db, loan.lender_type, loan.lender_id, principalPaid, interestPaid);

    // Update loan
    db.prepare(
      `UPDATE loans SET balance_remaining = ?, interest_accrued = interest_accrued + ?, status = ?, last_payment_at = datetime('now') WHERE id = ?`
    ).run(newBalance, interestPaid, newStatus, loanId);

    return { remaining: newBalance, interestPaid, principalPaid };
  })();

  return result;
}

function creditLenderRepayment(
  db: ReturnType<typeof getDb>, lenderType: LenderType, lenderId: number,
  principalPaid: number, interestPaid: number
): void {
  const totalCredit = principalPaid + interestPaid;
  if (lenderType === 'world_bank') {
    db.prepare(
      'UPDATE world_bank SET reserves = reserves + ?, revenue_accumulated = revenue_accumulated + ? WHERE id = 1'
    ).run(totalCredit, interestPaid);
    // Interest income → WBNK company revenue for stock dividends
    routeBankRevenue(interestPaid);
  } else if (lenderType === 'national_bank') {
    const { chunkX, chunkY } = decodeNcbId(lenderId);
    db.prepare(
      'UPDATE national_banks SET reserves = reserves + ? WHERE chunk_x = ? AND chunk_y = ?'
    ).run(totalCredit, chunkX, chunkY);
  } else if (lenderType === 'local_bank') {
    db.prepare(
      'UPDATE local_banks SET reserves = reserves + ? WHERE id = ?'
    ).run(totalCredit, lenderId);
  }
}

export function getPlayerLoans(playerId: number): Loan[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM loans WHERE borrower_type = 'player' AND borrower_id = ? ORDER BY created_at DESC"
  ).all(playerId) as Loan[];
}

export function getLoanById(id: number): Loan | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM loans WHERE id = ?').get(id) as Loan | undefined;
  return row || null;
}

export function getBankLoansIssued(lenderType: LenderType, lenderId: number): Loan[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM loans WHERE lender_type = ? AND lender_id = ? ORDER BY created_at DESC'
  ).all(lenderType, lenderId) as Loan[];
}

export function getBankLoansTaken(borrowerType: BorrowerType, borrowerId: number): Loan[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM loans WHERE borrower_type = ? AND borrower_id = ? ORDER BY created_at DESC'
  ).all(borrowerType, borrowerId) as Loan[];
}

export function calculateInterestDue(loan: Loan): number {
  const lastPayment = new Date(loan.last_payment_at + 'Z').getTime();
  const now = Date.now();
  const daysPassed = (now - lastPayment) / (1000 * 60 * 60 * 24);
  return Math.floor(loan.balance_remaining * (loan.interest_rate / 365) * daysPassed);
}

export function defaultOnLoan(loanId: number): void {
  const db = getDb();
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId) as Loan | undefined;
  if (!loan) throw new Error('Loan not found.');
  if (loan.status !== 'active') throw new Error(`Loan is already ${loan.status}.`);

  db.prepare("UPDATE loans SET status = 'defaulted' WHERE id = ?").run(loanId);
}
