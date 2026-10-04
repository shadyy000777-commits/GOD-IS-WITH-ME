const {
  ActionRowBuilder, UserSelectMenuBuilder, MessageFlags,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { groupDisplayName } = require('./group-schedule');

// "Transfer Role" — lets a team's owner hand their group role to another
// player (e.g. the owner is busy and someone else will play that match).
// The role is removed from the owner and given to the player they pick, so
// the new player gets access to the group channel and the owner loses it.
//
// Who may use it for a group: the slot's registered owner (slot.userId), or
// whoever currently holds the role after a previous transfer
// (slot.roleHolderId) — the owner loses channel access once they transfer,
// so the new holder needs to be able to pass it on again if plans change.

function findGroupSlot(store, groupLetter) {
  const scrim = store.scrim;
  if (!scrim || !scrim.slots) return null;
  return Object.values(scrim.slots).find((s) => s.group === groupLetter) || null;
}

// Every slot of that group that this user is allowed to transfer for.
function findTransferableSlot(store, groupLetter, userId) {
  const scrim = store.scrim;
  if (!scrim || !scrim.slots) return null;
  return Object.values(scrim.slots).find(
    (s) => s.group === groupLetter && (s.roleHolderId || s.userId) === userId,
  ) || null;
}

async function handleGroupTransferButton(interaction) {
  const groupLetter = interaction.customId.split(':')[1];
  const store = getGuildStore(interaction.guildId);

  if (!store.scrim) {
    return interaction.reply({ content: '❌ No scrim is set up right now.', flags: MessageFlags.Ephemeral });
  }

  const slot = findTransferableSlot(store, groupLetter, interaction.user.id);
  if (!slot) {
    return interaction.reply({
      content: `❌ Only the team owner of a team in **${groupDisplayName(groupLetter)}** can transfer the group role.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const roleId = store.settings && store.settings.groupRoles && store.settings.groupRoles[groupLetter];
  if (!roleId) {
    return interaction.reply({
      content: `❌ ${groupDisplayName(groupLetter)} doesn't have a group role to transfer.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const select = new UserSelectMenuBuilder()
    .setCustomId(`group_transfer_select:${groupLetter}`)
    .setPlaceholder('Select the player who will take your role')
    .setMinValues(1)
    .setMaxValues(1);

  await interaction.reply({
    content:
      `🔁 **Transfer ${groupDisplayName(groupLetter)} role** — team **${slot.team}**\n` +
      `Pick the player who will play in your place. The role (and access to this channel) moves to them and is **removed from you**.`,
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleGroupTransferSelect(interaction) {
  const groupLetter = interaction.customId.split(':')[1];
  const store = getGuildStore(interaction.guildId);

  const slot = store.scrim && findTransferableSlot(store, groupLetter, interaction.user.id);
  if (!slot) {
    return interaction.update({ content: '❌ You no longer hold this group\'s role, so you can\'t transfer it.', components: [] });
  }

  const roleId = store.settings && store.settings.groupRoles && store.settings.groupRoles[groupLetter];
  const role = roleId && interaction.guild.roles.cache.get(roleId);
  if (!role) {
    return interaction.update({ content: `❌ The ${groupDisplayName(groupLetter)} role no longer exists.`, components: [] });
  }

  const targetId = interaction.values[0];
  const targetUser = interaction.users && interaction.users.get(targetId);

  if (targetId === interaction.user.id) {
    return interaction.update({ content: '❌ You already hold the role — pick a different player.', components: [] });
  }
  if (targetUser && targetUser.bot) {
    return interaction.update({ content: '❌ You can\'t transfer the role to a bot.', components: [] });
  }

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles') || role.position >= botMember.roles.highest.position) {
    return interaction.update({
      content: '❌ I can\'t move this role — my role needs **Manage Roles** and must sit above the group role. Ask an admin.',
      components: [],
    });
  }

  await interaction.update({ content: '⏳ Transferring role...', components: [] });

  let targetMember;
  try {
    targetMember = await interaction.guild.members.fetch(targetId);
  } catch {
    return interaction.editReply({ content: '❌ That player isn\'t in this server.' });
  }

  try {
    if (!targetMember.roles.cache.has(role.id)) {
      await targetMember.roles.add(role.id, `Group role transferred by ${interaction.user.tag}`);
    }
    const ownerMember = await interaction.guild.members.fetch(interaction.user.id);
    if (ownerMember.roles.cache.has(role.id)) {
      await ownerMember.roles.remove(role.id, `Group role transferred to ${targetMember.user.tag}`);
    }
  } catch (err) {
    console.error(`[group-transfer] Failed in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    return interaction.editReply({ content: '❌ Something went wrong moving the role. Ask an admin to check it.' });
  }

  slot.roleHolderId = targetId;
  saveGuildStore(interaction.guildId, store);

  await interaction.editReply({
    content: `✅ **${groupDisplayName(groupLetter)}** role transferred to <@${targetId}>. You no longer have it.`,
    allowedMentions: { parse: [] },
  });

  // Visible note in the group channel — the owner has just lost access, so
  // post it as the bot (not as an ephemeral reply) to leave a record.
  if (interaction.channel) {
    interaction.channel.send({
      content: `🔁 <@${interaction.user.id}> transferred the **${groupDisplayName(groupLetter)}** role to <@${targetId}> (team **${slot.team}**).`,
      allowedMentions: { users: [targetId] },
    }).catch(() => {});
  }
}

module.exports = { handleGroupTransferButton, handleGroupTransferSelect };
