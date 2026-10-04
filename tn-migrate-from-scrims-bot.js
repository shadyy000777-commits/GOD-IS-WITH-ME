// One-time helper: copies existing tournament data out of an old Rebound
// data.json into this bot's tournament-data.json.
//
//   npm run migrate:tournament -- /path/to/old/data.json
//   (or: node tn-migrate-from-scrims-bot.js /path/to/old/data.json)
//
// - Reads the old file only; it is never modified (so it stays as a backup).
// - Copies, per server: tournaments, activeTournamentByUser, and the
//   tournament group-channels category setting.
// - Also picks up the very old single-`tournament` format if it's still there.
// - Refuses to overwrite an existing tournament-data.json unless you pass --force.
//
// Run it BEFORE starting the tournament bot for the first time (or with the
// bot stopped), so the bot isn't writing to the file at the same time.
const fs = require('fs');
const { loadAll, saveAll, DATA_FILE } = require('./tn-storage');

const args = process.argv.slice(2);
const force = args.includes('--force');
const oldPath = args.find(a => !a.startsWith('--'));

if (!oldPath) {
  console.error('Usage: node tn-migrate-from-scrims-bot.js <path-to-old-data.json> [--force]');
  process.exit(1);
}
if (!fs.existsSync(oldPath)) {
  console.error(`Old data file not found: ${oldPath}`);
  process.exit(1);
}
if (fs.existsSync(DATA_FILE) && !force) {
  console.error(`${DATA_FILE} already exists — refusing to overwrite it. Re-run with --force if you really want to.`);
  process.exit(1);
}

let old;
try {
  old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
} catch (err) {
  console.error('Could not parse the old data file as JSON:', err.message);
  process.exit(1);
}

const result = force ? loadAll() : {};
let guildsMigrated = 0;
let tournamentsMigrated = 0;

for (const [guildId, g] of Object.entries(old)) {
  if (guildId.startsWith('_') || !g || typeof g !== 'object') continue; // skip reserved keys like _dmThreads

  const tournaments = { ...(g.tournaments || {}) };
  if (g.tournament && typeof g.tournament === 'object') {
    const id = g.tournament.id || 't1';
    if (!tournaments[id]) tournaments[id] = { ...g.tournament, id };
  }
  const categoryId = g.settings && g.settings.tournamentGroupChannelsCategoryId;
  if (!Object.keys(tournaments).length && !categoryId) continue;

  const entry = result[guildId] || { tournaments: {}, activeTournamentByUser: {}, settings: {} };
  Object.assign(entry.tournaments, tournaments);
  Object.assign(entry.activeTournamentByUser, g.activeTournamentByUser || {});
  if (categoryId) entry.settings.tournamentGroupChannelsCategoryId = categoryId;
  result[guildId] = entry;

  guildsMigrated++;
  tournamentsMigrated += Object.keys(tournaments).length;
}

saveAll(result);
console.log(`Migrated ${tournamentsMigrated} tournament(s) from ${guildsMigrated} server(s) into ${DATA_FILE}`);
