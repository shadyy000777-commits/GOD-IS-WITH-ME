const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildStore } = require('./storage');
const { buildAdminPanelPayload } = require('./admin-panel-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin-panel')
    .setDescription('Open the admin panel — post panels, set channels/roles, and more, all in one place')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};

    await interaction.reply(buildAdminPanelPayload(store));
  },
};
