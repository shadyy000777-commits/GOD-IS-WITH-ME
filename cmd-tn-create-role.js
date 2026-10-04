const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isAllowedUser } = require('./tn-access');

// ---------------------------------------------------------------------------
// /create-role — creates the two tournament roles in the server.
// What each role can do is decided by the bot (see access.js), not by Discord
// permissions: TOURNAMENT ELITE has full access to the bot — the !tournament
// panel and every button, group swaps (done instantly, no owner approval) and
// registering even while registration is closed.
//
// To give a role permissions, list them in its `permissions` array using
// discord.js permission names, e.g. ['ManageMessages', 'MuteMembers'].
// Left empty, the role is created with no extra permissions.
// ---------------------------------------------------------------------------
const ROLES_TO_CREATE = [
  { name: 'TOURNAMENT ADMIN', permissions: [] },
  { name: 'TOURNAMENT ELITE', permissions: [] },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('create-role')
    .setDescription('Create the TOURNAMENT ADMIN and TOURNAMENT ELITE roles'),

  async execute(interaction) {
    if (!isAllowedUser(interaction.user.id)) {
      return interaction.reply({
        content: '❌ You\'re not authorized to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const lines = [];
    for (const def of ROLES_TO_CREATE) {
      const existing = guild.roles.cache.find(r => r.name.toLowerCase() === def.name.toLowerCase());
      if (existing) {
        lines.push(`ℹ️ <@&${existing.id}> already exists — left as it is.`);
        continue;
      }
      try {
        const role = await guild.roles.create({
          name: def.name,
          permissions: def.permissions,
          reason: `/create-role used by ${interaction.user.tag}`,
        });
        lines.push(`✅ Created <@&${role.id}>`);
      } catch (err) {
        console.error(`[create-role] Failed to create "${def.name}" in guild ${guild.id}: ${err.code ?? ''} ${err.message}`);
        lines.push(`❌ Couldn't create **${def.name}** — check that I have the **Manage Roles** permission.`);
      }
    }

    return interaction.editReply({
      content: lines.join('\n'),
      allowedMentions: { parse: [] },
    });
  },
};
