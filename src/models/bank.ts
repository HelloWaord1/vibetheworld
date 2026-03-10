import { getDb } from '../db/connection.js';
import type { WorldBank, NationalBank, LocalBank, BankAccount } from '../types/index.js';
import {
  MIN_FEDERAL_RATE, MAX_FEDERAL_RATE,
  MAX_NCB_MARKUP, MAX_LOCAL_DEPOSIT_RATE, MAX_LOCAL_LENDING_RATE,
  MAX_GOLD,
} from '../types/index.js';

export function getWorldBank(): WorldBank {
  const db = getDb();
  return db.prepare('SELECT * FROM world_bank WHERE id = 1').get() as WorldBank;
}


export function withdrawFromWRB(amount: number): number {
  const db = getDb();
  const wrb = db.prepare('SELECT reserves FROM world_bank WHERE id = 1').get() as { reserves: number } | undefined;
  if (!wrb || wrb.reserves <= 0) return 0;
  const actual = Math.min(amount, wrb.reserves);
  db.prepare('UPDATE world_bank SET reserves = reserves - ? WHERE id = 1').run(actual);
  return actual;
}
export function setFederalRate(rate: number): void {
  if (rate < MIN_FEDERAL_RATE || rate > MAX_FEDERAL_RATE) {
    throw new Error(`Federal rate must be between ${MIN_FEDERAL_RATE} and ${MAX_FEDERAL_RATE}.`);
  }
  const db = getDb();
  db.prepare(
    `UPDATE world_bank SET federal_rate = ?, last_rate_change = datetime('now') WHERE id = 1`
  ).run(rate);
}

export function getNationalBank(chunkX: number, chunkY: number): NationalBank | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM national_banks WHERE chunk_x = ? AND chunk_y = ?'
  ).get(chunkX, chunkY) as NationalBank | undefined;
  return row || null;
}

export function createNationalBank(chunkX: number, chunkY: number, rulerId: number): NationalBank {
  const db = getDb();
  db.prepare(
    `INSERT INTO national_banks (chunk_x, chunk_y, ruler_id) VALUES (?, ?, ?)`
  ).run(chunkX, chunkY, rulerId);
  return getNationalBank(chunkX, chunkY)!;
}

export function setNcbMarkup(chunkX: number, chunkY: number, markup: number): void {
  if (markup < 0.01 || markup > MAX_NCB_MARKUP) {
    throw new Error(`NCB markup must be between 0.01 and ${MAX_NCB_MARKUP}.`);
  }
  const db = getDb();
  const result = db.prepare(
    'UPDATE national_banks SET markup = ? WHERE chunk_x = ? AND chunk_y = ?'
  ).run(markup, chunkX, chunkY);
  if (result.changes === 0) throw new Error('National bank not found.');
}

export function getLocalBank(id: number): LocalBank | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM local_banks WHERE id = ?').get(id) as LocalBank | undefined;
  return row || null;
}

export function getLocalBanksAtLocation(
  chunkX: number, chunkY: number, locationId?: number
): LocalBank[] {
  const db = getDb();
  if (locationId !== undefined) {
    return db.prepare(
      'SELECT * FROM local_banks WHERE chunk_x = ? AND chunk_y = ? AND location_id = ?'
    ).all(chunkX, chunkY, locationId) as LocalBank[];
  }
  return db.prepare(
    'SELECT * FROM local_banks WHERE chunk_x = ? AND chunk_y = ?'
  ).all(chunkX, chunkY) as LocalBank[];
}

export function getLocalBanksInChunk(chunkX: number, chunkY: number): LocalBank[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM local_banks WHERE chunk_x = ? AND chunk_y = ?'
  ).all(chunkX, chunkY) as LocalBank[];
}

