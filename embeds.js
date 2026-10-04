const { EmbedBuilder } = require('discord.js');

// Discord embeds cap at 25 fields, and each field here covers 20 slots —
// so one page tops out at 500 slots. Large scrims (thousands of slots)
// need multiple pages; callers page through with Prev/Next buttons.
const FIELD_CHUNK_SIZE = 20;
const SLOTS_PER_PAGE = FIELD_CHUNK_SIZE * 25;

function buildSlotListEmbed(scrim, page = 0) {
  const totalPages = Math.max(1, Math.ceil(scrim.totalSlots / SLOTS_PER_PAGE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);

  const embed = new EmbedBuilder()
    .setTitle(`<a:emoji_14:1544290922043543552> ${scrim.scrimName || 'BGMI Scrim'} — Slot List`)
    .setColor(0x57F287)
    .setFooter({
      text: totalPages > 1
        ? `Registration OPEN 24/7 • Page ${clampedPage + 1}/${totalPages}`
        : 'Registration OPEN 24/7',
    });

  const filled = Object.keys(scrim.slots).length;
  embed.setDescription(`Slots filled: **${filled}/${scrim.totalSlots}**`);

  const rangeStart = clampedPage * SLOTS_PER_PAGE + 1;
  const rangeEnd = Math.min(rangeStart + SLOTS_PER_PAGE - 1, scrim.totalSlots);

  for (let chunkStart = rangeStart; chunkStart <= rangeEnd; chunkStart += FIELD_CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + FIELD_CHUNK_SIZE - 1, rangeEnd);
    const lines = [];
    for (let i = chunkStart; i <= chunkEnd; i++) {
      const s = scrim.slots[i];
      lines.push(s ? `**Slot ${i}:** ${s.team}` : `**Slot ${i}:** _empty_`);
    }
    embed.addFields({ name: `${chunkStart}-${chunkEnd}`, value: lines.join('\n') });
  }

  return { embed, page: clampedPage, totalPages };
}

function buildGroupsEmbed(tournament) {
  const embed = new EmbedBuilder()
    .setTitle(`🥇 ${tournament.name || 'Tournament'} — Groups`)
    .setColor(tournament.open ? 0x57F287 : 0xED4245)
    .setFooter({ text: tournament.open ? 'Registration OPEN' : 'Registration CLOSED' });

  for (const [groupName, group] of Object.entries(tournament.groups)) {
    const lines = group.teams.length
      ? group.teams.map((t, idx) => `${idx + 1}. **${t.team}** — ${t.players.join(', ')}`)
      : ['_no teams yet_'];
    embed.addFields({
      name: `Group ${groupName} (${group.teams.length}/${group.capacity})`,
      value: lines.join('\n'),
    });
  }

  if (tournament.qualified.length) {
    embed.addFields({
      name: '✅ Qualified',
      value: tournament.qualified.map(t => `**${t}**`).join(', '),
    });
  }

  return embed;
}

// Auto-generates a numbered slot list for one tournament group straight from
// its registered teams + capacity — same idea as buildSlotListEmbed for
// scrims, just keyed off tournament.groups[letter] instead of scrim.slots.
// Slot numbers are assigned by registration order (team #1 -> Slot 1, etc.),
// so there's nothing to maintain by hand: add/remove a team and the next
// call reflects it automatically.
function buildTournamentSlotListEmbed(tournament, letter, group, roundNum = 1) {
  const label = roundNum > 1 ? `Round ${roundNum} — Group ${letter}` : `Group ${letter}`;
  const embed = new EmbedBuilder()
    .setTitle(`📋 ${tournament.name || 'Tournament'} — ${label} Slot List`)
    .setColor(tournament.open ? 0x57F287 : 0xED4245)
    .setFooter({ text: tournament.open ? 'Registration OPEN' : 'Registration CLOSED' });

  if (!group) {
    embed.setDescription(`❌ Group **${letter}** doesn't exist.`);
    return embed;
  }

  embed.setDescription(`Slots filled: **${group.teams.length}/${group.capacity}**`);

  for (let chunkStart = 1; chunkStart <= group.capacity; chunkStart += FIELD_CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + FIELD_CHUNK_SIZE - 1, group.capacity);
    const lines = [];
    for (let i = chunkStart; i <= chunkEnd; i++) {
      const team = group.teams[i - 1];
      lines.push(team ? `**Slot ${i}:** ${team.team}` : `**Slot ${i}:** _empty_`);
    }
    embed.addFields({ name: `${chunkStart}-${chunkEnd}`, value: lines.join('\n') });
  }

  return embed;
}

// Posted to a group's own channel when an admin submits that group's
// result via the group admin panel's Result button (see
// group-admin-handlers.js). Purely an announcement — no roles are given
// out for this. Lists the two qualified teams as:
//   ## __QUALIFIED TEAMS FOR T3 | G5__
//   - TEAM NAME (S5) - 40 pts <@owner>
// Placements that failed to resolve (empty slot etc.) are left out.
function buildGroupResultEmbed(groupDisplayNameStr, placements) {
  const groupShort = String(groupDisplayNameStr).replace(/^Group\s*/i, 'G');

  const lines = placements
    .filter(p => !p.error)
    .map((p) => {
      const pts = p.points ? ` - ${p.points} pts` : '';
      return `- ${p.team} (S${p.localNum})${pts} <@${p.userId}>`;
    });

  return new EmbedBuilder()
    .setColor(0xFEE75C)
    .setDescription(`## __QUALIFIED TEAMS FOR T3 | ${groupShort}__\n${lines.join('\n') || '_No qualified teams._'}`);
}

module.exports = { buildSlotListEmbed, buildGroupsEmbed, buildTournamentSlotListEmbed, buildGroupResultEmbed };
