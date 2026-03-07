CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
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
