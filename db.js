// Postgres-backed persistence.
//
// The bot's entire data set (scrims, tournaments, verifications, teams,
// settings, embeds, DM threads — everything storage.js used to keep only
// in data.json) is stored as ONE jsonb blob in a single row of the
// `bot_storage` table. That mirrors exactly what data.json already held,
// so no other file needs to know the data moved — storage.js is the only
// thing that talks to this module.
//
// Why one row instead of one-row-per-guild: it's the smallest possible
// change from "one JSON file" to "a database", so every existing
// getGuildStore/saveGuildStore call in the other ~40 files keeps working
// unmodified. If this bot grows to the point that a single-row jsonb blob
// becomes a bottleneck, splitting into a `guild_data(guild_id, data)`
// table is the natural next step — the shape of `data` here is already
// keyed by guildId, so that split is easy later.
const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL;

// Railway (and most hosts that give you a managed Postgres) require SSL
// for external connections but the certificate isn't in Node's default
// trust store, so the plain `ssl: true` default fails. Internal
// (same-project) Railway connections don't need SSL at all. Disabling
// certificate verification here is the standard workaround for managed
// Postgres providers (Railway, Render, Heroku, Supabase all recommend
// this exact setting) — the connection itself is still encrypted, only
// the CA check is skipped.
const pool = CONNECTION_STRING
  ? new Pool({
      connectionString: CONNECTION_STRING,
      ssl: CONNECTION_STRING.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  : null;

// CRITICAL: node-postgres's Pool emits an 'error' event whenever an idle
// client in the pool hits a problem (a dropped connection, the database
// restarting, a brief network blip, etc). If nothing is listening for
// that event, Node treats it as an unhandled error and crashes the ENTIRE
// process — taking the whole Discord bot down, not just the DB — until
// the host restarts it. This listener is what stops that: log it and
// move on, since every query already has its own error handling and a
// dead pooled client just gets replaced automatically on the next query.
if (pool) {
  pool.on('error', (err) => {
    console.error('[db] Unexpected error on idle PostgreSQL client (bot keeps running):', err.message);
  });
}

function isEnabled() {
  return pool !== null;
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_storage (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT bot_storage_single_row CHECK (id = 1)
    );
  `);
}

// Returns the stored data object, or null if the table is empty (first
// ever boot against this database — caller decides what to seed it with).
async function loadFromDb() {
  await ensureTable();
  const res = await pool.query('SELECT data FROM bot_storage WHERE id = 1');
  if (res.rows.length === 0) return null;
  return res.rows[0].data;
}

// Upsert the whole blob. Fire-and-forget from the caller's side (see
// storage.js) — this function itself still returns a promise so callers
// that DO want to await it (e.g. a graceful-shutdown flush) can.
async function saveToDb(data) {
  await pool.query(
    `INSERT INTO bot_storage (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [data]
  );
}

module.exports = { isEnabled, loadFromDb, saveToDb, pool };
