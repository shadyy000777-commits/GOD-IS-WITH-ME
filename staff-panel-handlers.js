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
  PermissionFlagsBits,
} = require('discord.js');
const { canManageBot } = require('./access');
const staffActivity = require('./staff-activity');
const staffSystem = require('./staff-system');
const { listGuildIds } = require('./storage');

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

// A dropdown of the people currently on the staff list (what admins asked for:
// pick from the real list, not any server member). Discord caps a dropdown at
// 25 entries, so a bigger team falls back to the free user picker.
function staffPicker(guildId, customId, placeholder) {
  const members = staffSystem.listMembers(guildId);
  if (!members.length || members.length > 25) return userSelect(customId, placeholder);
  return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder)
    .addOptions(members.map(m => ({
      label: String(m.name || m.userId).slice(0, 100),
      value: m.userId,
      description: `${m.rankName} • ${m.status}`.slice(0, 100),
    })));
}

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
      `Staff are **active** while they have checked in within the last ${staffSystem.CHECKIN_WINDOW_HOURS} hours. No check-in = **inactive** (people on leave are excluded).`,
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
  const hours = staffSystem.CHECKIN_WINDOW_HOURS;
  const total = members.length;

  if (kind === 'active') {
    const lines = members
      .filter(m => m.status === 'active')
      .sort((a, b) => b.lastCheckinAt - a.lastCheckinAt)
      .map(m => `🟢 <@${m.userId}> — ${m.rankName} • checked in ${ts(m.lastCheckinAt)}`);
    return {
      embeds: [new EmbedBuilder()
        .setTitle(`🟢 Active Staff (${lines.length}/${total})`)
        .setColor(COLOR.ok)
        .setDescription(joinLines(lines, 3900, `Nobody has checked in during the last ${hours} hours.`))
        .setFooter({ text: `Active = checked in within the last ${hours} hours.` })],
    };
  }

  const inactive = members.filter(m => m.status === 'inactive')
    .map(m => `🔴 <@${m.userId}> — ${m.rankName} • ${m.lastCheckinAt ? `last check-in ${ts(m.lastCheckinAt)}` : 'never checked in'}`);
  const onLeave = members.filter(m => m.status === 'leave')
    .map(m => `🏖️ <@${m.userId}> — ${m.rankName} • back ${ts(m.leaveUntil, 'D')}`);
  const embed = new EmbedBuilder()
    .setTitle(`🔴 Inactive Staff (${inactive.length}/${total})`)
    .setColor(COLOR.bad)
    .setDescription(joinLines(inactive, 3000, '🎉 Everyone has checked in.'))
    .setFooter({ text: `Inactive = no check-in in the last ${hours} hours (staff on leave are listed separately).` });
  if (onLeave.length) embed.addFields({ name: `On leave (${onLeave.length})`, value: joinLines(onLeave, 1000) });
  return { embeds: [embed] };
}

function buildListPayload(guildId, notice) {
  const members = staffSystem.listMembers(guildId);
  const lines = members.map(m => `${STATUS_EMOJI[m.status]} <@${m.userId}> — ${m.rankName} • ${m.position}`);
  const embed = new EmbedBuilder()
    .setTitle(`📋 Staff List (${members.length})`)
    .setColor(COLOR.main)
    .setDescription(joinLines(lines, 3900, 'No staff yet. Add some below, or have them use **Staff Entry Form**.'))
    .setFooter({ text: `${members.length} staff entered (via Staff Entry Form or added here). Use the dropdown to remove someone.` });
  return {
    content: notice || null,
    embeds: [embed],
    components: [
      row(userSelect('staffp:add_select', '➕ Add staff member(s)…', 10)),
      ...(members.length ? [row(staffPicker(guildId, 'staffp:rm_select', '🗑️ Remove a staff member…'))] : []),
    ],
  };
}

// Where this person stands on the 7-day leaderboard: { pos, of } or null.
function leaderboardPosition(guildId, userId) {
  const { rows } = staffSystem.weeklyData(guildId, 7);
  const idx = rows.findIndex(r => r.userId === userId);
  return idx === -1 ? null : { pos: idx + 1, of: rows.length };
}

