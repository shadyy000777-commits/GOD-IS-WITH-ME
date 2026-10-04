const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore } = require('./t3-storage');
const { buildAdminPanelPayload } = require('./t3-admin-panel-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('t3-admin-panel')
    .setDescription('Post the T3 Scrims admin panel (registration panel, log channel, role, schedule, groups/day)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    await interaction.channel.send(buildAdminPanelPayload(store));
    await interaction.reply({ content: '✅ Admin panel posted.', flags: MessageFlags.Ephemeral });
  },
};
