const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { clearPending } = require('./pending-verifications');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove-verify')
    .setDescription("Remove a player's team verification so they can verify again")
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('The player whose verification should be removed')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const target = interaction.options.getUser('user');

    const store = getGuildStore(interaction.guildId);
    if (!store.verifications) store.verifications = {};

    // The named player might be the team owner (the record's own key), or
    // just one of the 4 picked lineup players — search both, so an admin
    // doesn't need to know who technically "owns" the verification to free
    // up a player who's stuck blocking new registrations.
    let ownerId = store.verifications[target.id] ? target.id : null;
    if (!ownerId) {
      for (const [oid, record] of Object.entries(store.verifications)) {
        if ((record.selectedPlayerIds || []).includes(target.id)) {
          ownerId = oid;
          break;
        }
      }
    }

    if (!ownerId) {
      return interaction.reply({
        content: `❌ ${target} doesn't have a saved verification.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const existing = store.verifications[ownerId];
    delete store.verifications[ownerId];
    saveGuildStore(interaction.guildId, store);

    // In case they're mid-way through the 3-step form right now, clear that too
    // so a stale in-progress session can't finish and re-save after removal.
    clearPending(ownerId);

    // Strip the verified role from every player on that team, not just the
    // one the admin named — a verification covers the whole lineup, so
    // leaving the rest holding the role would make it look like they're
    // still verified when their record is actually gone.
    const roleId = store.settings && store.settings.verifiedRoleId;
    const allPlayers = new Set([ownerId, ...(existing.selectedPlayerIds || [])]);
    let roleFailures = 0;
    if (roleId) {
      for (const pid of allPlayers) {
        try {
          const member = await interaction.guild.members.fetch(pid);
          if (member.roles.cache.has(roleId)) await member.roles.remove(roleId);
        } catch (err) {
          roleFailures++;
        }
      }
    }
    const roleNote = roleFailures
      ? ` ⚠️ Could not update roles for ${roleFailures} player(s) (they may have left the server, or I lack permission).`
      : '';

    await interaction.reply({
      content: `✅ Removed the verification for team **${existing.team_name}** (owned by <@${ownerId}>). Every player in that lineup can now run \`/verify-panel\` again.${roleNote}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
