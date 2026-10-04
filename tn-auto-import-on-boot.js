// Optional: automatically imports a CSV of team registrations into a new
// tournament once, at bot startup — no command-line usage needed. Controlled
// entirely by environment variables, so it can be set up purely through
// Railway's dashboard (Variables tab) plus pushing the CSV file to GitHub.
//
// Set these Railway variables to turn it on:
//   AUTO_IMPORT_CSV              Path to the CSV file, relative to the repo
//                                 root (e.g. "100k-tournament.csv" — commit
//                                 the file itself alongside your bot's code).
//   AUTO_IMPORT_GUILD_ID          The Discord server (guild) ID to import into.
//   AUTO_IMPORT_TOURNAMENT_NAME   Name for the new tournament, e.g. "100K TOURNAMENT".
//   AUTO_IMPORT_PER_GROUP         Optional. Teams per group. Default: 20.
//   AUTO_IMPORT_RAW               Optional. "true" = import every row exactly
//                                 as-is (default). "false" = the safe/deduped
//                                 mode (skips duplicate team names, drops a
//                                 player from every team after their first,
//                                 skips teams that fall below 3 players).
//
// Safe to leave these variables in place indefinitely: this checks first
// whether a tournament with that exact name already exists in that guild,
// and skips (does nothing) if it does — so it will NOT re-import and create
// duplicates on every restart. To import again on purpose, either rename
// AUTO_IMPORT_TOURNAMENT_NAME or delete the previous tournament first.
//
// If AUTO_IMPORT_CSV isn't set, this entire module is a no-op — completely
// inert for normal bot operation.

const fs = require('fs');
const path = require('path');
const { getGuildStore, saveGuildStore } = require('./tn-storage');
const { buildTournamentFromCsv } = require('./tn-csv-team-import');

async function runAutoImportOnBoot() {
  const csvPath = process.env.AUTO_IMPORT_CSV;
  if (!csvPath) return; // not configured — do nothing

  const guildId = process.env.AUTO_IMPORT_GUILD_ID;
  const tournamentName = process.env.AUTO_IMPORT_TOURNAMENT_NAME;
  const perGroup = parseInt(process.env.AUTO_IMPORT_PER_GROUP, 10) || 20;
  const raw = process.env.AUTO_IMPORT_RAW !== 'false'; // default true

  if (!guildId || !tournamentName) {
    console.error('[auto-import] AUTO_IMPORT_CSV is set but AUTO_IMPORT_GUILD_ID or AUTO_IMPORT_TOURNAMENT_NAME is missing — skipping auto-import.');
    return;
  }

  let resolvedPath = path.isAbsolute(csvPath) ? csvPath : path.join(__dirname, csvPath);
  // The bundled files carry a "tn-" prefix in the combined bot, so a value like
  // "100k-tournament.csv" (the old standalone name) still resolves.
  if (!fs.existsSync(resolvedPath) && !path.isAbsolute(csvPath)) {
    const prefixed = path.join(__dirname, 'tn-' + csvPath);
    if (fs.existsSync(prefixed)) resolvedPath = prefixed;
  }
  if (!fs.existsSync(resolvedPath)) {
    console.error(`[auto-import] CSV not found at ${resolvedPath} — skipping auto-import.`);
    return;
  }

  const store = getGuildStore(guildId);
  const already = Object.values(store.tournaments || {}).some(t => t.name === tournamentName);
  if (already) {
    console.log(`[auto-import] Tournament "${tournamentName}" already exists in guild ${guildId} — skipping (no duplicate import).`);
    return;
  }

  console.log(`[auto-import] Importing ${resolvedPath} into guild ${guildId} as "${tournamentName}" (raw=${raw}, perGroup=${perGroup})...`);
  const csvText = fs.readFileSync(resolvedPath, 'utf8');
  const { tournament, report } = buildTournamentFromCsv(csvText, tournamentName, { perGroup, raw });

  store.tournaments[tournament.id] = tournament;
  saveGuildStore(guildId, store);

  console.log(`[auto-import] Done. Rows read: ${report.totalRows}, teams imported: ${report.teamsImported}, groups: ${report.groupsCreated}` +
    (raw ? '' : `, skipped (dup name): ${report.skippedDuplicateName}, skipped (too small): ${report.skippedTooSmall}, owner substituted: ${report.ownerSubstituted.length}`));
}

module.exports = { runAutoImportOnBoot };
