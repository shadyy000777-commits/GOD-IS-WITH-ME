const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  EmbedBuilder, MessageFlags,
} = require('discord.js');
const { canManageBot } = require('./tn-access');
const staffActivity = require('./tn-staff-activity');
const staffPanelHandlers = require('./tn-staff-panel-handlers');

// Builds the !staff panel for the given state — { userId, mode }. userId
// null shows the role's leaderboard; otherwise a per-channel breakdown for
// that one member. mode is 'daily' (today) or 'monthly' (current UTC month).
async function buildStaffPanel(guild, state) {
  const roleId = staffActivity.getStaffRoleId(guild.id);
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  const periodLabel = state.mode === 'monthly'
    ? `This Month (${staffActivity.currentMonthKey()})`
    : `Today (${staffActivity.todayKey()})`;

  if (role) await guild.members.fetch().catch(() => {}); // keep role.members current

  let embed;
  if (!role) {
    embed = new EmbedBuilder()
      .setTitle('📊 Staff Activity')
      .setColor(0xED4245)
      .setDescription('❌ No staff role is set yet — run `!staff role @role` first, then come back and run `!staff` again.');
  } else if (state.userId) {
    const stats = state.mode === 'monthly'
      ? staffActivity.getUserMonthStats(guild.id, state.userId)
      : staffActivity.getUserDayStats(guild.id, state.userId);
    const member = await guild.members.fetch(state.userId).catch(() => null);
    const label = member ? member.displayName : `<@${state.userId}>`;
    const channelLines = Object.entries(stats.messages)
      .sort(([, a], [, b]) => b - a)
      .map(([chId, count]) => `<#${chId}> — **${count}**`);

    embed = new EmbedBuilder()
      .setTitle(`📊 ${label} — ${periodLabel}`)
      .setColor(0x5865F2)
      .addFields(
        { name: 'Total Messages', value: String(stats.messageTotal), inline: true },
        { name: 'Voice Time', value: staffActivity.formatDuration(stats.voiceSeconds), inline: true },
        { name: 'Messages by Channel', value: channelLines.length ? channelLines.join('\n').slice(0, 1024) : 'No messages recorded.' },
      );
  } else {
    const memberIds = role.members.map(m => m.id);
    const stats = state.mode === 'monthly'
      ? staffActivity.getMonthLeaderboardStats(guild.id, memberIds)
      : staffActivity.getLeaderboardStats(guild.id, memberIds);
    const lines = stats.map((s, i) =>
      `**${i + 1}.** <@${s.userId}> — **${s.messageTotal}** messages, **${staffActivity.formatDuration(s.voiceSeconds)}** VC`
    );
    embed = new EmbedBuilder()
      .setTitle(`📊 Staff Activity — ${periodLabel} (${role.name})`)
      .setColor(0x57F287)
      .setDescription(lines.length ? lines.join('\n').slice(0, 4000) : `No one currently holds **${role.name}**.`)
      .setFooter({ text: 'Pick a staff member below for their per-channel breakdown.' });
  }

  const rows = [];

  if (role) {
    // Only members holding the staff role show up here — capped at 25,
    // Discord's hard limit on select-menu options.
    const staffMembers = [...role.members.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const shown = staffMembers.slice(0, 25);
    const options = shown.length
      ? shown.map(m => ({ label: m.displayName.slice(0, 100), value: m.id, default: m.id === state.userId }))
      : [{ label: 'No one currently holds this role', value: 'none' }];

    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('staffactivity_user_select')
        .setPlaceholder(shown.length ? `Pick a staff member (${role.name})...` : 'No staff members yet')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(shown.length === 0)
        .addOptions(options),
    ));

    if (staffMembers.length > 25 && embed.data.footer) {
      embed.setFooter({ text: `${embed.data.footer.text} Showing 25 of ${staffMembers.length} staff in the dropdown.` });
    }
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('staffactivity_mode:daily').setLabel('Daily').setStyle(state.mode === 'monthly' ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('staffactivity_mode:monthly').setLabel('Monthly').setStyle(state.mode === 'monthly' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('staffactivity_leaderboard').setLabel('Leaderboard').setEmoji('📋').setStyle(ButtonStyle.Secondary).setDisabled(!state.userId),
    ),
  );

  return { embeds: [embed], components: rows };
}

async function handleUserSelect(interaction) {
  if (!canManageBot(interaction.member)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const state = staffActivity.setPanelState(interaction.message.id, { userId: interaction.values[0] });
  await interaction.update(await buildStaffPanel(interaction.guild, state));
}

async function handleModeButton(interaction) {
  if (!canManageBot(interaction.member)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const mode = interaction.customId.split(':')[1];
  const state = staffActivity.setPanelState(interaction.message.id, { mode });
  await interaction.update(await buildStaffPanel(interaction.guild, state));
}

async function handleLeaderboardButton(interaction) {
  if (!canManageBot(interaction.member)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const state = staffActivity.setPanelState(interaction.message.id, { userId: null });
  await interaction.update(await buildStaffPanel(interaction.guild, state));
}

module.exports = {
  name: 'staff',
  description: 'Staff control panel — !staff posts the 16-button panel. !staff role @role sets who is tracked. !staff activity opens the old message/voice activity viewer.',
  adminOnly: true,

  async execute(message, args) {
    const { guild } = message;

    // !staff role [@role] — view or change who gets tracked.
    if ((args[0] || '').toLowerCase() === 'role') {
      const mentionedRole = message.mentions.roles.first();
      if (mentionedRole) {
        staffActivity.setStaffRoleId(guild.id, mentionedRole.id);
        return message.reply(`✅ Now tracking daily messages (by channel) and voice time for everyone with **${mentionedRole.name}**.`).catch(() => {});
      }
      const currentId = staffActivity.getStaffRoleId(guild.id);
      const currentRole = currentId ? guild.roles.cache.get(currentId) : null;
      return message.reply(currentRole
        ? `Currently tracking **${currentRole.name}**. Change it any time with \`!staff role @role\`.`
        : '❌ No role set yet — run `!staff role @role` to pick who gets tracked.'
      ).catch(() => {});
    }

    // !staff — the staff control panel (check-in, entry form, active / inactive
    // staff, promotions, work, leave, reports, rules, weekly report ...).
    if ((args[0] || '').toLowerCase() !== 'activity') {
      await message.channel.send(staffPanelHandlers.buildMainPanel(guild));
      await message.delete().catch(() => {});
      return;
    }

    // !staff activity [@user] — the original per-channel message / voice viewer.
    const mentionedUser = message.mentions.users.first();
    const state = { userId: mentionedUser?.id || null, mode: 'daily' };
    const payload = await buildStaffPanel(guild, state);
    const sent = await message.channel.send(payload);
    staffActivity.setPanelState(sent.id, state);
  },

  handleUserSelect,
  handleModeButton,
  handleLeaderboardButton,
};