export function createLocalBank(
  ownerId: number, locationId: number, chunkX: number, chunkY: number, name: string
): LocalBank {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO local_banks (owner_id, location_id, chunk_x, chunk_y, name) VALUES (?, ?, ?, ?, ?)`
  ).run(ownerId, locationId, chunkX, chunkY, name);
  return getLocalBank(result.lastInsertRowid as number)!;
}

export function setLocalBankRates(
  bankId: number, ownerId: number, depositRate: number, lendingRate: number
): void {
  if (depositRate < 0.01 || depositRate > MAX_LOCAL_DEPOSIT_RATE) {
    throw new Error(`Deposit rate must be between 0.01 and ${MAX_LOCAL_DEPOSIT_RATE}.`);
  }
  if (lendingRate < 0.05 || lendingRate > MAX_LOCAL_LENDING_RATE) {
    throw new Error(`Lending rate must be between 0.05 and ${MAX_LOCAL_LENDING_RATE}.`);
  }
  const db = getDb();
  const bank = getLocalBank(bankId);
  if (!bank) throw new Error('Bank not found.');
  if (bank.owner_id !== ownerId) throw new Error('You do not own this bank.');

  db.prepare(
    'UPDATE local_banks SET deposit_rate = ?, lending_rate = ? WHERE id = ?'
  ).run(depositRate, lendingRate, bankId);
}

export function getPlayerBankAccount(playerId: number, bankId: number): BankAccount | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM bank_accounts WHERE player_id = ? AND bank_id = ?'
  ).get(playerId, bankId) as BankAccount | undefined;
  return row || null;
}

export function deposit(playerId: number, bankId: number, amount: number): BankAccount {
  if (amount <= 0) throw new Error('Deposit amount must be positive.');
  const db = getDb();

  const result = db.transaction(() => {
    const player = db.prepare('SELECT gold FROM players WHERE id = ?').get(playerId) as { gold: number } | undefined;
    if (!player) throw new Error('Player not found.');
    if (player.gold < amount) throw new Error(`Insufficient gold. You have ${player.gold}g.`);

    const bank = db.prepare('SELECT id FROM local_banks WHERE id = ?').get(bankId) as { id: number } | undefined;
    if (!bank) throw new Error('Bank not found.');

    // Deduct player gold
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(amount, playerId);

    // Add to bank reserves and total deposits
    db.prepare(
      'UPDATE local_banks SET reserves = reserves + ?, total_deposits = total_deposits + ? WHERE id = ?'
    ).run(amount, amount, bankId);

    // Create or update account
    const existing = db.prepare(
      'SELECT id FROM bank_accounts WHERE player_id = ? AND bank_id = ?'
    ).get(playerId, bankId) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        'UPDATE bank_accounts SET balance = balance + ? WHERE id = ?'
      ).run(amount, existing.id);
    } else {
      db.prepare(
        `INSERT INTO bank_accounts (player_id, bank_id, balance) VALUES (?, ?, ?)`
      ).run(playerId, bankId, amount);
    }

    return db.prepare(
      'SELECT * FROM bank_accounts WHERE player_id = ? AND bank_id = ?'
    ).get(playerId, bankId) as BankAccount;
  })();

  return result;
}

export function withdraw(playerId: number, bankId: number, amount: number): BankAccount {
  if (amount <= 0) throw new Error('Withdrawal amount must be positive.');
  const db = getDb();

  const result = db.transaction(() => {
    const account = db.prepare(
      'SELECT * FROM bank_accounts WHERE player_id = ? AND bank_id = ?'
    ).get(playerId, bankId) as BankAccount | undefined;
    if (!account) throw new Error('You have no account at this bank.');
    if (account.balance < amount) throw new Error(`Insufficient balance. You have ${account.balance}g deposited.`);

    const bank = db.prepare(
      'SELECT reserves FROM local_banks WHERE id = ?'
    ).get(bankId) as { reserves: number };
    if (bank.reserves < amount) throw new Error('Bank does not have enough reserves for this withdrawal.');

    // Deduct from account
    db.prepare('UPDATE bank_accounts SET balance = balance - ? WHERE player_id = ? AND bank_id = ?')
      .run(amount, playerId, bankId);

    // Deduct from bank reserves
    db.prepare('UPDATE local_banks SET reserves = reserves - ? WHERE id = ?')
      .run(amount, bankId);

    // Credit player gold (capped at MAX_GOLD)
    db.prepare('UPDATE players SET gold = min(gold + ?, ?) WHERE id = ?')
      .run(amount, MAX_GOLD, playerId);

    return db.prepare(
      'SELECT * FROM bank_accounts WHERE player_id = ? AND bank_id = ?'
    ).get(playerId, bankId) as BankAccount;
  })();

  return result;
}

export function accrueInterest(accountId: number): number {
  const db = getDb();

  const result = db.transaction(() => {
    const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId) as BankAccount | undefined;
    if (!account) throw new Error('Account not found.');
    if (account.balance <= 0) return 0;

    const bank = db.prepare('SELECT deposit_rate FROM local_banks WHERE id = ?').get(account.bank_id) as { deposit_rate: number };

    const lastInterest = new Date(account.last_interest_at + 'Z').getTime();
    const now = Date.now();
    const daysPassed = (now - lastInterest) / (1000 * 60 * 60 * 24);
    if (daysPassed < 0.01) return 0; // less than ~15 minutes, skip

    const interest = Math.floor(account.balance * (bank.deposit_rate / 365) * daysPassed);
    if (interest <= 0) return 0;

    db.prepare(
      `UPDATE bank_accounts SET balance = balance + ?, interest_accrued = interest_accrued + ?, last_interest_at = datetime('now') WHERE id = ?`
    ).run(interest, interest, accountId);

    return interest;
  })();

  return result;
}
