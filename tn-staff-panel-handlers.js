// The !staff admin panel — 16 buttons, their modals / pickers, and the weekly
// report. All custom IDs start with "staffp:". index.js hands every such
// interaction to handleInteraction(); data lives in staff-system.js.
//
// Who may press what:
//   • Admins (canManageBot) — everything.
//   • Members holding the tracked staff role (!staff role @role) — only the
//     self-service buttons: Check-in, Entry Form, Staff Work (their own),
//     My Activity, Leave, Report Form and Rules (view only).
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  UserSelectMenuBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
} = require('discord.js');
const { canManageBot } = require('./tn-access');
const staffActivity = require('./tn-staff-activity');
const staffSystem = require('./tn-staff-system');
const { listGuildIds } = require('./tn-storage');

const EPHEMERAL = MessageFlags.Ephemeral;
const COLOR = { main: 0x5865F2, ok: 0x57F287, warn: 0xFEE75C, bad: 0xED4245 };
const STATUS_EMOJI = { active: '🟢', inactive: '🔴', leave: '🏖️' };
const MEDALS = ['🥇', '🥈', '🥉'];

// Buttons / modals / selects staff-role holders may use (everything else is admin-only).
const SELF_ACTIONS = new Set([
  'checkin', 'entry', 'myactivity', 'leave', 'report', 'rules', 'work', 'task_done',
  'm_checkin', 'm_entry', 'm_leave', 'm_report',
]);

// In-progress "Distribute Work" requests: `${guildId}:${userId}` -> { title, details, at }
const pendingDistribute = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ helpers
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const isAdmin = (interaction) => canManageBot(interaction.member);
const isStaff = (interaction) => isAdmin(interaction) || staffActivity.isTrackedMember(interaction.guildId, interaction.member);
const reply = (interaction, content) => interaction.reply({ content, flags: EPHEMERAL });

function joinLines(lines, max = 3900, empty = '—') {
  if (!lines.length) return empty;
  let out = '';
  let shown = 0;
  for (const line of lines) {
    if ((out + line + '\n').length > max - 40) break;
    out += line + '\n';
    shown++;
  }
  if (shown < lines.length) out += `…and ${lines.length - shown} more`;
  return out.trim();
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function textInput({ id, label, style = TextInputStyle.Short, required = true, placeholder, value, max, min }) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (placeholder) input.setPlaceholder(placeholder);
  if (value) input.setValue(String(value).slice(0, max || 4000));
  if (max) input.setMaxLength(max);
  if (min) input.setMinLength(min);
  return input;
}

function modal(customId, title, inputs) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(...inputs.map(i => row(i)));
}

function userSelect(customId, placeholder, max = 1) {
  return new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(max);
}

const fmtDuration = staffActivity.formatDuration;

// ------------------------------------------------------------- main panel
function buildMainPanel(guild) {
  const roleId = staffActivity.getStaffRoleId(guild.id);
  const embed = new EmbedBuilder()
    .setTitle('🛡️ Staff Control Panel')
    .setColor(COLOR.main)
    .setDescription([
      '**Row 1** — check in, join the staff list, see who is active, leaderboard',
      '**Row 2** — inactive staff, add / remove staff, promotions, profiles',
      '**Row 3** — work: view, distribute, history, your own activity',
      '**Row 4** — leave, report form, rules, weekly report',
      '',
      `Staff count as **inactive** after ${staffSystem.INACTIVE_AFTER_DAYS} days with no check-in, finished work or report (leave excluded).`,
    ].join('\n'))
    .addFields({
      name: 'Tracked staff role',
      value: roleId ? `<@&${roleId}> — members with it can use the self-service buttons.` : 'Not set — run `!staff role @role`.',
    })
    .setFooter({ text: 'Admin buttons are locked to admins. Pressing a button only replies to you.' });

  const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`staffp:${id}`).setLabel(label).setEmoji(emoji).setStyle(style);

  return {
    embeds: [embed],
    components: [
      row(btn('checkin', 'Check-in / Input', '✅', ButtonStyle.Success), btn('entry', 'Staff Entry Form', '📝'), btn('active', 'Active Staff', '🟢'), btn('leaderboard', 'Leaderboard', '🏆')),
      row(btn('inactive', 'Inactive Staff', '🔴'), btn('list', 'Staff List / Remove', '📋'), btn('promote', 'Promote Staff', '⬆️', ButtonStyle.Primary), btn('profile', 'View Profile / History', '👤')),
      row(btn('work', 'Staff Work', '🛠️'), btn('distribute', 'Distribute Work', '📤', ButtonStyle.Primary), btn('history', 'Staff History', '📚'), btn('myactivity', 'My Activity', '📈')),
      row(btn('leave', 'Staff Leave', '🏖️'), btn('report', 'Report Form', '🧾'), btn('rules', 'Rules', '📜'), btn('weekly', 'Weekly Report', '🗓️', ButtonStyle.Primary)),
    ],
  };
}

