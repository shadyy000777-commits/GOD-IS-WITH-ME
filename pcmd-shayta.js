const { EmbedBuilder, PermissionsBitField } = require('discord.js');

const SHORT_DESC_MAX = 70;

// Full descriptions carry usage syntax ("— usage: !open <group>") meant for
// error messages, not a scannable list — strip that off and cap the length
// so every row in !shayta stays short and readable.
function shortDescription(desc) {
  if (!desc) return 'No description provided.';
  let short = desc
    .split(/\s+—\s+usage:/i)[0]
    .split(/\s*\(usage:/i)[0]
    .trim();
  if (short.length > SHORT_DESC_MAX) {
    short = short.slice(0, SHORT_DESC_MAX).replace(/\s+\S*$/, '') + '…';
  }
  return short;
}

// Embed fields cap at 1024 chars and an embed caps at 25 fields, so a long
// command list gets grouped into a few fields (each holding several
// commands with a blank line between them for spacing) and, if needed,
// spread across more than one embed.
const MAX_FIELD_CHARS = 1000;
const MAX_FIELDS_PER_EMBED = 25;
const COMMANDS_PER_FIELD = 6;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function buildFields(entries) {
  const fields = [];
  for (const group of chunk(entries, COMMANDS_PER_FIELD)) {
    let value = group.map(e => `${e.name}\n${e.desc}`).join('\n\n');
    if (value.length > MAX_FIELD_CHARS) value = value.slice(0, MAX_FIELD_CHARS - 1) + '…';
    fields.push({ name: '\u200b', value });
  }
  return fields;
}

function buildEmbeds(title, color, entries, footerText) {
  if (!entries.length) return [];
  const fields = buildFields(entries);
  const fieldGroups = chunk(fields, MAX_FIELDS_PER_EMBED);

  return fieldGroups.map((group, i) => {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setFields(group)
      .setFooter({ text: footerText });
    embed.setTitle(fieldGroups.length > 1 ? `${title} (${i + 1}/${fieldGroups.length})` : title);
    return embed;
  });
}

module.exports = {
  name: 'shayta',
  aliases: [],
  description: 'Show every prefix and slash command and what it does',
  adminOnly: false,

  async execute(message) {
    const prefix = process.env.PREFIX || '!';

    // client.prefixCommands has each command registered once per name AND
    // once per alias (so lookups are O(1)) — dedupe back down to the
    // unique command objects before listing.
    const uniquePrefix = [...new Set(message.client.prefixCommands.values())]
      .sort((a, b) => a.name.localeCompare(b.name));

    const slashCommands = [...message.client.commands.values()]
      .sort((a, b) => a.data.name.localeCompare(b.data.name));

    const prefixEntries = uniquePrefix.map(cmd => {
      const aliasText = cmd.aliases && cmd.aliases.length
        ? ` (${cmd.aliases.map(a => `${prefix}${a}`).join(', ')})`
        : '';
      return {
        name: `${cmd.adminOnly ? '🔒 ' : '▫️ '}**${prefix}${cmd.name}**${aliasText}`,
        desc: shortDescription(cmd.description),
      };
    });

    const slashEntries = slashCommands.map(cmd => {
      const json = cmd.data.toJSON();
      // default_member_permissions is a stringified bitfield, or null/undefined
      // for a command anyone can run — mirrors the 🔒 = Manage Server convention
      // already used for prefix commands.
      const isAdminOnly = json.default_member_permissions
        && new PermissionsBitField(BigInt(json.default_member_permissions)).has(PermissionsBitField.Flags.ManageGuild);
      return {
        name: `${isAdminOnly ? '🔒 ' : '▫️ '}**/${json.name}**`,
        desc: shortDescription(json.description),
      };
    });

    const footerText = '🔒 = requires Manage Server';

    const embeds = [
      ...buildEmbeds(`📜 Slash Commands (${slashEntries.length})`, 0x5865F2, slashEntries, footerText),
      ...buildEmbeds(`📜 Prefix Commands (${prefixEntries.length})`, 0x57F287, prefixEntries, footerText),
    ];

    await message.channel.send(
      `📖 **${slashEntries.length + prefixEntries.length}** command(s) available.`
    );

    // Discord caps messages at 10 embeds each, so send in batches just in
    // case a very large command list ever needs more than that.
    for (const group of chunk(embeds, 10)) {
      await message.channel.send({ embeds: group });
    }
  },
};
