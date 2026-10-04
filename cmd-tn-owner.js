const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { canManageBot } = require('./tn-access');
const { listTournaments, getTournamentById } = require('./tn-tournament-store');
const { groupSlotNumber } = require('./tn-slots');

// ---------------------------------------------------------------------------
// /owner — look up who registered which team in a tournament.
//   /owner tournament:<pick>                     → every registered team + its owner
//   /owner tournament:<pick> player:@someone     → the team(s) that player owns or plays in
//   /owner tournament:<pick> team:<name>         → teams whose name / owner name matches
// Staff only (Manage Server, ALLOWED_USER_IDS, or the TOURNAMENT ELITE role) —
// the result includes WhatsApp numbers, so it is always shown privately.
// ---------------------------------------------------------------------------

const MAX_DETAIL_EMBEDS = 10;

function sortedGroupKeys(groups) {
  return Object.keys(groups || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Every Round 1 registration, in group / slot order.
function listRegistrations(tournament) {
  const out = [];
  for (const letter of sortedGroupKeys(tournament.groups)) {
    const group = tournament.groups[letter];
    (group.teams || []).forEach((team, idx) => {
      out.push({ letter, slot: groupSlotNumber(group, idx), team });
    });
  }
  return out;
}

function roundName(tournament, roundNum) {
  const saved = (tournament.rounds && tournament.rounds[roundNum]) || {};
  return (saved.displayName || '').trim() || `Round ${roundNum}`;
}

// Where the team is now if it has been promoted past Round 1 (highest round wins).
function laterRoundSpot(tournament, team) {
  let spot = null;
  for (const [key, round] of Object.entries(tournament.rounds || {})) {
    const roundNum = parseInt(key, 10);
    if (!(roundNum > 1)) continue;
    for (const letter of sortedGroupKeys(round.groups)) {
      const group = round.groups[letter];
      const idx = (group.teams || []).findIndex(t => t.ownerId === team.ownerId && t.team === team.team);
      if (idx !== -1 && (!spot || roundNum > spot.roundNum)) {
        spot = { roundNum, letter, slot: groupSlotNumber({ ...group, round: roundNum }, idx) };
      }
    }
  }
  return spot;
}

function ownerLabel(team) {
  const mention = team.ownerId ? `<@${team.ownerId}>` : '_unknown_';
  return team.ownerName ? `${mention} (${team.ownerName})` : mention;
}

function detailEmbed(tournament, entry) {
  const { letter, slot, team } = entry;
  const embed = new EmbedBuilder()
    .setTitle(`${team.team}`.slice(0, 256))
    .setColor(0x5865F2)
    .setFooter({ text: tournament.name || 'Tournament' });
  embed.addFields(
    { name: 'Registered in', value: `Group ${letter} · Slot ${slot}`, inline: true },
    { name: 'Owner', value: ownerLabel(team), inline: true },
  );
  if (team.ownerId) embed.addFields({ name: 'Owner ID', value: `\`${team.ownerId}\``, inline: true });
  if (team.whatsapp) embed.addFields({ name: 'WhatsApp', value: String(team.whatsapp).slice(0, 1024), inline: true });
  const players = (team.playerIgns || []).map((ign, i) => {
    const uid = (team.playerUids || [])[i];
    return `**P${i + 1}** — ${ign}${uid ? ` (${uid})` : ''}`;
  });
  if (players.length) embed.addFields({ name: 'Players', value: players.join('\n').slice(0, 1024) });
  const tags = (team.playerIds || []).map(id => `<@${id}>`);
  if (tags.length) embed.addFields({ name: 'Discord Tags', value: tags.join(' ').slice(0, 1024) });
  const later = laterRoundSpot(tournament, team);
  if (later) {
    embed.addFields({ name: 'Now in', value: `${roundName(tournament, later.roundNum)} · Group ${later.letter} · Slot ${later.slot}` });
  }
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('owner')
    .setDescription('See who registered which team in a tournament')
    .addStringOption(opt =>
      opt.setName('tournament')
        .setDescription('The tournament to look in')
        .setAutocomplete(true)
        .setRequired(true))
    .addUserOption(opt =>
      opt.setName('player')
        .setDescription('Show the team(s) this player owns or plays in')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('team')
        .setDescription('Search by team name or owner name')
        .setRequired(false)),

  async autocomplete(interaction) {
    if (!canManageBot(interaction.member)) return interaction.respond([]);
    const typed = String(interaction.options.getFocused() || '').toLowerCase();
    const choices = listTournaments(interaction.guildId)
      .filter(t => !typed || String(t.name || '').toLowerCase().includes(typed))
      .slice(0, 25)
      .map(t => ({ name: String(t.name || t.id).slice(0, 100), value: t.id }));
    return interaction.respond(choices);
  },

  async execute(interaction) {
    if (!canManageBot(interaction.member)) {
      return interaction.reply({ content: '❌ You\'re not authorized to use this command.', flags: MessageFlags.Ephemeral });
    }

    const tournament = getTournamentById(interaction.guildId, interaction.options.getString('tournament'));
    if (!tournament) {
      return interaction.reply({ content: '❌ I couldn\'t find that tournament — pick one from the list.', flags: MessageFlags.Ephemeral });
    }

    const player = interaction.options.getUser('player');
    const search = (interaction.options.getString('team') || '').trim().toLowerCase();
    let entries = listRegistrations(tournament);
    if (player) {
      entries = entries.filter(e => e.team.ownerId === player.id || (e.team.playerIds || []).includes(player.id));
    }
    if (search) {
      entries = entries.filter(e => String(e.team.team || '').toLowerCase().includes(search)
        || String(e.team.ownerName || '').toLowerCase().includes(search));
    }

    const filtered = Boolean(player || search);
    if (!entries.length) {
      const what = player ? `<@${player.id}>` : search ? `"${search}"` : 'anyone';
      return interaction.reply({
        content: `❌ No registration found for ${what} in **${tournament.name || 'this tournament'}**.`,
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral,
      });
    }

    // A specific lookup — full details, one embed per team.
    if (filtered && entries.length <= MAX_DETAIL_EMBEDS) {
      return interaction.reply({
        content: `🔎 **${tournament.name || 'Tournament'}** — ${entries.length} registration${entries.length === 1 ? '' : 's'} found`,
        embeds: entries.map(e => detailEmbed(tournament, e)),
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral,
      });
    }

    // Whole tournament (or a very broad search) — one line per team.
    const lines = entries.map(e => `\`G${e.letter} · S${e.slot}\` **${e.team.team}** — ${ownerLabel(e.team)}`);
    const body = lines.join('\n');
    if (body.length <= 3900) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`📋 ${tournament.name || 'Tournament'} — ${entries.length} team${entries.length === 1 ? '' : 's'}`)
          .setColor(0x5865F2)
          .setDescription(body)
          .setFooter({ text: 'Use the player or team option for full details.' })],
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral,
      });
    }
    const text = entries.map(e => `Group ${e.letter} · Slot ${e.slot} | ${e.team.team} | Owner: ${e.team.ownerName || '-'} (${e.team.ownerId || '-'}) | WhatsApp: ${e.team.whatsapp || '-'}`).join('\n');
    return interaction.reply({
      content: `📋 **${tournament.name || 'Tournament'}** — ${entries.length} teams (too many to show here, so it's attached).`,
      files: [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: 'registrations.txt' })],
      flags: MessageFlags.Ephemeral,
    });
  },
};