// ------------------------------------------------------- screens (payloads)
function statusListPayload(guildId, kind) {
  const members = staffSystem.listMembers(guildId);
  const now = Date.now();

  if (kind === 'active') {
    const lines = members
      .filter(m => m.status === 'active')
      .map(m => `🟢 <@${m.userId}> — ${m.rankName} • last active ${ts(m.lastActiveAt)} • ${m.openTasks} open task(s)`);
    return {
      embeds: [new EmbedBuilder()
        .setTitle(`🟢 Active Staff (${lines.length})`)
        .setColor(COLOR.ok)
        .setDescription(joinLines(lines, 3900, 'Nobody is active right now. Staff become active by checking in, finishing work or filing a report.'))],
    };
  }

  const inactive = members.filter(m => m.status === 'inactive')
    .map(m => `🔴 <@${m.userId}> — ${m.rankName} • idle **${Math.floor((now - m.lastActiveAt) / 86400000)}d** (last active ${ts(m.lastActiveAt)})`);
  const onLeave = members.filter(m => m.status === 'leave')
    .map(m => `🏖️ <@${m.userId}> — ${m.rankName} • back ${ts(m.leaveUntil, 'D')}`);
  const embed = new EmbedBuilder()
    .setTitle(`🔴 Inactive Staff (${inactive.length})`)
    .setColor(COLOR.bad)
    .setDescription(joinLines(inactive, 3000, '🎉 Nobody is inactive.'));
  if (onLeave.length) embed.addFields({ name: `On leave (${onLeave.length})`, value: joinLines(onLeave, 1000) });
  return { embeds: [embed] };
}

function buildListPayload(guildId, notice) {
  const members = staffSystem.listMembers(guildId);
  const lines = members.map(m => `${STATUS_EMOJI[m.status]} <@${m.userId}> — ${m.rankName} • ${m.position}`);
  const embed = new EmbedBuilder()
    .setTitle(`📋 Staff List (${members.length})`)
    .setColor(COLOR.main)
    .setDescription(joinLines(lines, 3900, 'No staff yet. Add some below, or have them use **Staff Entry Form**.'));
  return {
    content: notice || null,
    embeds: [embed],
    components: [
      row(userSelect('staffp:add_select', '➕ Add staff member(s)…', 10)),
      row(userSelect('staffp:rm_select', '🗑️ Remove a staff member…')),
    ],
  };
}

async function buildProfilePayload(guild, userId, { picker = false, notice = null } = {}) {
  const components = picker ? [row(userSelect('staffp:profile_select', '👤 Pick another staff member…'))] : [];
  const m = staffSystem.getMember(guild.id, userId);
  if (!m) {
    return {
      content: notice,
      embeds: [new EmbedBuilder().setColor(COLOR.bad).setDescription(`❌ <@${userId}> isn't in the staff list.`)],
      components,
    };
  }

  const discordMember = await guild.members.fetch(userId).catch(() => null);
  const week = staffActivity.getUserRangeStats(guild.id, userId, 7);
  const month = staffActivity.getUserMonthStats(guild.id, userId);
  const topChannels = Object.entries(month.messages).sort(([, a], [, b]) => b - a).slice(0, 5)
    .map(([ch, n]) => `<#${ch}> — **${n}**`);
  const history = staffSystem.getHistory(guild.id, 8, userId)
    .map(h => `${ts(h.at)} **${h.type.replace('_', ' ')}** — ${h.text || '—'}`);

  const embed = new EmbedBuilder()
    .setTitle(`👤 ${m.name || discordMember?.displayName || 'Staff member'}`)
    .setColor(COLOR[m.status === 'active' ? 'ok' : m.status === 'inactive' ? 'bad' : 'warn'])
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: 'Rank', value: m.rankName, inline: true },
      { name: 'Status', value: `${STATUS_EMOJI[m.status]} ${m.status[0].toUpperCase()}${m.status.slice(1)}`, inline: true },
      { name: 'Position', value: m.position || '—', inline: true },
      { name: 'Joined', value: ts(m.joinedAt, 'D'), inline: true },
      { name: 'Last active', value: ts(m.lastActiveAt), inline: true },
      { name: 'Availability', value: m.availability || '—', inline: true },
      { name: 'Check-ins', value: String(m.checkins || 0), inline: true },
      { name: 'Work', value: `${m.tasksDone || 0} done • ${m.openTasks} open`, inline: true },
      { name: 'Last 7 days', value: `💬 ${week.messageTotal} • 🎙️ ${fmtDuration(week.voiceSeconds)}`, inline: true },
    );
  if (m.leaveUntil && m.leaveUntil > Date.now()) embed.addFields({ name: 'On leave until', value: ts(m.leaveUntil, 'D'), inline: true });
  if (m.notes) embed.addFields({ name: 'Notes', value: m.notes.slice(0, 1000) });
  if (topChannels.length) embed.addFields({ name: 'Top channels this month', value: topChannels.join('\n') });
  embed.addFields({ name: 'Recent history', value: joinLines(history, 1000, 'Nothing yet.') });
  if (discordMember) embed.setThumbnail(discordMember.displayAvatarURL());

  return { content: notice, embeds: [embed], components };
}

