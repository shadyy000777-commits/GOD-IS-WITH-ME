const fs = require('fs');
const path = require('path');
const { todayDayNumber, DEFAULT_GROUPS_PER_DAY } = require('./t3-group-schedule');

// DATA_DIR is a manual override (e.g. a Railway volume mount path) so
// data.json survives redeploys. Falls back to this folder for local dev.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 't3-data.json');

// Registration is open 24/7 and groups keep incrementing forever, so this is
// sized generously (1000 groups' worth) so it never needs to be manually
// resized.
const DEFAULT_TOTAL_SLOTS = 20000;

function defaultScrim() {
  return {
    scrimName: 'T3 Scrims', totalSlots: DEFAULT_TOTAL_SLOTS, slots: {},
    createdDayNumber: todayDayNumber(), groupsPerDay: DEFAULT_GROUPS_PER_DAY,
  };
}

// Per-guild data shape:
// {
//   "<guildId>": {
//     registrations: { "<userId>": { team_name, owner_name, whatsapp, owner_email,
//       p1_ign, p1_uid, ..., p5_ign, p5_uid, selectedPlayerIds, registeredDate, teamNumber } },
//     scrim: { scrimName, totalSlots, slots: { "<slotNumber>": {...} }, createdDayNumber, closedGroups: [] },
//     settings: { logChannelId: "<channelId>" | null, requiredRoleId: "<roleId>" | null, teamCounter: <number>,
//       livePanelChannelId, livePanelMessageId, groupSchedule: { "<position>": { matches: [...] } } }
//   }
// }

// Storage backend:
//   • DATABASE_URL set  -> PostgreSQL (table t3_guilds, one JSONB row per
//     guild). Data survives redeploys / file replacements / restarts. On the
//     very first run it imports an existing t3-data.json so nothing is lost.
//   • DATABASE_URL unset -> t3-data.json exactly as before.
//
// The rest of the bot keeps the same synchronous API (getGuildStore /
// saveGuildStore / listGuildIds). In Postgres mode all guild data is loaded
// into memory once at startup (initStorage(), awaited before the bot logs
// in) and every save is written to the database in the background, in order.
// Reads hand back a copy, so — like the file version — changes only stick
// once saveGuildStore() is called.
const USE_PG = Boolean(process.env.DATABASE_URL);

let pool = null;
let cache = null;            // { guildId: guildData } — only used in Postgres mode
let writeQueue = Promise.resolve();

const clone = value => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- JSON file
function loadFile() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to parse t3-data.json, starting fresh:', err);
    return {};
  }
}

function saveFile(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ------------------------------------------------------------------ Postgres
function persistGuild(guildId, data) {
  const json = JSON.stringify(data);
  writeQueue = writeQueue
    .then(() => pool.query(
      `INSERT INTO t3_guilds (guild_id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (guild_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [guildId, json],
    ))
    .catch(err => console.error(`[t3-storage] Failed to save guild ${guildId} to PostgreSQL:`, err));
  return writeQueue;
}

// Call once at startup, before the bot logs in. No-op without DATABASE_URL.
async function initStorage() {
  if (!USE_PG) {
    console.log(`[t3-storage] DATABASE_URL not set — using JSON file: ${DATA_FILE}`);
    return;
  }
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  pool = new Pool({
    connectionString: url,
    // Same SSL rule as db.js (managed Postgres hosts need SSL without a CA).
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  pool.on('error', err => console.error('[t3-storage] Idle PostgreSQL client error (bot keeps running):', err.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS t3_guilds (
      guild_id   TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query('SELECT guild_id, data FROM t3_guilds');
  cache = {};
  for (const row of rows) cache[row.guild_id] = row.data;

  // First run on Postgres: bring over an existing t3-data.json.
  if (rows.length === 0 && fs.existsSync(DATA_FILE)) {
    const fromFile = loadFile();
    const ids = Object.keys(fromFile);
    for (const id of ids) {
      cache[id] = fromFile[id];
      await persistGuild(id, fromFile[id]);
    }
    if (ids.length) console.log(`[t3-storage] Imported ${ids.length} guild(s) from ${DATA_FILE} into PostgreSQL.`);
  }
  console.log(`[t3-storage] Using PostgreSQL — ${Object.keys(cache).length} guild(s) loaded.`);
}

// Waits for queued database writes (call before exiting).
async function flushStorage() {
  await writeQueue;
  if (pool) await pool.end().catch(() => {});
}

// ------------------------------------------------------------------ public API
function loadAll() {
  return cache ? clone(cache) : loadFile();
}

function saveAll(data) {
  if (!cache) return saveFile(data);
  cache = clone(data);
  for (const [id, guildData] of Object.entries(cache)) persistGuild(id, guildData);
}

function getGuildStore(guildId) {
  const all = cache || loadFile();
  let guildData = all[guildId];
  if (!guildData) {
    guildData = { registrations: {}, scrim: defaultScrim(), settings: {} };
    if (cache) {
      cache[guildId] = clone(guildData);
      persistGuild(guildId, cache[guildId]);
    } else {
      all[guildId] = guildData;
      saveFile(all);
    }
  } else if (cache) {
    guildData = clone(guildData);      // callers may mutate; only saveGuildStore() commits
  }
  // backfill in case older data is missing newer keys
  if (guildData.registrations === undefined) guildData.registrations = {};
  if (!guildData.scrim) guildData.scrim = defaultScrim();
  if (!Number.isInteger(guildData.scrim.groupsPerDay) || guildData.scrim.groupsPerDay < 1) {
    guildData.scrim.groupsPerDay = DEFAULT_GROUPS_PER_DAY; // backfill for scrims saved before this setting existed
  }
  if (guildData.settings === undefined) guildData.settings = {};
  return guildData;
}

function saveGuildStore(guildId, guildData) {
  if (cache) {
    cache[guildId] = clone(guildData);
    persistGuild(guildId, cache[guildId]);
    return;
  }
  const all = loadFile();
  all[guildId] = guildData;
  saveFile(all);
}

function listGuildIds() {
  return Object.keys(cache || loadFile());
}

module.exports = { initStorage, flushStorage, getGuildStore, saveGuildStore, listGuildIds, loadAll, saveAll };
