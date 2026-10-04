// One-time helper: imports team registrations exported from another bot's
// CSV (columns: Reg Posi, Team Name, Leader, Leader ID, Teammates,
// Teammates in Server, Jump URL) into a brand-new tournament in THIS bot.
//
//   node import-teams-from-csv.js <path-to-csv> <guildId> "<tournament name>" [--per-group=20] [--dry-run] [--raw]
//
// Example (raw, exactly as the CSV has it — every row, no filtering):
//   node import-teams-from-csv.js sample-import.csv 1538500688038994040 "100K TOURNAMENT" --per-group=20 --raw
//
// Prefer not to run commands at all? See auto-import-on-boot.js instead —
// it does the same import automatically at bot startup, controlled purely
// by Railway environment variables (no terminal needed).
//
// TWO MODES:
//
// --raw (every row becomes a team, unmodified):
//   - Team name kept exactly as in the CSV, even if duplicated.
//   - Every teammate in the "Teammates" column is kept (no trimming to 4,
//     subs included).
//   - ownerId/ownerName always come straight from the Leader/Leader ID
//     columns, even on rows where the leader isn't actually listed in the
//     Teammates column for that row.
//   - No player-appears-on-multiple-teams check.
//   - Nothing is skipped. Row count in == team count out.
//
// Default mode (safe/deduped, used when --raw is NOT passed):
//   1. Builds each team's player list as [Leader, ...Teammates], de-duped
//      by Discord ID, then trims to the first 4 (BGMI squad size) —
//      guarantees the captain survives the trim.
//   2. Skips a team if its name (case-insensitive) was already used by an
//      earlier row — the earlier row wins.
//   3. Removes any player already claimed by an earlier KEPT team. If that
//      leaves a team with fewer than 3 players, the whole team is skipped
//      (its players are NOT reserved, so they stay free for a later team).
//   4. If the leader ends up removed by rule 3, falls back to the first
//      remaining player as owner and flags it in the report.
//
// Either way:
//   - Creates a new tournament (open: false, teamsPerGroup: <per-group>)
//     and fills groups "1", "2", "3"... at <per-group> capacity each, in
//     CSV order.
//   - Saves it into the target guild's store via storage.js — same
//     Postgres/JSON backend the bot itself uses (respects DATABASE_URL).
//   - Nothing is written with --dry-run: it only prints the report.
//   - Safe to re-run: always creates a NEW tournament (never edits an
//     existing one), so running it twice just gives you two tournaments.

const fs = require('fs');
const { initStorage, flushStorage, getGuildStore, saveGuildStore } = require('./tn-storage');
const { buildTournamentFromCsv } = require('./tn-csv-team-import');

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const rawMode = rawArgs.includes('--raw');
const positional = rawArgs.filter(a => !a.startsWith('--'));
const perGroupArg = rawArgs.find(a => a.startsWith('--per-group='));
const perGroup = perGroupArg ? parseInt(perGroupArg.split('=')[1], 10) : 20;

const [csvPath, guildId, tournamentName] = positional;

if (!csvPath || !guildId || !tournamentName) {
  console.error('Usage: node import-teams-from-csv.js <path-to-csv> <guildId> "<tournament name>" [--per-group=20] [--dry-run] [--raw]');
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error(`CSV file not found: ${csvPath}`);
  process.exit(1);
}
if (!Number.isInteger(perGroup) || perGroup < 1) {
  console.error('--per-group must be a positive whole number.');
  process.exit(1);
}

async function main() {
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const { tournament, report } = buildTournamentFromCsv(csvText, tournamentName, { perGroup, raw: rawMode });

  console.log('--- Import report ---');
  console.log(`Mode:                       ${rawMode ? 'RAW (no filtering)' : 'safe (deduped)'}`);
  console.log(`CSV rows read:              ${report.totalRows}`);
  if (!rawMode) {
    console.log(`Skipped (duplicate name):   ${report.skippedDuplicateName}`);
    console.log(`Skipped (<3 players left):  ${report.skippedTooSmall}`);
  }
  console.log(`Teams imported:             ${report.teamsImported}`);
  console.log(`Groups created:             ${report.groupsCreated} (capacity ${perGroup} each)`);
  if (!rawMode) console.log(`Owner substituted:          ${report.ownerSubstituted.length}`);
  if (report.ownerSubstituted.length) {
    console.log('  (leader missing from kept players — first remaining teammate used instead)');
    report.ownerSubstituted.slice(0, 20).forEach(s => {
      console.log(`   - "${s.team}": ${s.originalLeader} -> ${s.newOwner}`);
    });
    if (report.ownerSubstituted.length > 20) {
      console.log(`   ... and ${report.ownerSubstituted.length - 20} more`);
    }
  }

  if (dryRun) {
    console.log('\n--dry-run set: nothing was written to the database/file.');
    return;
  }

  await initStorage();
  const store = getGuildStore(guildId);
  store.tournaments[tournament.id] = tournament;
  saveGuildStore(guildId, store);
  await flushStorage();

  console.log(`\nSaved tournament "${tournamentName}" (id: ${tournament.id}) into guild ${guildId}.`);
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