function buildWorkPayload(guildId, userId, admin, notice = null) {
  const tasks = staffSystem.getOpenTasks(guildId, admin ? null : userId);
  const lines = tasks.map(t =>
    `**#${t.id}** ${admin ? `<@${t.assigneeId}> — ` : ''}${t.title}${t.details ? `\n└ ${t.details.slice(0, 80)}` : ''} • ${ts(t.createdAt)}`);
  const embed = new EmbedBuilder()
    .setTitle(admin ? `🛠️ All Open Work (${tasks.length})` : `🛠️ Your Open Work (${tasks.length})`)
    .setColor(tasks.length ? COLOR.warn : COLOR.ok)
    .setDescription(joinLines(lines, 3900, '🎉 No open work.'));

  const components = [];
  if (tasks.length) {
    const members = new Map(staffSystem.listMembers(guildId).map(m => [m.userId, m.name]));
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('staffp:task_done')
        .setPlaceholder('✅ Mark a task as done…')
        .addOptions(tasks.slice(0, 25).map(t => {
          const option = { label: `#${t.id} ${t.title}`.slice(0, 100), value: String(t.id) };
          if (admin) option.description = String(members.get(t.assigneeId) || 'Unknown').slice(0, 100) || 'Unknown';
          return option;
        })),
    ));
    if (tasks.length > 25) embed.setFooter({ text: 'Dropdown shows the 25 oldest tasks.' });
  }
  return { content: notice, embeds: [embed], components };
}

function buildHistoryPayload(guildId) {
  const lines = staffSystem.getHistory(guildId, 25)
    .map(h => `${ts(h.at)} **${h.type.replace('_', ' ')}** ${h.userId ? `<@${h.userId}>` : ''} — ${h.text || '—'}`);
  return {
    embeds: [new EmbedBuilder().setTitle('📚 Staff History (latest 25)').setColor(COLOR.main)
      .setDescription(joinLines(lines, 3900, 'No history yet.'))],
  };
}

function buildLeaderboardPayload(guildId) {
  const { rows, since, now } = staffSystem.weeklyData(guildId, 7);
  const lines = rows.slice(0, 20).map((r, i) =>
    `${MEDALS[i] || `**${i + 1}.**`} <@${r.userId}> ${STATUS_EMOJI[r.status]} — ✅ ${r.checkins} • 🛠️ ${r.tasksDone} • 💬 ${r.messages} • 🎙️ ${fmtDuration(r.voiceSeconds)}`);
  return {
    embeds: [new EmbedBuilder().setTitle('🏆 Staff Leaderboard — last 7 days').setColor(COLOR.warn)
      .setDescription(`${ts(since, 'D')} → ${ts(now, 'D')}\n\n${joinLines(lines, 3600, 'No staff yet.')}`)
      .setFooter({ text: '✅ check-ins • 🛠️ work done • 💬 messages • 🎙️ voice. Ranked by work done, then check-ins, then messages.' })],
  };
}

