const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./tn-storage');
const { isAllowedUser } = require('./tn-access');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('disable-welcome-channel')
    .setDescription('Turn off the new-member welcome greeting'),
    // No setDefaultMemberPermissions — gated below by ALLOWED_USER_IDS only.

  async execute(interaction) {
    if (!isAllowedUser(interaction.user.id)) {
      return interaction.reply({
        content: '❌ You\'re not authorized to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};

    if (!store.settings.welcomeChannelId) {
      return interaction.reply({
        content: 'ℹ️ The welcome greeting isn\'t set up right now — nothing to disable.',
        flags: MessageFlags.Ephemeral,
      });
    }

    store.settings.welcomeChannelId = null;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: '✅ Disabled the new-member welcome greeting.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
