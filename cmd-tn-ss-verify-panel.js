const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuildStore } = require('./tn-storage');
const { isAllowedUser } = require('./tn-access');
const { buildSsVerifyPanelPayload } = require('./tn-ss-verify-panel-handlers');

// Only users whose Discord ID is listed in ALLOWED_USER_IDS may open this
// panel. No default permission is set on purpose — Discord would hide the
// command from allowed users who lack Manage Server — so the check happens
// here instead (and again on every panel button/menu in index.js).
module.exports = {
  data: new SlashCommandBuilder()
    .setName('ss-verify-panel')
    .setDescription('Manage screenshot verification setups — type, submit channel, verified role, and details'),

  async execute(interaction) {
    if (!isAllowedUser(interaction.user.id)) {
      return interaction.reply({
        content: '❌ Only users listed in `ALLOWED_USER_IDS` can use the screenshot verification panel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};

    await interaction.reply({ ...buildSsVerifyPanelPayload(store), flags: MessageFlags.Ephemeral });
  },
};