function buildRulesPayload(guildId, admin) {
  const rules = staffSystem.getRules(guildId);
  const embed = new EmbedBuilder().setTitle('📜 Staff Rules').setColor(COLOR.main)
    .setDescription(rules || 'No rules have been written yet.');
  const components = admin
    ? [row(new ButtonBuilder().setCustomId('staffp:rules_edit').setLabel('Edit Rules').setEmoji('✏️').setStyle(ButtonStyle.Primary))]
    : [];
  return { embeds: [embed], components };
}

function buildWeeklySettingsPayload(guildId, notice = null) {
  const s = staffSystem.getWeeklySettings(guildId);
  const embed = new EmbedBuilder().setTitle('🗓️ Weekly Staff Report').setColor(COLOR.main)
    .setDescription('A final report of the last 7 days is posted automatically every week.')
    .addFields(
      { name: 'Auto-post', value: s.enabled ? '✅ On' : '⏸️ Off', inline: true },
      { name: 'Channel', value: s.channelId ? `<#${s.channelId}>` : '❌ Not set', inline: true },
      { name: 'Schedule', value: `Every Sunday ${String(staffSystem.WEEKLY_HOUR_UTC).padStart(2, '0')}:00 UTC`, inline: true },
      { name: 'Last sent', value: s.lastWeeklyAt ? ts(s.lastWeeklyAt) : 'Never', inline: true },
    );
  return {
    content: notice,
    embeds: [embed],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('staffp:wk_channel').setPlaceholder('Pick the report channel…')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1)),
      row(
        new ButtonBuilder().setCustomId('staffp:wk_toggle').setLabel(s.enabled ? 'Turn Auto-post Off' : 'Turn Auto-post On')
          .setStyle(s.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('staffp:wk_send').setLabel('Send Report Now').setEmoji('📤').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

// The weekly report itself — a summary embed plus the per-member breakdown.
function buildWeeklyReportEmbeds(guild) {
  const { rows, since, now } = staffSystem.weeklyData(guild.id, 7);
  if (!rows.length) {
    return [new EmbedBuilder().setTitle('📊 Weekly Staff Report').setColor(COLOR.main)
      .setDescription('No staff are registered yet, so there is nothing to report.')];
  }

  const count = (status) => rows.filter(r => r.status === status).length;
  const sum = (key) => rows.reduce((total, r) => total + r[key], 0);
  const top = rows[0].tasksDone + rows[0].checkins > 0 ? rows[0] : null;
  const needsAttention = rows.filter(r => r.status === 'inactive').map(r => `<@${r.userId}>`);

  const summary = new EmbedBuilder()
    .setTitle('📊 Weekly Staff Report — Final')
    .setColor(COLOR.main)
    .setDescription(`${ts(since, 'D')} → ${ts(now, 'D')}`)
    .addFields(
      { name: 'Staff', value: `${rows.length} total • 🟢 ${count('active')} active • 🔴 ${count('inactive')} inactive • 🏖️ ${count('leave')} on leave` },
      { name: 'Work', value: `✅ ${sum('checkins')} check-ins • 🛠️ ${sum('tasksDone')} tasks completed • 📌 ${sum('tasksOpen')} still open • 🧾 ${sum('reports')} reports` },
      { name: 'Chat & voice', value: `💬 ${sum('messages')} messages • 🎙️ ${fmtDuration(sum('voiceSeconds'))} in voice` },
    )
    .setFooter({ text: 'Generated by the Staff Control Panel' })
    .setTimestamp(now);
  if (top) summary.addFields({ name: '🏆 Top performer', value: `<@${top.userId}> — ${top.tasksDone} task(s) done, ${top.checkins} check-in(s)` });
  if (needsAttention.length) summary.addFields({ name: '⚠️ Needs attention (inactive)', value: joinLines(needsAttention, 1000) });

  const lines = rows.map((r, i) =>
    `**${i + 1}.** <@${r.userId}> ${STATUS_EMOJI[r.status]} — ✅ ${r.checkins} • 🛠️ ${r.tasksDone} (+${r.tasksOpen} open) • 🧾 ${r.reports} • 💬 ${r.messages} • 🎙️ ${fmtDuration(r.voiceSeconds)}`);
  const embeds = [summary];
  let chunk = '';
  const flush = () => {
    if (!chunk) return;
    embeds.push(new EmbedBuilder().setColor(COLOR.main).setTitle(embeds.length === 1 ? '👥 Staff breakdown' : '👥 Staff breakdown (cont.)').setDescription(chunk.trim()));
    chunk = '';
  };
  let dropped = 0;
  for (const line of lines) {
    if ((chunk + line + '\n').length > 3800) flush();
    if (embeds.length >= 4) { dropped++; continue; }
    chunk += line + '\n';
  }
  flush();
  if (dropped) embeds[embeds.length - 1].setFooter({ text: `…and ${dropped} more staff not shown` });
  return embeds.slice(0, 4);
}

async function fetchTextChannel(guild, channelId) {
  if (!channelId) return null;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  return ch && ch.isTextBased() ? ch : null;
}

// ---------------------------------------------------------------- dispatcher
async function handleInteraction(interaction) {
  const [, action, arg] = interaction.customId.split(':');

  if (SELF_ACTIONS.has(action)) {
    if (!isStaff(interaction)) return reply(interaction, '❌ This is for staff members only.');
  } else if (!isAdmin(interaction)) {
    return reply(interaction, '❌ Only admins can use that.');
  }

  if (interaction.isButton()) return handleButton(interaction, action, arg);
  if (interaction.isModalSubmit()) return handleModal(interaction, action);
  if (interaction.isUserSelectMenu()) return handleUserSelect(interaction, action);
  if (interaction.isStringSelectMenu()) return handleStringSelect(interaction, action);
  if (interaction.isChannelSelectMenu()) return handleChannelSelect(interaction, action);
}

// ------------------------------------------------------------------ buttons
async function handleButton(interaction, action, arg) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  switch (action) {
    case 'checkin':
      return interaction.showModal(modal('staffp:m_checkin', 'Check-in', [
        textInput({ id: 'note', label: 'What are you working on / done?', style: TextInputStyle.Paragraph, placeholder: 'e.g. Handled slot list for Group B, answered 12 tickets', max: 300 }),
      ]));

    case 'entry': {
      const existing = staffSystem.getMember(guildId, userId);
      return interaction.showModal(modal('staffp:m_entry', 'Staff Entry Form', [
        textInput({ id: 'name', label: 'Name / IGN', value: existing?.name || interaction.member.displayName, max: 60 }),
        textInput({ id: 'position', label: 'What do you handle?', value: existing?.position, placeholder: 'e.g. Registrations, Slot lists, Support', max: 60 }),
        textInput({ id: 'availability', label: 'Availability (optional)', value: existing?.availability, required: false, placeholder: 'e.g. 6 PM – 11 PM IST', max: 100 }),
        textInput({ id: 'notes', label: 'Notes (optional)', value: existing?.notes, required: false, style: TextInputStyle.Paragraph, max: 500 }),
      ]));
    }

    case 'active':
      return interaction.reply({ ...statusListPayload(guildId, 'active'), flags: EPHEMERAL });
    case 'inactive':
      return interaction.reply({ ...statusListPayload(guildId, 'inactive'), flags: EPHEMERAL });
    case 'leaderboard':
      return interaction.reply({ ...buildLeaderboardPayload(guildId), flags: EPHEMERAL });
    case 'list':
      return interaction.reply({ ...buildListPayload(guildId), flags: EPHEMERAL });
    case 'history':
      return interaction.reply({ ...buildHistoryPayload(guildId), flags: EPHEMERAL });

    case 'promote':
      return interaction.reply({
        content: '⬆️ Pick the staff member to promote one rank:',
        components: [row(userSelect('staffp:promote_select', 'Pick a staff member…'))],
        flags: EPHEMERAL,
      });

    case 'profile':
      return interaction.reply({
        content: '👤 Pick a staff member to see their profile and history:',
        components: [row(userSelect('staffp:profile_select', 'Pick a staff member…'))],
        flags: EPHEMERAL,
      });

    case 'work':
      return interaction.reply({ ...buildWorkPayload(guildId, userId, isAdmin(interaction)), flags: EPHEMERAL });

    case 'distribute':
      return interaction.showModal(modal('staffp:m_distribute', 'Distribute Work', [
        textInput({ id: 'title', label: 'Task', placeholder: 'e.g. Verify Group C screenshots', max: 100 }),
        textInput({ id: 'details', label: 'Details (optional)', required: false, style: TextInputStyle.Paragraph, max: 500 }),
      ]));

    case 'myactivity': {
      await interaction.deferReply({ flags: EPHEMERAL });
      const payload = await buildProfilePayload(guild, userId);
      if (!staffSystem.getMember(guildId, userId)) payload.content = 'You are not in the staff list yet — press **Staff Entry Form** to join.';
      return interaction.editReply(payload);
    }

    case 'leave':
      if (!staffSystem.getMember(guildId, userId)) return reply(interaction, '❌ You are not in the staff list yet — press **Staff Entry Form** first.');
      return interaction.showModal(modal('staffp:m_leave', 'Staff Leave', [
        textInput({ id: 'days', label: 'How many days? (1-90)', placeholder: '3', max: 2 }),
        textInput({ id: 'reason', label: 'Reason (optional)', required: false, style: TextInputStyle.Paragraph, max: 200 }),
      ]));

    case 'report':
      return interaction.showModal(modal('staffp:m_report', 'Report Form', [
        textInput({ id: 'subject', label: 'Subject', placeholder: 'e.g. Player dispute in Group A', max: 100 }),
        textInput({ id: 'details', label: 'What happened?', style: TextInputStyle.Paragraph, max: 1500 }),
      ]));

    case 'rules':
      return interaction.reply({ ...buildRulesPayload(guildId, isAdmin(interaction)), flags: EPHEMERAL });

    case 'rules_edit':
      return interaction.showModal(modal('staffp:m_rules', 'Edit Staff Rules', [
        textInput({ id: 'rules', label: 'Rules', style: TextInputStyle.Paragraph, required: false, value: staffSystem.getRules(guildId), max: 4000 }),
      ]));

    case 'weekly':
      return interaction.reply({ ...buildWeeklySettingsPayload(guildId), flags: EPHEMERAL });

    case 'wk_toggle': {
      const s = staffSystem.getWeeklySettings(guildId);
      staffSystem.setWeeklyEnabled(guildId, !s.enabled);
      return interaction.update(buildWeeklySettingsPayload(guildId, `Auto-post is now ${!s.enabled ? 'on' : 'off'}.`));
    }

    case 'wk_send': {
      await interaction.deferUpdate();
      const embeds = buildWeeklyReportEmbeds(guild);
      const channel = await fetchTextChannel(guild, staffSystem.getReportChannelId(guildId));
      if (!channel) {
        await interaction.followUp({ content: 'No report channel is set (or I can\'t see it), so here is the report just for you:', embeds, flags: EPHEMERAL });
        return;
      }
      try {
        await channel.send({ embeds });
        return interaction.editReply(buildWeeklySettingsPayload(guildId, `✅ Report sent to <#${channel.id}>.`));
      } catch (err) {
        console.error('[staff] Failed to send weekly report:', err);
        return interaction.editReply(buildWeeklySettingsPayload(guildId, '❌ I couldn\'t post in that channel — check my permissions there.'));
      }
    }

    case 'rm_yes': {
      const removed = staffSystem.removeMember(guildId, arg, userId);
      return interaction.update({
        content: removed ? `✅ Removed <@${arg}> from the staff list.` : 'That person was already not on the staff list.',
        embeds: [], components: [],
      });
    }

    case 'rm_no':
      return interaction.update({ content: 'Cancelled — nobody was removed.', embeds: [], components: [] });

    case 'dist_auto': {
      const pending = takePending(guildId, userId);
      if (!pending) return interaction.update({ content: '⌛ That request expired — press **Distribute Work** again.', components: [] });
      const ids = staffSystem.pickLeastBusy(guildId, 1);
      if (!ids.length) {
        pendingDistribute.set(`${guildId}:${userId}`, pending);
        return reply(interaction, '❌ There is nobody to auto-assign to — add staff first.');
      }
      return finishDistribute(interaction, pending, ids);
    }
  }
}

// ------------------------------------------------------------------- modals
async function handleModal(interaction, action) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const field = (id) => interaction.fields.getTextInputValue(id).trim();

  switch (action) {
    case 'm_checkin': {
      const member = staffSystem.checkIn(guildId, userId, field('note'));
      if (!member) return reply(interaction, '❌ You are not in the staff list yet — press **Staff Entry Form** first.');
      return reply(interaction, `✅ Checked in (#${member.checkins}). Nice work!`);
    }

    case 'm_entry': {
      const { isNew } = staffSystem.registerMember(guildId, userId, {
        name: field('name'), position: field('position') || 'Staff',
        availability: field('availability'), notes: field('notes'),
      });
      return reply(interaction, isNew ? '✅ Welcome to the staff team! You\'re on the list.' : '✅ Your entry has been updated.');
    }

    case 'm_distribute': {
      const title = field('title');
      pendingDistribute.set(`${guildId}:${userId}`, { title, details: field('details'), at: Date.now() });
      return interaction.reply({
        content: `📤 **${title}**\nWho should get this? Pick people (up to 10) — each gets their own copy — or let me pick the least busy active member.`,
        components: [
          row(userSelect('staffp:dist_select', 'Pick who gets this work…', 10)),
          row(new ButtonBuilder().setCustomId('staffp:dist_auto').setLabel('Auto-assign (least busy)').setEmoji('⚖️').setStyle(ButtonStyle.Secondary)),
        ],
        flags: EPHEMERAL,
      });
    }

    case 'm_leave': {
      const days = parseInt(field('days'), 10);
      if (!Number.isInteger(days) || days < 1 || days > 90) return reply(interaction, '❌ Days must be a number from 1 to 90.');
      const reason = field('reason');
      const member = staffSystem.setLeave(guildId, userId, days, reason);
      if (!member) return reply(interaction, '❌ You are not in the staff list yet — press **Staff Entry Form** first.');
      await interaction.reply({ content: `🏖️ Leave recorded — you're marked as away until ${ts(member.leaveUntil, 'D')}. Checking in ends it early.`, flags: EPHEMERAL });
      const channel = await fetchTextChannel(guild, staffSystem.getReportChannelId(guildId));
      if (channel) {
        channel.send({
          embeds: [new EmbedBuilder().setColor(COLOR.warn).setTitle('🏖️ Staff Leave')
            .setDescription(`<@${userId}> is on leave for **${days}** day(s), back ${ts(member.leaveUntil, 'D')}.${reason ? `\n**Reason:** ${reason}` : ''}`)],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
      return;
    }

    case 'm_report': {
      const report = staffSystem.addReport(guildId, { userId, subject: field('subject'), details: field('details') });
      const channel = await fetchTextChannel(guild, staffSystem.getReportChannelId(guildId));
      if (channel) {
        await channel.send({
          embeds: [new EmbedBuilder().setColor(COLOR.warn).setTitle(`🧾 Report #${report.id} — ${report.subject}`)
            .setDescription(report.details).addFields({ name: 'From', value: `<@${userId}>`, inline: true })
            .setTimestamp(report.at)],
          allowedMentions: { parse: [] },
        }).catch(() => {});
        return reply(interaction, `✅ Report #${report.id} sent to <#${channel.id}>.`);
      }
      return reply(interaction, `✅ Report #${report.id} saved. (No report channel is set yet — an admin can set one under **Weekly Report**.)`);
    }

    case 'm_rules':
      staffSystem.setRules(guildId, interaction.fields.getTextInputValue('rules'));
      return reply(interaction, '✅ Rules updated.');
  }
}

// -------------------------------------------------------------- user selects
function takePending(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const pending = pendingDistribute.get(key);
  pendingDistribute.delete(key);
  if (!pending || Date.now() - pending.at > PENDING_TTL_MS) return null;
  return pending;
}

async function finishDistribute(interaction, pending, assigneeIds) {
  const tasks = staffSystem.createTasks(interaction.guildId, {
    title: pending.title, details: pending.details, assigneeIds, by: interaction.user.id,
  });
  const got = tasks.map(t => t.assigneeId);
  await interaction.update({
    content: `✅ Assigned **${pending.title}** to ${got.map(id => `<@${id}>`).join(', ')}.`,
    components: [],
  });
  const announce = `📤 **New work** from <@${interaction.user.id}>\n**${pending.title}**${pending.details ? `\n${pending.details}` : ''}\n→ ${got.map(id => `<@${id}>`).join(' ')}\n*Use **Staff Work** on the staff panel to see and finish it.*`;
  interaction.channel?.send({ content: announce, allowedMentions: { users: got } }).catch(() => {});
}

async function handleUserSelect(interaction, action) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const actorId = interaction.user.id;

  switch (action) {
    case 'add_select': {
      const added = [];
      for (const user of interaction.users.values()) {
        if (user.bot) continue;
        const gm = interaction.members?.get(user.id);
        staffSystem.registerMember(guildId, user.id, { name: gm?.displayName || user.username }, actorId);
        added.push(`<@${user.id}>`);
      }
      return interaction.update(buildListPayload(guildId, added.length ? `✅ Added ${added.join(', ')}.` : 'Bots can\'t be staff.'));
    }

    case 'rm_select': {
      const targetId = interaction.values[0];
      const m = staffSystem.getMember(guildId, targetId);
      if (!m) return interaction.update({ ...buildListPayload(guildId, `❌ <@${targetId}> isn't in the staff list.`) });
      return interaction.update({
        content: null,
        embeds: [new EmbedBuilder().setColor(COLOR.bad).setTitle('Remove staff member?')
          .setDescription(`Remove <@${targetId}> (${m.rankName}) from the staff list? Their unfinished work is cancelled; their history stays.`)],
        components: [row(
          new ButtonBuilder().setCustomId(`staffp:rm_yes:${targetId}`).setLabel('Yes, remove').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('staffp:rm_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
      });
    }

    case 'promote_select': {
      const targetId = interaction.values[0];
      const result = staffSystem.promote(guildId, targetId, actorId);
      if (!result) return interaction.update({ content: `❌ <@${targetId}> isn't in the staff list.`, components: [] });
      if (result.maxed) return interaction.update({ content: `⭐ <@${targetId}> is already at the top rank (**${result.rankName}**).`, components: [] });
      await interaction.update({ content: `✅ Promoted <@${targetId}>: **${result.from}** → **${result.to}**.`, components: [] });
      interaction.channel?.send({
        content: `🎉 Congratulations <@${targetId}> — promoted from **${result.from}** to **${result.to}**!`,
        allowedMentions: { users: [targetId] },
      }).catch(() => {});
      return;
    }

    case 'profile_select':
      await interaction.deferUpdate();
      return interaction.editReply(await buildProfilePayload(guild, interaction.values[0], { picker: true }));

    case 'dist_select': {
      const pending = takePending(guildId, actorId);
      if (!pending) return interaction.update({ content: '⌛ That request expired — press **Distribute Work** again.', components: [] });
      const ids = [...interaction.users.values()].filter(u => !u.bot && staffSystem.getMember(guildId, u.id)).map(u => u.id);
      if (!ids.length) {
        pendingDistribute.set(`${guildId}:${actorId}`, pending); // let them pick again
        return reply(interaction, '❌ None of the people you picked are in the staff list. Pick again.');
      }
      return finishDistribute(interaction, pending, ids);
    }
  }
}

// ------------------------------------------------------ string / channel selects
async function handleStringSelect(interaction, action) {
  if (action !== 'task_done') return;
  const guildId = interaction.guildId;
  const admin = isAdmin(interaction);
  const task = staffSystem.getTask(guildId, interaction.values[0]);
  if (!task) return interaction.update(buildWorkPayload(guildId, interaction.user.id, admin, '❌ That task no longer exists.'));
  if (!admin && task.assigneeId !== interaction.user.id) {
    return reply(interaction, '❌ You can only finish your own work.');
  }
  const done = staffSystem.completeTask(guildId, task.id, interaction.user.id);
  return interaction.update(buildWorkPayload(guildId, interaction.user.id, admin, done ? `✅ Marked **#${task.id} ${task.title}** as done.` : 'That task was already done.'));
}

async function handleChannelSelect(interaction, action) {
  if (action !== 'wk_channel') return;
  staffSystem.setReportChannelId(interaction.guildId, interaction.values[0]);
  return interaction.update(buildWeeklySettingsPayload(interaction.guildId, `✅ Reports and leave / report notices will go to <#${interaction.values[0]}>.`));
}

// ----------------------------------------------------------- weekly scheduler
function startWeeklyScheduler(client) {
  const tick = async () => {
    for (const guildId of listGuildIds()) {
      if (guildId === '__global__') continue;
      try {
        if (!staffSystem.isWeeklyDue(guildId)) continue;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        const channel = await fetchTextChannel(guild, staffSystem.getReportChannelId(guildId));
        if (!channel) continue;
        await channel.send({ embeds: buildWeeklyReportEmbeds(guild) });
        staffSystem.markWeeklySent(guildId);
        console.log(`[staff] Weekly report posted in guild ${guildId}.`);
      } catch (err) {
        console.error(`[staff] Weekly report failed for guild ${guildId}:`, err);
      }
    }
  };
  setTimeout(tick, 60 * 1000).unref?.();
  setInterval(tick, 15 * 60 * 1000).unref?.();
}

module.exports = {
  buildMainPanel,
  handleInteraction,
  startWeeklyScheduler,
  buildWeeklyReportEmbeds,
};
