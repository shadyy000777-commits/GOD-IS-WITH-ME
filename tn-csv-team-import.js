// Shared logic for turning a "kraftob"-style CSV export (columns: Reg Posi,
// Team Name, Leader, Leader ID, Teammates, Teammates in Server, Jump URL)
// into a tournament object matching this bot's own shape. Used by both
// import-teams-from-csv.js (manual CLI run) and auto-import-on-boot.js
// (automatic run at bot startup, controlled by env vars).

const { generateTournamentId } = require('./tn-tournament-store');

const DEFAULT_GROUP_CAPACITY = 20;
const GROUP_LETTERS = Array.from({ length: 1000 }, (_, i) => String(i + 1));

// Minimal CSV line splitter that respects double-quoted fields (in case a
// future export quotes fields containing commas), even though the known
// BGMI-kraftob export format doesn't use double quotes at all.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const header = parseCsvLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

// "name (id)" pairs separated by " | "
function parseTeammates(cell) {
  if (!cell) return [];
  return cell.split('|').map(part => {
    const m = part.trim().match(/^(.*)\((\d+)\)\s*$/);
    if (!m) return null;
    return { username: m[1].trim(), id: m[2] };
  }).filter(Boolean);
}

function stripQuotes(s) {
  return (s || '').trim().replace(/^'+|'+$/g, '');
}

// Turns CSV text into { tournament, report }. Options:
//   perGroup: teams per group (default 20)
//   raw: true = every row kept exactly as-is, no dedup/trim/skip (default false)
function buildTournamentFromCsv(csvText, tournamentName, { perGroup = DEFAULT_GROUP_CAPACITY, raw = false } = {}) {
  const rows = parseCsv(csvText);

  const seenTeamNames = new Set();
  const claimedPlayerIds = new Set();
  const keptTeams = [];
  const report = {
    totalRows: rows.length,
    skippedDuplicateName: 0,
    skippedTooSmall: 0,
    ownerSubstituted: [],
  };

  for (const row of rows) {
    const teamName = (row['Team Name'] || '').trim();
    if (!teamName) continue;

    const leaderName = (row['Leader'] || '').trim();
    const leaderId = stripQuotes(row['Leader ID']);
    const teammates = parseTeammates(row['Teammates']);

    if (raw) {
      keptTeams.push({
        team: teamName,
        playerIds: teammates.map(p => p.id),
        players: teammates.map(p => `<@${p.id}>`),
        ownerId: leaderId,
        ownerName: leaderName,
        whatsapp: '',
        playerIgns: teammates.map(p => p.username),
        playerUids: [],
      });
      continue;
    }

    const nameKey = teamName.toLowerCase();
    if (seenTeamNames.has(nameKey)) {
      report.skippedDuplicateName++;
      continue;
    }

    const ordered = [{ username: leaderName, id: leaderId }, ...teammates];
    const localSeen = new Set();
    const deduped = [];
    for (const p of ordered) {
      if (!p.id || localSeen.has(p.id)) continue;
      localSeen.add(p.id);
      deduped.push(p);
    }
    const trimmed = deduped.slice(0, 4);
    const kept = trimmed.filter(p => !claimedPlayerIds.has(p.id));

    if (kept.length < 3) {
      report.skippedTooSmall++;
      continue;
    }

    seenTeamNames.add(nameKey);
    for (const p of kept) claimedPlayerIds.add(p.id);

    let ownerId = leaderId;
    let ownerName = leaderName;
    if (!kept.some(p => p.id === leaderId)) {
      ownerId = kept[0].id;
      ownerName = kept[0].username;
      report.ownerSubstituted.push({ team: teamName, originalLeader: leaderName, newOwner: ownerName });
    }

    keptTeams.push({
      team: teamName,
      playerIds: kept.map(p => p.id),
      players: kept.map(p => `<@${p.id}>`),
      ownerId,
      ownerName,
      whatsapp: '',
      playerIgns: kept.map(p => p.username),
      playerUids: [],
    });
  }

  const groups = {};
  keptTeams.forEach((team, i) => {
    const groupIndex = Math.floor(i / perGroup);
    const letter = GROUP_LETTERS[groupIndex];
    if (!groups[letter]) groups[letter] = { capacity: perGroup, teams: [] };
    groups[letter].teams.push(team);
  });
  if (keptTeams.length > 0) {
    const lastLetter = GROUP_LETTERS[Math.floor((keptTeams.length - 1) / perGroup)];
    if (lastLetter && groups[lastLetter]) {
      groups[lastLetter].capacity = Math.max(groups[lastLetter].capacity, groups[lastLetter].teams.length);
    }
  }

  const tournament = {
    id: generateTournamentId(),
    name: tournamentName,
    open: false,
    groups,
    qualified: [],
    bannedTeams: [],
    slotManagerChannelId: null,
    confirmChannelId: null,
    requiredMentions: 4,
    allowFakeTag: false,
    teamsPerGroup: perGroup,
    totalSlots: null,
    rounds: {},
  };

  report.teamsImported = keptTeams.length;
  report.groupsCreated = Object.keys(groups).length;

  return { tournament, report };
}

module.exports = { buildTournamentFromCsv };
