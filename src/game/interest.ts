import { getDb } from '../db/connection.js';
import type { BankAccount, Loan } from '../types/index.js';

/** Calculate simple interest: principal * (annualRate / 365) * days */
export function calculateSimpleInterest(
  principal: number, annualRate: number, days: number
): number {
  if (principal <= 0 || annualRate <= 0 || days <= 0) return 0;
  return Math.floor(principal * (annualRate / 365) * days);
}

/** Batch accrue interest on all bank accounts. */
export function accrueAllInterest(): void {
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM bank_accounts WHERE balance > 0').all() as BankAccount[];

  const updateStmt = db.prepare(
    `UPDATE bank_accounts SET balance = balance + ?, interest_accrued = interest_accrued + ?, last_interest_at = datetime('now') WHERE id = ?`
  );

  const batchAccrue = db.transaction(() => {
    for (const account of accounts) {
      const lastInterest = new Date(account.last_interest_at + 'Z').getTime();
      const now = Date.now();
      const daysPassed = (now - lastInterest) / (1000 * 60 * 60 * 24);
      if (daysPassed < 0.01) continue;

      const bank = db.prepare(
        'SELECT deposit_rate FROM local_banks WHERE id = ?'
      ).get(account.bank_id) as { deposit_rate: number } | undefined;
      if (!bank) continue;

      const interest = calculateSimpleInterest(account.balance, bank.deposit_rate, daysPassed);
      if (interest <= 0) continue;

      updateStmt.run(interest, interest, account.id);
    }
  });

  batchAccrue();
}

/** Check overdue loans and apply late penalties (50% markup on interest rate). */
export function processLoanPayments(): void {
  const db = getDb();
  const activeLoans = db.prepare(
    "SELECT * FROM loans WHERE status = 'active'"
  ).all() as Loan[];

  const updateStmt = db.prepare(
    `UPDATE loans SET interest_accrued = interest_accrued + ?, last_payment_at = datetime('now') WHERE id = ?`
  );
  const defaultStmt = db.prepare(
    "UPDATE loans SET status = 'defaulted' WHERE id = ?"
  );

  const batchProcess = db.transaction(() => {
    const now = Date.now();

    for (const loan of activeLoans) {
      const createdAt = new Date(loan.created_at + 'Z').getTime();
      const termEnd = createdAt + loan.term_days * 24 * 60 * 60 * 1000;
      const lastPayment = new Date(loan.last_payment_at + 'Z').getTime();
      const daysSincePayment = (now - lastPayment) / (1000 * 60 * 60 * 24);

      if (daysSincePayment < 0.01) continue;

      // If past term, apply 50% penalty rate and check for auto-default
      const isOverdue = now > termEnd;
      const effectiveRate = isOverdue
        ? loan.interest_rate * 1.5
        : loan.interest_rate;

      const interest = calculateSimpleInterest(
        loan.balance_remaining, effectiveRate, daysSincePayment
      );

      if (interest > 0) {
        updateStmt.run(interest, loan.id);
      }

      // Auto-default if more than 2x the term has passed since creation
      const gracePeriodEnd = createdAt + loan.term_days * 2 * 24 * 60 * 60 * 1000;
      if (now > gracePeriodEnd && loan.balance_remaining > 0) {
        defaultStmt.run(loan.id);
      }
    }
  });

  batchProcess();
}
