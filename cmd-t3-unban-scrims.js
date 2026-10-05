const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./t3-storage');
const { SCRIMS_BAN_ROLE_NAME } = require('./t3-punish-handlers');

// Manually lifts a T3 Scrims Ban given by the group panel's "Punish Team"
// button. Punishing bans every account on the team (owner + lineup), so this
// takes up to 5 players — pick the whole roster to unban the full team.
// For each one it removes the Scrims Ban role and clears the tracked expiry,
// so they can register again right away instead of waiting out the 2 days.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('t3-unban-scrims')
    .setDescription("Lift a T3 Scrims Ban so a team can register again right away")
    .addUserOption(opt =>
      opt.setName('player').setDescription('A banned player (e.g. the team owner)').setRequired(true))
    .addUserOption(opt => opt.setName('player2').setDescription('Another banned player on the same team'))
    .addUserOption(opt => opt.setName('player3').setDescription('Another banned player on the same team'))
    .addUserOption(opt => opt.setName('player4').setDescription('Another banned player on the same team'))
    .addUserOption(opt => opt.setName('player5').setDescription('Another banned player on the same team'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const targets = new Map();
    for (const name of ['player', 'player2', 'player3', 'player4', 'player5']) {
      const user = interaction.options.getUser(name);
      if (user) targets.set(user.id, user);
    }

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    const bans = store.settings.scrimsBans || {};
    const roleId = store.settings.scrimsBanRoleId;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const lifted = [];
    const notBanned = [];
    const roleFailed = [];

    for (const user of targets.values()) {
      const wasTracked = !!bans[user.id];
      let hadRole = false;

      try {
        const member = await interaction.guild.members.fetch(user.id);
        if (roleId && member.roles.cache.has(roleId)) {
          hadRole = true;
          await member.roles.remove(roleId, `T3 Scrims Ban lifted by ${interaction.user.tag}`);
        }
      } catch (err) {
        // Member may have left the server, or the bot may lack permissions —
        // the tracking entry is still cleared below either way.
        if (wasTracked) roleFailed.push(user.id);
      }

      if (!wasTracked && !hadRole) {
        notBanned.push(user.id);
        continue;
      }

      delete bans[user.id];
      lifted.push(user.id);
    }

    if (lifted.length) saveGuildStore(interaction.guildId, store);

    if (!lifted.length) {
      return interaction.editReply({
        content: `❌ ${notBanned.map(id => `<@${id}>`).join(', ')} ${notBanned.length === 1 ? "isn't" : "aren't"} currently under a **${SCRIMS_BAN_ROLE_NAME}**.`,
      });
    }

    let msg = `✅ Lifted the **${SCRIMS_BAN_ROLE_NAME}** from ${lifted.map(id => `<@${id}>`).join(', ')} — they can register again right away.`;
    if (notBanned.length) msg += `\nℹ️ Not banned: ${notBanned.map(id => `<@${id}>`).join(', ')}.`;
    if (roleFailed.length) msg += `\n⚠️ Couldn't update the roles of ${roleFailed.map(id => `<@${id}>`).join(', ')} (they may have left the server, or I lack permission) — their ban is cleared in the bot either way.`;

    return interaction.editReply({ content: msg });
  },
};
