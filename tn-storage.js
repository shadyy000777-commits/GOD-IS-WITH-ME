const fs = require('fs');
const path = require('path');

// Same persistence rules as the scrims bot: RAILWAY_VOLUME_MOUNT_PATH (auto-set
// when a Volume is attached) wins, DATA_DIR is a manual override for other
// hosts, and it falls back to this folder for local development.
//
// The file is named tournament-data.json (NOT data.json) so it can never
// collide with the scrims bot's data.json if both bots ever point at the same
// DATA_DIR. Two bots must never write to the same file — each one reads the
// whole file, changes it and writes it back, so they would overwrite each
// other's changes.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'tournament-data.json');

// Storage backend:
//   • DATABASE_URL set  -> PostgreSQL (one JSONB row per guild). Data survives
//     redeploys / file replacements / restarts, no matter what the host does to
//     the bot's folder. Set DATABASE_SSL=true if your provider requires SSL.
//   • DATABASE_URL unset -> tournament-data.json exactly as before.
//
// Either way the rest of the bot keeps using the same synchronous API
// (getGuildStore / saveGuildStore / listGuildIds). In Postgres mode all guild
// data is loaded into memory once at startup (initStorage(), awaited before the
// bot logs in) and every save is written to the database in the background, in
// order. Reads hand back a copy, so — like the file version — changes only stick
// once saveGuildStore() is called.
//
// Per-guild data shape:
// {
//   "<guildId>": {
//     tournaments: { "<tournamentId>": { id, name, open, groups: { "1": { capacity, teams: [] } }, qualified: [] , ... } },
//       — several can exist at once; which one a given admin is currently
//       managing in the wizard panel is tracked in activeTournamentByUser.
//     activeTournamentByUser: { "<userId>": "<tournamentId>" },
//     settings: { tournamentGroupChannelsCategoryId: "<channelId>" | undefined,
//       ssVerifyLogChannelId, logChannelId }   (screenshot-verification log channel)
//     ssSetups: { "<submitChannelId>": { channelId, type, accountName, link, keywords: [], roleId,
//       requiredSs, allowSame, successMessage } } — one screenshot-verification setup per submit channel
//     ssData: { "<submitChannelId>": [ { authorId, channelId, messageId, dhash, phash, submittedAt } ] }
//       — every screenshot that has been counted for that setup
//   }
// }

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
    console.error('Failed to parse tournament-data.json, starting fresh:', err);
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
      `INSERT INTO tournament_guilds (guild_id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (guild_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [guildId, json],
    ))
    .catch(err => console.error(`[storage] Failed to save guild ${guildId} to PostgreSQL:`, err));
  return writeQueue;
}

// Call once at startup, before the bot logs in. No-op without DATABASE_URL.
async function initStorage() {
  if (!USE_PG) {
    console.log(`[storage] Using JSON file: ${DATA_FILE}`);
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_guilds (
      guild_id   TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query('SELECT guild_id, data FROM tournament_guilds');
  cache = {};
  for (const row of rows) cache[row.guild_id] = row.data;

  // First run on Postgres: bring over an existing tournament-data.json so
  // nothing already created is lost.
  if (rows.length === 0 && fs.existsSync(DATA_FILE)) {
    const fromFile = loadFile();
    const ids = Object.keys(fromFile);
    if (ids.length) {
      for (const id of ids) {
        cache[id] = fromFile[id];
        await persistGuild(id, fromFile[id]);
      }
      console.log(`[storage] Imported ${ids.length} guild(s) from ${DATA_FILE} into PostgreSQL.`);
    }
  }
  console.log(`[storage] Using PostgreSQL — ${Object.keys(cache).length} guild(s) loaded.`);
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
    guildData = { tournaments: {}, activeTournamentByUser: {}, settings: {} };
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
  if (guildData.tournaments === undefined) guildData.tournaments = {};
  if (guildData.activeTournamentByUser === undefined) guildData.activeTournamentByUser = {};
  if (guildData.settings === undefined) guildData.settings = {};
  if (guildData.aiChatHistory === undefined) guildData.aiChatHistory = {};
  if (guildData.ssSetups === undefined) guildData.ssSetups = {};
  if (guildData.ssData === undefined) guildData.ssData = {};
  return guildData;
}

// Read-only peek at a guild's data WITHOUT copying it (getGuildStore clones the
// whole guild on every call in Postgres mode). Used on hot paths such as
// "is this message in a tournament channel?" — callers must never mutate it.
function peekGuildStore(guildId) {
  const all = cache || loadFile();
  return all[guildId] || null;
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

// ------------------------------------------------------------ global config
// A handful of settings (currently: admin-added Gemini API keys — see
// ss-verify-panel's "API Keys" screen) aren't per-guild, so they're stored
// under this reserved pseudo-guild-id instead. Real Discord guild IDs are
// always numeric snowflakes, so "__global__" can never collide with one.
// Reuses the exact same file / Postgres plumbing as guild data.
const GLOBAL_ID = '__global__';

function getGlobalData() {
  const all = cache || loadFile();
  const g = all[GLOBAL_ID];
  const data = g ? (cache ? clone(g) : g) : {};
  if (data.extraApiKeys === undefined) data.extraApiKeys = [];
  return data;
}

function saveGlobalData(data) {
  if (cache) {
    cache[GLOBAL_ID] = clone(data);
    persistGuild(GLOBAL_ID, cache[GLOBAL_ID]);
    return;
  }
  const all = loadFile();
  all[GLOBAL_ID] = data;
  saveFile(all);
}

module.exports = {
  initStorage, flushStorage,
  getGuildStore, peekGuildStore, saveGuildStore, listGuildIds, loadAll, saveAll, DATA_FILE,
  getGlobalData, saveGlobalData,
};