const topChannelLines = (messages, n = 5) => Object.entries(messages).sort(([, a], [, b]) => b - a).slice(0, n)
  .map(([ch, count]) => `<#${ch}> — **${count}**`);

// Full staff profile (admin "View Profile" with a picker for the next person).
async function buildProfilePayload(guild, userId, { picker = false, notice = null } = {}) {
  const components = picker ? [row(staffPicker(guild.id, 'staffp:profile_select', '👤 Pick another staff member…'))] : [];
  const m = staffSystem.getMember(guild.id, userId);
  if (!m) {
    return {
      content: notice,
      embeds: [new EmbedBuilder().setColor(COLOR.bad).setDescription(`❌ <@${userId}> isn't in the staff list.`)],
      components,
    };
  }

  const discordMember = await guild.members.fetch(userId).catch(() => null);
  const today = staffActivity.getUserDayStats(guild.id, userId);
  const week = staffActivity.getUserRangeStats(guild.id, userId, 7);
  const month = staffActivity.getUserMonthStats(guild.id, userId);
  const board = leaderboardPosition(guild.id, userId);
  const reportCount = staffSystem.getReportCount(guild.id, userId);
  const topChannels = topChannelLines(month.messages);
  const history = staffSystem.getHistory(guild.id, 8, userId)
    .map(h => `${ts(h.at)} **${h.type.replace('_', ' ')}** — ${h.text || '—'}`);

  const embed = new EmbedBuilder()
    .setTitle(`👤 ${m.name || discordMember?.displayName || 'Staff member'}`)
    .setColor(COLOR[m.status === 'active' ? 'ok' : m.status === 'inactive' ? 'bad' : 'warn'])
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: 'Rank', value: m.rankName, inline: true },
      { name: 'Position', value: m.position || '—', inline: true },
      { name: 'Status', value: `${STATUS_EMOJI[m.status]} ${m.status[0].toUpperCase()}${m.status.slice(1)}`, inline: true },
      { name: '🏆 Leaderboard (7d)', value: board ? `#${board.pos} of ${board.of}` : '—', inline: true },
      { name: 'Joined', value: ts(m.joinedAt, 'D'), inline: true },
      { name: 'Availability', value: m.availability || '—', inline: true },
      { name: 'Check-ins', value: `${m.checkins || 0} total\nlast: ${m.lastCheckinAt ? ts(m.lastCheckinAt) : 'never'}`, inline: true },
      { name: 'Work', value: `${m.tasksDone || 0} done • ${m.openTasks} open`, inline: true },
      { name: 'Reports filed', value: String(reportCount), inline: true },
      { name: 'Today', value: `💬 ${today.messageTotal} • 🎙️ ${fmtDuration(today.voiceSeconds)}`, inline: true },
      { name: 'Last 7 days', value: `💬 ${week.messageTotal} • 🎙️ ${fmtDuration(week.voiceSeconds)}`, inline: true },
      { name: 'This month', value: `💬 ${month.messageTotal} • 🎙️ ${fmtDuration(month.voiceSeconds)}`, inline: true },
    );
  if (m.leaveUntil && m.leaveUntil > Date.now()) {
    embed.addFields({
      name: m.status === 'leave' ? 'On leave until' : 'Leave scheduled',
      value: `${m.leaveFrom ? `${ts(m.leaveFrom, 'D')} → ` : ''}${ts(m.leaveUntil, 'D')}${m.leaveReason ? `\n${m.leaveReason}` : ''}`,
    });
  }
  if (m.notes) embed.addFields({ name: 'Notes', value: m.notes.slice(0, 1000) });
  if (topChannels.length) embed.addFields({ name: 'Top channels this month', value: topChannels.join('\n') });
  embed.addFields({ name: 'Recent history', value: joinLines(history, 1000, 'Nothing yet.') });
  if (discordMember) embed.setThumbnail(discordMember.displayAvatarURL());

  return { content: notice, embeds: [embed], components };
}

