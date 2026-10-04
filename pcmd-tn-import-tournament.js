// !import_tournament [name]
// Loads a registration CSV (same "Reg Posi, Team Name, Leader, Leader ID,
// Teammates, ..." format as 100k-tournament.csv) into a tournament.
//
//   • Attach a .csv to the message -> that file is used.
//   • No attachment                -> the bundled 100k-tournament.csv is used.
//   • No name given                -> the tournament with "100k" in its name
//                                     (or a new "100K TOURNAMENT" if none).
//
// If the tournament ALREADY EXISTS it keeps all its settings (roles, channels,
// slot manager, rounds...) and only its team list is replaced — but only when
// it has no teams yet, so do "Reset" from the !tournament panel first (that
// also deletes the old group channels/roles). If it doesn't exist, a new
// tournament is created. Then use Auto Channels in the panel as usual:
// every team owner gets their group role + channel access.
const fs = require('fs');
const path = require('path');
const { getGuildStore, saveGuildStore } = require('./tn-storage');
const { buildTournamentFromCsv } = require('./tn-csv-team-import');

const DEFAULT_NAME = '100K TOURNAMENT';
const DEFAULT_FILE = path.join(__dirname, 'tn-100k-tournament.csv');

const countTeams = t => Object.values(t.groups || {}).reduce((n, g) => n + (g.teams || []).length, 0);

module.exports = {
  name: 'import_tournament',
  aliases: ['importtournament'],
  description: 'Load a registration CSV into a tournament (usage: !import_tournament [name], attach a .csv or use the bundled 100k one)',
  adminOnly: true,

  async execute(message, args) {
    const nameArg = args.join(' ').trim();
    const store = getGuildStore(message.guildId);
    const all = Object.values(store.tournaments || {});

    // ---- which tournament? -------------------------------------------------
    let existing = null;
    if (nameArg) {
      existing = all.find(t => t.name.toLowerCase() === nameArg.toLowerCase()) || null;
    } else {
      const matches = all.filter(t => /100\s*k/i.test(t.name));
      if (matches.length > 1) {
        return message.reply(`❌ Several tournaments look like 100K: ${matches.map(t => `\`${t.name}\``).join(', ')}. Say which one: \`!import_tournament <name>\``).catch(() => {});
      }
      existing = matches[0] || null;
    }
    const name = existing ? existing.name : (nameArg || DEFAULT_NAME);

    if (existing && countTeams(existing) > 0) {
      return message.reply(
        `❌ **${existing.name}** still has **${countTeams(existing)}** old registration(s). ` +
        `Open \`!tournament\` → select it → **Reset** (this clears the old teams and deletes its old group channels/roles), then run this command again.`,
      ).catch(() => {});
    }

    // ---- read the CSV ------------------------------------------------------
    let csvText;
    let source;
    const attachment = message.attachments.find(a => /\.csv$/i.test(a.name || ''));
    try {
      if (attachment) {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        csvText = await res.text();
        source = attachment.name;
      } else {
        csvText = fs.readFileSync(DEFAULT_FILE, 'utf8');
        source = '100k-tournament.csv (bundled)';
      }
    } catch (err) {
      return message.reply(`❌ Couldn't read the CSV: ${err.message}`).catch(() => {});
    }
    csvText = csvText.replace(/^\uFEFF/, '');

    const perGroup = (existing && parseInt(existing.teamsPerGroup, 10)) || 20;
    let result;
    try {
      result = buildTournamentFromCsv(csvText, name, { perGroup, raw: true });
    } catch (err) {
      return message.reply(`❌ That doesn't look like a valid registration CSV: ${err.message}`).catch(() => {});
    }
    const { tournament: built, report } = result;
    if (!report.teamsImported) {
      return message.reply('❌ No teams found in that CSV — nothing imported.').catch(() => {});
    }

    // ---- save --------------------------------------------------------------
    let note = '';
    if (existing) {
      // Keep every setting; only the registrations change.
      existing.groups = built.groups;
      existing.qualified = [];
      if (existing.totalSlots && existing.totalSlots < report.teamsImported) {
        note = `\n⚠️ This tournament's total slots is **${existing.totalSlots}**, but the CSV has **${report.teamsImported}** teams.`;
      }
      store.activeTournamentByUser[message.author.id] = existing.id;
    } else {
      store.tournaments[built.id] = built;
      store.activeTournamentByUser[message.author.id] = built.id;
    }
    saveGuildStore(message.guildId, store);

    await message.reply(
      `✅ **${name}** ${existing ? 'updated' : 'created'} from \`${source}\`: **${report.teamsImported}** teams in **${report.groupsCreated}** groups (${perGroup} per group).${note}\n` +
      `It's selected for you — run \`!tournament\` and use Auto Channels; each team owner gets their group role and channel access.`,
    ).catch(() => {});
  },
};
