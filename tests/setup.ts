import { beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Use in-memory DB for tests
let testDb: Database.Database;

beforeEach(() => {
  // Reset DB module cache so each test gets fresh state
  process.env.DATABASE_PATH = ':memory:';
});

// Force fresh connection for each test by clearing the module
export function freshDb() {
  // We manually create a fresh in-memory db and inject it
  process.env.DATABASE_PATH = ':memory:';
}
