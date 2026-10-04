const { AttachmentBuilder } = require('discord.js');
const { getGuildStore } = require('./tn-storage');

function csvValue(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  return [headers, ...rows].map(r => r.map(csvValue).join(',')).join('\r\n');
}

module.exports = {
  name: 'export_tournament',
  aliases: ['exporttournament'],
  description: 'Download a tournament\'s registrations as a CSV, in group order — usage: !export_tournament [tournament name]',
  adminOnly: true,

  async execute(message, args) {
    const store = getGuildStore(message.guildId);
    const tournaments = Object.values(store.tournaments || {});
    if (!tournaments.length) {
      return message.reply('❌ No tournament is set up yet.').catch(() => {});
    }

    let tournament;
    const nameArg = args.join(' ').trim().toLowerCase();
    if (nameArg) {
      tournament = tournaments.find(t => t.name.toLowerCase() === nameArg);
      if (!tournament) {
        const names = tournaments.map(t => `\`${t.name}\``).join(', ');
        return message.reply(`❌ No tournament named **${args.join(' ')}**. Currently running: ${names}`).catch(() => {});
      }
    } else if (tournaments.length === 1) {
      tournament = tournaments[0];
    } else {
      const names = tournaments.map(t => `\`${t.name}\``).join(', ');
      return message.reply(`❌ Several tournaments are running — say which one: \`!export_tournament <name>\`. Currently running: ${names}`).catch(() => {});
    }

    const headers = ['Group', 'Team'];
    const rows = [];
    // Groups are keyed "1".."60" — sort numerically so Group 2 comes before Group 10.
    const groupEntries = Object.entries(tournament.groups || {})
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    for (const [letter, group] of groupEntries) {
      for (const t of group.teams) rows.push([`Group ${letter}`, typeof t === 'string' ? t : t.team]);
    }

    const csv = toCsv(headers, rows);
    const filename = `tournament-${(tournament.name || 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
    const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: filename });
    await message.channel.send({
      content: `📄 Exported **${rows.length}** registration(s).${rows.length === 0 ? ' (Nothing registered yet.)' : ''}`,
      files: [attachment],
    });
  },
};
