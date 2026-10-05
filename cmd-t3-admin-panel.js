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
    if (!store.settings) store.settings = {};
    // Ephemeral, like the main /admin-panel — only the admin who ran it sees it.
    await interaction.reply({ ...buildAdminPanelPayload(store), flags: MessageFlags.Ephemeral });
  },
};
