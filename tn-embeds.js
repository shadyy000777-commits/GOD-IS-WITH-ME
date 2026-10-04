const { EmbedBuilder } = require('discord.js');
const { LOCKED_SLOTS, isLockedSlot, slotNumber, groupSlotNumber } = require('./tn-slots');

// The whole slot list (Slots 1-25) is shown as ONE block. It only splits into
// a second block if the names are so long the field would exceed Discord's
// 1024-character limit (see FIELD_VALUE_LIMIT below).
const FIELD_CHUNK_SIZE = 50;

function buildGroupsEmbed(tournament) {
  const embed = new EmbedBuilder()
    .setTitle(`🥇 ${tournament.name || 'Tournament'} — Groups`)
    .setColor(tournament.open ? 0x57F287 : 0xED4245)
    .setFooter({ text: tournament.open ? 'Registration OPEN' : 'Registration CLOSED' });

  for (const [groupName, group] of Object.entries(tournament.groups)) {
    const lines = group.teams.length
      ? group.teams.map((t, idx) => `${groupSlotNumber(group, idx)}. **${t.team}** — ${t.players.join(', ')}`)
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
// `roundName` is the round's display name (Round Name / Category Name /
// "Round N") — the title uses it instead of "Group X", matching the group
// admin panel.
function buildTournamentSlotListEmbed(tournament, letter, group, roundNum = 1, roundName = null) {
  const label = roundName || (roundNum > 1 ? `Round ${roundNum}` : 'Round 1');
  const embed = new EmbedBuilder()
    .setTitle(`📋 ${tournament.name || 'Tournament'} — ${label} Slot List`)
    .setColor(0x6E3232)
    .setFooter({ text: tournament.open ? 'Registration OPEN' : 'Registration CLOSED' });

  if (!group) {
    embed.setDescription(`❌ Group **${letter}** doesn't exist.`);
    return embed;
  }

  embed.setDescription(`Slots filled: **${group.teams.length}/${group.capacity}**`);

  // Locked slots (see slots.js) are shown as locked and never given to a team
  // — unless Manually Add Slot placed an overflow team there once the group
  // was already full, in which case that team shows on its locked slot's row.
  // Slots are listed in monospace code blocks ("Slot 6:  Team"), grouped into
  // fields titled "Slots 1-20", "Slots 21-25" etc. Owners are NOT tagged.
  // Discord caps an embed field's value at 1024 characters, so a field is
  // closed as soon as it reaches FIELD_CHUNK_SIZE lines OR would go over it.
  const FIELD_VALUE_LIMIT = 1024 - 8; // room for the ``` fences
  const LABEL_WIDTH = 10;
  const lastSlot = Math.max(group.capacity > 0 ? slotNumber(group.capacity - 1) : 0, ...LOCKED_SLOTS);
  const slotMap = new Map();
  group.teams.forEach((team, idx) => slotMap.set(groupSlotNumber(group, idx), team));
  let chunkStart = 1;
  let lines = [];
  let length = 0;
  const flush = (last) => {
    if (!lines.length) return;
    embed.addFields({
      name: chunkStart === last ? `Slot ${chunkStart}` : `Slots ${chunkStart}-${last}`,
      value: '```\n' + lines.join('\n') + '\n```',
    });
    lines = [];
    length = 0;
  };
  for (let n = 1; n <= lastSlot; n++) {
    let name;
    const team = slotMap.get(n);
    if (team) {
      name = String(team.team).replace(/`/g, "'");
    } else {
      // Main locked slots (24, 25, 1, 2, 3) and empty slots both show the lock
      // emoji — an empty slot is just a slot nobody has taken yet.
      name = '🔒';
    }
    let line = `${`Slot ${n}:`.padEnd(LABEL_WIDTH)}${name}`;
    if (line.length > FIELD_VALUE_LIMIT) line = line.slice(0, FIELD_VALUE_LIMIT - 1) + '…';
    const added = line.length + (lines.length ? 1 : 0);
    if (lines.length && (lines.length >= FIELD_CHUNK_SIZE || length + added > FIELD_VALUE_LIMIT)) {
      flush(n - 1);
      chunkStart = n;
    }
    length += line.length + (lines.length ? 1 : 0);
    lines.push(line);
  }
  flush(lastSlot);

  return embed;
}

module.exports = { buildGroupsEmbed, buildTournamentSlotListEmbed };
