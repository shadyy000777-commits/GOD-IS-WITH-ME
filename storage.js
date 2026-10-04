const fs = require('fs');
const path = require('path');
const { todayDayNumber } = require('./group-schedule');
const db = require('./db');

// ---------------------------------------------------------------------
// Storage backend
// ---------------------------------------------------------------------
// Source of truth is PostgreSQL (set DATABASE_URL — Railway's Postgres
// plugin injects this automatically once attached to this service), so
// data survives redeploys, code pushes, and Railway wiping the container
// filesystem.
//
// Every function below (getGuildStore, saveGuildStore, getDmThread,
// setDmThread, listGuildIds, loadAll, saveAll) keeps its original
// SYNCHRONOUS signature — none of the ~40 files that call these need to
// change. That's possible because the whole dataset is kept in an
// in-memory cache (`cache`) that's hydrated once at startup from Postgres
// via initStorage() (called from index.js before the bot logs in), and
// every write updates that cache immediately (so reads within the same
// process are always instantly consistent) while the Postgres write
// happens in the background.
//
// Trade-off: because the DB write is fire-and-forget, if the process
// crashes in the split second between a write and that write reaching
// Postgres, that one write can be lost. That was a deliberate choice to
// keep every command/button handler fast and to avoid touching every
// call site to `await` a save.
//
// If DATABASE_URL isn't set at all (e.g. running locally without a
// database), this falls back to the original data.json file behavior so
// local development still works with zero setup.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_TOTAL_SLOTS = 20000;

function defaultScrim() {
  return { scrimName: 'BGMI Scrim', totalSlots: DEFAULT_TOTAL_SLOTS, slots: {}, createdDayNumber: todayDayNumber() };
}

// In-memory cache of the entire dataset — same shape as the old
// data.json: { "<guildId>": {...}, "_dmThreads": {...} }
let cache = null;

function readLegacyFile() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (err) {
      console.error('[storage] Failed to parse existing data.json:', err.message);
    }
  }
  // Also check next to this file, in case DATA_DIR points at a volume
  // that doesn't have it yet but the old in-repo copy does (same
  // migration case the original storage.js handled).
  const legacyPath = path.join(__dirname, 'data.json');
  if (DATA_FILE !== legacyPath && fs.existsSync(legacyPath)) {
    try {
      return JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    } catch (err) {
      console.error('[storage] Failed to parse legacy data.json:', err.message);
    }
  }
  return null;
}

// Must be awaited once, before the bot logs in (see index.js). Loads the
// cache from Postgres; if Postgres has nothing yet, seeds it from
// whatever data.json is lying around (old volume/local data) so a
// first-time migration to Postgres doesn't lose existing registrations.
async function initStorage() {
  if (db.isEnabled()) {
    try {
      const dbData = await db.loadFromDb();
      if (dbData !== null) {
        cache = dbData;
        console.log('[storage] Loaded data from PostgreSQL.');
        return;
      }
      // Nothing in Postgres yet — one-time seed from any existing
      // data.json so switching to Postgres doesn't wipe current data.
      const legacy = readLegacyFile();
      cache = legacy || {};
      await db.saveToDb(cache);
      console.log(legacy
        ? '[storage] Migrated existing data.json into PostgreSQL.'
        : '[storage] Initialized empty PostgreSQL storage.');
    } catch (err) {
      console.error('[storage] Failed to connect to PostgreSQL, falling back to data.json for this run:', err.message);
      cache = readLegacyFile() || {};
    }
  } else {
    console.warn('[storage] DATABASE_URL not set — using data.json only. Data will NOT survive a redeploy on hosts with an ephemeral filesystem (e.g. Railway without this set).');
    cache = readLegacyFile() || {};
  }
}

function persist() {
  // Always keep data.json as a local snapshot too (cheap, harmless, and
  // useful if you ever need to inspect/back up the data by hand) —
  // but Postgres, when enabled, is the copy that actually survives a
  // redeploy.
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    // Non-fatal: e.g. read-only filesystem on some hosts. Postgres is
    // the real source of truth when it's enabled.
    console.error('[storage] Failed to write local data.json snapshot:', err.message);
  }

  if (db.isEnabled()) {
    db.saveToDb(cache).catch((err) => {
      console.error('[storage] Failed to save to PostgreSQL:', err.message);
    });
  }
}

function loadAll() {
  if (cache === null) {
    // Safety net: something called a storage function before
    // initStorage() finished (shouldn't happen — index.js awaits it
    // before login — but better than crashing).
    console.error('[storage] loadAll() called before initStorage() completed — reading data.json synchronously as a fallback.');
    cache = readLegacyFile() || {};
  }
  return cache;
}

function saveAll(data) {
  cache = data;
  persist();
}

function getGuildStore(guildId) {
  const all = loadAll();
  if (!all[guildId]) {
    all[guildId] = { scrim: defaultScrim(), tournament: null, warnings: {}, verifications: {}, ssVerifications: {}, teams: {}, settings: {}, embeds: {} };
    saveAll(all);
  }
  // backfill in case an older record is missing newer keys
  if (!all[guildId].scrim) all[guildId].scrim = defaultScrim();
  if (all[guildId].tournament === undefined) all[guildId].tournament = null;
  if (all[guildId].warnings === undefined) all[guildId].warnings = {};
  if (all[guildId].verifications === undefined) all[guildId].verifications = {};
  if (all[guildId].ssVerifications === undefined) all[guildId].ssVerifications = {};
  if (all[guildId].teams === undefined) all[guildId].teams = {};
  if (all[guildId].settings === undefined) all[guildId].settings = {};
  if (all[guildId].embeds === undefined) all[guildId].embeds = {};
  return all[guildId];
}

function saveGuildStore(guildId, guildData) {
  const all = loadAll();
  all[guildId] = guildData;
  saveAll(all);
}

// Tracks the most recent /dm sent to each Discord user, globally (not
// scoped to one guild — DM channels have no guild context of their own).
// Lets a later reply in that DM get relayed back to wherever it came from.
// Stored under a reserved top-level key that can never collide with a real
// guild ID (guild IDs are pure numeric snowflakes).
function getDmThread(userId) {
  const all = loadAll();
  return (all._dmThreads && all._dmThreads[userId]) || null;
}

function setDmThread(userId, thread) {
  const all = loadAll();
  if (!all._dmThreads) all._dmThreads = {};
  all._dmThreads[userId] = thread;
  saveAll(all);
}

function listGuildIds() {
  return Object.keys(loadAll()).filter((key) => key !== '_dmThreads');
}

module.exports = { initStorage, getGuildStore, saveGuildStore, getDmThread, setDmThread, listGuildIds, loadAll, saveAll };
