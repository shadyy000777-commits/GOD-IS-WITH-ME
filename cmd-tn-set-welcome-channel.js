const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./tn-storage');
const { isAllowedUser } = require('./tn-access');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-welcome-channel')
    .setDescription('Choose where Gungun greets new members and pings staff for help')
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('The channel where new-member welcomes are posted')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addRoleOption(opt =>
      opt.setName('staff_role')
        .setDescription('The role pinged to help the new member get settled')
        .setRequired(false)),
    // No setDefaultMemberPermissions — gated below by ALLOWED_USER_IDS only.

  async execute(interaction) {
    if (!isAllowedUser(interaction.user.id)) {
      return interaction.reply({
        content: '❌ You\'re not authorized to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = interaction.options.getChannel('channel');
    const role = interaction.options.getRole('staff_role');

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    store.settings.welcomeChannelId = channel.id;
    // Only touch the staff role if one was actually passed — re-running the
    // command just to change the channel shouldn't silently clear it.
    if (role) store.settings.welcomeStaffRoleId = role.id;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: `✅ New members will now be greeted in ${channel}${role ? `, pinging <@&${role.id}> for help` : store.settings.welcomeStaffRoleId ? `, still pinging <@&${store.settings.welcomeStaffRoleId}>` : ' (no staff role set to ping — add one with \`staff_role\` to enable that)'}. Use \`/disable-welcome-channel\` to turn this off.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