// "My Activity" — the pressing person's own chat / voice numbers. Works for
// anyone holding the tracked staff role, even before they fill the entry form.
async function buildMyActivityPayload(guild, userId) {
  const m = staffSystem.getMember(guild.id, userId);
  const discordMember = await guild.members.fetch(userId).catch(() => null);
  const today = staffActivity.getUserDayStats(guild.id, userId);
  const week = staffActivity.getUserRangeStats(guild.id, userId, 7);
  const month = staffActivity.getUserMonthStats(guild.id, userId);
  const board = m ? leaderboardPosition(guild.id, userId) : null;

  const embed = new EmbedBuilder()
    .setTitle(`📈 My Activity — ${m?.name || discordMember?.displayName || 'You'}`)
    .setColor(COLOR.main)
    .addFields(
      { name: '💬 Chat — messages', value: `Today **${today.messageTotal}**\nLast 7 days **${week.messageTotal}**\nThis month **${month.messageTotal}**`, inline: true },
      { name: '🎙️ Voice time', value: `Today **${fmtDuration(today.voiceSeconds)}**\nLast 7 days **${fmtDuration(week.voiceSeconds)}**\nThis month **${fmtDuration(month.voiceSeconds)}**`, inline: true },
    );
  if (m) {
    embed.addFields(
      { name: '✅ Check-ins', value: `${m.checkins || 0} total\nlast: ${m.lastCheckinAt ? ts(m.lastCheckinAt) : 'never'}`, inline: true },
      { name: '🛠️ Work', value: `${m.tasksDone || 0} done • ${m.openTasks} open`, inline: true },
      { name: 'Rank', value: m.rankName, inline: true },
      { name: '🏆 Leaderboard (7d)', value: board ? `#${board.pos} of ${board.of}` : '—', inline: true },
      { name: 'Status', value: `${STATUS_EMOJI[m.status]} ${m.status[0].toUpperCase()}${m.status.slice(1)}`, inline: true },
    );
  }
  const todayCh = topChannelLines(today.messages, 5);
  const monthCh = topChannelLines(month.messages, 5);
  if (todayCh.length) embed.addFields({ name: 'Messages today by channel', value: todayCh.join('\n') });
  if (monthCh.length) embed.addFields({ name: 'Top channels this month', value: monthCh.join('\n') });
  embed.setFooter({ text: m ? 'Chat and voice are counted for members holding the tracked staff role.' : 'Not on the staff list yet — press Staff Entry Form to join.' });
  if (discordMember) embed.setThumbnail(discordMember.displayAvatarURL());
  return { embeds: [embed] };
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

// "Staff History" — people who used to be staff (removed from the list).
function buildHistoryPayload(guildId) {
  const former = staffSystem.getFormerStaff(guildId);
  const lines = former.map(f =>
    `**${f.name || 'Unknown'}** (<@${f.userId}>) — ${f.rankName}${f.position ? ` • ${f.position}` : ''}\n`
    + `└ joined ${ts(f.joinedAt, 'D')} • removed ${ts(f.removedAt, 'D')}${f.removedBy ? ` by <@${f.removedBy}>` : ''} • ✅ ${f.checkins} check-ins • 🛠️ ${f.tasksDone} work done`);
  return {
    embeds: [new EmbedBuilder().setTitle(`📚 Staff History — former staff (${former.length})`).setColor(COLOR.main)
      .setDescription(joinLines(lines, 3900, 'Nobody has been removed from the staff list yet.'))
      .setFooter({ text: 'Newest removals first. Open View Profile for an active member\'s own event history.' })],
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

// ------------------------------------------------- private channel / leave role
// Report forms and leave notices go to a channel only admins can see. If none
// is set (or it was deleted) one is created: hidden from @everyone, visible to
// the bot and the TOURNAMENT ELITE role (server admins see everything anyway).
// `!staff reportchannel #channel` points it at an existing private channel.
async function ensurePrivateChannel(guild) {
  const existing = await fetchTextChannel(guild, staffSystem.getPrivateChannelId(guild.id));
  if (existing) return existing;
  try {
    const me = guild.members.me || await guild.members.fetchMe();
    const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: me.id, allow },
    ];
    const elite = guild.roles.cache.find(r => r.name.toLowerCase() === 'tournament elite');
    if (elite) overwrites.push({ id: elite.id, allow });
    const channel = await guild.channels.create({
      name: 'staff-reports',
      type: ChannelType.GuildText,
      topic: 'Private — staff report forms and leave notices.',
      permissionOverwrites: overwrites,
      reason: 'Staff panel: private channel for report forms',
    });
    staffSystem.setPrivateChannelId(guild.id, channel.id);
    return channel;
  } catch (err) {
    console.error('[staff] Could not create the private reports channel:', err.message);
    return null;
  }
}

async function ensureLeaveRole(guild) {
  const id = staffSystem.getLeaveRoleId(guild.id);
  const found = id ? (guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null)) : null;
  if (found) return found;
  const byName = guild.roles.cache.find(r => r.name.toLowerCase() === 'staff on leave');
  if (byName) { staffSystem.setLeaveRoleId(guild.id, byName.id); return byName; }
  try {
    const role = await guild.roles.create({
      name: 'Staff On Leave', color: 0x95A5A6, mentionable: false, permissions: [],
      reason: 'Staff panel: role for staff who are on leave',
    });
    staffSystem.setLeaveRoleId(guild.id, role.id);
    return role;
  } catch (err) {
    console.error('[staff] Could not create the Staff On Leave role:', err.message);
    return null;
  }
}

