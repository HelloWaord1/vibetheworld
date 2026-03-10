# VibeWorld — Multiplayer Text RPG via MCP

## Quick Reference

```bash
npm run dev          # Start dev server (tsx, auto-reload off)
PORT=3333 npm run dev # Start on custom port
npm run build        # TypeScript compile to dist/
npm start            # Run compiled JS
npm test             # Run vitest tests
```

## Architecture

- **MCP Server** (stateless StreamableHTTP) — each POST /mcp creates a fresh McpServer+Transport
- **SQLite** via better-sqlite3 — single file DB, WAL mode, foreign keys ON
- **Express** — /health, /api/map, /api/leaderboard, /api/stats
- **No ORM** — raw SQL via prepared statements in `src/models/`

## Project Structure

```
src/
  index.ts            — Entry point, Express + MCP setup, graceful shutdown
  server/
    mcp-server.ts     — Creates McpServer, registers all tools
    http-server.ts    — Express routes for health/API
    auth.ts           — Token auth helper
    rate-limit.ts     — In-memory rate limiter middleware
  db/
    connection.ts     — SQLite singleton (getDb/resetDb)
    migrate.ts        — Inlined schema + seed data (The Nexus)
  models/             — CRUD functions (player, chunk, location, item, message, event-log, trade, discovery)
  tools/              — MCP tool registrations (auth, navigation, chunk, inventory, combat, social, economy, info)
  game/               — Game logic (combat, leveling, discovery, dice, world-rules)
  types/index.ts      — All interfaces + constants
  utils/              — crypto (bcrypt/uuid), logger
tests/                — vitest tests
```

## Key Decisions

- **Stateless MCP**: New McpServer per request. No session state on server. Player state is in DB, identified by token.
- **Schema inlined**: SQL schema is a string constant in migrate.ts (not a .sql file), so `tsc` build works without file copying.
- **Shop items**: `is_shop_item=1` items are permanent fixtures — buying creates a copy for the player. Regular `pickup` is blocked for shop items.
- **Coordinate range**: -99 to 99 on both axes. Origin (0,0) is The Nexus.
- **Permadeath**: Dead player names can be reused (unique index only on alive players).
- **Stat bonuses**: Items with `stat_bonuses` JSON apply/remove stats on equip/unequip.
- **Key items**: Locations can have `required_key_id`. Keys are checked automatically on `enter`. Rare keys bypass all locks.
- **Inventory limit**: 20 items max per player. Currency items bypass (convert to gold on pickup).
- **Crit cap**: Max crit chance is 25% (d20 <= 5), regardless of luck.
- **Transactions**: Combat deaths and trades are wrapped in SQLite transactions for data integrity.
- **Password minimum**: 6 characters.

## Adding a New MCP Tool

1. Add tool registration in the appropriate `src/tools/*-tools.ts` file
2. Use `server.tool(name, description, zodSchema, handler)` pattern
3. Always call `authenticate(token)` first (except register/login)
4. Return `{ content: [{ type: 'text', text: '...' }] }`
5. Wrap handler body in try/catch, return error as text

## Database

9 tables: players, chunks, locations, items, messages, event_log, discoveries, chunk_locks, trades.
Schema is auto-applied on startup via `migrate()`. Seed data creates The Nexus chunk with tavern, shop, and starter items.

## Deploy

Railway with Dockerfile. Persistent volume mounted at /data for SQLite.
`DATABASE_PATH=/data/vibeworld.db`
