import { getDb } from './connection.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  chunk_x INTEGER NOT NULL DEFAULT 0,
  chunk_y INTEGER NOT NULL DEFAULT 0,
  location_id INTEGER,
  hp INTEGER NOT NULL DEFAULT 50,
  max_hp INTEGER NOT NULL DEFAULT 50,
  strength INTEGER NOT NULL DEFAULT 5,
  dexterity INTEGER NOT NULL DEFAULT 5,
  constitution INTEGER NOT NULL DEFAULT 5,
  charisma INTEGER NOT NULL DEFAULT 5,
  luck INTEGER NOT NULL DEFAULT 5,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  gold INTEGER NOT NULL DEFAULT 50,
  is_alive INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  died_at TEXT,
  cause_of_death TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name_alive ON players(name) WHERE is_alive = 1;

CREATE TABLE IF NOT EXISTS chunks (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  terrain_type TEXT NOT NULL,
  danger_level INTEGER NOT NULL DEFAULT 1,
  theme_tags TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (x, y)
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_x INTEGER NOT NULL,
  chunk_y INTEGER NOT NULL,
  parent_id INTEGER,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  location_type TEXT NOT NULL DEFAULT 'room',
  depth INTEGER NOT NULL DEFAULT 1,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  discovery_dc INTEGER NOT NULL DEFAULT 10,
  is_shop INTEGER NOT NULL DEFAULT 0,
  required_key_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (chunk_x, chunk_y) REFERENCES chunks(x, y),
  FOREIGN KEY (parent_id) REFERENCES locations(id)
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'misc',
  damage_bonus INTEGER NOT NULL DEFAULT 0,
  defense_bonus INTEGER NOT NULL DEFAULT 0,
  stat_bonuses TEXT NOT NULL DEFAULT '{}',
  heal_amount INTEGER NOT NULL DEFAULT 0,
  value INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER,
  chunk_x INTEGER,
  chunk_y INTEGER,
  location_id INTEGER,
  is_equipped INTEGER NOT NULL DEFAULT 0,
  rarity TEXT NOT NULL DEFAULT 'common',
  is_shop_item INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (owner_id) REFERENCES players(id),
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  to_id INTEGER,
  chunk_x INTEGER NOT NULL,
  chunk_y INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (from_id) REFERENCES players(id),
  FOREIGN KEY (to_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_id INTEGER,
  target_id INTEGER,
  chunk_x INTEGER,
  chunk_y INTEGER,
  location_id INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discoveries (
  player_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, location_id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

CREATE TABLE IF NOT EXISTS chunk_locks (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  locked_by INTEGER NOT NULL,
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (x, y),
  FOREIGN KEY (locked_by) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  offer_items TEXT NOT NULL DEFAULT '[]',
  offer_gold INTEGER NOT NULL DEFAULT 0,
  request_items TEXT NOT NULL DEFAULT '[]',
  request_gold INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (from_id) REFERENCES players(id),
  FOREIGN KEY (to_id) REFERENCES players(id)
);
`;

export function migrate(): void {
  const db = getDb();
  db.exec(SCHEMA);
  seed(db);
}

function seed(db: ReturnType<typeof getDb>): void {
  const nexus = db.prepare('SELECT 1 FROM chunks WHERE x = 0 AND y = 0').get();
  if (nexus) return;

  db.exec(`
    INSERT INTO chunks (x, y, name, description, terrain_type, danger_level, theme_tags, created_by)
    VALUES (0, 0, 'The Nexus', 'A shimmering crossroads at the center of all realities. Cobblestone streets radiate outward in four directions, bustling with travelers from countless worlds. Arcane lampposts cast a warm glow over market stalls and gathering places. This is where every adventurer begins their journey.', 'city', 1, '["urban","safe","hub","magical"]', 0);
  `);

  db.exec(`
    INSERT INTO locations (chunk_x, chunk_y, parent_id, name, description, location_type, depth, is_hidden, discovery_dc, is_shop, created_by)
    VALUES (0, 0, NULL, 'The First Pint Tavern', 'A cozy tavern with oak beams and a roaring fireplace. The barkeep, a stout dwarf named Grimjaw, polishes mugs behind a worn counter. Adventurers swap tales over foaming ales. A notice board near the entrance is covered in job postings and wanted posters.', 'tavern', 1, 0, 0, 0, 0);
  `);

  db.exec(`
    INSERT INTO locations (chunk_x, chunk_y, parent_id, name, description, location_type, depth, is_hidden, discovery_dc, is_shop, created_by)
    VALUES (0, 0, NULL, 'The Curiosity Shop', 'A cramped shop overflowing with strange artifacts. Glass cases display glowing trinkets, dusty tomes, and weapons of curious design. The shopkeeper, a tall elf with silver eyes, watches every movement with an appraising gaze.', 'shop', 1, 0, 0, 1, 0);
  `);

  const shopLocation = db.prepare(
    `SELECT id FROM locations WHERE name = 'The Curiosity Shop' AND chunk_x = 0 AND chunk_y = 0`
  ).get() as { id: number } | undefined;

  if (shopLocation) {
    const locId = shopLocation.id;
    const insert = db.prepare(`
      INSERT INTO items (name, description, item_type, damage_bonus, defense_bonus, heal_amount, value, chunk_x, chunk_y, location_id, rarity, is_shop_item)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1)
    `);
    insert.run('Rusty Sword', 'A battered but serviceable blade. Better than bare fists.', 'weapon', 2, 0, 0, 15, locId, 'common');
    insert.run('Leather Cap', 'A simple leather helmet offering modest protection.', 'armor', 0, 1, 0, 10, locId, 'common');
    insert.run('Minor Healing Potion', 'A small vial of red liquid. Restores 15 HP.', 'consumable', 0, 0, 15, 12, locId, 'common');
    insert.run('Minor Healing Potion', 'A small vial of red liquid. Restores 15 HP.', 'consumable', 0, 0, 15, 12, locId, 'common');
    insert.run('Iron Shield', 'A round iron shield, dented but functional.', 'armor', 0, 2, 0, 20, locId, 'common');
    insert.run('Adventurer\'s Compass', 'A brass compass that always points toward the nearest unexplored chunk.', 'misc', 0, 0, 0, 25, locId, 'uncommon');
    insert.run('Skeleton Key', 'A mysterious key that hums with faint energy. Might open locked doors.', 'key', 0, 0, 0, 40, locId, 'rare');
  }

  console.log('[seed] The Nexus created with starter locations and items');
}
