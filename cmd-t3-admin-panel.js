const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
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
    // A normal (non-ephemeral) message so it stays in the channel. Every
    // button/select on it still checks Manage Server, so only admins can use it.
    await interaction.reply(buildAdminPanelPayload(store));
  },
};