// Gives / takes the leave role so it matches the person's real leave status.
// Returns false only when the role couldn't be applied (missing permission).
async function syncLeaveRole(guild, userId, { force = false } = {}) {
  const m = staffSystem.getMember(guild.id, userId);
  const should = Boolean(m && m.status === 'leave');
  if (!force && m && Boolean(m.leaveRoleGiven) === should) return true;
  try {
    const role = should ? await ensureLeaveRole(guild)
      : (staffSystem.getLeaveRoleId(guild.id) && (guild.roles.cache.get(staffSystem.getLeaveRoleId(guild.id)) || null));
    if (should && !role) return false;
    const gm = await guild.members.fetch(userId).catch(() => null);
    if (gm && role) {
      if (should && !gm.roles.cache.has(role.id)) await gm.roles.add(role, 'Staff leave started');
      if (!should && gm.roles.cache.has(role.id)) await gm.roles.remove(role, 'Staff leave ended');
    }
    if (m) staffSystem.setLeaveRoleGiven(guild.id, userId, should);
    return true;
  } catch (err) {
    console.error(`[staff] Leave role sync failed for ${userId}:`, err.message);
    return false;
  }
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
        components: [row(staffPicker(guildId, 'staffp:promote_select', 'Pick a staff member…'))],
        flags: EPHEMERAL,
      });

    case 'profile':
      return interaction.reply({
        content: '👤 Pick a staff member to see their profile and history:',
        components: [row(staffPicker(guildId, 'staffp:profile_select', 'Pick a staff member…'))],
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
      return interaction.editReply(await buildMyActivityPayload(guild, userId));
    }

    case 'leave':
      if (!staffSystem.getMember(guildId, userId)) return reply(interaction, '❌ You are not in the staff list yet — press **Staff Entry Form** first.');
      return interaction.showModal(modal('staffp:m_leave', 'Staff Leave', [
        textInput({ id: 'from', label: 'From date (DD/MM/YYYY)', placeholder: '15/10/2026', min: 8, max: 10 }),
        textInput({ id: 'to', label: 'To date (DD/MM/YYYY)', placeholder: '18/10/2026', min: 8, max: 10 }),
        textInput({ id: 'reason', label: 'Reason', style: TextInputStyle.Paragraph, placeholder: 'Why are you taking leave?', max: 300 }),
      ]));

    case 'report':
      return interaction.showModal(modal('staffp:m_report', 'Report Form', [
        textInput({ id: 'subject', label: 'Subject', placeholder: 'e.g. Player dispute in Group A', max: 100 }),
        textInput({ id: 'about', label: 'Who / what is this about? (optional)', required: false, placeholder: 'Team name, player, channel…', max: 100 }),
        textInput({ id: 'details', label: 'What happened?', style: TextInputStyle.Paragraph, max: 1500 }),
        textInput({ id: 'evidence', label: 'Proof / links (optional)', required: false, style: TextInputStyle.Paragraph, placeholder: 'Message links, screenshot links…', max: 500 }),
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
      if (removed) syncLeaveRole(guild, arg, { force: true });
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
      await reply(interaction, `✅ Checked in (#${member.checkins}). You're now **active**. Nice work!`);
      syncLeaveRole(guild, userId); // a check-in ends a running leave
      return;
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
      const range = staffSystem.parseLeaveRange(field('from'), field('to'));
      if (range.error) return reply(interaction, `❌ ${range.error}`);
      const reason = field('reason');
      const member = staffSystem.setLeave(guildId, userId, range.fromMs, range.toMs, reason);
      if (!member) return reply(interaction, '❌ You are not in the staff list yet — press **Staff Entry Form** first.');
      await interaction.deferReply({ flags: EPHEMERAL });
      const roleOk = await syncLeaveRole(guild, userId, { force: true });
      const starts = range.fromMs > Date.now() ? `starts ${ts(range.fromMs, 'D')}` : 'started';
      await interaction.editReply(
        `🏖️ Leave recorded: ${ts(range.fromMs, 'D')} → ${ts(range.toMs, 'D')} (${starts}).`
        + (member.status === 'leave' ? ' You now have the **Staff On Leave** role.' : ' You\'ll get the **Staff On Leave** role when it starts.')
        + (roleOk ? '' : '\n⚠️ I couldn\'t manage the leave role — an admin needs to give me **Manage Roles** (with my role above it).')
        + '\nChecking in ends it early.');
      const channel = await ensurePrivateChannel(guild);
      if (channel) {
        channel.send({
          embeds: [new EmbedBuilder().setColor(COLOR.warn).setTitle('🏖️ Staff Leave')
            .setDescription(`<@${userId}> — ${ts(range.fromMs, 'D')} → ${ts(range.toMs, 'D')}`)
            .addFields({ name: 'Reason', value: reason.slice(0, 1000) || '—' })],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
      return;
    }

    case 'm_report': {
      await interaction.deferReply({ flags: EPHEMERAL });
      const report = staffSystem.addReport(guildId, {
        userId, subject: field('subject'), about: field('about'), details: field('details'), evidence: field('evidence'),
      });
      const channel = await ensurePrivateChannel(guild);
      if (!channel) return interaction.editReply(`✅ Report #${report.id} saved, but I couldn't post it to a private channel — an admin can set one with \`!staff reportchannel #channel\` (or give me Manage Channels).`);
      const embed = new EmbedBuilder().setColor(COLOR.warn).setTitle(`🧾 Report #${report.id} — ${report.subject}`)
        .setDescription(report.details)
        .addFields({ name: 'From', value: `<@${userId}>`, inline: true })
        .setTimestamp(report.at);
      if (report.about) embed.addFields({ name: 'About', value: report.about, inline: true });
      if (report.evidence) embed.addFields({ name: 'Proof / links', value: report.evidence });
      try {
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch (err) {
        console.error('[staff] Could not post report:', err.message);
        return interaction.editReply(`✅ Report #${report.id} saved, but I can't post in <#${channel.id}> — check my permissions there.`);
      }
      return interaction.editReply(`✅ Report #${report.id} submitted privately to the admins.`);
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
  // The staff-list dropdowns return the picked user ID in values[0], just like the user picker.
  if (action === 'rm_select' || action === 'profile_select' || action === 'promote_select') return handleUserSelect(interaction, action);
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

// Gives / removes the Staff On Leave role as leave starts and ends, even when
// nobody presses a button (a leave that begins next week, or one that just ran out).
function startLeaveScheduler(client) {
  const tick = async () => {
    for (const guildId of listGuildIds()) {
      if (guildId === '__global__') continue;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      try {
        for (const m of staffSystem.listMembers(guildId)) await syncLeaveRole(guild, m.userId);
      } catch (err) {
        console.error(`[staff] Leave role check failed for guild ${guildId}:`, err);
      }
    }
  };
  setTimeout(tick, 45 * 1000).unref?.();
  setInterval(tick, 5 * 60 * 1000).unref?.();
}

module.exports = {
  buildMainPanel,
  startLeaveScheduler,
  ensurePrivateChannel,
  ensureLeaveRole,
  handleInteraction,
  startWeeklyScheduler,
  buildWeeklyReportEmbeds,
};
