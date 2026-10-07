const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelType, AttachmentBuilder,
  MessageFlags, PermissionFlagsBits, OverwriteType,
} = require('discord.js');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const { getGuildStore, saveGuildStore, listGuildIds } = require('./tn-storage');
const {
  bindActiveTournament, getTournamentStore, listTournaments, getTournamentById,
  setActiveTournament, generateTournamentId,
} = require('./tn-tournament-store');
const { buildGroupsEmbed, buildTournamentSlotListEmbed } = require('./tn-embeds');
const { groupSlotNumber, nextLockedSlot, emptySlotNumbers, activeOverride, hasEmptySlot, normalSlotTotal } = require('./tn-slots');
const { canManageBot, hasTournamentAdminRole, hasTournamentEliteRole, envAllowedIds } = require('./tn-access');
const {
  MAX_MATCHES, parseTimeInput, formatTime, parseDateInput, formatDateLabel,
  matchLine, setMatchCount, buildScheduleLines,
} = require('./tn-group-schedule');
const {
  startPending: startRegPending, getPending: getRegPending,
  updatePending: updateRegPending, clearPending: clearRegPending,
} = require('./tn-pending-tournament-registrations');
const { logRoleChange } = require('./tn-tournament-activity-log');

const RESTART_HINT = 'Click **Register Team** again to restart — no partial data is saved.';

const MAX_GROUPS = 150;
const DEFAULT_GROUP_CAPACITY = 20;
const MAX_GROUP_CAPACITY = 1000;
const MAX_TOTAL_SLOTS = 15000;
const MAX_ROUND = 10;
// Groups are keyed 1..MAX_GROUPS (plain numeric strings) rather than
// letters, so "Group 1", "Group 2"... display correctly everywhere they're
// already interpolated as `Group ${letter}` without needing a separate
// display-name lookup.
const GROUP_LETTERS = Array.from({ length: MAX_GROUPS }, (_, i) => String(i + 1));
const MAX_GUILD_ROLES = 250;
const MAX_GUILD_CHANNELS = 500;
const SAFETY_MARGIN = 5;

// Discord allows at most 50 channels inside one category.
const MAX_CHANNELS_PER_CATEGORY = 50;

function categoryChildCount(guild, categoryId) {
  return guild.channels.cache.filter(c => c.parentId === categoryId).size;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The base category plus its numbered continuations ("Groups", "Groups 2",
// "Groups 3"...), in order. A base already named "Groups 1" continues as
// "Groups 2", "Groups 3"...
function getCategoryFamily(guild, baseCategory) {
  const stem = baseCategory.name.replace(/[\s\-_#]*\d+\s*$/, '').trim() || baseCategory.name;
  const re = new RegExp(`^${escapeRegExp(stem)}[\\s\\-_#]*(\\d+)$`, 'i');
  const baseMatch = baseCategory.name.match(re);
  const baseNumber = baseMatch ? Number(baseMatch[1]) : 1;
  const siblings = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildCategory && c.id !== baseCategory.id && re.test(c.name))
    .map(c => ({ channel: c, n: Number(c.name.match(re)[1]) }))
    .filter(x => x.n > baseNumber)
    .sort((a, b) => a.n - b.n);
  return { stem, baseNumber, siblings, all: [baseCategory, ...siblings.map(x => x.channel)] };
}

// Runs an API call, retrying transient failures (network drops, 5xx, 429)
// with a short backoff. Real Discord rejections (missing permission, channel
// cap, unknown channel...) carry a numeric error code and are NOT retried.
async function withRetry(fn, { tries = 3, delays = [1500, 3000] } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = err && (err.status >= 500 || err.status === 429 || typeof err.code !== 'number');
      if (!transient || attempt === tries - 1) throw err;
      await new Promise(r => setTimeout(r, delays[attempt] ?? delays[delays.length - 1]));
    }
  }
  throw lastErr;
}

// Returns a category that still has room for another channel. If `baseCategory`
// is full (50 channels), continues into numbered copies of it — reusing any
// existing one with room before creating a new one. New ones copy the base
// category's permissions.
async function ensureCategoryWithRoom(guild, baseCategory, reason) {
  if (categoryChildCount(guild, baseCategory.id) < MAX_CHANNELS_PER_CATEGORY) return baseCategory;

  const { stem, baseNumber, siblings } = getCategoryFamily(guild, baseCategory);
  for (const { channel } of siblings) {
    if (categoryChildCount(guild, channel.id) < MAX_CHANNELS_PER_CATEGORY) return channel;
  }

  const nextNumber = Math.max(baseNumber, ...siblings.map(x => x.n)) + 1;
  const last = siblings.length ? siblings[siblings.length - 1].channel : baseCategory;
  return withRetry(() => guild.channels.create({
    name: `${stem.slice(0, 90)} ${nextNumber}`,
    type: ChannelType.GuildCategory,
    permissionOverwrites: baseCategory.permissionOverwrites.cache.map(o => ({
      id: o.id, type: o.type, allow: o.allow, deny: o.deny,
    })),
    position: last.rawPosition + 1,
    reason,
  }));
}

// Guilds currently running Auto Channels — stops a second press (e.g. an
// impatient retry) from racing the first run and making duplicate channels.
const channelBuildsInFlight = new Set();

function isBanned(tournament, teamName) {
  return (tournament.bannedTeams || []).includes(teamName.toLowerCase());
}

function isDuplicateTeam(tournament, teamName) {
  return Object.values(tournament.groups)
    .some(g => g.teams.some(t => t.team.toLowerCase() === teamName.toLowerCase()));
}

// Same check, but for one specific round's groups (Round 1 = tournament.groups).
// A team promoted into Round 2 legitimately shares its name with its Round 1
// entry, so Round 2+ only compares against that round's own groups.
function isDuplicateTeamInRound(tournament, teamName, roundNum) {
  if (roundNum <= 1) return isDuplicateTeam(tournament, teamName);
  const groups = getRound(tournament, roundNum).groups || {};
  return Object.values(groups)
    .some(g => g.teams.some(t => t.team.toLowerCase() === teamName.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Tournament list — entry point when several tournaments can exist at once.
// Pick one to open its wizard panel, or start a brand new one.
// ---------------------------------------------------------------------------
function buildTournamentListPayload(guildId) {
  const tournaments = listTournaments(guildId);

  const embed = new EmbedBuilder()
    .setTitle('🥇 Tournaments')
    .setColor(0x5865F2)
    .setDescription(
      tournaments.length
        ? 'Pick a tournament to manage, or create a new one — several can run at the same time.'
        : 'No tournaments yet. Click **Create Tournament** to start your first one.'
    );

  const rows = [];
  if (tournaments.length) {
    // Select menus cap at 25 options — plenty for any realistic number of
    // concurrently-running tournaments; extra ones just won't show up here.
    const select = new StringSelectMenuBuilder()
      .setCustomId('tourney_list_select')
      .setPlaceholder('Select a tournament to manage')
      .addOptions(tournaments.slice(0, 25).map(t => ({
        label: t.name.slice(0, 100),
        description: t.open ? 'Open' : 'Closed',
        value: t.id,
      })));
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_create').setLabel('Create Tournament').setEmoji('➕').setStyle(ButtonStyle.Success),
  ));

  return { embeds: [embed], components: rows };
}

async function handleTournamentListSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const tid = interaction.values[0];
  const ok = setActiveTournament(interaction.guildId, interaction.user.id, tid);
  if (!ok) {
    return interaction.update({ content: '❌ That tournament no longer exists.', embeds: [], components: [] });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  await interaction.update({ content: '', ...buildTournamentWizardPayload(store) });
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
function buildTournamentWizardPayload(store) {
  const tournament = store.tournament;

  const embed = new EmbedBuilder()
    .setTitle(tournament ? `🥇 Tournament Setup — ${tournament.name}` : '🥇 Tournament Setup')
    .setColor(tournament ? (tournament.open ? 0x57F287 : 0xED4245) : 0x5865F2);

  if (!tournament) {
    embed.setDescription('No tournament is set up yet. Click **Create Tournament** to get started — the rest of these buttons need one to exist first.');
  } else {
    const groupCount = Object.keys(tournament.groups).length;
    const teamCount = Object.values(tournament.groups).reduce((sum, g) => sum + g.teams.length, 0);
    const bannedCount = (tournament.bannedTeams || []).length;

    embed.addFields(
      { name: 'Status', value: tournament.open ? '🟢 Open' : '🔴 Closed', inline: true },
      { name: 'Groups', value: groupCount ? String(groupCount) : 'None yet', inline: true },
      { name: 'Teams Registered', value: String(teamCount), inline: true },
    );

    if (bannedCount) {
      embed.addFields({ name: '🔨 Banned Teams', value: String(bannedCount), inline: true });
    }
    if (tournament.slotManagerChannelId) {
      embed.addFields({ name: 'Slot-Manager Channel', value: `<#${tournament.slotManagerChannelId}>`, inline: true });
    }
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_create').setLabel('Create Tournament').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tourney_wizard_toggle')
      .setLabel('Start/Pause Reg')
      .setEmoji(tournament && tournament.open ? '⏸️' : '▶️')
      .setStyle(tournament && tournament.open ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_manage_groups').setLabel('Manage Groups').setEmoji('🗂️').setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_edit_settings').setLabel('Edit Settings').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_create_channels').setLabel('Create Channels').setEmoji('📺').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_ban_unban').setLabel('Ban/Unban').setEmoji('🔨').setStyle(ButtonStyle.Danger),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_cancel_slots').setLabel('Cancel Slots').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_add').setLabel('Manually Add Slot').setEmoji('📌').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_post_register_panel').setLabel('Post Register Panel').setEmoji('📮').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tourney_wizard_swap_toggle')
      .setLabel(tournament && isGroupSwapOpen(tournament) ? 'Group Swap: On' : 'Group Swap: Off')
      .setEmoji(tournament && isGroupSwapOpen(tournament) ? '🔄' : '🚫')
      .setStyle(tournament && isGroupSwapOpen(tournament) ? ButtonStyle.Success : ButtonStyle.Danger),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_slot_manager_channel').setLabel('Slot-Manager channel').setEmoji('📡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_export_data').setLabel('Export Data').setEmoji('📥').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_select_staff').setLabel('Select Staff').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_back_to_list').setLabel('Other Tournaments').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  );
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_reset').setLabel('Reset').setEmoji('🔄').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tourney_wizard_delete').setLabel('Delete Tournament').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tourney_wizard_help').setLabel('Help').setEmoji('❓').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tourney_wizard_repost_group_panel').setLabel('Group Panel').setEmoji('📨').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_refresh').setLabel('Refresh').setEmoji('🔃').setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

// "Manage Groups" now goes straight to the group picker (see
// buildSlotListGroupSelectPayload, further down) — pick a group and its
// current slot list is shown. Nothing else to configure here manually
// since groups are auto-created from Total Slots / Teams-per-Group when
// Create Channels is hit, and each group's own channel carries its own
// admin panel (Publish Slot List / Punish Team / Result — see
// buildTournamentGroupAdminPanelPayload) for jobs scoped to that group.

// Sub-panel behind "Create Channels" — leads into the Channel Name /
// Category Name panel, which itself now creates one channel per group
// (see buildManualChannelCreationPayload).
function buildCreateChannelsSubmenuPayload() {
  const embed = new EmbedBuilder()
    .setTitle('📺 Create Channels')
    .setColor(0x5865F2)
    .setDescription(
      '**Create Channel** — set a naming format (defaults to `Group {number}`, use `{letter}` for A, B, C...) and a category name, then hit **Auto Channels** on the next screen to create every group\'s own channel under that category — one channel per group, in order (1, 2, 3...).'
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_create_channels_manual').setLabel('Create Channel').setEmoji('➕').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// Posted automatically in a group's own channel the moment that channel is
// created via "Create Channels" (Round 1) or a "Result" promotion (Round
// 2+) — the per-group counterpart to the top-level wizard panel, scoped to
// just this one group. Round-aware: the "Result" button (and its wording)
// changes depending on whether there's a next round to promote into.
function buildTournamentGroupAdminPanelPayload(tournament, roundNum, letter) {
  const group = getRoundGroups(tournament, roundNum)[letter];
  // Titled with the round's name (Round Name / Category Name / "Round N") rather than the group.
  const title = `🛠️ ${getRoundDisplayName(tournament, roundNum).name} — Admin Panel`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865F2);

  // The panel shows this group's match schedule (set via Config): the date and
  // each match's IDP time, start time and map. No description until matches
  // are configured. The panel message is edited in place whenever Config
  // changes (see refreshGroupSlotList).
  const scheduleLines = buildScheduleLines(group);
  if (scheduleLines.length) embed.setDescription(scheduleLines.join('\n'));

  const tid = tournament.id;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_group_publish:${tid}:${roundNum}:${letter}`).setLabel('Publish Slot List').setEmoji('📤').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tourney_wizard_group_punish:${tid}:${roundNum}:${letter}`).setLabel('Punish Team').setEmoji('🔨').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tourney_wizard_group_result:${tid}:${roundNum}:${letter}`).setLabel('Result').setEmoji('🌟').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tourney_wizard_group_config:${tid}:${roundNum}:${letter}`).setLabel('Config').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
    // Open / Close toggle — group channels are created closed. The button
    // shows the action it will perform (Open while closed, Close while open)
    // and that action rides in the customId, so a stale panel can't flip the
    // wrong way.
    new ButtonBuilder()
      .setCustomId(`tourney_wizard_group_chat:${tid}:${roundNum}:${letter}:${group && group.chatOpen ? 'close' : 'open'}`)
      .setLabel(group && group.chatOpen ? 'Close' : 'Open')
      .setEmoji(group && group.chatOpen ? '🔒' : '🔓')
      .setStyle(group && group.chatOpen ? ButtonStyle.Danger : ButtonStyle.Success),
  );
  // Second row — Reminder posts the auto-timings nudge (see
  // buildGroupReminderPayload) straight into this channel, pinging the
  // group's role. Separate row since the first one is already full (5/5).
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_group_reminder:${tid}:${roundNum}:${letter}`).setLabel('Reminder').setEmoji('🔔').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row, row2] };
}

// "Reminder" button on the group admin panel — posts a pre-formatted,
// role-pinged nudge straight into that group's channel with whatever
// match timings are currently configured (Config -> Set Date / matches).
// Purely a messaging action: doesn't touch the schedule, teams, or panel.
function buildGroupReminderPayload(group) {
  const matchLines = (group && group.schedule && group.schedule.matches && group.schedule.matches.length)
    ? group.schedule.matches.map((m, idx) => `**Match ${idx + 1}** — IDP ${formatTime(m.idp)} | Start ${formatTime(m.start)}`)
    : ['Schedule not set yet — check with staff.'];
  const roleId = group && group.roleId ? group.roleId : null;

  const embed = new EmbedBuilder()
    .setTitle('REMINDER 🛑')
    .setColor(0xED4245)
    .setDescription([
      '**YOUR MATCHES ARE TODAY**',
      '',
      matchLines.join('\n'),
      '',
      '**__CHECK YOUR SCHEDULE & SLOTLIST__**',
      '',
      '**__RESULT SS IS COMPULSORY__**',
    ].join('\n'));

  // The role mention goes in `content` on the SAME message as the embed —
  // a content-field mention still pings even with an embed attached, so
  // this shows as one message (ping text above the embed) instead of two.
  return {
    embed,
    roleId,
    payload: {
      content: roleId ? `<@&${roleId}>` : '',
      embeds: [embed],
      allowedMentions: roleId ? { roles: [roleId] } : { parse: [] },
    },
  };
}

// Public panel — this is the one meant to live in a #register-style
// channel where players (not admins) click to sign their team up. It's
// just an embed + the same Register Team button the admin panel used to
// carry, but posted on its own so players never see admin controls.
function buildTournamentRegisterPanelPayload(tournament) {
  const teamCount = Object.values(tournament.groups).reduce((sum, g) => sum + g.teams.length, 0);
  const perGroupCapacity = tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY;
  // Effective max capacity for display — the smaller of the admin's overall
  // totalSlots cap (if set) and what MAX_GROUPS groups can actually hold.
  // Groups themselves are created lazily as they're needed, so this is a
  // ceiling, not a count of slots that already exist.
  const maxCapacity = Math.min(
    tournament.totalSlots || Infinity,
    MAX_GROUPS * perGroupCapacity,
  );

  const embed = new EmbedBuilder()
    .setTitle(`<a:6bbbe07d495743d0a6b546e50d7dd64e:1548939826924097566> ${tournament.name} — Team Registration`)
    .setColor(tournament.open ? 0x57F287 : 0xED4245)
    .setDescription(
      tournament.open
        ? 'Click **Register Team** below, enter your team details and BE READY FOR YOUR MATCHES.'
        : '<:3409locked:1548939795147915345> Registration is currently closed.'
    )
    .addFields(
      { name: 'Status', value: tournament.open ? '<a:885679180799422574:1548939840547061910> Open' : '<a:836435400498741289:1548939837422309397> Closed', inline: true },
      { name: 'Slots Filled', value: Number.isFinite(maxCapacity) ? `${teamCount}/${maxCapacity}` : String(teamCount), inline: true },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_register_team:${tournament.id}`).setLabel('Register Team').setEmoji('<a:452028tick:1548939815574175764>').setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}
// Quotient-style lettered settings screen — each field is edited by its own
// button (A-G) rather than one big modal, since Discord modals cap at 5
// text inputs and two of these fields (channel, role) need pickers anyway.
// Every pick saves immediately, so "Go Back" and "Save" both just return to
// the main panel — there's no separate unsaved draft to discard or commit.
function buildCreateSettingsPayload(tournament) {
  const embed = new EmbedBuilder()
    .setTitle('Enter details & Press Save')
    .setColor(0x5865F2)
    .addFields(
      { name: 'B. Confirm Channel', value: tournament.confirmChannelId ? `<#${tournament.confirmChannelId}>` : 'Not-Set' },
      { name: 'C. Required Mentions (0-4)', value: String(tournament.requiredMentions ?? 4) },
      { name: 'D. Teams per Group', value: tournament.teamsPerGroup ? String(tournament.teamsPerGroup) : 'Not-Set' },
      { name: 'E. Total Slots', value: tournament.totalSlots ? String(tournament.totalSlots) : 'Not-Set' },
      { name: 'F. Fake Tag', value: tournament.allowFakeTag ? '✅ ON — players can pick already-registered players' : '❌ OFF — a player can only be on one team' },
      { name: 'G. Register Role', value: tournament.registerRoleId ? `<@&${tournament.registerRoleId}> — only players with this role can register` : 'Not-Set — anyone can register' },
      { name: 'H. Group Swap Channel', value: tournament.swapChannelId ? `<#${tournament.swapChannelId}> — swap requests and completed swaps are posted here` : 'Not-Set — swaps are posted where the request was made' },
      { name: 'I. Registration Role', value: tournament.confirmRoleId ? `<@&${tournament.confirmRoleId}> — given to players right after they register, before their group role` : 'Not-Set — an auto-created "<Tournament> Registered" role is given' },
      { name: 'J. Log Channel', value: tournament.logChannelId ? `<#${tournament.logChannelId}> — every button click, form and menu pick is posted here` : 'Not-Set — nothing is logged' },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_create_settings_b').setLabel('B').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_c').setLabel('C').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_d').setLabel('D').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_e').setLabel('E').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_fake_tag').setLabel('F').setStyle(tournament.allowFakeTag ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_create_settings_g').setLabel('G').setStyle(tournament.registerRoleId ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_h').setLabel('H').setStyle(tournament.swapChannelId ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_i').setLabel('I').setStyle(tournament.confirmRoleId ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_create_settings_j').setLabel('J').setStyle(tournament.logChannelId ? ButtonStyle.Success : ButtonStyle.Primary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_manage_rounds').setLabel('Manage Rounds').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tourney_create_settings_back').setLabel('Go Back').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tourney_create_settings_save').setLabel('Save').setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row1, row3, row4] };
}


function buildHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('❓ Tournament Panel Help')
    .setColor(0x5865F2)
    .setDescription([
      '**Start/Pause Reg** — open or close team registration',
      '**Manage Groups** — pick a group to view its current slot list',
      '**Create Channels** — groups auto-generate from Total Slots / Teams-per-Group if none exist yet; press **Create Channel**, set a Channel Name and Category Name, then hit **Auto Channels** to create every group\'s own channel under that category',
      '**Each group\'s own channel** — carries its own panel: Publish Slot List, Punish Team, Result, Config, Open/Close, and Reminder (posts a role-pinged "today\'s matches" nudge with the configured timings), scoped to just that group',
      '**Edit Settings** — rename the tournament',
      '**Ban/Unban** — block or unblock a team name from registering',
      '**Cancel Slots** — remove a registered team from its group',
      '**Manually Add Slot** — pick a player, then a group, then enter the team name — force-registers them into that group (bypassing auto-assign) and gives them the group\'s role; once a group is full it drops them into a reserved locked slot instead',
      '**Post Register Panel** — posts the public registration panel in this channel, for players to register themselves',
      '**Slot-Manager channel** — pick a channel where a self-service panel (Cancel My Slot / My Groups / Change Team Name / Swap Group) is posted for players',
      '**Group Swap: On/Off** — lets Manage Server or TOURNAMENT ELITE turn the players\' self-service group swap on or off; while off, no player can open the swap picker, send a request, or accept/reject one (admins can still swap teams themselves)',
      '**Export Data** — export every team\'s owner name, player IGNs + UIDs and Discord players as an Excel file (a Teams sheet + a Discord Players sheet)',
      '**Select Staff** — pick the players who get this tournament\'s Staff role; they can talk in every group channel, use @everyone / @here and group-role mentions, and use every button on each group\'s panel except Punish Team, without Manage Server',
      '**Group Panel** — pick a group and repost its admin panel (Publish Slot List / Punish Team / Result / Config / Open-Close) in that group\'s channel with its current settings — use this if a staff member accidentally deletes that panel message',
      '**Refresh** — re-render everything the bot has posted for this tournament (this panel, the register panel, every group\'s admin panel and slot list) with the latest data and layout; nothing is deleted or changed',
      '**Reset** — clear every registered team, group role, group channel and slot list, but keep all settings (name, slots, rounds, confirm/slot-manager channels, register panel, staff, bans)',
      '**Delete Tournament** — wipe everything and start over (an Excel backup of all registrations is sent to you automatically first)',
    ].join('\n'));
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function buildTournamentCreateModal() {
  return new ModalBuilder()
    .setCustomId('tourney_wizard_create_modal')
    .setTitle('Create Tournament')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('Tournament name').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. BGMI Winter Championship').setRequired(true).setMaxLength(80)
      ),
    );
}

function buildAddGroupModal() {
  return new ModalBuilder()
    .setCustomId('tourney_wizard_group_modal')
    .setTitle('Add Group')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('letter').setLabel(`Group number (1-${MAX_GROUPS})`).setStyle(TextInputStyle.Short)
          .setPlaceholder('1').setRequired(true).setMaxLength(3)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('capacity').setLabel('Team capacity').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 20').setRequired(true).setMaxLength(4)
      ),
    );
}

// Core group-creation math, shared by the "Create Channels" auto-setup path
// below. Fills GROUP_LETTERS sequentially with `perGroup`-capacity groups
// until `total` teams are covered. Returns null groups on validation error.
function computeAutoGroups(tournament, total, perGroup) {
  if (!Number.isInteger(total) || total < 1 || total > MAX_TOTAL_SLOTS) {
    return { error: `❌ Total teams must be a whole number between 1 and ${MAX_TOTAL_SLOTS}.` };
  }
  if (!Number.isInteger(perGroup) || perGroup < 1 || perGroup > MAX_GROUP_CAPACITY) {
    return { error: `❌ Teams per group must be a whole number between 1 and ${MAX_GROUP_CAPACITY}.` };
  }

  const groupsNeeded = Math.ceil(total / perGroup);
  const freeLetters = GROUP_LETTERS.filter(l => !tournament.groups[l]);

  if (groupsNeeded > freeLetters.length) {
    return {
      error: `❌ That needs **${groupsNeeded}** new group(s), but only **${freeLetters.length}** letter slot(s) are free (max ${GROUP_LETTERS.length} groups total). Raise "teams per group" or delete an unused group first.`,
    };
  }

  const createdLetters = [];
  let remaining = total;
  for (let i = 0; i < groupsNeeded; i++) {
    const letter = freeLetters[i];
    const capacity = Math.min(perGroup, remaining);
    tournament.groups[letter] = { capacity, teams: [] };
    remaining -= capacity;
    createdLetters.push(letter);
  }

  return { createdLetters, groupsNeeded };
}

// Shared by both "Create Channels" paths (auto and manual) — makes sure
// groups exist before any channel gets created, auto-generating them from
// Total Slots / Teams-per-Group. Safe to call even if some groups already
// exist (e.g. a team registered before Create Channels was ever pressed,
// auto-creating just one group) — computeAutoGroups only fills in letters
// that are still free, so existing groups are left untouched. Returns an
// error string to show the admin, or null once groups are ready.
function ensureGroupsExist(interaction, store) {
  const tournament = store.tournament;
  if (!tournament.totalSlots) {
    if (Object.keys(tournament.groups).length) return null;
    return '❌ Set **Total Slots** first — Edit Settings → Total Slots (and Teams-per-Group, if you want something other than the default).';
  }
  const perGroup = tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY;
  const groupsAlreadyCovered = Object.keys(tournament.groups).length;
  const totalGroupsWanted = Math.ceil(tournament.totalSlots / perGroup);
  const stillNeeded = totalGroupsWanted - groupsAlreadyCovered;
  if (stillNeeded <= 0) return null;

  const result = computeAutoGroups(tournament, stillNeeded * perGroup, perGroup);
  if (result.error) {
    // Groups already exist (e.g. a big CSV import) — don't block channel
    // creation just because the extra empty groups can't be added; carry on
    // with the groups that are there.
    if (groupsAlreadyCovered > 0) return null;
    return result.error;
  }
  saveGuildStore(interaction.guildId, store);
  return null;
}

// Looks up (or auto-creates, once per group) the private role scoped to
// one tournament group. Registration calls this directly (role only, no
// channel) the moment a team lands in a group; createGroupChannels (the
// "Auto Channels" admin button) calls it too when it's time to actually
// make that group's channel — so whichever path runs first creates the
// role, and the other reuses it, instead of ever drifting apart.
//
// If the role already exists but under a different name than what's
// wanted now (e.g. registration created it with the default
// "Tournament Group {letter}" format before the admin ever set a custom
// Role Name, and Auto Channels is now asking for that custom name), it
// gets renamed in place rather than silently kept under its old name —
// otherwise a custom Role Name typed into the Auto Channels panel would
// only ever apply to brand-new groups, never ones that already had a
// team register into them.
//
// Never throws — a role-cap, permissions, or rename hiccup just logs and
// returns the role (or null), so it never blocks registration or channel
// creation outright.
async function ensureGroupRole(interaction, store, group, roleName, reason) {
  // Once tournament staff exist, group roles are mentionable so staff can ping
  // a group by typing its role (they don't get the server-wide "Mention
  // @everyone / all roles" permission — see Select Staff).
  const staffConfigured = Object.values(store.tournaments || {}).some(t => t.staffRoleId);
  let role = group.roleId ? interaction.guild.roles.cache.get(group.roleId) : null;
  if (role) {
    if (staffConfigured && !role.mentionable) await role.setMentionable(true, reason).catch(() => {});
    if (role.name !== roleName) {
      try {
        role = await role.setName(roleName, reason);
      } catch (err) {
        console.error(`[tournament-group-role] Failed to rename role ${role.id} to "${roleName}" in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      }
    }
    return role;
  }

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    console.error(`[tournament-group-role] Bot is missing the "Manage Roles" permission in guild ${interaction.guildId}.`);
    return null;
  }
  if (interaction.guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) {
    console.error(`[tournament-group-role] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_ROLES}-role cap — skipping auto-create for "${roleName}".`);
    return null;
  }
  try {
    role = await interaction.guild.roles.create({ name: roleName, mentionable: staffConfigured, reason });
    group.roleId = role.id;
    saveGuildStore(interaction.guildId, store);
    return role;
  } catch (err) {
    console.error(`[tournament-group-role] Failed to auto-create role "${roleName}" in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    return null;
  }
}

// One tournament-wide role — "<Tournament Name> Winner" — created lazily
// the moment a winner is picked on the final round. Reused across re-runs
// of Result on the final group (tournament.winnerRoleId), same caching
// pattern as ensureGroupRole.
async function ensureWinnerRole(interaction, store, tournament) {
  let role = tournament.winnerRoleId ? interaction.guild.roles.cache.get(tournament.winnerRoleId) : null;
  if (role) return role;

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    console.error(`[tournament-winner-role] Bot is missing the "Manage Roles" permission in guild ${interaction.guildId}.`);
    return null;
  }
  if (interaction.guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) {
    console.error(`[tournament-winner-role] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_ROLES}-role cap — skipping winner role creation.`);
    return null;
  }
  try {
    role = await interaction.guild.roles.create({
      name: `${tournament.name} Winner`,
      mentionable: false,
      reason: `Tournament "${tournament.name}" winner role`,
    });
    tournament.winnerRoleId = role.id;
    saveGuildStore(interaction.guildId, store);
    return role;
  } catch (err) {
    console.error(`[tournament-winner-role] Failed to auto-create winner role in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    return null;
  }
}

// One tournament-wide role — "<Tournament Name> Registered" — given to a team's
// owner the moment they register. It's what registered players hold BEFORE
// any group channel exists; the group role (which is what actually shows a
// group's channel) is handed out later, when an admin creates the channels.
// Created lazily and cached on tournament.registeredRoleId, like the winner role.
async function ensureTournamentRegisteredRole(interaction, store, tournament) {
  // Setting I (Registration Role): if the admin picked a role, that's the one
  // players get on registering. It's never auto-deleted (it isn't ours).
  if (tournament.confirmRoleId) {
    const customRole = interaction.guild.roles.cache.get(tournament.confirmRoleId);
    if (customRole) return customRole;
  }
  let role = tournament.registeredRoleId ? interaction.guild.roles.cache.get(tournament.registeredRoleId) : null;
  if (role) return role;

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    console.error(`[tournament-registered-role] Bot is missing the "Manage Roles" permission in guild ${interaction.guildId}.`);
    return null;
  }
  if (interaction.guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) {
    console.error(`[tournament-registered-role] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_ROLES}-role cap — skipping registered role creation.`);
    return null;
  }
  try {
    role = await interaction.guild.roles.create({
      name: `${tournament.name} Registered`.slice(0, 100),
      mentionable: false,
      reason: `Tournament "${tournament.name}" registered-players role`,
    });
    tournament.registeredRoleId = role.id;
    saveGuildStore(interaction.guildId, store);
    return role;
  } catch (err) {
    console.error(`[tournament-registered-role] Failed to create registered role in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    return null;
  }
}

// Takes the Registered role off a member (team cancelled / banned / punished).
async function removeRegisteredRole(guild, tournament, member, reason = 'registration removed') {
  if (!tournament || !member) return;
  for (const roleId of [tournament.confirmRoleId, tournament.registeredRoleId]) {
    if (roleId && guild.roles.cache.has(roleId) && member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId).catch(() => {});
      await logRoleChange(guild, tournament, { member, roleId, added: false, reason });
    }
  }
}

// Puts group channels in true numeric order (G1, G2, G3 ... G10) inside
// whichever category they sit in. Discord orders channels by their saved
// position and breaks ties by name, which gives the text order
// G1, G10, G11 ... G19, G2 whenever positions were never set explicitly.
// Every text channel of each affected category is sorted by its NAME with
// natural number ordering (so a channel whose saved id went stale still gets
// sorted), and the category's whole family ("... 2", "... 3") is included.
//
// `opts.onlyNewIds`: when given, existing channels are NOT reordered — only the
// listed, freshly created channels are slotted into numeric position among
// them. This is what automatic runs use, so a category you arranged by hand
// stays exactly as you left it. The manual "Sort" button omits it, which does
// the full re-sort.
// Turns a channel-name format ("ROU-100K-ROUND-1-G{number}") into a regex that
// recognises every group channel made from it, wherever it was dragged to.
// Returns null when the format has no {number}/{letter} token.
function groupChannelMatcher(format, roundNum) {
  if (!format || !/\{(letter|number)\}/i.test(format)) return null;
  const src = String(format).trim().split(/(\{round\}|\{number\}|\{letter\})/i).map(part => {
    const t = part.toLowerCase();
    if (t === '{round}') return String(roundNum);
    if (t === '{number}') return '\\d+';
    if (t === '{letter}') return '[a-z]+';
    return escapeRegExp(part).replace(/\s+/g, '[-_ ]');
  }).join('');
  try { return new RegExp(`^${src}$`, 'i'); } catch { return null; }
}

async function sortGroupChannels(guild, groups, extraCategoryIds = [], opts = {}) {
  const natural = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const onlyNew = Array.isArray(opts.onlyNewIds) ? new Set(opts.onlyNewIds) : null;
  try {
    await guild.channels.fetch().catch(() => {});
    const parentIds = new Set(extraCategoryIds.filter(Boolean));
    for (const g of Object.values(groups || {})) {
      const ch = g && g.channelId && guild.channels.cache.get(g.channelId);
      if (ch && ch.parentId) parentIds.add(ch.parentId);
    }
    // Full sort: also find group channels by NAME, so a channel dragged into
    // some other category (or whose saved id went stale) is still picked up.
    const matcher = onlyNew ? null : groupChannelMatcher(opts.channelFormat, opts.roundNum ?? 1);
    const matchedChs = matcher
      ? guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.parentId && matcher.test(c.name)).map(c => c)
      : [];
    for (const ch of matchedChs) parentIds.add(ch.parentId);
    // Pull in overflow categories ("<name> 2", "<name> 3"...) too.
    for (const pid of [...parentIds]) {
      const cat = guild.channels.cache.get(pid);
      if (cat && cat.type === ChannelType.GuildCategory) {
        for (const c of getCategoryFamily(guild, cat).all) parentIds.add(c.id);
      }
    }
    let total = 0;

    // ---- FULL SORT (manual "Sort" button) --------------------------------
    // Puts EVERY group channel of the round in true numeric order across all
    // the categories involved — G1..G50 in the first category, G51.. in the
    // next, and so on — pulling in a channel that was dragged into a
    // different category (e.g. G6 sitting elsewhere) so it lands back in its
    // numeric place. Each category keeps room for its non-group channels.
    if (!onlyNew) {
      const groupChs = [];
      const addCh = ch => { if (ch && ch.type === ChannelType.GuildText && ch.parentId && !groupChs.includes(ch)) groupChs.push(ch); };
      for (const g of Object.values(groups || {})) addCh(g && g.channelId && guild.channels.cache.get(g.channelId));
      matchedChs.forEach(addCh);
      if (!groupChs.length) {
        // Nothing identified by id or name — fall back to every text channel in
        // the group categories (how the sort always worked before).
        guild.channels.cache.filter(c => c.type === ChannelType.GuildText && parentIds.has(c.parentId)).forEach(addCh);
      }
      if (!groupChs.length) {
        if (opts.stats) opts.stats.empty = `checked ${parentIds.size} categor${parentIds.size === 1 ? 'y' : 'ies'}, ${Object.values(groups || {}).filter(g => g && g.channelId).length} saved channel id(s), name pattern ${matcher ? matcher : 'none'}`;
        return 0;
      }
      groupChs.sort(natural);
      const groupIds = new Set(groupChs.map(c => c.id));

      const cats = [...parentIds]
        .map(id => guild.channels.cache.get(id))
        .filter(c => c && c.type === ChannelType.GuildCategory)
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));

      // Hand group channels to the categories top-to-bottom, respecting each
      // category's 50-channel cap (non-group channels already in it count).
      const plan = new Map(cats.map(c => [c.id, []]));
      let next = 0;
      for (const cat of cats) {
        const others = guild.channels.cache.filter(c => c.parentId === cat.id && !groupIds.has(c.id)).size;
        const room = Math.max(0, MAX_CHANNELS_PER_CATEGORY - others);
        plan.get(cat.id).push(...groupChs.slice(next, next + room));
        next += room;
      }
      // Safety net (shouldn't happen): anything that didn't fit stays where it is.
      for (const ch of groupChs.slice(next)) {
        if (plan.has(ch.parentId)) plan.get(ch.parentId).push(ch);
      }

      const payload = [];
      const byCat = new Map();
      let moved = 0;
      for (const cat of cats) {
        const assigned = plan.get(cat.id);
        const others = guild.channels.cache
          .filter(c => c.parentId === cat.id && c.type === ChannelType.GuildText && !groupIds.has(c.id))
          .map(c => c)
          .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
        const ordered = [...assigned, ...others];
        if (!ordered.length) continue;
        const base = Math.min(...ordered.map(c => c.rawPosition ?? 0));
        const entries = [];
        ordered.forEach((ch, i) => {
          const entry = { channel: ch.id, position: base + i };
          if (ch.parentId !== cat.id) { entry.parent = cat.id; entry.lockPermissions = false; moved++; }
          entries.push(entry);
          payload.push(entry);
        });
        byCat.set(cat.id, entries);
        total += assigned.length;
      }
      const describe = e => `${e && e.message ? e.message : e}${e && e.code ? ` (code ${e.code})` : ''}`;
      const failed = [];
      let lastErr = null;
      if (payload.length) {
        try {
          await guild.channels.setPositions(payload);
        } catch (bulkErr) {
          // One bad channel (e.g. one the bot can't access) makes Discord reject
          // the whole batch — retry per category, then per channel, so
          // everything that CAN be sorted still is.
          console.error('[tournament] Bulk channel reorder failed, retrying per category:', bulkErr);
          lastErr = bulkErr;
          for (const entries of byCat.values()) {
            try {
              await guild.channels.setPositions(entries);
            } catch (catErr) {
              lastErr = catErr;
              for (const e of entries) {
                try { await guild.channels.setPositions([e]); }
                catch (chErr) { lastErr = chErr; failed.push(e.channel); }
              }
            }
          }
        }
      }
      const failedGroup = failed.filter(id => groupIds.has(id));
      total = Math.max(0, total - failedGroup.length);
      if (opts.stats) {
        opts.stats.moved = moved;
        if (failedGroup.length) {
          const names = failedGroup.slice(0, 5).map(id => `#${guild.channels.cache.get(id)?.name ?? id}`).join(', ');
          opts.stats.error = `${failedGroup.length} channel(s) couldn't be moved — ${describe(lastErr)}. e.g. ${names}`;
        }
      }
      return total;
    }

    for (const pid of parentIds) {
      let list;
      const inCat = guild.channels.cache
        .filter(c => c.parentId === pid && c.type === ChannelType.GuildText)
        .map(c => c);
      if (onlyNew) {
        const fresh = inCat.filter(c => onlyNew.has(c.id)).sort(natural);
        if (!fresh.length) continue;
        // Keep the current (possibly hand-made) order of everything else.
        list = inCat.filter(c => !onlyNew.has(c.id))
          .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || (a.id < b.id ? -1 : 1));
        for (const ch of fresh) {
          let at = 0; // after the last existing channel that sorts before it
          list.forEach((c, i) => { if (natural(c, ch) < 0) at = i + 1; });
          list.splice(at, 0, ch);
        }
        const before = inCat.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || (a.id < b.id ? -1 : 1)).map(c => c.id).join();
        if (before === list.map(c => c.id).join()) continue; // already in place
      } else {
        list = inCat.sort(natural);
      }
      if (list.length < 2) continue;
      const base = Math.min(...list.map(c => c.rawPosition ?? 0));
      await guild.channels.setPositions(list.map((ch, i) => ({ channel: ch.id, position: base + i })));
      total += list.length;
    }
    return total;
  } catch (err) {
    console.error(`[tournament] Couldn't sort group channels:`, err);
    if (opts.stats) opts.stats.error = err.message;
    return 0;
  }
}

// Shared by both "Create Channels" paths — actually creates the Discord
// channel for every group that has at least one registered team and
// doesn't have a channel yet, under `parentId` (or no category) using
// `nameFormat`. Groups with zero registered teams are skipped — e.g. 1000
// total slots at 20/group makes 50 possible groups, but if only 800 teams
// have registered so far, only the 40 groups that actually have teams get
// a channel; the rest wait until they fill up and Auto Channels is run
// again. "{letter}" is swapped for the group's internal letter (A, B,
// C...) and "{number}" for its 1-based position in that order (1, 2,
// 3...) — so an admin typing "Noble {number}" gets "Noble 1", "Noble 2",
// "Noble 3"... in order, while the groups are still tracked internally by
// letter. If the format uses neither token, "-{letter}" is appended so
// names stay unique across groups. Every channel comes out private — only
// that specific group's own role can see it (auto-created here if it
// doesn't have one yet), so a team registered into Group 1 can never see
// Group 2's channel, and it can't spin up threads — same lockdown
// regardless of which path made it.
async function createGroupChannels(interaction, store, { nameFormat, parentId, roleFormat, onProgress }) {
  const guild = interaction.guild;
  const tournament = store.tournament;
  const letters = Object.keys(tournament.groups).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const hasLetterToken = /\{letter\}/i.test(nameFormat);
  const hasNumberToken = /\{number\}/i.test(nameFormat);
  const effectiveRoleFormat = roleFormat || getRoundNaming(tournament, 1).roleFormat;
  const hasRoleLetterToken = /\{letter\}/i.test(effectiveRoleFormat);
  const hasRoleNumberToken = /\{number\}/i.test(effectiveRoleFormat);

  const created = [];
  const newChannelIds = []; // channels made in this run — only these get auto-positioned
  const categoriesUsed = new Set();
  let missingRole = 0;
  const roleProblems = []; // teams whose owner couldn't be given the group role
  let skippedEmpty = 0;
  let failed = 0;
  let repaired = 0;
  let adopted = 0;
  let stopReason = null;
  const baseCategory = parentId
    ? (guild.channels.cache.get(parentId) ?? await guild.channels.fetch(parentId).catch(() => null))
    : null;

  // Every channel already claimed by a group — used so a channel left behind
  // by an interrupted run can be adopted, but never one another group owns.
  const claimedChannelIds = new Set(letters.map(l => tournament.groups[l].channelId).filter(Boolean));
  const workTotal = letters.filter(l => (tournament.groups[l].teams || []).length > 0).length;
  let workDone = 0;

  const roleNameFor = (letter, number) => {
    let roleName = effectiveRoleFormat.replace(/\{round\}/gi, '1');
    if (hasRoleLetterToken) roleName = roleName.replace(/\{letter\}/gi, letter);
    if (hasRoleNumberToken) roleName = roleName.replace(/\{number\}/gi, String(number));
    if (!hasRoleLetterToken && !hasRoleNumberToken) roleName = `${roleName} ${letter}`;
    return roleName.slice(0, 100); // Discord's hard cap on role name length
  };

  // Gives every registered team owner in the group its role. Only adds where
  // it's missing, so it's safe (and self-healing) to run on every pass.
  const grantRoleToOwners = async (group, role, letter) => {
    if (!role) return;
    for (const t of group.teams) {
      if (!t.ownerId) { roleProblems.push(`${t.team} (G${letter}: no owner saved)`); continue; }
      const ownerMember = guild.members.cache.get(t.ownerId)
        ?? await guild.members.fetch(t.ownerId).catch(() => null);
      if (!ownerMember) { roleProblems.push(`${t.team} (G${letter}: owner <@${t.ownerId}> isn't in the server)`); continue; }
      if (!ownerMember.roles.cache.has(role.id)) {
        await ownerMember.roles.add(role.id, 'Group channel created').then(() => {
          logRoleChange(guild, tournament, { member: ownerMember, roleId: role.id, added: true, reason: `Group ${letter} channel created by ${interaction.user.tag}` });
        }).catch(err => {
          roleProblems.push(`${t.team} (G${letter}: couldn't add role — ${err.message})`);
          console.error(`[tournament-group-role] Failed to add role ${role.id} to ${t.ownerId} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
        });
      }
    }
  };

  const ensurePanelMessage = async (channel, group, letter) => {
    let exists = null;
    let unknown = false;
    if (group.adminPanelMessageId) {
      try {
        exists = await channel.messages.fetch(group.adminPanelMessageId);
      } catch (err) {
        if (err.code !== 10008) unknown = true; // couldn't tell — don't post a duplicate
      }
    }
    if (exists || unknown) return false;
    const panelMessage = await channel.send(buildTournamentGroupAdminPanelPayload(tournament, 1, letter)).catch(() => null);
    if (panelMessage) { group.adminPanelMessageId = panelMessage.id; return true; }
    return false;
  };

  for (let i = 0; i < letters.length; i++) {
    const letter = letters[i];
    const number = /^\d+$/.test(letter) ? Number(letter) : i + 1;
    const group = tournament.groups[letter];
    // Skip groups nobody has registered into yet — e.g. 1000 slots / 20 per
    // group makes 50 possible groups, but if only 800 teams (40 groups'
    // worth) have actually registered, the other 10 stay empty and get no
    // channel. They'll get one automatically once a team lands in them and
    // Auto Channels is run again.
    if (!group.teams || group.teams.length === 0) { skippedEmpty++; continue; }

    try {
      // ---- Does this group's channel still exist? -----------------------
      // A saved id whose channel was deleted counts as missing (rebuilt
      // below). Only Discord's "Unknown Channel" answer proves that — any
      // other lookup error means we can't tell, so we leave it alone rather
      // than risk a duplicate.
      let channel = null;
      let lookupUncertain = false;
      if (group.channelId) {
        channel = guild.channels.cache.get(group.channelId) ?? null;
        if (!channel) {
          try { channel = await guild.channels.fetch(group.channelId); }
          catch (err) { if (err.code !== 10003) lookupUncertain = true; }
        }
        if (!channel && !lookupUncertain) { claimedChannelIds.delete(group.channelId); group.channelId = null; }
      }
      if (lookupUncertain) { failed++; continue; }

      const roleName = roleNameFor(letter, number);
      let name = nameFormat.replace(/\{round\}/gi, '1');
      if (hasLetterToken) name = name.replace(/\{letter\}/gi, letter);
      if (hasNumberToken) name = name.replace(/\{number\}/gi, String(number));
      if (!hasLetterToken && !hasNumberToken) name = `${name}-${letter}`;
      name = name.toLowerCase();

      // ---- Existing channel: check it and repair whatever is missing ------
      if (channel) {
        let didRepair = false;
        const hadRole = Boolean(group.roleId && guild.roles.cache.has(group.roleId));
        const role = await ensureGroupRole(interaction, store, group, roleName, `Auto-created for Group ${letter} tournament registration`);
        if (!role) missingRole++;

        // Fix names made by the old text-sorted numbering (e.g. Group 10's
        // channel called "...-2"): rename so they match the real group number.
        if (channel.name !== name) {
          await channel.setName(name, 'Fix group number').then(() => { didRepair = true; }).catch(() => {});
        }
        if (role && role.name !== roleName) {
          await role.setName(roleName, 'Fix group number').then(() => { didRepair = true; }).catch(() => {});
        }

        if (role && !channel.permissionOverwrites.cache.has(role.id)) {
          // Role was missing/deleted (or the channel was made without one):
          // put the lockdown back. Only when the role has no overwrite yet, so
          // a channel staff already Opened is never re-closed.
          const keep = channel.permissionOverwrites.cache
            .filter(o => o.id !== role.id && o.id !== guild.roles.everyone.id)
            .map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
          const staffFix = staffChannelOverwrite(guild, tournament);
          if (staffFix && !keep.some(o => o.id === staffFix.id)) keep.push(staffFix);
          for (const bo of botRoleChannelOverwrites(guild)) if (!keep.some(o => o.id === bo.id)) keep.push(bo);
          for (const so of staffMemberOverwrites(guild, tournament)) if (!keep.some(o => o.id === so.id)) keep.push(so);
          await channel.permissionOverwrites.set([
            ...keep,
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.MentionEveryone] },
            { id: role.id, allow: GROUP_CLOSED_ALLOW, deny: GROUP_CLOSED_DENY },
          ], 'Repair: restoring group role access').then(() => { didRepair = true; }).catch(err => {
            console.error(`[tournament] Repair of permissions for group ${letter} failed: ${err.message}`);
          });
        }
        if (!hadRole && role) didRepair = true;
        if (!channel.parentId && baseCategory) {
          // Its category was deleted — put it back under the family.
          try {
            const cat = await ensureCategoryWithRoom(guild, baseCategory, 'Repair: re-homing orphaned group channel');
            await channel.setParent(cat.id, { lockPermissions: false });
            categoriesUsed.add(cat.name);
            didRepair = true;
          } catch (err) { console.error(`[tournament] Couldn't re-home channel for group ${letter}: ${err.message}`); }
        }
        if (await ensurePanelMessage(channel, group, letter)) didRepair = true;
        await grantRoleToOwners(group, role, letter);
        if (didRepair) repaired++;
        saveGuildStore(interaction.guildId, store);
        continue;
      }

      // ---- Missing channel: build it -------------------------------------
      if (guild.channels.cache.size >= MAX_GUILD_CHANNELS - SAFETY_MARGIN) {
        stopReason = `the server is at Discord's ${MAX_GUILD_CHANNELS}-channel limit`;
        break;
      }
      // Find a category with room BEFORE making the group's role, so a failure
      // here never leaves an orphan role behind. A full category (50 channels)
      // rolls over into "<name> 2", "<name> 3"...
      let targetCategory = null;
      if (baseCategory) {
        try {
          targetCategory = await ensureCategoryWithRoom(guild, baseCategory, `Category full — continuing tournament group channels (${interaction.user.tag})`);
        } catch (err) {
          console.error(`[tournament] Couldn't get/create an overflow category under "${baseCategory.name}": ${err.message}`);
          stopReason = `I couldn't create the next category (${err.message})`;
          break;
        }
      }

      // Best-effort private role per group — if it can't be made (missing
      // Manage Roles permission, role cap hit, etc.) the channel still gets
      // created below, just without that group-only lockdown; a later re-run
      // will add the role and lock it down.
      const role = await ensureGroupRole(interaction, store, group, roleName, `Auto-created for Group ${letter} tournament registration`);
      // Group channels are created CLOSED: players can see the channel but not
      // chat, send files or start threads until staff press Open on the admin
      // panel (Close locks it again). Staff keep full access via the staff-role
      // overwrite.
      const overwrites = role
        ? [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.MentionEveryone] },
            { id: role.id, allow: GROUP_CLOSED_ALLOW, deny: GROUP_CLOSED_DENY },
          ]
        // No group role could be created: channel stays public, so lock chat for @everyone instead.
        : [{ id: guild.roles.everyone.id, deny: GROUP_CLOSED_DENY }];
      const staffOw = staffChannelOverwrite(guild, tournament);
      if (staffOw) overwrites.push(staffOw);
      overwrites.push(...allowedUserChannelOverwrites(guild));
      overwrites.push(...botRoleChannelOverwrites(guild));
      overwrites.push(...staffMemberOverwrites(guild, tournament));
      if (!role) missingRole++;

      // A channel with this exact name left behind by an interrupted run (the
      // bot died after Discord made it but before the id was saved) is adopted
      // instead of duplicated.
      const familyIds = new Set(baseCategory ? getCategoryFamily(guild, baseCategory).all.map(c => c.id) : []);
      const leftover = guild.channels.cache.find(c =>
        c.type === ChannelType.GuildText && c.name === name && !claimedChannelIds.has(c.id) &&
        (baseCategory ? familyIds.has(c.parentId) : !c.parentId));

      if (leftover) {
        channel = leftover;
        adopted++;
        if (role && !channel.permissionOverwrites.cache.has(role.id)) {
          await channel.permissionOverwrites.edit(role.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }).catch(() => {});
        }
      } else {
        channel = await withRetry(() => guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: targetCategory ? targetCategory.id : undefined,
          permissionOverwrites: overwrites,
          reason: `Tournament group channel created by ${interaction.user.tag}`,
        }));
      }
      // Persist immediately — if the bot dies right after this, the channel
      // is already recorded and a retry won't duplicate it.
      group.channelId = channel.id;
      claimedChannelIds.add(channel.id);
      saveGuildStore(interaction.guildId, store);
      created.push(`<#${channel.id}>`);
      newChannelIds.push(channel.id);
      if (targetCategory) categoriesUsed.add(targetCategory.name);

      await ensurePanelMessage(channel, group, letter);
      saveGuildStore(interaction.guildId, store);

      // Now that the channel exists, every registered team owner in this
      // group gets the group role — that's what makes the channel visible
      // to them (until now they only held the tournament's Registered role).
      await grantRoleToOwners(group, role, letter);
    } catch (err) {
      failed++;
      console.error(`[tournament] Failed to create/repair channel for group ${letter}:`, err.message);
    } finally {
      workDone++;
      if (onProgress && workDone % 10 === 0) await onProgress(workDone, workTotal).catch(() => {});
    }
  }
  await sortGroupChannels(guild, tournament.groups, [], { onlyNewIds: newChannelIds });
  saveGuildStore(interaction.guildId, store);
  return { created, missingRole, roleProblems, skippedEmpty, failed, repaired, adopted, stopReason, categoriesUsed: [...categoriesUsed] };
}

// In-progress "Create Channel" (manual) data — Channel Format and Category
// Name are set one at a time via separate modals, so this bridges them
// until both are set and "Create Channels" is pressed. In-memory only: if
// the bot restarts mid-flow, the admin just presses the button again.
const pendingManualChannelCreation = new Map(); // key: `${guildId}:${userId}` -> { data, timer }
const MANUAL_CHANNEL_CREATION_TTL_MS = 15 * 60 * 1000;

function manualChannelCreationKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function setPendingChannelCreation(guildId, userId, fields) {
  const key = manualChannelCreationKey(guildId, userId);
  const existing = pendingManualChannelCreation.get(key);
  if (existing && existing.timer) clearTimeout(existing.timer);
  const data = { ...(existing ? existing.data : {}), ...fields };
  const timer = setTimeout(() => pendingManualChannelCreation.delete(key), MANUAL_CHANNEL_CREATION_TTL_MS);
  pendingManualChannelCreation.set(key, { data, timer });
  return data;
}

function getPendingChannelCreation(guildId, userId) {
  const entry = pendingManualChannelCreation.get(manualChannelCreationKey(guildId, userId));
  return entry ? entry.data : null;
}

function clearPendingChannelCreation(guildId, userId) {
  const key = manualChannelCreationKey(guildId, userId);
  const entry = pendingManualChannelCreation.get(key);
  if (entry && entry.timer) clearTimeout(entry.timer);
  pendingManualChannelCreation.delete(key);
}

// Panel behind "Create Channel" — set Channel Name (format) and pick an
// existing Category from the server, then Auto Channels creates every
// filled group's own channel, named from that format, under the chosen
// category.
function buildManualChannelCreationPayload(data) {
  const ready = Boolean(data.channelFormat && data.categoryId);
  const embed = new EmbedBuilder()
    .setTitle('📺 Tournament Channel Creation')
    .setColor(ready ? 0x57F287 : 0x5865F2)
    .setDescription(
      'Creates a channel for every **filled** group (empty groups with no registered teams are skipped) under the category below. ' +
      'Use `{number}` in the channel name for 1, 2, 3... or `{letter}` for A, B, C...'
    )
    .addFields(
      { name: 'Channel Name', value: data.channelFormat ? `\`${data.channelFormat}\`` : '`Not Set`' },
      { name: 'Category', value: data.categoryId ? `\`${data.categoryName}\`` : '`Not Set`' },
      { name: 'Role Name', value: data.roleFormat ? `\`${data.roleFormat}\`` : '`Tournament Group {letter}` (default)' },
      { name: 'Status', value: ready ? '✅ Ready — hit Auto Channels.' : '🔒 Set both the channel name and category to continue' },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_set_format').setLabel('Channel Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_set_category').setLabel('Category').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_set_role').setLabel('Role Name').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_auto_create').setLabel('Auto Channels').setEmoji('⚙️').setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_sort').setLabel('Sort Channels').setEmoji('🔢').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_cancel').setLabel('Cancel').setEmoji('🚫').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2] };
}

function buildAutoGroupsModal(tournament) {
  const totalInput = new TextInputBuilder().setCustomId('total').setLabel('Total teams expected').setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 720').setRequired(true).setMaxLength(5);
  if (tournament && tournament.totalSlots) totalInput.setValue(String(tournament.totalSlots));

  const perGroupInput = new TextInputBuilder().setCustomId('per_group').setLabel('Teams per group').setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 20').setRequired(true).setMaxLength(4);
  if (tournament && tournament.teamsPerGroup) perGroupInput.setValue(String(tournament.teamsPerGroup));

  return new ModalBuilder()
    .setCustomId('tourney_wizard_auto_groups_modal')
    .setTitle('Auto-Create Groups')
    .addComponents(
      new ActionRowBuilder().addComponents(totalInput),
      new ActionRowBuilder().addComponents(perGroupInput),
    );
}

// Registration form — ONE modal with 4 boxes:
//   Team Name · Team Owner Name · WhatsApp Contact · Players
// The Players box takes one "IGN,UID" per line: 4 required players + an
// optional 5th. Discord modals can't hold a user-select component, so the
// player @mentions are picked afterwards (see buildMentionPlayersRow).
// Nothing is saved until the player taps Confirm at the very end.
const MAX_IGN_LENGTH = 30;
const MIN_TEAM_PLAYERS = 4;
const MAX_TEAM_PLAYERS = 5;
const UID_RE = /^[0-9]{5,12}$/;
const WHATSAPP_RE = /^\+?[0-9]{7,15}$/; // same rule as the verification panel
// One player line: "IGN,UID" (also tolerates "-", "/", "|", ":" or a space
// between them). The UID is numbers only, 5-12 digits, and comes last.
const PLAYER_LINE_RE = /^(.+?)(?:\s*[-–—\/|:,]\s*|\s+)([0-9]{5,12})$/;

// draft = raw answers from a previous failed attempt, so "Try Again" doesn't
// make the player retype everything.
function buildRegisterModal(tid, draft = {}, { customId, title } = {}) {
  const input = (id, label, style, { max, placeholder } = {}) => {
    const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(true).setMaxLength(max);
    if (placeholder) field.setPlaceholder(placeholder);
    if (draft[id]) field.setValue(String(draft[id]));
    return field;
  };
  return new ModalBuilder()
    .setCustomId(customId || `tourney_wizard_register_modal:${tid}`)
    .setTitle(title || 'Register Team')
    .addComponents(
      new ActionRowBuilder().addComponents(input('team', 'Team Name', TextInputStyle.Short, { max: 80 })),
      new ActionRowBuilder().addComponents(input('owner', 'Team Owner Name', TextInputStyle.Short, { max: 60 })),
      new ActionRowBuilder().addComponents(input('whatsapp', 'WhatsApp Contact Number', TextInputStyle.Short, { max: 16, placeholder: 'e.g. 919876543210' })),
      new ActionRowBuilder().addComponents(input('players', 'Players - IGN,UID (4 required, 5th optional)', TextInputStyle.Paragraph, {
        max: 500, placeholder: 'Nova,5123456789\nSoul,5234567890\nRex,5345678901\nAce,5456789012\n(optional) Zed,5567890123',
      })),
    );
}

// Checks the whole form. Returns { error } or { data } (cleaned-up values).
function validateRegistrationForm(tournament, draft, { roundNum = 1 } = {}) {
  const team = String(draft.team || '').trim();
  const ownerName = String(draft.owner || '').trim();
  const whatsapp = String(draft.whatsapp || '').trim().replace(/[\s-]/g, '');

  if (!team) return { error: '❌ Team name is required.' };
  if (isBanned(tournament, team)) return { error: `❌ **${team}** is banned from registering.` };
  if (isDuplicateTeamInRound(tournament, team, roundNum)) return { error: `❌ A team named **${team}** is already registered${roundNum > 1 ? ` in Round ${roundNum}` : ''}.` };
  if (!ownerName) return { error: '❌ Team owner name is required.' };
  if (!WHATSAPP_RE.test(whatsapp)) {
    return { error: "❌ That WhatsApp number doesn't look valid (digits only, 7-15 digits, optional leading +)." };
  }

  const lines = String(draft.players || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < MIN_TEAM_PLAYERS || lines.length > MAX_TEAM_PLAYERS) {
    return { error: `❌ Enter ${MIN_TEAM_PLAYERS} players (a 5th is optional), one per line as **IGN,UID** — you entered ${lines.length}.` };
  }
  const playerIgns = [];
  const playerUids = [];
  for (let i = 0; i < lines.length; i++) {
    const match = PLAYER_LINE_RE.exec(lines[i]);
    if (!match) {
      return { error: `❌ Player ${i + 1} must be in the format **IGN,UID** (e.g. \`Nova,5123456789\`) — the UID is numbers only (5-12 digits).` };
    }
    const ign = match[1].trim();
    if (ign.length > MAX_IGN_LENGTH) {
      return { error: `❌ Player ${i + 1}'s IGN must be ${MAX_IGN_LENGTH} characters or fewer.` };
    }
    playerIgns.push(ign);
    playerUids.push(match[2]);
  }
  const dupUid = playerUids.find((uid, i) => playerUids.indexOf(uid) !== i);
  if (dupUid) return { error: `❌ UID **${dupUid}** is entered more than once — every player needs their own UID.` };

  return { data: { team, ownerName, whatsapp, playerIgns, playerUids } };
}

// "**Owner** — x", "**WhatsApp** — n", "**P1** — ign (uid)" ... lines for a
// team (empty string if it has none, e.g. registrations made before these
// fields existed). Pass includeContact=false to leave the WhatsApp number out.
function formatTeamDetailLines(team, includeContact = true) {
  const lines = [];
  if (team.ownerName) lines.push(`**Owner** — ${team.ownerName}`);
  if (includeContact && team.whatsapp) lines.push(`**WhatsApp** — ${team.whatsapp}`);
  (team.playerIgns || []).forEach((ign, i) => {
    const uid = (team.playerUids || [])[i];
    lines.push(`**P${i + 1}** — ${ign}${uid ? ` (${uid})` : ''}`);
  });
  return lines.join('\n');
}

// The form failed a check: keep what the player typed (in the pending store)
// and offer a "Try Again" button that reopens the modal prefilled, like the
// verification panel — so one typo never costs them the whole form.
function rejectRegistrationForm(interaction, tid, draft, message) {
  startRegPending(interaction.user.id, interaction.guildId, { tournamentId: tid, draft });
  return interaction.reply({
    content: `${message} Tap **Try Again** to fix it — your other answers are kept.`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tourney_wizard_register_retry:${tid}`).setLabel('Try Again').setEmoji('🔁').setStyle(ButtonStyle.Primary)
    )],
    flags: MessageFlags.Ephemeral,
  });
}

function buildMentionPlayersRow(count = 4) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('tourney_reg_select_players')
    .setPlaceholder(`Mention the ${count} player${count === 1 ? '' : 's'} on your team`)
    .setMinValues(count)
    .setMaxValues(count);
  return new ActionRowBuilder().addComponents(menu);
}

function tourneyConfirmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_reg_confirm').setLabel('Confirm Registration').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_reg_cancel').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger)
  );
}

// Whether any of the newly-picked player IDs is already locked into another
// team's roster in this tournament — a player can only be mentioned on one
// team at a time. Returns the conflicting user ID and their team, or null.
function findTournamentLineupConflict(tournament, selectedIds) {
  for (const group of Object.values(tournament.groups)) {
    for (const t of group.teams) {
      if (t.ownerId && selectedIds.includes(t.ownerId)) {
        return { conflictId: t.ownerId, team: t.team };
      }
      for (const id of t.playerIds || []) {
        if (selectedIds.includes(id)) {
          return { conflictId: id, team: t.team };
        }
      }
    }
  }
  return null;
}

function buildTeamRegPreviewEmbed(data) {
  const lineup = (data.selectedPlayerIds || []).map(id => `<@${id}>`).join(' ') || '_none_';
  return new EmbedBuilder()
    .setTitle('📝 Review Your Registration')
    .setColor(0xFEE75C)
    .setDescription(
      `**Team Name** — ${data.team}\n` +
      (formatTeamDetailLines(data) ? `${formatTeamDetailLines(data)}\n` : '') +
      `**Discord Tags** — ${lineup}`
    )
    .setFooter({ text: 'Double-check everything, then tap Confirm to lock in your slot.' });
}

function buildEditSettingsModal(tournament) {
  const nameInput = new TextInputBuilder().setCustomId('name').setLabel('Tournament name').setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(80);
  if (tournament && tournament.name) nameInput.setValue(tournament.name);

  return new ModalBuilder()
    .setCustomId('tourney_wizard_edit_modal')
    .setTitle('Edit Settings')
    .addComponents(new ActionRowBuilder().addComponents(nameInput));
}

function buildBanUnbanModal() {
  return new ModalBuilder()
    .setCustomId('tourney_wizard_ban_modal')
    .setTitle('Ban / Unban Team')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('team').setLabel('Team name').setStyle(TextInputStyle.Short)
          .setPlaceholder('Exact team name — running this again unbans it').setRequired(true).setMaxLength(80)
      ),
    );
}

// "Manually Add Slot" is a 4-step flow:
//   1. Pick the player (UserSelectMenu) — this is who the group role gets
//      given to, same as a normal self-registration owner.
//   2. Pick the round (StringSelectMenu, built from Manage Rounds — only
//      rounds that still have an open group, or can get a new one).
//   3. Pick the group inside that round (groups with a free slot; Round 2+
//      also offers "New Group"). The picked user, round and group travel
//      through the customId of each step.
//   4. The same registration form the public panel uses (team, owner,
//      WhatsApp, players IGN,UID), then the team is pushed into that
//      round's group and the picked member is given that group's role
//      (auto-creating it — and, for Round 2+, its channel — if needed).
function buildManualAddUserSelectPayload() {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('tourney_manual_add_user_select')
    .setPlaceholder('Select the player to add')
    .setMinValues(1)
    .setMaxValues(1);

  const embed = new EmbedBuilder()
    .setTitle('📌 Manually Add Slot')
    .setColor(0x5865F2)
    .setDescription('Select the player you want to add — they\'ll be the one who gets the group\'s role.');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

// Capacity a brand-new group in this round would get.
function getRoundGroupCapacity(tournament, roundNum) {
  return roundNum <= 1
    ? (tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY)
    : (getRound(tournament, roundNum).groupSize || DEFAULT_GROUP_CAPACITY);
}

// First unused group number in a round, or null if all MAX_GROUPS exist.
function nextFreeGroupKey(groups) {
  for (let i = 1; i <= MAX_GROUPS; i++) {
    if (!groups[String(i)]) return String(i);
  }
  return null;
}

// Rounds an admin can manually add into: every round up to Max Rounds that
// has a group with a free slot, or (Round 2+) room to create a new group.
function getManualAddRounds(tournament) {
  const rounds = [];
  for (let n = 1; n <= getMaxRounds(tournament); n++) {
    const groups = getRoundGroups(tournament, n);
    const openGroups = Object.keys(groups).filter(l => hasEmptySlot(groups[l]) || nextLockedSlot(groups[l]) !== null);
    const canCreate = n > 1 && Object.keys(groups).length < MAX_GROUPS;
    if (openGroups.length || canCreate) rounds.push({ roundNum: n, groups, openGroups, canCreate });
  }
  return rounds;
}

function buildManualAddRoundSelectPayload(tournament, userId) {
  const rounds = getManualAddRounds(tournament);
  if (!rounds.length) {
    return { error: '❌ Every group is already full — add another group first.' };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tourney_manual_add_round_select:${userId}`)
    .setPlaceholder('Select a round')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(rounds.slice(0, 25).map(({ roundNum, groups, openGroups, canCreate }) => {
      const teamCount = Object.values(groups).reduce((sum, g) => sum + g.teams.length, 0);
      const openText = openGroups.length
        ? `${openGroups.length} open group${openGroups.length === 1 ? '' : 's'}`
        : 'new group available';
      return {
        label: getRoundDisplayName(tournament, roundNum).name.slice(0, 100),
        description: `${teamCount} team${teamCount === 1 ? '' : 's'} · ${openText}${openGroups.length && canCreate ? ' + new' : ''}`.slice(0, 100),
        value: String(roundNum),
      };
    }));

  const embed = new EmbedBuilder()
    .setTitle('📌 Manually Add Slot')
    .setColor(0x5865F2)
    .setDescription(`Adding <@${userId}> — pick which round to add them to.`);

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

function buildManualAddGroupSelectPayload(tournament, userId, roundNum = 1) {
  const groups = getRoundGroups(tournament, roundNum);
  // A group that's at normal capacity still shows up as long as it has a
  // free locked slot left — Manually Add Slot can overflow into those.
  const letters = Object.keys(groups)
    .filter(l => hasEmptySlot(groups[l]) || nextLockedSlot(groups[l]) !== null)
    .sort((a, b) => Number(a) - Number(b));
  const newKey = roundNum > 1 && Object.keys(groups).length < MAX_GROUPS ? nextFreeGroupKey(groups) : null;
  if (!letters.length && !newKey) {
    return { error: roundNum > 1
      ? `❌ Every group in Round ${roundNum} is already full.`
      : '❌ Every group is already full — add another group first.' };
  }

  // Discord select menus cap at 25 options — keep a slot free for "New Group".
  const options = letters.slice(0, newKey ? 124 : 125).map(letter => {
    const g = groups[letter];
    const free = emptySlotNumbers(g).length;
    const total = normalSlotTotal();
    return {
      label: `Group ${letter}`,
      description: free === 0 ? `${total}/${total} slots · goes to locked slot ${nextLockedSlot(g)}` : `${total - free}/${total} slots · next empty slot ${emptySlotNumbers(g)[0]}`,
      value: letter,
    };
  });
  if (newKey) {
    options.push({
      label: `➕ New Group ${newKey}`,
      description: `Create it now · ${getRoundGroupCapacity(tournament, roundNum)} teams`,
      value: 'new',
    });
  }


  const embed = new EmbedBuilder()
    .setTitle('📌 Manually Add Slot')
    .setColor(0x5865F2)
    .setDescription(`Adding <@${userId}> to **${getRoundDisplayName(tournament, roundNum).name}** — pick which group to place them in.`);

  return { embeds: [embed], components: buildChunkedSelectRows(`tourney_manual_add_group_select:${userId}:${roundNum}`, 'Select a group to add them to', options) };
}

// The same form the public Register Team panel shows. `letter` is a group
// number, or 'new' for "create the next group in this round".
function buildManualAddSlotModal(userId, roundNum, letter, draft = {}) {
  const where = letter === 'new' ? 'a New Group' : `Group ${letter}`;
  return buildRegisterModal(null, draft, {
    customId: `tourney_wizard_manual_add_modal:${userId}:${roundNum}:${letter}`,
    title: (roundNum > 1 ? `Add to Round ${roundNum} - ${where}` : `Add to ${where}`).slice(0, 45),
  });
}

async function handleManualAddUserSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }

  const picked = interaction.users.first();
  if (picked && picked.bot) {
    return interaction.update({
      content: `❌ ${picked} is a bot and can't be added as a player. Pick a human player:`,
      ...buildManualAddUserSelectPayload(),
    });
  }

  const userId = interaction.values[0];
  const payload = buildManualAddRoundSelectPayload(tournament, userId);
  if (payload.error) {
    return interaction.update({ content: payload.error, embeds: [], components: [] });
  }
  await interaction.update({ content: '', ...payload });
}

async function handleManualAddRoundSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const [, userId] = interaction.customId.split(':');
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }

  const roundNum = parseInt(interaction.values[0], 10);
  if (!Number.isInteger(roundNum) || roundNum < 1 || roundNum > getMaxRounds(tournament)) {
    return interaction.update({ content: '❌ That round no longer exists — run **Manually Add Slot** again.', embeds: [], components: [] });
  }

  const payload = buildManualAddGroupSelectPayload(tournament, userId, roundNum);
  if (payload.error) {
    return interaction.update({ content: payload.error, embeds: [], components: [] });
  }
  await interaction.update({ content: '', ...payload });
}

async function handleManualAddGroupSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  // customId: tourney_manual_add_group_select:<userId>:<round>  (older
  // menus without the round part were Round 1)
  const parts = interaction.customId.split(':');
  const userId = parts[1];
  const roundNum = parts[2] ? parseInt(parts[2], 10) : 1;
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const letter = interaction.values[0];

  if (!tournament || !Number.isInteger(roundNum) || roundNum < 1 || roundNum > getMaxRounds(tournament)) {
    return interaction.update({ content: '❌ That round no longer exists.', embeds: [], components: [] });
  }
  const groups = getRoundGroups(tournament, roundNum);
  if (letter === 'new') {
    if (roundNum <= 1 || !nextFreeGroupKey(groups)) {
      return interaction.update({ content: '❌ No more groups can be created — run **Manually Add Slot** again.', embeds: [], components: [] });
    }
  } else {
    if (!groups[letter]) {
      return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
    }
    if (!hasEmptySlot(groups[letter]) && nextLockedSlot(groups[letter]) === null) {
      return interaction.update({ content: `❌ Group **${letter}** is completely full — every locked slot is taken too. Run **Manually Add Slot** again.`, embeds: [], components: [] });
    }
  }

  return interaction.showModal(buildManualAddSlotModal(userId, roundNum, letter));
}

function buildRequiredMentionsModal(tournament) {
  const input = new TextInputBuilder().setCustomId('value').setLabel('Required Mentions (0-4)').setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(1).setPlaceholder('4');
  if (tournament.requiredMentions != null) input.setValue(String(tournament.requiredMentions));
  return new ModalBuilder().setCustomId('tourney_create_settings_d_modal').setTitle('Required Mentions')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildTeamsPerGroupModal(tournament) {
  const input = new TextInputBuilder().setCustomId('value').setLabel('Teams per Group').setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(4).setPlaceholder('e.g. 20');
  input.setValue(String(tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY));
  return new ModalBuilder().setCustomId('tourney_create_settings_e_modal').setTitle('Teams per Group')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildTotalSlotsModal(tournament) {
  const input = new TextInputBuilder().setCustomId('value').setLabel('Total Slots').setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(5).setPlaceholder('e.g. 15000');
  if (tournament.totalSlots) input.setValue(String(tournament.totalSlots));
  return new ModalBuilder().setCustomId('tourney_create_settings_f_modal').setTitle('Total Slots')
    .addComponents(new ActionRowBuilder().addComponents(input));
}




// Manage Server, OR a user the bot owner allowed by Discord user ID (ALLOWED_USER_IDS — see access.js). Every admin check in the bot goes through here.
function hasManageGuild(interaction) {
  return canManageBot(interaction.member);
}

// Manage Server (or an allowed user) OR the TOURNAMENT ADMIN role. Used ONLY by
// the handlers behind the five panel features that role may use: Start/Pause
// Reg, Manage Groups, Edit Settings (with its Manage Rounds), Post Register
// Panel and Slot-Manager channel (plus picking a tournament from the list).
// Everything else keeps using hasManageGuild.
function hasTournamentAdminAccess(interaction) {
  return hasManageGuild(interaction) || hasTournamentAdminRole(interaction.member);
}

// Panel buttons the TOURNAMENT ADMIN role may press (nothing else). Every
// button of the Edit Settings screen (tourney_create_settings_*) is included.
const TOURNAMENT_ADMIN_BUTTON_IDS = new Set([
  'tourney_wizard_toggle',                // Start/Pause Reg
  'tourney_wizard_manage_groups',         // Manage Groups
  'tourney_wizard_edit_settings',         // Edit Settings
  'tourney_wizard_manage_rounds',         // Manage Rounds (button on the Edit Settings screen)
  'tourney_wizard_post_register_panel',   // Post Register Panel
  'tourney_wizard_slot_manager_channel',  // Slot-Manager channel
  'tourney_wizard_repost_group_panel',    // Group Panel (repost)
]);

// Setting G — when a Register Role is set, only players holding it may register.
// (If that role was later deleted, the requirement is ignored rather than
// locking everyone out.) Returns an error message string, or null when allowed.
// TOURNAMENT ELITE members can register even while registration is closed and
// even without the Register Role.
// TOURNAMENT ELITE members may press every Slot-Manager button even without a
// team of their own; with no slot they just get an empty result instead of an error.
function eliteNoSlotReply(interaction, what) {
  return interaction.reply({
    content: `📭 ${what} — you don't have a slot in this tournament, so your group and slot list are empty.`,
    flags: MessageFlags.Ephemeral,
  });
}

function canBypassRegistration(interaction) {
  return hasTournamentEliteRole(interaction.member);
}

function registerRoleBlock(interaction, tournament) {
  if (canBypassRegistration(interaction)) return null;
  const roleId = tournament && tournament.registerRoleId;
  if (!roleId || !interaction.guild.roles.cache.has(roleId)) return null;
  const has = interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? interaction.member.roles.cache.has(roleId)
    : false;
  return has ? null : `❌ Only players with the <@&${roleId}> role can register for **${tournament.name}**.`;
}

// ---------------------------------------------------------------------------
// Tournament staff — players picked via the panel's "Select Staff" button get
// a per-tournament Staff role (tournament.staffRoleId). That role can see and
// talk in every group channel (permission overwrite added when a channel is
// created, and back-filled onto existing ones), can mention group roles (the
// staff also get @everyone / @here in group channels — players never do),
// and may use each group panel's Publish Slot List and Result buttons even
// without Manage Server. Punish Team and the main panel stay admin-only.
// ---------------------------------------------------------------------------
// MentionEveryone lets staff use @everyone / @here (and any role) in group
// channels — players are denied it there (see GROUP_CLOSED_DENY).
const STAFF_CHANNEL_PERMS = {
  ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, MentionEveryone: true,
};

// Group channel chat state, applied to the group's role (or @everyone when a
// group has no role). CLOSED = can view + read history only, every other
// permission is off; the panel's Open / Close button flips it.
const GROUP_CLOSED_ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
// Every text-channel permission a player could otherwise use, beyond viewing
// and reading history. CLOSED denies all of these. OPEN denies all of these
// too, except SendMessages + AttachFiles (see GROUP_OPEN_ALLOW below) — so an
// open channel is still "text + files only", nothing else ever turns on.
// Named as strings (not PermissionFlagsBits.X) because these lists are also
// used as an object's keys in setGroupChatOpen's permissionOverwrites.edit()
// call, which needs permission-name keys, not bitfield values.
const GROUP_ALL_OFF = [
  'MentionEveryone', 'SendMessages', 'AttachFiles', 'AddReactions',
  'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads',
  'EmbedLinks', 'UseExternalEmojis', 'UseExternalStickers',
  'SendVoiceMessages', 'SendTTSMessages', 'UseApplicationCommands',
  'ManageMessages', 'ManageThreads', 'ManageWebhooks', 'ManageChannels',
  'CreateInstantInvite',
];
// Kept for the two channel-creation call sites below (channels are always
// created CLOSED). Plain permission-name strings work fine in an
// overwrite's allow/deny arrays, same as PermissionFlagsBits values do.
const GROUP_CLOSED_DENY = GROUP_ALL_OFF;
// What OPEN grants on top of the closed baseline: text + files, nothing else.
const GROUP_OPEN_ALLOW = ['SendMessages', 'AttachFiles'];
const GROUP_OPEN_DENY = GROUP_ALL_OFF.filter(p => !GROUP_OPEN_ALLOW.includes(p));

function isTournamentStaff(interaction, tournament) {
  if (!tournament || !tournament.staffRoleId) return false;
  const roles = interaction.member && interaction.member.roles;
  if (!roles) return false;
  if (roles.cache) return roles.cache.has(tournament.staffRoleId);
  return Array.isArray(roles) && roles.includes(tournament.staffRoleId);
}

function canUseGroupPanel(interaction, tournament) {
  return hasManageGuild(interaction) || isTournamentStaff(interaction, tournament);
}

// Staff role id if it still exists in the guild, else null.
function getLiveStaffRoleId(guild, tournament) {
  return tournament && tournament.staffRoleId && guild.roles.cache.has(tournament.staffRoleId)
    ? tournament.staffRoleId
    : null;
}

// Permission overwrite entries for every user ID listed in ALLOWED_USER_IDS
// (see access.js) — full staff-level access to any group channel, so those
// user(s) can see and use every tournament/round/group channel without
// needing the group role, the staff role, or Manage Server — same idea as
// staffChannelOverwrite below, just keyed to a user id instead of a role.
function allowedUserChannelOverwrites(guild) {
  return envAllowedIds().map(id => ({
    id,
    type: OverwriteType.Member,
    allow: channelAllowList(guild),
  }));
}

// Permission overwrite entry to add to a freshly created private group channel.
function staffChannelOverwrite(guild, tournament) {
  const id = getLiveStaffRoleId(guild, tournament);
  return id
    ? { id, allow: channelAllowList(guild) }
    : null;
}

// Discord only lets the bot grant a permission it holds itself, so if the bot
// lacks "Mention Everyone" the whole overwrite is rejected — and staff would see
// nothing. These helpers drop MentionEveryone in that case instead of failing.
function channelAllowList(guild) {
  const list = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
  const me = guild.members.me;
  if (me && me.permissions.has(PermissionFlagsBits.MentionEveryone)) list.push(PermissionFlagsBits.MentionEveryone);
  return list;
}

// Edit a channel overwrite with staff perms; retry without MentionEveryone if
// Discord refuses. Returns null on success or an error message.
async function applyStaffPerms(channel, targetId, reason, extra = {}) {
  try {
    await channel.permissionOverwrites.edit(targetId, { ...STAFF_CHANNEL_PERMS }, { reason, ...extra });
    return null;
  } catch (err) {
    const { MentionEveryone, ...lite } = STAFF_CHANNEL_PERMS;
    try {
      await channel.permissionOverwrites.edit(targetId, lite, { reason, ...extra });
      return null;
    } catch (err2) {
      console.error(`[tournament-staff-access] Couldn't give ${targetId} access to channel ${channel.id}: ${err2.code ?? ''} ${err2.message}`);
      return err2.message;
    }
  }
}

// Every group channel of a tournament (all rounds), fetched if not cached.
async function getAllGroupChannels(guild, tournament) {
  const groups = [...Object.values(tournament.groups || {})];
  for (const round of Object.values(tournament.rounds || {})) groups.push(...Object.values(round.groups || {}));
  const seen = new Set();
  const channels = [];
  for (const g of groups) {
    if (!g.channelId || seen.has(g.channelId)) continue;
    seen.add(g.channelId);
    const ch = guild.channels.cache.get(g.channelId) ?? await guild.channels.fetch(g.channelId).catch(() => null);
    if (ch) channels.push(ch);
  }
  return channels;
}

// Direct per-member overwrites for the people picked in Select Staff, so they
// see every group channel even if the staff-role overwrite ever fails.
function staffMemberOverwrites(guild, tournament) {
  return (tournament && tournament.staffUserIds || [])
    .filter(id => guild.members.cache.has(id))
    .map(id => ({ id, type: OverwriteType.Member, allow: channelAllowList(guild) }));
}

// Channel overwrites for the TOURNAMENT ADMIN and TOURNAMENT ELITE roles (matched
// by name, like access.js) so they can see and use every group channel and its
// admin panel without needing Manage Server or the tournament Staff role.
function botRoleChannelOverwrites(guild) {
  const names = ['tournament admin', 'tournament elite'];
  return guild.roles.cache
    .filter(r => names.includes(r.name.toLowerCase()))
    .map(r => ({
      id: r.id,
      allow: channelAllowList(guild),
    }));
}

async function ensureStaffRole(guild, guildId, store, tournament, out) {
  let role = tournament.staffRoleId ? guild.roles.cache.get(tournament.staffRoleId) : null;
  if (!role) {
    const botMember = guild.members.me;
    if (!botMember.permissions.has('ManageRoles')) {
      console.error(`[tournament-staff-role] Bot is missing the "Manage Roles" permission in guild ${guildId}.`);
      return null;
    }
    if (guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) {
      console.error(`[tournament-staff-role] Guild ${guildId} is at/near Discord's ${MAX_GUILD_ROLES}-role cap — skipping staff role creation.`);
      return null;
    }
    try {
      role = await guild.roles.create({
        name: `${tournament.name} Staff`.slice(0, 100),
        mentionable: false,
        reason: `Tournament "${tournament.name}" staff role`,
      });
      tournament.staffRoleId = role.id;
      saveGuildStore(guildId, store);
    } catch (err) {
      console.error(`[tournament-staff-role] Failed to create staff role in guild ${guildId}: ${err.code ?? ''} ${err.message}`);
      return null;
    }
  }

  // Back-fill onto every group channel that already exists (all rounds).
  const groups = [...Object.values(tournament.groups || {})];
  for (const round of Object.values(tournament.rounds || {})) groups.push(...Object.values(round.groups || {}));
  for (const group of groups) {
    if (!group.channelId) continue;
    const channel = guild.channels.cache.get(group.channelId) ?? await guild.channels.fetch(group.channelId).catch(() => null);
    if (!channel) continue;
    const failed = await applyStaffPerms(channel, role.id, 'Tournament staff access');
    if (out) { if (failed) out.failed = (out.failed || 0) + 1; else out.done = (out.done || 0) + 1; }
  }
  return role;
}

// ---------------------------------------------------------------------------
// Open / Close button on each group's admin panel — pressed by Manage Server
// admins or the tournament's Staff role. Group channels are created closed;
// Open lets that group's players chat and send files, Close locks the
// channel again (no messages, files, reactions or threads).
// ---------------------------------------------------------------------------
function findGroupByChannel(store, channelId) {
  for (const tournament of Object.values(store.tournaments || {})) {
    for (const [letter, group] of Object.entries(tournament.groups || {})) {
      if (group.channelId === channelId) return { tournament, roundNum: 1, letter, group };
    }
    for (const [roundKey, round] of Object.entries(tournament.rounds || {})) {
      for (const [letter, group] of Object.entries(round.groups || {})) {
        if (group.channelId === channelId) return { tournament, roundNum: parseInt(roundKey, 10) || 1, letter, group };
      }
    }
  }
  return null;
}

// Flips a group channel between OPEN (players can send messages and attach
// files — nothing else) and CLOSED (every permission below view + read
// history is off, including messages and files). Used by the Open / Close
// button on the group's admin panel. Returns { error } on failure.
async function setGroupChatOpen(guild, channel, group, open, actorTag) {
  // Players' chat permissions live on the group role; if the group never got
  // a role, the channel is public and @everyone is what gets toggled.
  const role = group.roleId ? guild.roles.cache.get(group.roleId) : null;
  const target = role || guild.roles.everyone;

  // OPEN = text + files only, everything else in GROUP_ALL_OFF stays denied.
  // CLOSED = everything in GROUP_ALL_OFF denied, including text + files.
  const perms = {};
  for (const flag of GROUP_OPEN_ALLOW) perms[flag] = open ? true : false;
  for (const flag of GROUP_OPEN_DENY) perms[flag] = false;
  // On @everyone, "open" means clearing the lock rather than granting anything extra.
  if (open && !role) Object.keys(perms).forEach(k => { perms[k] = null; });
  // Players can never mention @everyone / @here / all roles, open or closed
  // (also fixes channels created before this rule existed).
  perms.MentionEveryone = false;

  try {
    await channel.permissionOverwrites.edit(target.id, perms, {
      reason: `${open ? 'Opened' : 'Closed'} by ${actorTag}`,
    });
    if (role) {
      await channel.permissionOverwrites.edit(guild.roles.everyone.id, { MentionEveryone: false }, {
        reason: 'Group channel: no @everyone / @here mentions',
      }).catch(() => {});
    }
  } catch (err) {
    console.error(`[tournament-chat-toggle] Failed to ${open ? 'open' : 'close'} channel ${channel.id}: ${err.code ?? ''} ${err.message}`);
    return { error: '❌ I couldn\'t change this channel\'s permissions — check that I have **Manage Channels** and **Manage Roles**.' };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Refresh — the tournament panel's Refresh button. Re-renders, in place, every
// message the bot has posted for this tournament using the latest data and
// layout: the register panel, and in every group channel the admin panel and
// the published slot list. Nothing is deleted, no data changes (only the
// stored id of an older admin panel is filled in if it was missing).
// ---------------------------------------------------------------------------
async function refreshTournamentMessages(interaction, store, tournament) {
  const guild = interaction.guild;
  const botId = interaction.client.user.id;
  let panels = 0;
  let slotLists = 0;
  let skipped = 0;
  let idsBackfilled = false;

  await refreshRegisterPanel(guild, tournament);

  const maxRounds = getMaxRounds(tournament);
  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    const groups = getRoundGroups(tournament, roundNum);
    for (const [letter, group] of Object.entries(groups)) {
      if (!group.channelId) continue;
      const channel = guild.channels.cache.get(group.channelId)
        ?? await guild.channels.fetch(group.channelId).catch(() => null);
      if (!channel) { skipped++; continue; }

      // Keep the no-@everyone rule on channels created before it existed.
      await channel.permissionOverwrites.edit(guild.roles.everyone.id, { MentionEveryone: false }, { reason: 'Group channel: no @everyone / @here mentions' }).catch(() => {});
      if (group.roleId) {
        await channel.permissionOverwrites.edit(group.roleId, { MentionEveryone: false }, { reason: 'Group channel: no @everyone / @here mentions' }).catch(() => {});
      }
      // ...while staff keep @everyone / @here (and chat + files) here.
      const liveStaffRoleId = getLiveStaffRoleId(guild, tournament);
      if (liveStaffRoleId) {
        await applyStaffPerms(channel, liveStaffRoleId, 'Tournament staff access');
      }
      for (const so of staffMemberOverwrites(guild, tournament)) {
        await applyStaffPerms(channel, so.id, 'Tournament staff access', { type: OverwriteType.Member });
      }
      // ...and the TOURNAMENT ADMIN / ELITE roles.
      for (const bo of botRoleChannelOverwrites(guild)) {
        await applyStaffPerms(channel, bo.id, 'Tournament admin/elite role access');
      }
      // ...and so does everyone in ALLOWED_USER_IDS, on channels created
      // before they were added to that variable.
      for (const ow of allowedUserChannelOverwrites(guild)) {
        await channel.permissionOverwrites.edit(ow.id, STAFF_CHANNEL_PERMS, { type: OverwriteType.Member, reason: 'ALLOWED_USER_IDS access' }).catch(err => {
          console.error(`[tournament-allowed-user] Failed to add channel overwrite for ${ow.id} on ${channel.id} in guild ${guild.id}: ${err.message}`);
        });
      }

      // Admin panel — older ones were posted before their message id was
      // stored, so find the bot's panel message (the one with the Publish
      // Slot List button) in the channel's recent history.
      let panel = group.adminPanelMessageId
        ? await channel.messages.fetch(group.adminPanelMessageId).catch(() => null)
        : null;
      if (!panel) {
        const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        panel = recent && recent.find(m => m.author.id === botId
          && m.components.some(row => row.components.some(c => c.customId && c.customId.startsWith('tourney_wizard_group_publish:'))));
        if (panel) { group.adminPanelMessageId = panel.id; idsBackfilled = true; }
      }
      if (panel) {
        const ok = await panel.edit(buildTournamentGroupAdminPanelPayload(tournament, roundNum, letter)).then(() => true).catch(() => false);
        if (ok) panels++; else skipped++;
      }

      // Published slot list.
      if (group.slotListMessageId) {
        const message = await channel.messages.fetch(group.slotListMessageId).catch(() => null);
        if (message) {
          const ok = await message
            .edit(buildPublishedSlotListPayload(tournament, roundNum, letter, group))
            .then(() => true).catch(() => false);
          if (ok) slotLists++; else skipped++;
        }
      }
    }
  }

  if (idsBackfilled) saveGuildStore(interaction.guildId, store);

  return `🔃 Refreshed — ${panels} group panel${panels === 1 ? '' : 's'}, ${slotLists} slot list${slotLists === 1 ? '' : 's'}, the register panel and this panel.`
    + (skipped ? `\n⚠️ ${skipped} message(s) couldn't be updated (deleted channel/message or missing permissions).` : '');
}

// ---------------------------------------------------------------------------
// Group Config — "Config" on each group's admin panel. Pick how many matches
// the group plays (Match 1..N), then edit each match's IDP time / start time /
// map (and the date). The schedule lives on group.schedule (see
// group-schedule.js) and is shown on the group's slot list, which is
// refreshed in place after every change.
// ---------------------------------------------------------------------------
function groupLabel(roundNum, letter) {
  return roundNum > 1 ? `Round ${roundNum} — Group ${letter}` : `Group ${letter}`;
}

function buildGroupConfigPayload(tournament, roundNum, letter) {
  const group = getRoundGroups(tournament, roundNum)[letter];
  const tid = tournament.id;
  const key = `${tid}:${roundNum}:${letter}`;
  const matches = (group.schedule && group.schedule.matches) || [];

  const description = matches.length
    ? [
        group.schedule.date ? `📅 **${formatDateLabel(group.schedule.date)}**` : '📅 _No date set_',
        ...matches.map((m, i) => matchLine(m, i)),
      ].join('\n')
    : 'No matches configured yet — pick how many matches this group plays below.';

  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ${groupLabel(roundNum, letter)} — Match Config`)
    .setColor(0x5865F2)
    .setDescription(description)
    .setFooter({ text: 'Changes update this group\'s admin panel automatically.' });

  const countOptions = [{ label: 'No matches (hide schedule)', value: '0', default: matches.length === 0 }];
  for (let i = 1; i <= MAX_MATCHES; i++) {
    countOptions.push({ label: `${i} match${i === 1 ? '' : 'es'}`, value: String(i), default: matches.length === i });
  }
  const rows = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`tourney_group_cfg_count:${key}`)
        .setPlaceholder('How many matches will be played?')
        .addOptions(countOptions),
    ),
  ];

  if (matches.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`tourney_group_cfg_match:${key}`)
        .setPlaceholder('Edit a match\'s timing / map')
        .addOptions(matches.map((m, i) => ({
          label: `Match ${i + 1}`,
          description: `IDP ${formatTime(m.idp)} | Start ${formatTime(m.start)}${m.map ? ` | ${m.map}` : ''}`.slice(0, 100),
          value: String(i),
        }))),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tourney_wizard_group_configdate:${key}`).setLabel('Set Date').setEmoji('📅').setStyle(ButtonStyle.Primary),
    ));
  }

  return { content: '', embeds: [embed], components: rows };
}

function buildGroupMatchModal(key, idx, match) {
  const modal = new ModalBuilder()
    .setCustomId(`tourney_group_cfg_match_modal:${key}:${idx}`)
    .setTitle(`Match ${idx + 1} timing`);
  const input = (id, label, value, placeholder, required, maxLength) => new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
      .setRequired(required).setMaxLength(maxLength).setPlaceholder(placeholder)
      .setValue(value || ''),
  );
  modal.addComponents(
    input('idp', 'IDP time', match.idp ? formatTime(match.idp) : '', 'e.g. 01:04 PM', true, 12),
    input('start', 'Start time', match.start ? formatTime(match.start) : '', 'e.g. 01:10 PM', true, 12),
    input('map', 'Map (optional)', match.map || '', 'e.g. Erangel', false, 30),
  );
  return modal;
}

function buildGroupDateModal(tid, roundNum, letter, group) {
  const modal = new ModalBuilder()
    .setCustomId(`tourney_group_cfg_date_modal:${tid}:${roundNum}:${letter}`)
    .setTitle('Match date');
  const date = group.schedule && group.schedule.date;
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('date').setLabel('Date (empty = hide the date line)').setStyle(TextInputStyle.Short)
      .setRequired(false).setMaxLength(12).setPlaceholder('today, tomorrow, or DD/MM')
      .setValue(date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : ''),
  ));
  return modal;
}

// Re-renders the group's admin panel message in place (it shows the match
// schedule). The slot list itself does not show the schedule.
async function refreshGroupSlotList(interaction, tournament, roundNum, letter) {
  const group = getRoundGroups(tournament, roundNum)[letter];
  if (!group || !group.adminPanelMessageId || !interaction.channel) return;
  const panel = await interaction.channel.messages.fetch(group.adminPanelMessageId).catch(() => null);
  if (panel) await panel.edit(buildTournamentGroupAdminPanelPayload(tournament, roundNum, letter)).catch(() => {});
}

// Shared lookup + permission check for every Config select / modal. Returns
// { store, tournament, group, roundNum, letter } or null after replying.
async function resolveGroupConfig(interaction, parts) {
  const [tid, roundStr, letter] = parts;
  const roundNum = parseInt(roundStr, 10);
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  const group = tournament && getRoundGroups(tournament, roundNum)[letter];
  if (!group) {
    await interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    return null;
  }
  if (!hasManageGuild(interaction)) {
    await interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
    return null;
  }
  return { store, tournament, group, roundNum, letter };
}

async function handleGroupConfigCountSelect(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const ctx = await resolveGroupConfig(interaction, [tid, roundStr, letter]);
  if (!ctx) return;
  setMatchCount(ctx.group, parseInt(interaction.values[0], 10));
  saveGuildStore(interaction.guildId, ctx.store);
  await refreshGroupSlotList(interaction, ctx.tournament, ctx.roundNum, ctx.letter);
  return interaction.update(buildGroupConfigPayload(ctx.tournament, ctx.roundNum, ctx.letter));
}

async function handleGroupConfigMatchSelect(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const ctx = await resolveGroupConfig(interaction, [tid, roundStr, letter]);
  if (!ctx) return;
  const idx = parseInt(interaction.values[0], 10);
  const match = ctx.group.schedule && ctx.group.schedule.matches[idx];
  if (!match) {
    return interaction.update(buildGroupConfigPayload(ctx.tournament, ctx.roundNum, ctx.letter));
  }
  return interaction.showModal(buildGroupMatchModal(`${tid}:${roundStr}:${letter}`, idx, match));
}

async function handleGroupConfigMatchModalSubmit(interaction) {
  const [, tid, roundStr, letter, idxStr] = interaction.customId.split(':');
  const ctx = await resolveGroupConfig(interaction, [tid, roundStr, letter]);
  if (!ctx) return;
  const idx = parseInt(idxStr, 10);
  const match = ctx.group.schedule && ctx.group.schedule.matches[idx];
  if (!match) {
    return interaction.reply({ content: '❌ That match no longer exists — reopen Config.', flags: MessageFlags.Ephemeral });
  }

  const idp = parseTimeInput(interaction.fields.getTextInputValue('idp'));
  const start = parseTimeInput(interaction.fields.getTextInputValue('start'));
  if (!idp || !start) {
    return interaction.reply({
      content: `❌ Couldn't read the ${!idp ? 'IDP' : 'start'} time. Use a format like \`01:04 PM\` or \`13:04\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const map = interaction.fields.getTextInputValue('map').trim();

  match.idp = idp;
  match.start = start;
  match.map = map || null;
  saveGuildStore(interaction.guildId, ctx.store);
  await refreshGroupSlotList(interaction, ctx.tournament, ctx.roundNum, ctx.letter);

  const payload = buildGroupConfigPayload(ctx.tournament, ctx.roundNum, ctx.letter);
  return interaction.isFromMessage()
    ? interaction.update(payload)
    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function handleGroupConfigDateModalSubmit(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const ctx = await resolveGroupConfig(interaction, [tid, roundStr, letter]);
  if (!ctx) return;
  if (!ctx.group.schedule) {
    return interaction.reply({ content: '❌ Pick how many matches first.', flags: MessageFlags.Ephemeral });
  }

  const raw = interaction.fields.getTextInputValue('date').trim();
  if (!raw) {
    ctx.group.schedule.date = null;
  } else {
    const date = parseDateInput(raw);
    if (!date) {
      return interaction.reply({ content: '❌ Couldn\'t read that date. Use `today`, `tomorrow`, or `DD/MM` (e.g. `05/09`).', flags: MessageFlags.Ephemeral });
    }
    ctx.group.schedule.date = date;
  }
  saveGuildStore(interaction.guildId, ctx.store);
  await refreshGroupSlotList(interaction, ctx.tournament, ctx.roundNum, ctx.letter);

  const payload = buildGroupConfigPayload(ctx.tournament, ctx.roundNum, ctx.letter);
  return interaction.isFromMessage()
    ? interaction.update(payload)
    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function buildSelectStaffPayload(tournament) {
  const select = new UserSelectMenuBuilder()
    .setCustomId('tourney_staff_user_select')
    .setPlaceholder('Mention / pick the staff players')
    .setMinValues(0)
    .setMaxValues(25);
  const current = (tournament.staffUserIds || []).slice(0, 25);
  if (current.length) select.setDefaultUsers(current);
  return {
    content: [
      '🛡️ **Select Staff** — pick the players who should be staff for this tournament.',
      'They get the staff role. Staff can: talk in every group channel, use @everyone / @here and group-role mentions, and use every button on each group\'s channel panel (Publish Slot List, Result, Reminder, Config, Open/Close) except **Punish Team**. They can\'t use the main tournament panel.',
      'Current staff are pre-selected — deselect someone to remove their role, or clear everyone to remove all staff.',
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(select)],
  };
}

async function handleStaffUserSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }
  await interaction.deferUpdate();

  const guild = interaction.guild;
  const backfill = { done: 0, failed: 0 };
  const role = await ensureStaffRole(guild, interaction.guildId, store, tournament, backfill);
  if (!role) {
    return interaction.editReply({ content: '❌ I couldn\'t create the staff role — check my **Manage Roles** permission and that my role sits above the roles I manage.', components: [] });
  }

  // Staff can mention group roles as well as @everyone / @here in group
  // channels; group roles are made mentionable for them (was: only those — no @everyone / @here / other
  // roles), so make this tournament's existing group roles mentionable.
  const allGroups = [...Object.values(tournament.groups || {})];
  for (const round of Object.values(tournament.rounds || {})) allGroups.push(...Object.values(round.groups || {}));
  for (const g of allGroups) {
    const groupRole = g.roleId && guild.roles.cache.get(g.roleId);
    if (groupRole && !groupRole.mentionable) await groupRole.setMentionable(true, 'Tournament staff can ping group roles').catch(() => {});
  }

  const selected = new Set(interaction.values);
  const previous = new Set(tournament.staffUserIds || []);
  let failures = 0;

  for (const userId of selected) {
    const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
    if (!member) { failures++; continue; }
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role.id, 'Tournament staff').catch(() => { failures++; });
      await logRoleChange(guild, tournament, { member, roleId: role.id, added: true, reason: `given Select Staff access by ${interaction.user.tag}` });
    }
  }
  for (const userId of previous) {
    if (selected.has(userId)) continue;
    const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
    if (member && member.roles.cache.has(role.id)) {
      await member.roles.remove(role.id, 'Tournament staff removed').catch(() => { failures++; });
      await logRoleChange(guild, tournament, { member, roleId: role.id, added: false, reason: `staff access removed by ${interaction.user.tag}` });
    }
  }

  tournament.staffUserIds = [...selected];
  saveGuildStore(interaction.guildId, store);

  // Direct channel access for every selected person (and removal for anyone
  // deselected) on all existing group channels.
  const groupChannels = await getAllGroupChannels(guild, tournament);
  let channelFailures = 0;
  for (const channel of groupChannels) {
    for (const userId of selected) {
      if (!guild.members.cache.has(userId)) continue;
      const failed = await applyStaffPerms(channel, userId, 'Tournament staff access', { type: OverwriteType.Member });
      if (failed) channelFailures++;
    }
    for (const userId of previous) {
      if (selected.has(userId)) continue;
      await channel.permissionOverwrites.delete(userId, 'Tournament staff removed').catch(() => {});
    }
  }
  backfill.failed += channelFailures;

  const list = selected.size ? [...selected].map(id => `<@${id}>`).join(', ') : '_none_';
  return interaction.editReply({
    content: `✅ Staff for **${tournament.name}**: ${list}\nThey hold <@&${role.id}> — they can talk in every group channel, use @everyone / @here and group-role mentions, and use every button on each group's panel except **Punish Team**.`
      + (backfill.failed ? `\n⚠️ I couldn't give staff access to ${backfill.failed} group channel(s) — check that I have **Manage Channels** and **Manage Roles** (and that my role is above the staff role).` : '')
      + (failures ? `\n⚠️ ${failures} role change(s) failed — check my **Manage Roles** permission and role position.` : ''),
    components: [],
  });
}

// ---------------------------------------------------------------------------
// Tournament data export — the workbook behind the panel's Export Data button,
// also sent automatically (to the admin, before anything is removed) when a
// tournament is deleted. Returns null when no team is registered.
// ---------------------------------------------------------------------------
function collectExportEntries(tournament) {
  const entries = [];
  for (const [letter, group] of Object.entries(tournament.groups || {}).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    group.teams.forEach((t, idx) => entries.push({ letter, slot: groupSlotNumber(group, idx), t }));
  }
  return entries;
}

async function buildTournamentExport(guild, tournament) {
  const entries = collectExportEntries(tournament);
  if (entries.length === 0) return null;

  // Look up Discord usernames for every owner / tagged player. Anyone not
  // already cached is fetched in batches of 100 (the gateway limit); anyone
  // who has left the server just gets a blank username — their ID is still
  // exported.
  const allIds = new Set();
  for (const { t } of entries) {
    if (t.ownerId) allIds.add(t.ownerId);
    (t.playerIds || []).forEach(pid => allIds.add(pid));
  }
  const missing = [...allIds].filter(uid => !guild.members.cache.has(uid));
  for (let i = 0; i < missing.length; i += 100) {
    await guild.members.fetch({ user: missing.slice(i, i + 100) }).catch(() => null);
  }
  const usernameOf = uid => guild.members.cache.get(uid)?.user.username ?? '';

  const workbook = new ExcelJS.Workbook();

  // --- Sheet 1: one row per team ----------------------------------------
  const teamsSheet = workbook.addWorksheet('Teams');
  teamsSheet.columns = [
    { header: 'Reg Position', key: 'n', width: 13 },
    { header: 'Team Name', key: 'team', width: 26 },
    { header: 'Leader', key: 'ownerName', width: 24 },
    { header: 'Leader ID', key: 'ownerId', width: 22 },
    { header: 'WhatsApp', key: 'whatsapp', width: 18 },
    { header: 'Teammates', key: 'teammates', width: 44 },
    { header: 'Teammates in Slot', key: 'teammateCount', width: 18 },
    { header: 'Jump URL', key: 'jump', width: 60 },
    { header: 'Group', key: 'group', width: 8 },
    { header: 'Slot', key: 'slot', width: 6 },
    { header: 'Leader Discord', key: 'ownerDiscord', width: 22 },
    { header: 'P1 IGN', key: 'p1', width: 20 },
    { header: 'P1 UID', key: 'u1', width: 16 },
    { header: 'P2 IGN', key: 'p2', width: 20 },
    { header: 'P2 UID', key: 'u2', width: 16 },
    { header: 'P3 IGN', key: 'p3', width: 20 },
    { header: 'P3 UID', key: 'u3', width: 16 },
    { header: 'P4 IGN', key: 'p4', width: 20 },
    { header: 'P4 UID', key: 'u4', width: 16 },
    { header: 'P5 IGN', key: 'p5', width: 20 },
    { header: 'P5 UID', key: 'u5', width: 16 },
    { header: 'Extra IGNs', key: 'extra', width: 24 },
  ];
  teamsSheet.getRow(1).font = { bold: true };

  entries.forEach(({ letter, slot, t }, i) => {
    // Teams from the public form store their IGNs in playerIgns. Teams
    // added with Manually Add Slot keep typed IGNs in `players` instead
    // (mentions are stored there as <@id>, so those are filtered out).
    const igns = (t.playerIgns && t.playerIgns.length)
      ? t.playerIgns
      : (t.players || []).filter(pl => !/^<@!?\d+>$/.test(pl));
    const uids = t.playerUids || [];
    const playerIds = t.playerIds || [];
    const row = teamsSheet.addRow({
      n: i + 1,
      team: t.team,
      ownerName: t.ownerName || '',
      ownerId: t.ownerId || '',
      whatsapp: t.whatsapp || '',
      // Tagged Discord players as "username (id)" — same idea as the
      // "Teammates" column in other bots' exports.
      teammates: playerIds.map(pid => `${usernameOf(pid) || 'Unknown'} (${pid})`).join(', '),
      teammateCount: playerIds.length,
      jump: t.confirmMessageUrl ? { text: t.confirmMessageUrl, hyperlink: t.confirmMessageUrl } : '',
      group: letter,
      slot,
      ownerDiscord: t.ownerId ? usernameOf(t.ownerId) : '',
      p1: igns[0] || '', u1: uids[0] || '', p2: igns[1] || '', u2: uids[1] || '',
      p3: igns[2] || '', u3: uids[2] || '', p4: igns[3] || '', u4: uids[3] || '',
      p5: igns[4] || '', u5: uids[4] || '',
      extra: igns.slice(5).join(', '),
    });
    // Long digit strings turn into scientific notation in Excel unless
    // the cell is explicitly text.
    row.getCell('ownerId').numFmt = '@';
    ['u1', 'u2', 'u3', 'u4', 'u5'].forEach(k => { row.getCell(k).numFmt = '@'; });
  });

  // --- Sheet 2: one row per Discord player ------------------------------
  // (With Fake Tag ON the same person can appear under several teams.)
  const playersSheet = workbook.addWorksheet('Discord Players');
  playersSheet.columns = [
    { header: 'Group', key: 'group', width: 8 },
    { header: 'Slot', key: 'slot', width: 6 },
    { header: 'Team Name', key: 'team', width: 26 },
    { header: 'Role', key: 'role', width: 16 },
    { header: 'Discord Username', key: 'username', width: 24 },
    { header: 'Discord ID', key: 'id', width: 22 },
  ];
  playersSheet.getRow(1).font = { bold: true };

  for (const { letter, slot, t } of entries) {
    const playerIds = t.playerIds || [];
    const ordered = [...new Set([t.ownerId, ...playerIds].filter(Boolean))];
    for (const uid of ordered) {
      const role = uid === t.ownerId ? (playerIds.includes(uid) ? 'Owner & Player' : 'Owner') : 'Player';
      const row = playersSheet.addRow({ group: letter, slot, team: t.team, role, username: usernameOf(uid), id: uid });
      row.getCell('id').numFmt = '@';
    }
  }

  // --- Sheet 3: teams promoted into Round 2+ (only if any exist) ---------
  const laterRows = [];
  for (const [roundKey, round] of Object.entries(tournament.rounds || {})) {
    const roundNum = parseInt(roundKey, 10);
    if (!(roundNum > 1)) continue;
    for (const [letter, group] of Object.entries(round.groups || {}).sort(([x], [y]) => x.localeCompare(y, undefined, { numeric: true }))) {
      group.teams.forEach((t, idx) => laterRows.push({
        round: getRoundDisplayName(tournament, roundNum).name, group: letter, slot: groupSlotNumber(group, idx),
        team: t.team, ownerName: t.ownerName || '', ownerId: t.ownerId || '',
      }));
    }
  }
  if (laterRows.length) {
    const laterSheet = workbook.addWorksheet('Later Rounds');
    laterSheet.columns = [
      { header: 'Round', key: 'round', width: 20 },
      { header: 'Group', key: 'group', width: 8 },
      { header: 'Slot', key: 'slot', width: 6 },
      { header: 'Team Name', key: 'team', width: 26 },
      { header: 'Leader', key: 'ownerName', width: 24 },
      { header: 'Leader ID', key: 'ownerId', width: 22 },
    ];
    laterSheet.getRow(1).font = { bold: true };
    for (const r of laterRows) laterSheet.addRow(r).getCell('ownerId').numFmt = '@';
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `tournament-${(tournament.name || 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-data.xlsx`;
  return { buffer: Buffer.from(buffer), filename, teamCount: entries.length };
}

// ---------------------------------------------------------------------------
// Button handler
// ---------------------------------------------------------------------------
async function handleTournamentWizardButton(interaction) {
  const id = interaction.customId;

  // Public: any player can register a team, no Manage Server needed.
  // These panels are posted for one specific tournament, so the id they
  // were posted for travels with the button instead of depending on
  // whichever tournament an admin happens to have open right now.
  if (id.startsWith('tourney_wizard_register_team:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const roleBlock = registerRoleBlock(interaction, tournament);
    if (roleBlock) {
      return interaction.reply({ content: roleBlock, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (!tournament.open && !canBypassRegistration(interaction)) {
      const content = tournament.closedReason === 'full'
        ? '🔒 Registration is closed — all slots are full.'
        : '❌ Registration is currently closed.';
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    // Safety net for the rare case registration is still marked open but
    // capacity was already hit (e.g. totalSlots got lowered after the
    // fact) — normally auto-close in handleTourneyRegConfirm means this
    // never actually gets reached with room to spare.
    if (isRegistrationFull(tournament)) {
      return interaction.reply({ content: '🔒 Registration is closed — all slots are full.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildRegisterModal(tid));
  }

  // Public: "Try Again" after a form validation error — reopens the modal
  // prefilled with whatever the player typed last time.
  if (id.startsWith('tourney_wizard_register_retry:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    if (!tournament.open && !canBypassRegistration(interaction)) {
      return interaction.reply({ content: '❌ Registration is currently closed.', flags: MessageFlags.Ephemeral });
    }
    const retryRoleBlock = registerRoleBlock(interaction, tournament);
    if (retryRoleBlock) {
      return interaction.reply({ content: retryRoleBlock, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    const pendingEntry = getRegPending(interaction.user.id);
    if (!pendingEntry || pendingEntry.data.tournamentId !== tid || !pendingEntry.data.draft) {
      return interaction.reply({ content: `❌ Your session expired or was interrupted. ${RESTART_HINT}`, flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildRegisterModal(tid, pendingEntry.data.draft));
  }

  // Public: continuing the register flow, also no Manage Server needed.
  // The tournament id was stashed in the pending registration record back
  // when the modal was submitted.
  if (id === 'tourney_wizard_reg_confirm') {
    return handleTourneyRegConfirm(interaction);
  }
  if (id === 'tourney_wizard_reg_cancel') {
    return handleTourneyRegCancel(interaction);
  }

  // Public: self-service slot management, posted in a tournament's own
  // Slot-Manager channel — any registered player can cancel their own
  // slot, check which group they're in, or rename their own team. No
  // Manage Server permission needed for any of these. Same as above, the
  // tournament id rides along on the button/modal customId.
  // Public: Swap Group (picker, request, and the owners' Accept / Reject).
  // Note: 'tourney_wizard_swap_toggle' (the admin Group Swap: On/Off button,
  // handled further down) is intentionally excluded here — it's an admin
  // panel button, not part of the player-facing swap picker/request flow.
  if (id.startsWith('tourney_wizard_selfservice_swap:')
    || (id.startsWith('tourney_wizard_swap_') && id !== 'tourney_wizard_swap_toggle')) {
    return handleSwapButton(interaction);
  }

  if (id.startsWith('tourney_wizard_selfservice_cancel:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const entry = findUserTournamentEntry(tournament, interaction.user.id);
    if (!entry) {
      if (canBypassRegistration(interaction)) return eliteNoSlotReply(interaction, 'Nothing to cancel');
      return interaction.reply({ content: "❌ You're not registered for this tournament.", flags: MessageFlags.Ephemeral });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_cancel_confirm:${tid}`).setLabel('Yes, Cancel My Slot').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_wizard_selfservice_cancel_abort').setLabel('Never Mind').setStyle(ButtonStyle.Secondary),
    );
    const cancelEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle(`⚠️ Cancel Team ${entry.team.team}'s registration in Group ${entry.letter}?`)
      .setDescription("This removes your tournament role(s) and frees the slot for someone else. This can't be undone.");
    return interaction.reply({
      embeds: [cancelEmbed],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id === 'tourney_wizard_selfservice_cancel_abort') {
    return interaction.update({ content: "✅ No changes made — you're still registered.", components: [], embeds: [] });
  }

  if (id.startsWith('tourney_wizard_selfservice_cancel_confirm:')) {
    const tid = id.split(':')[1];
    const store = getGuildStore(interaction.guildId);
    const tournament = store.tournaments && store.tournaments[tid];
    if (!tournament) {
      return interaction.update({ content: '❌ This tournament no longer exists.', components: [], embeds: [] });
    }
    const entry = findUserTournamentEntry(tournament, interaction.user.id);
    if (!entry) {
      return interaction.update({ content: "❌ You're not registered for this tournament.", components: [], embeds: [] });
    }

    await interaction.deferUpdate();

    const { letter, group, team } = entry;
    await removeTeamFromRoundOnward(interaction, store, tournament, team, 2);
    const groupRoleId = group.roleId;
    const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
    for (const userId of targets) {
      const member = interaction.guild.members.cache.get(userId)
        ?? await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (isStillRegisteredElsewhere(tournament, userId, team)) continue;
      if (groupRoleId) {
        await member.roles.remove(groupRoleId).catch(() => {});
        await logRoleChange(interaction.guild, tournament, { member, roleId: groupRoleId, added: false, reason: `self-cancelled team "${team.team}"` });
      }
      await removeRegisteredRole(interaction.guild, tournament, member, `self-cancelled team "${team.team}"`);
    }

    group.teams = group.teams.filter(t => t !== team);
    tournament.qualified = tournament.qualified.filter(name => name !== team.team);
    saveGuildStore(interaction.guildId, store);
    await refreshPublishedSlotList(interaction.guild, tournament, 1, letter, group);

    return interaction.editReply({ content: `🗑️ **${team.team}** has been removed from Group ${letter} — your tournament roles have been cleared.`, components: [], embeds: [] });
  }

  if (id.startsWith('tourney_wizard_selfservice_my_groups:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const entry = findUserTournamentEntry(tournament, interaction.user.id);
    if (!entry) {
      if (canBypassRegistration(interaction)) return eliteNoSlotReply(interaction, 'No group to show');
      return interaction.reply({ content: "❌ You're not registered for this tournament.", flags: MessageFlags.Ephemeral });
    }
    const { letter, team, idx, group } = entry;
    const details = formatTeamDetailLines(team, false);
    // Only the registering owner is tagged (not every player).
    const ownerTag = team.ownerId ? `<@${team.ownerId}>` : '';
    const myGroupEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle(`📋 Team ${team.team} is in Group ${letter}, Slot ${groupSlotNumber(group, idx)}.`)
      .setDescription([details, ownerTag ? `\n👥 ${ownerTag}` : ''].filter(Boolean).join('\n'));
    return interaction.reply({
      embeds: [myGroupEmbed],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id.startsWith('tourney_wizard_selfservice_change_name:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const entry = findUserTournamentEntry(tournament, interaction.user.id);
    if (!entry) {
      if (canBypassRegistration(interaction)) return eliteNoSlotReply(interaction, 'No team name to change');
      return interaction.reply({ content: "❌ You're not registered for this tournament.", flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId(`tourney_selfservice_change_name_modal:${tid}`).setTitle('Change Team Name');
    const input = new TextInputBuilder()
      .setCustomId('team').setLabel('New team name').setStyle(TextInputStyle.Short)
      .setValue(entry.team.team).setMaxLength(100).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'tourney_wizard_back_to_list') {
    return interaction.update({ content: '', ...buildTournamentListPayload(interaction.guildId) });
  }

  // Staff (see Select Staff) may press ONLY the per-group Publish Slot List
  // and Result buttons. Open / Close, Punish Team, Config and every other
  // panel button stay Manage Server only.
  const groupPanelMatch = /^tourney_wizard_group_(?:publish|result|reminder|chat|configdate|config|slotinfo):([^:]+):/.exec(id);
  const staffAllowed = groupPanelMatch
    ? isTournamentStaff(interaction, getTournamentById(interaction.guildId, groupPanelMatch[1]))
    : false;
  const tournamentAdminAllowed = hasTournamentAdminRole(interaction.member)
    && (TOURNAMENT_ADMIN_BUTTON_IDS.has(id) || id.startsWith('tourney_create_settings_')
      || id.startsWith('tourney_wizard_group_slotedit:') || id.startsWith('tourney_wizard_group_slotinfo:'));
  if (!hasManageGuild(interaction) && !staffAllowed && !tournamentAdminAllowed) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  // Everything from here down is admin-only and acts on whichever
  // tournament this admin currently has open in the wizard.
  const store = getTournamentStore(interaction.guildId, interaction.user.id);

  if (id === 'tourney_wizard_create') {
    // Several tournaments can exist at once now — always allowed. Creating
    // one makes it this admin's active tournament in the wizard.
    return interaction.showModal(buildTournamentCreateModal());
  }

  if (id === 'tourney_create_settings_b') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    const select = new ChannelSelectMenuBuilder().setCustomId('tourney_create_confirmchannel_select')
      .setPlaceholder('Choose the confirm channel').addChannelTypes(ChannelType.GuildText);
    return interaction.update({ content: 'B. Pick the confirm channel:', embeds: [], components: [new ActionRowBuilder().addComponents(select)] });
  }

  if (id === 'tourney_create_settings_c') {
    if (!store.tournament) return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(buildRequiredMentionsModal(store.tournament));
  }

  if (id === 'tourney_create_settings_d') {
    if (!store.tournament) return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(buildTeamsPerGroupModal(store.tournament));
  }

  if (id === 'tourney_create_settings_e') {
    if (!store.tournament) return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    return interaction.showModal(buildTotalSlotsModal(store.tournament));
  }

  if (id === 'tourney_create_settings_g') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    const select = new RoleSelectMenuBuilder().setCustomId('tourney_create_registerrole_select')
      .setPlaceholder('Choose the role players need to register');
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tourney_create_settings_g_clear').setLabel('Clear — anyone can register').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_create_settings_g_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({
      content: 'G. Pick the role — only players who have it can register for this tournament:',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), buttons],
    });
  }

  if (id === 'tourney_create_settings_h') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    const select = new ChannelSelectMenuBuilder().setCustomId('tourney_create_swapchannel_select')
      .setPlaceholder('Choose the group swap channel').addChannelTypes(ChannelType.GuildText);
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tourney_create_settings_h_clear').setLabel('Clear — post where requested').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_create_settings_h_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({
      content: 'H. Pick the channel where group swap requests and completed swaps are posted:',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), buttons],
    });
  }

  if (id === 'tourney_create_settings_i') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    const select = new RoleSelectMenuBuilder().setCustomId('tourney_create_confirmrole_select')
      .setPlaceholder('Choose the role given after registration');
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tourney_create_settings_i_clear').setLabel('Clear — use auto-created role').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_create_settings_i_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({
      content: 'I. Pick the role players get right after they register (before their group role):',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), buttons],
    });
  }

  if (id === 'tourney_create_settings_i_clear' || id === 'tourney_create_settings_i_cancel') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    if (id === 'tourney_create_settings_i_clear') {
      store.tournament.confirmRoleId = null;
      saveGuildStore(interaction.guildId, store);
    }
    return interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
  }

  if (id === 'tourney_create_settings_j') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    const select = new ChannelSelectMenuBuilder().setCustomId('tourney_create_logchannel_select')
      .setPlaceholder('Choose the private log channel').addChannelTypes(ChannelType.GuildText);
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tourney_create_settings_j_clear').setLabel('Clear — stop logging').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_create_settings_j_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({
      content: 'J. Pick the private channel where every tournament action (buttons, menus, forms — who clicked what, who banned/cancelled/swapped a team, who created channels, etc.) will be logged:',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), buttons],
    });
  }

  if (id === 'tourney_create_settings_j_clear' || id === 'tourney_create_settings_j_cancel') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    if (id === 'tourney_create_settings_j_clear') {
      store.tournament.logChannelId = null;
      saveGuildStore(interaction.guildId, store);
    }
    return interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
  }

  if (id === 'tourney_create_settings_h_clear' || id === 'tourney_create_settings_h_cancel') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    if (id === 'tourney_create_settings_h_clear') {
      store.tournament.swapChannelId = null;
      saveGuildStore(interaction.guildId, store);
    }
    return interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
  }

  if (id === 'tourney_create_settings_g_clear' || id === 'tourney_create_settings_g_cancel') {
    if (!store.tournament) return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    if (id === 'tourney_create_settings_g_clear') {
      store.tournament.registerRoleId = null;
      saveGuildStore(interaction.guildId, store);
      await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
      return refreshRegisterPanel(interaction.guild, store.tournament);
    }
    return interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
  }

  if (id === 'tourney_create_settings_fake_tag') {
    if (!store.tournament) return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    store.tournament.allowFakeTag = !store.tournament.allowFakeTag;
    saveGuildStore(interaction.guildId, store);
    return interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
  }

  if (id === 'tourney_create_settings_back' || id === 'tourney_create_settings_save') {
    // Everything on this screen saves the moment it's picked, so both
    // buttons do the same thing: drop back to the main panel.
    return interaction.update(buildTournamentWizardPayload(store));
  }

  if (id === 'tourney_wizard_manage_groups') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildSlotListGroupSelectPayload(store.tournament);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id.startsWith('tourney_wizard_slotlist_edit_back:')) {
    if (!hasTournamentAdminAccess(interaction)) {
      return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
    }
    const [, roundStr, letter] = id.split(':');
    const store = getTournamentStore(interaction.guildId, interaction.user.id);
    const tournament = store.tournament;
    const round = Number(roundStr);
    const group = tournament ? getRoundGroups(tournament, round)[letter] : null;
    if (!tournament || !group) {
      return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
    }
    return interaction.update({ content: '', ...buildSlotListViewPayload(tournament, round, letter, group) });
  }

  if (id.startsWith('tourney_wizard_slotlist_edit:')) {
    if (!hasTournamentAdminAccess(interaction)) {
      return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
    }
    const [, roundStr, letter] = id.split(':');
    const store = getTournamentStore(interaction.guildId, interaction.user.id);
    const tournament = store.tournament;
    const round = Number(roundStr);
    const group = tournament ? getRoundGroups(tournament, round)[letter] : null;
    if (!tournament || !group) {
      return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
    }
    const payload = buildSlotListEditTeamSelectPayload(tournament, round, letter, group);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.update({ content: '', ...payload });
  }

  if (id === 'tourney_wizard_edit_settings') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
  }

  // "Group Panel" — restores a group's admin panel (Publish Slot List /
  // Punish Team / Result / Config / Open-Close) if a staff member
  // accidentally deleted that message. Picks any group that already has a
  // channel, then posts a brand-new panel there with that group's current
  // round/settings — nothing about the group itself changes, only the
  // stored admin panel message id is replaced with the new one.
  if (id === 'tourney_wizard_repost_group_panel') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildGroupPanelRepostSelectPayload(store.tournament);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_ban_unban') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.update({ content: '', ...buildBanUnbanMenuPayload(store, store.tournament) });
  }

  if (id === 'tourney_wizard_ban_modal_legacy') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildBanUnbanModal());
  }

  // "Ban Team" (timed) — admin types the exact team name + days directly.
  if (id === 'tourney_wizard_ban_start') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildTimedBanModal());
  }

  if (id === 'tourney_wizard_unban_pick') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildUnbanSelectPayload(store, store.tournament);
    if (payload.error) {
      return interaction.update({ content: payload.error, embeds: [], components: [] });
    }
    return interaction.update({ content: '', ...payload });
  }

  if (id === 'tourney_wizard_post_register_panel') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const select = new ChannelSelectMenuBuilder()
      .setCustomId('tourney_register_panel_channel_select')
      .setPlaceholder('Choose a channel to post the registration panel in')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.reply({
      content: '📮 Pick a channel — players will register from there.',
      components: [new ActionRowBuilder().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id === 'tourney_wizard_manual_add') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    if (!Object.keys(store.tournament.groups).length) {
      return interaction.reply({ content: '❌ Add a group first.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...buildManualAddUserSelectPayload(), flags: MessageFlags.Ephemeral });
  }

  // "Try Again" after a Manually Add Slot form error — reopens the form
  // prefilled with what the admin typed.
  if (id.startsWith('tourney_wizard_manual_add_retry:')) {
    const [, userId, roundStr, letter] = id.split(':');
    const draft = manualAddDrafts.get(manualAddDraftKey(interaction.guildId, interaction.user.id));
    if (!draft || draft.userId !== userId) {
      return interaction.reply({ content: '❌ Your session expired — run **Manually Add Slot** again.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildManualAddSlotModal(userId, parseInt(roundStr, 10), letter, draft.fields));
  }

  if (id === 'tourney_wizard_cancel_slots') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildCancelGroupSelectPayload(store.tournament);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_slot_manager_channel') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const select = new ChannelSelectMenuBuilder()
      .setCustomId('tourney_slotmanager_channel_select')
      .setPlaceholder('Choose the slot-manager channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.reply({
      content: '📡 Pick a channel — published slot lists will be posted there.',
      components: [new ActionRowBuilder().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id === 'tourney_wizard_create_channels') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...buildCreateChannelsSubmenuPayload(), flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_create_channels_manual') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const me = interaction.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ content: '❌ I need the **Manage Channels** permission to do that.', flags: MessageFlags.Ephemeral });
    }

    // Pre-fill from Manage Rounds -> Round 1 (Channel / Role name) so the
    // admin doesn't retype them; anything already edited in this session
    // wins over the saved value. Category isn't pre-filled — it's picked
    // fresh each time from the server's actual categories.
    const roundOne = (store.tournament.rounds && store.tournament.rounds[1]) || {};
    const seed = {};
    if (roundOne.channelFormat) seed.channelFormat = roundOne.channelFormat;
    if (roundOne.roleFormat) seed.roleFormat = roundOne.roleFormat;
    const existing = getPendingChannelCreation(interaction.guildId, interaction.user.id) || {};
    const data = setPendingChannelCreation(interaction.guildId, interaction.user.id, { ...seed, ...existing });
    return interaction.reply({ ...buildManualChannelCreationPayload(data), flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_manual_channels_set_format') {
    const data = getPendingChannelCreation(interaction.guildId, interaction.user.id) || {};
    const modal = new ModalBuilder().setCustomId('tourney_manual_channels_format_modal').setTitle('Channel Format');
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setLabel('Name ({number}=1,2,3.. or {letter}=A,B,C..)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Group {number}')
      .setValue(data.channelFormat || 'Group {number}')
      .setRequired(true)
      .setMaxLength(80);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'tourney_wizard_manual_channels_set_category') {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId('tourney_wizard_manual_channels_category_select')
      .setPlaceholder('Choose the category')
      .addChannelTypes(ChannelType.GuildCategory);
    const back = new ButtonBuilder().setCustomId('tourney_wizard_manual_channels_category_back').setLabel('Back').setStyle(ButtonStyle.Secondary);
    return interaction.update({
      content: 'Pick the category the group channels should go under:',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(back)],
    });
  }

  if (id === 'tourney_wizard_manual_channels_category_back') {
    const data = getPendingChannelCreation(interaction.guildId, interaction.user.id) || {};
    return interaction.update({ content: '', ...buildManualChannelCreationPayload(data) });
  }

  if (id === 'tourney_wizard_manual_channels_set_role') {
    const data = getPendingChannelCreation(interaction.guildId, interaction.user.id) || {};
    const modal = new ModalBuilder().setCustomId('tourney_manual_channels_rolename_modal').setTitle('Role Name');
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setLabel('Name ({number}=1,2,3.. or {letter}=A,B,C..)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Tournament Group {letter}')
      .setValue(data.roleFormat || 'Tournament Group {letter}')
      .setRequired(true)
      .setMaxLength(80);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'tourney_wizard_manual_channels_sort') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let sorted = 0;
    const sortStats = { moved: 0 };
    const sortErrors = [];
    const sortEmpty = [];
    const maxRounds = getMaxRounds(store.tournament);
    for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
      const extra = [];
      if (roundNum > 1) extra.push(getRound(store.tournament, roundNum).categoryId);
      const pending = getPendingChannelCreation(interaction.guildId, interaction.user.id);
      if (roundNum === 1 && pending && pending.categoryId) extra.push(pending.categoryId);
      const savedRound = (store.tournament.rounds && store.tournament.rounds[roundNum]) || {};
      const fmt = roundNum === 1
        ? ((pending && pending.channelFormat) || savedRound.channelFormat || null)
        : getRoundNaming(store.tournament, roundNum).channelFormat;
      const roundStats = { moved: 0 };
      sorted += await sortGroupChannels(interaction.guild, getRoundGroups(store.tournament, roundNum), extra, { stats: roundStats, channelFormat: fmt, roundNum });
      sortStats.moved += roundStats.moved || 0;
      if (roundStats.error) sortErrors.push(`Round ${roundNum}: ${roundStats.error}`);
      if (roundStats.empty) sortEmpty.push(`Round ${roundNum}: ${roundStats.empty}`);
    }
    if (sortErrors.length) {
      const head = sorted ? `⚠️ Sorted **${sorted}** channel${sorted === 1 ? '' : 's'}, but some failed:` : '❌ Couldn\'t sort:';
      return interaction.editReply({ content: `${head}\n${sortErrors.join('\n')}\n\nIf this says Missing Access / Missing Permissions, give my role **Manage Channels** and **View Channel** on those group channels (or put my role above theirs), then press Sort again.`.slice(0, 1900) });
    }
    if (!sorted && sortEmpty.length) {
      return interaction.editReply({ content: `❌ I couldn't find any group channels to sort.\n${sortEmpty.slice(0, 3).join('\n')}`.slice(0, 1900) });
    }
    return interaction.editReply({ content: sorted ? `🔢 Sorted **${sorted}** channel${sorted === 1 ? '' : 's'} into numeric order (G1, G2, G3 ... G10) across all categories${sortStats.moved ? `, moving **${sortStats.moved}** into the right category` : ''}. Nothing was created or deleted.` : '❌ No group channels found to sort (or I couldn\'t reorder them — check my **Manage Channels** permission).' });
  }

  if (id === 'tourney_wizard_manual_channels_cancel') {
    clearPendingChannelCreation(interaction.guildId, interaction.user.id);
    return interaction.update({ content: '❌ Cancelled.', embeds: [], components: [] });
  }

  if (id === 'tourney_wizard_manual_channels_auto_create') {
    const data = getPendingChannelCreation(interaction.guildId, interaction.user.id);
    if (!data || !data.channelFormat || !data.categoryId) {
      return interaction.reply({ content: '❌ Set both Channel Name and Category first.', flags: MessageFlags.Ephemeral });
    }
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const groupsErr = ensureGroupsExist(interaction, store);
    if (groupsErr) {
      return interaction.reply({ content: groupsErr, flags: MessageFlags.Ephemeral });
    }
    const me = interaction.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ content: '❌ I need the **Manage Channels** permission to do that.', flags: MessageFlags.Ephemeral });
    }
    // Manage Roles is only needed to lock each group's channel down to
    // that group's own players — nice to have, but its absence should
    // never stop the channels themselves from being created.
    const canManageRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);

    const category = interaction.guild.channels.cache.get(data.categoryId)
      ?? await interaction.guild.channels.fetch(data.categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return interaction.reply({ content: '❌ That category no longer exists — pick it again from the Category button.', flags: MessageFlags.Ephemeral });
    }

    // One run at a time per server — a second press while the first is still
    // going would race it and make duplicate channels.
    if (channelBuildsInFlight.has(interaction.guildId)) {
      return interaction.reply({ content: '⏳ Auto Channels is already running for this server — wait for it to finish, then press it again if anything is left.', flags: MessageFlags.Ephemeral });
    }
    channelBuildsInFlight.add(interaction.guildId);

    await interaction.deferUpdate();

    // Discord only lets us edit this reply for 15 minutes; a very big run can
    // outlast that, so the final report falls back to a normal message.
    const report = async (payload) => {
      try { return await interaction.editReply(payload); }
      catch {
        const text = typeof payload === 'string' ? payload : payload.content;
        return interaction.channel?.send({ content: `<@${interaction.user.id}> ${text}`.slice(0, 2000) }).catch(() => null);
      }
    };

    let result;
    try {
      result = await createGroupChannels(interaction, store, {
        nameFormat: data.channelFormat,
        parentId: category.id,
        roleFormat: data.roleFormat,
        onProgress: (done, total) => interaction.editReply({ content: `⏳ Working… ${done}/${total} groups done.` }),
      });
    } catch (err) {
      // Nothing is lost: every channel/role made so far was saved as it was
      // made, and the panel stays open so Auto Channels can simply be pressed again.
      console.error('[tournament] Auto Channels crashed:', err);
      return report({ content: `⚠️ Auto Channels hit an error (${err.message}). Everything created so far is saved — press **Auto Channels** again and it will pick up where it stopped and fix anything missing.` });
    } finally {
      channelBuildsInFlight.delete(interaction.guildId);
    }
    const { created, missingRole, roleProblems = [], skippedEmpty, failed, repaired, adopted, stopReason, categoriesUsed } = result;

    const roleWarning = !canManageRoles
      ? '\n⚠️ I don\'t have **Manage Roles**, so these channels aren\'t locked to their own group — grant it and re-run to lock them down.'
      : missingRole
        ? `\n⚠️ ${missingRole} group role(s) couldn't be created (role cap or a permissions hiccup) — those channels are visible to everyone until you re-run.`
        : '';
    const skippedNote = skippedEmpty
      ? `\nℹ️ Skipped ${skippedEmpty} empty group(s) — no teams registered yet. Re-run Auto Channels once they fill up.`
      : '';
    const incomplete = Boolean(failed || stopReason);
    const failNote = incomplete
      ? `\n⚠️ ${failed ? `${failed} group(s) failed. ` : ''}${stopReason ? `Stopped early: ${stopReason}. ` : ''}Press **Auto Channels** again — it continues from where it stopped and only fixes what's missing.`
      : '';
    const repairNote = repaired ? `\n🔧 Repaired ${repaired} existing group(s) (missing role, permissions, category or admin panel).` : '';
    const adoptNote = adopted ? `\n♻️ Re-linked ${adopted} channel(s) left over from an interrupted run.` : '';
    const catList = categoriesUsed.length ? categoriesUsed.map(n => `**${n}**`).join(', ') : `**${category.name}**`;
    const catNote = categoriesUsed.length > 1 ? `\nℹ️ Categories fill up at 50 channels, so I continued into numbered categories.` : '';
    // Discord messages cap at 2000 chars — with 100+ channels the mention list won't fit.
    const createdText = created.join(', ');
    const createdShown = createdText.length > 1200 ? `${created.length} group channels` : createdText;

    const roleProblemNote = roleProblems.length
      ? `\n⚠️ **${roleProblems.length} team owner(s) don't have their group role:** ${roleProblems.slice(0, 8).join('; ')}${roleProblems.length > 8 ? '; …' : ''}. Fix that (or re-invite the owner) and press **Auto Channels** again — it re-checks every owner and only adds what's missing.`
      : '';
    const extras = `${catNote}${repairNote}${adoptNote}${roleWarning}${roleProblemNote}${skippedNote}${failNote}`;
    const content = (created.length
      ? `✅ Created ${createdShown} under ${catList}${extras}`
      : (repaired || adopted)
        ? `✅ Every group already had a channel.${extras}`
        : incomplete
          ? `ℹ️ No new channels were made.${extras}`
          : `ℹ️ Every filled group already has a channel and nothing needed fixing.${extras}`).slice(0, 2000);

    if (incomplete) {
      // Keep the panel (and its saved settings) so a retry is one click.
      return report({ content });
    }
    clearPendingChannelCreation(interaction.guildId, interaction.user.id);
    return report({ content, embeds: [], components: [] });
  }


  if (id === 'tourney_wizard_excel_export') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Slot List');
    sheet.columns = [
      { header: 'Group', key: 'group', width: 10 },
      { header: 'Slot', key: 'slot', width: 8 },
      { header: 'Team', key: 'team', width: 30 },
      { header: 'Leader', key: 'owner', width: 24 },
      { header: 'Leader ID', key: 'ownerId', width: 22 },
      { header: 'WhatsApp', key: 'whatsapp', width: 18 },
      { header: 'Players', key: 'players', width: 50 },
      { header: 'P1 IGN', key: 'p1', width: 20 },
      { header: 'P1 UID', key: 'u1', width: 16 },
      { header: 'P2 IGN', key: 'p2', width: 20 },
      { header: 'P2 UID', key: 'u2', width: 16 },
      { header: 'P3 IGN', key: 'p3', width: 20 },
      { header: 'P3 UID', key: 'u3', width: 16 },
      { header: 'P4 IGN', key: 'p4', width: 20 },
      { header: 'P4 UID', key: 'u4', width: 16 },
      { header: 'P5 IGN', key: 'p5', width: 20 },
      { header: 'P5 UID', key: 'u5', width: 16 },
      { header: 'Jump URL', key: 'jump', width: 60 },
    ];
    for (const [letter, group] of Object.entries(store.tournament.groups).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
      group.teams.forEach((t, idx) => {
        // Newer registrations store real Discord IDs in playerIds (from the
        // mention-based flow) — resolve those to readable tags for the
        // spreadsheet instead of dumping raw <@id> mention text. Older
        // registrations (typed IGNs, no playerIds) fall back to t.players as-is.
        const playerLabels = (t.playerIds && t.playerIds.length)
          ? t.playerIds.map(id => interaction.guild.members.cache.get(id)?.user.tag ?? `<@${id}>`)
          : (t.players || []);
        const igns = t.playerIgns || [];
        const uids = t.playerUids || [];
        const row = sheet.addRow({
          group: letter, slot: groupSlotNumber(group, idx), team: t.team, players: playerLabels.join(', '),
          owner: t.ownerName || '', ownerId: t.ownerId || '', whatsapp: t.whatsapp || '',
          p1: igns[0] || '', u1: uids[0] || '', p2: igns[1] || '', u2: uids[1] || '',
          p3: igns[2] || '', u3: uids[2] || '', p4: igns[3] || '', u4: uids[3] || '',
          p5: igns[4] || '', u5: uids[4] || '',
          jump: t.confirmMessageUrl ? { text: t.confirmMessageUrl, hyperlink: t.confirmMessageUrl } : '',
        });
        // Keep IDs/UIDs as text so Excel never shows them in scientific notation.
        ['ownerId', 'u1', 'u2', 'u3', 'u4', 'u5'].forEach(k => { row.getCell(k).numFmt = '@'; });
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `tournament-${(store.tournament.name || 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xlsx`;
    const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: filename });
    return interaction.editReply({ content: '📊 Full slot list export:', files: [attachment] });
  }

  if (id === 'tourney_wizard_export_data') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const tournament = store.tournament;

    if (collectExportEntries(tournament).length === 0) {
      return interaction.reply({ content: '❌ No teams registered yet — nothing to export.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const exported = await buildTournamentExport(interaction.guild, tournament);
    const attachment = new AttachmentBuilder(exported.buffer, { name: exported.filename });
    return interaction.editReply({
      content: `📥 Exported **${exported.teamCount}** team(s) from **${tournament.name}**.`,
      files: [attachment],
    });
  }

  if (id === 'tourney_wizard_help') {
    return interaction.reply({ embeds: [buildHelpEmbed()], flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_manage_rounds') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...buildRoundListPayload(store.tournament), flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_toggle') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    store.tournament.open = !store.tournament.open;
    // Any manual flip (open or closed) overrides whatever auto-closed it
    // before — otherwise the register button would keep reporting "all
    // slots are full" after an admin manually reopens it, or a manual
    // close would misleadingly claim slots are full.
    store.tournament.closedReason = null;
    saveGuildStore(interaction.guildId, store);
    const payload = buildTournamentWizardPayload(store);
    await interaction.update(payload);
    await refreshRegisterPanel(interaction.guild, store.tournament);
    await interaction.channel.send(
      store.tournament.open
        ? `✅ Registration opened for **${store.tournament.name}**. Teams can now register.`
        : `🔒 Registration for **${store.tournament.name}** is now closed.`
    ).catch(() => {});
    return;
  }

  if (id === 'tourney_wizard_swap_toggle') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    store.tournament.groupSwapOpen = !isGroupSwapOpen(store.tournament);
    saveGuildStore(interaction.guildId, store);
    const payload = buildTournamentWizardPayload(store);
    await interaction.update(payload);
    await interaction.channel.send(
      store.tournament.groupSwapOpen
        ? `🔄 Group Swap is now **ON** for **${store.tournament.name}** — players can request swaps again.`
        : `🚫 Group Swap is now **OFF** for **${store.tournament.name}** — players can no longer request or accept swaps.`
    ).catch(() => {});
    return;
  }

  // View Groups / Slot List / Qualify used to live on the top-level panel —
  // removed in favor of each group's own channel panel below, which covers
  // publish/punish/result scoped to that specific group.

  // These three live on a per-group channel panel that outlives any one
  // admin session, so — unlike the rest of this function — they resolve
  // their tournament explicitly from the id baked into the button instead
  // of from this admin's active-tournament pointer above.
  if (id.startsWith('tourney_wizard_group_slotedit:') || id.startsWith('tourney_wizard_group_slotinfo:')) {
    return handleSlotListButtons(interaction);
  }

  if (id.startsWith('tourney_wizard_group_publish:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const rawStore = getGuildStore(interaction.guildId);
    const tournament = rawStore.tournaments && rawStore.tournaments[tid];
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    return handleTourneyGroupPublish(interaction, rawStore, tournament, parseInt(roundStr, 10), letter);
  }

  if (id.startsWith('tourney_wizard_group_chat:')) {
    const [, tid, roundStr, letter, action] = id.split(':');
    const roundNum = parseInt(roundStr, 10);
    const chatStore = getGuildStore(interaction.guildId);
    const tournament = chatStore.tournaments && chatStore.tournaments[tid];
    const chatGroup = tournament && getRoundGroups(tournament, roundNum)[letter];
    if (!chatGroup) {
      return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const open = action === 'open';
    // Acknowledge right away — editing channel permissions can take longer
    // than Discord's 3-second window for answering a button press.
    await interaction.deferUpdate();
    const chatChannel = (chatGroup.channelId && interaction.guild.channels.cache.get(chatGroup.channelId)) || interaction.channel;
    const result = await setGroupChatOpen(interaction.guild, chatChannel, chatGroup, open, interaction.user.tag);
    if (result.error) {
      return interaction.followUp({ content: result.error, flags: MessageFlags.Ephemeral });
    }
    chatGroup.chatOpen = open;
    saveGuildStore(interaction.guildId, chatStore);
    // Swap the button (Open <-> Close) on the panel itself, then announce.
    await interaction.editReply(buildTournamentGroupAdminPanelPayload(tournament, roundNum, letter));
    // The announcement only stays in the channel for 5 seconds, then the bot
    // deletes it so the group channel stays clean.
    const announcement = await chatChannel.send(
      open
        ? `🔓 **${groupLabel(roundNum, letter)} is now OPEN** — players can chat and send files.`
        : `🔒 **${groupLabel(roundNum, letter)} is now CLOSED** — no messages, files or threads until staff press **Open** on the admin panel.`,
    ).catch(() => null);
    if (announcement) setTimeout(() => announcement.delete().catch(() => {}), 5000);
    return;
  }

  if (id.startsWith('tourney_wizard_group_punish:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const roundNum = parseInt(roundStr, 10);
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament || !getRoundGroups(tournament, roundNum)[letter]) {
      return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildTournamentPunishSelectPayload(tournament, tid, roundNum, letter);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id.startsWith('tourney_wizard_group_result:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const roundNum = parseInt(roundStr, 10);
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament || !getRoundGroups(tournament, roundNum)[letter]) {
      return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const payload = buildQualifySelectPayload(tournament, tid, roundNum, letter);
    if (payload.error) {
      return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (id.startsWith('tourney_wizard_group_reminder:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const roundNum = parseInt(roundStr, 10);
    const tournament = getTournamentById(interaction.guildId, tid);
    const group = tournament && getRoundGroups(tournament, roundNum)[letter];
    if (!group) {
      return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const reminder = buildGroupReminderPayload(group);
    // Posted via channel.send (not interaction.reply) so it's a fully
    // independent message with no "replying to" link back to the panel.
    await interaction.deferUpdate();
    const sentReminder = await interaction.channel.send(reminder.payload).catch(err => {
      console.error(`[tournament-reminder] Couldn't send reminder in ${interaction.channelId}: ${err.message}`);
      return null;
    });
    // The reminder cleans itself up 2 minutes after it's posted.
    if (sentReminder) setTimeout(() => sentReminder.delete().catch(() => {}), 2 * 60 * 1000);
    return;
  }

  if (id.startsWith('tourney_wizard_group_config:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const roundNum = parseInt(roundStr, 10);
    const cfgStore = getGuildStore(interaction.guildId);
    const tournament = cfgStore.tournaments && cfgStore.tournaments[tid];
    const cfgGroup = tournament && getRoundGroups(tournament, roundNum)[letter];
    if (!cfgGroup) {
      return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    }
    // The Config button lives on the group's admin panel message — remember it
    // (older panels were posted before ids were stored) and re-render it now
    // so it shows the schedule layout.
    if (interaction.message && cfgGroup.adminPanelMessageId !== interaction.message.id) {
      cfgGroup.adminPanelMessageId = interaction.message.id;
      saveGuildStore(interaction.guildId, cfgStore);
      await interaction.message.edit(buildTournamentGroupAdminPanelPayload(tournament, roundNum, letter)).catch(() => {});
    }
    return interaction.reply({ ...buildGroupConfigPayload(tournament, roundNum, letter), flags: MessageFlags.Ephemeral });
  }

  if (id.startsWith('tourney_wizard_group_configdate:')) {
    const [, tid, roundStr, letter] = id.split(':');
    const roundNum = parseInt(roundStr, 10);
    const tournament = getTournamentById(interaction.guildId, tid);
    const group = tournament && getRoundGroups(tournament, roundNum)[letter];
    if (!group) {
      return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildGroupDateModal(tid, roundNum, letter, group));
  }

  if (id === 'tourney_wizard_select_staff') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...buildSelectStaffPayload(store.tournament), flags: MessageFlags.Ephemeral });
  }

  if (id === 'tourney_wizard_refresh') {
    const tournament = store.tournament;
    if (!tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferUpdate();
    const summary = await refreshTournamentMessages(interaction, store, tournament);
    return interaction.editReply({ content: summary, ...buildTournamentWizardPayload(store) });
  }

  if (id === 'tourney_wizard_reset') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tourney_wizard_reset_confirm').setLabel('Yes, reset it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_wizard_reset_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({
      content: `⚠️ Reset **${store.tournament.name}**? This deletes every registered team, all group roles, all group channels (and their slot lists) and the winner role. Settings are kept. This can't be undone.`,
      embeds: [],
      components: [row],
    });
  }

  if (id === 'tourney_wizard_reset_cancel') {
    return interaction.update({ content: '', ...buildTournamentWizardPayload(store) });
  }

  if (id === 'tourney_wizard_reset_confirm') {
    const tournament = store.tournament;
    if (!tournament) {
      return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
    }
    await interaction.deferUpdate();

    const guild = interaction.guild;
    // Round 1 groups live on tournament.groups; Round 2+ groups live under
    // tournament.rounds[n].groups.
    const groups = [...Object.values(tournament.groups || {})];
    const categoryIds = new Set();
    if (tournament.rounds) {
      for (const round of Object.values(tournament.rounds)) {
        groups.push(...Object.values(round.groups || {}));
        if (round.categoryId) categoryIds.add(round.categoryId);
      }
    }

    let cleanupFailures = 0;
    const deletedChannelIds = new Set();

    for (const group of groups) {
      if (group.channelId) {
        const channel = guild.channels.cache.get(group.channelId)
          ?? await guild.channels.fetch(group.channelId).catch(() => null);
        if (channel) {
          if (channel.parentId) categoryIds.add(channel.parentId);
          await channel.delete('Tournament reset').then(() => deletedChannelIds.add(channel.id)).catch(() => { cleanupFailures++; });
        }
      }
      // Slot list copies posted outside the group's own channel (if any).
      if (group.slotListManagerMessageId && tournament.slotManagerChannelId) {
        const smChannel = guild.channels.cache.get(tournament.slotManagerChannelId);
        const msg = smChannel && await smChannel.messages.fetch(group.slotListManagerMessageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
      if (group.roleId) {
        const role = guild.roles.cache.get(group.roleId);
        if (role) await role.delete('Tournament reset').catch(() => { cleanupFailures++; });
      }
    }

    if (tournament.winnerRoleId) {
      const winnerRole = guild.roles.cache.get(tournament.winnerRoleId);
      if (winnerRole) await winnerRole.delete('Tournament reset').catch(() => { cleanupFailures++; });
    }
    if (tournament.registeredRoleId) {
      const registeredRole = guild.roles.cache.get(tournament.registeredRoleId);
      if (registeredRole) await registeredRole.delete('Tournament reset').catch(() => { cleanupFailures++; });
      tournament.registeredRoleId = null;
    }

    // Categories only go if nothing else is left inside them — the Round 1
    // category is found by name each time Auto Channels runs, so it simply
    // gets recreated when needed.
    for (const categoryId of categoryIds) {
      const category = guild.channels.cache.get(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) continue;
      const stillHasChildren = guild.channels.cache.some(c => c.parentId === categoryId && !deletedChannelIds.has(c.id));
      if (stillHasChildren) continue;
      await category.delete('Tournament reset').catch(() => { cleanupFailures++; });
    }

    // Wipe registration data only. Everything else on the tournament object
    // (name, totalSlots, teamsPerGroup, requiredMentions, allowFakeTag,
    // confirm / slot-manager / register-panel channels, maxRounds, each
    // round's naming + group size, bannedTeams, banRoleId) is left alone.
    tournament.groups = {};
    tournament.qualified = [];
    tournament.winnerTeam = null;
    tournament.winnerRoleId = null;
    if (tournament.rounds) {
      for (const round of Object.values(tournament.rounds)) {
        round.groups = {};
        round.categoryId = null;
      }
    }
    // "Full" no longer applies; leave registration open/closed as the admin had it.
    if (tournament.closedReason === 'full') tournament.closedReason = null;
    saveGuildStore(interaction.guildId, store);

    await refreshRegisterPanel(guild, tournament);

    return interaction.editReply({
      content: cleanupFailures
        ? `🔄 **${tournament.name}** reset. ⚠️ ${cleanupFailures} channel/role/category item(s) couldn't be removed — check my permissions.`
        : `🔄 **${tournament.name}** reset — teams, group roles, group channels and slot lists cleared. Settings kept${tournament.open ? '' : ' (registration is still closed — use Start/Pause Reg to reopen it)'}.`,
      ...buildTournamentWizardPayload(store),
    });
  }

  if (id === 'tourney_wizard_delete') {
    if (!store.tournament) {
      return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tourney_wizard_delete_confirm').setLabel('Yes, delete it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tourney_wizard_delete_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({
      content: `⚠️ Delete **${store.tournament.name}** and all groups/registrations? This can't be undone. An Excel file of all the registration data is sent to you automatically first.`,
      embeds: [],
      components: [row],
    });
  }

  if (id === 'tourney_wizard_delete_confirm') {
    const tournament = store.tournament;
    await interaction.deferUpdate();

    // Back the data up first: build the Excel export BEFORE anything is
    // removed. If that fails, the delete is stopped so nothing is lost.
    let exported = null;
    if (tournament) {
      try {
        exported = await buildTournamentExport(interaction.guild, tournament);
      } catch (err) {
        console.error(`[tournament-delete-export] Export failed in guild ${interaction.guildId}: ${err.message}`);
        return interaction.editReply({
          content: '❌ I couldn\'t create the Excel backup, so the tournament was **not** deleted. Try **Export Data** first, then delete again.',
          ...buildTournamentWizardPayload(store),
        });
      }
    }
    // Round 1 groups live on tournament.groups; Round 2+ groups live under
    // tournament.rounds[n].groups — both need their channels/roles cleaned
    // up, plus each round's own category and the shared Round 1 category.
    const groups = tournament ? [...Object.values(tournament.groups || {})] : [];
    const categoryIds = new Set();
    if (tournament && tournament.rounds) {
      for (const round of Object.values(tournament.rounds)) {
        groups.push(...Object.values(round.groups || {}));
        if (round.categoryId) categoryIds.add(round.categoryId);
      }
    }

    // Make sure the role cache is complete before looking roles up by id —
    // a cache-only lookup silently skips anything that isn't cached.
    await interaction.guild.roles.fetch().catch(() => {});

    let cleanupFailures = 0;
    const deletedChannelIds = new Set();

    for (const group of groups) {
      if (group.channelId) {
        // Fetch as a fallback: the channel may not be in the cache.
        const channel = interaction.guild.channels.cache.get(group.channelId)
          ?? await interaction.guild.channels.fetch(group.channelId).catch(() => null);
        if (channel) {
          // Remember the category the channel lived in (covers the shared
          // Round 1 category, which isn't stored on the tournament itself).
          if (channel.parentId) categoryIds.add(channel.parentId);
          await channel.delete('Tournament deleted')
            .then(() => deletedChannelIds.add(channel.id))
            .catch((err) => {
              cleanupFailures++;
              console.error(`[tournament-delete] Couldn't delete channel ${group.channelId}: ${err.message}`);
            });
        }
      }
      // Slot list copies posted in the slot-manager channel (if any).
      if (group.slotListManagerMessageId && tournament.slotManagerChannelId) {
        const smChannel = interaction.guild.channels.cache.get(tournament.slotManagerChannelId);
        const msg = smChannel && await smChannel.messages.fetch(group.slotListManagerMessageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
      if (group.roleId) {
        const role = interaction.guild.roles.cache.get(group.roleId)
          ?? await interaction.guild.roles.fetch(group.roleId).catch(() => null);
        if (role) {
          await role.delete('Tournament deleted').catch((err) => {
            cleanupFailures++;
            console.error(`[tournament-delete] Couldn't delete role ${group.roleId}: ${err.message}`);
          });
        }
      }
    }

    // Categories go last, and only when nothing else is left inside them
    // (another tournament may share the same category).
    if (store.settings && store.settings.tournamentGroupChannelsCategoryId) {
      categoryIds.add(store.settings.tournamentGroupChannelsCategoryId);
    }
    for (const categoryId of categoryIds) {
      const category = interaction.guild.channels.cache.get(categoryId)
        ?? await interaction.guild.channels.fetch(categoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) continue;
      const stillHasChildren = interaction.guild.channels.cache.some(c => c.parentId === categoryId && !deletedChannelIds.has(c.id));
      if (stillHasChildren) continue;
      await category.delete('Tournament deleted').catch((err) => {
        cleanupFailures++;
        console.error(`[tournament-delete] Couldn't delete category ${categoryId}: ${err.message}`);
      });
    }
    if (store.settings && store.settings.tournamentGroupChannelsCategoryId) {
      delete store.settings.tournamentGroupChannelsCategoryId;
    }

    if (tournament && tournament.winnerRoleId) {
      const winnerRole = interaction.guild.roles.cache.get(tournament.winnerRoleId);
      if (winnerRole) {
        await winnerRole.delete('Tournament deleted').catch(() => { cleanupFailures++; });
      }
    }

    if (tournament && tournament.registeredRoleId) {
      const registeredRole = interaction.guild.roles.cache.get(tournament.registeredRoleId);
      if (registeredRole) {
        await registeredRole.delete('Tournament deleted').catch(() => { cleanupFailures++; });
      }
    }

    if (tournament && tournament.staffRoleId) {
      const staffRole = interaction.guild.roles.cache.get(tournament.staffRoleId);
      if (staffRole) {
        await staffRole.delete('Tournament deleted').catch(() => { cleanupFailures++; });
      }
    }

    // The ban role is deliberately NOT torn down if a timed ban against
    // this tournament is still running — the whole point of a timed ban
    // is that deleting the tournament shouldn't let a punished team off
    // early. store.timedBans lives outside the tournament object and
    // keeps enforcing it (see processExpiredBans) until each one's own
    // expiry, at which point the role finally gets deleted too — see the
    // cleanup at the bottom of processExpiredBans.
    const activeBans = tournament ? (store.timedBans || []).filter(b => b.tournamentId === tournament.id) : [];
    if (tournament && tournament.banRoleId && !activeBans.length) {
      const banRole = interaction.guild.roles.cache.get(tournament.banRoleId);
      if (banRole) {
        await banRole.delete('Tournament deleted').catch(() => { cleanupFailures++; });
      }
    }

    store.tournament = null;
    saveGuildStore(interaction.guildId, store);
    const banNote = activeBans.length
      ? ` ${activeBans.length} team(s) are still serving a timed ban from this tournament — their ban role stays on until it expires on its own.`
      : '';
    await interaction.editReply({
      content: (cleanupFailures
        ? `🗑️ Tournament deleted. ⚠️ ${cleanupFailures} group channel/role(s) couldn't be removed automatically — check the bot's permissions.`
        : '🗑️ Tournament deleted, along with all group channels, categories, and roles.') + banNote,
      ...buildTournamentListPayload(interaction.guildId),
    });

    // Send the backup. The registration data includes WhatsApp numbers and
    // UIDs, so it goes to the admin only: a private (ephemeral) message for
    // right now, plus a DM copy that stays in their inbox.
    if (exported) {
      const file = () => new AttachmentBuilder(exported.buffer, { name: exported.filename });
      const dmSent = await interaction.user
        .send({ content: `📥 Backup of **${tournament.name}** (${exported.teamCount} team(s)) — exported automatically when it was deleted.`, files: [file()] })
        .then(() => true).catch(() => false);
      await interaction.followUp({
        content: `📥 **${tournament.name}** — Excel backup of all ${exported.teamCount} registered team(s). Download it now; ${dmSent ? 'a copy was also sent to your DMs.' : '⚠️ I couldn\'t DM you a copy (your DMs are closed), so this message is the only copy.'}`,
        files: [file()],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } else if (tournament) {
      await interaction.followUp({ content: 'ℹ️ No teams were registered, so there was nothing to export.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (id === 'tourney_wizard_delete_cancel') {
    const payload = buildTournamentWizardPayload(store);
    return interaction.update({ content: '', ...payload });
  }
}

// ---------------------------------------------------------------------------
// Modal submits
// ---------------------------------------------------------------------------
async function handleTournamentCreateModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);

  const name = interaction.fields.getTextInputValue('name').trim();
  store.tournament = {
    name, open: false, groups: {}, qualified: [], bannedTeams: [],
    slotManagerChannelId: null, confirmChannelId: null,
    requiredMentions: 4, allowFakeTag: false, teamsPerGroup: DEFAULT_GROUP_CAPACITY, totalSlots: null,
    rounds: {}, // rounds[2..maxRounds] = { groupSize, groups: {}, categoryId } — created lazily, see getRound(). maxRounds itself defaults via getMaxRounds() until Manage Rounds sets one.
  };
  saveGuildStore(interaction.guildId, store);

  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleAddGroupModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const letter = interaction.fields.getTextInputValue('letter').trim().toUpperCase();
  const capacityRaw = interaction.fields.getTextInputValue('capacity').trim();
  const capacity = parseInt(capacityRaw, 10);

  if (!GROUP_LETTERS.includes(letter)) {
    return interaction.reply({ content: `❌ Group number must be a whole number between 1 and ${MAX_GROUPS}.`, flags: MessageFlags.Ephemeral });
  }
  if (store.tournament.groups[letter]) {
    return interaction.reply({ content: `❌ Group **${letter}** already exists.`, flags: MessageFlags.Ephemeral });
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_GROUP_CAPACITY) {
    return interaction.reply({ content: `❌ Capacity must be a whole number between 1 and ${MAX_GROUP_CAPACITY}.`, flags: MessageFlags.Ephemeral });
  }

  store.tournament.groups[letter] = { capacity, teams: [] };
  saveGuildStore(interaction.guildId, store);

  const payload = buildTournamentWizardPayload(store);
  await interaction.update(payload);
}

// Auto-creates as many groups as needed to cover `total` teams at `perGroup`
// capacity each, filling the next free letters in order (A, B, C...). The
// last group created absorbs whatever remainder is left over, so the
// capacities always add up to exactly `total` instead of over-provisioning.
async function handleAutoGroupsModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const total = parseInt(interaction.fields.getTextInputValue('total').trim(), 10);
  const perGroup = parseInt(interaction.fields.getTextInputValue('per_group').trim(), 10);

  const result = computeAutoGroups(store.tournament, total, perGroup);
  if (result.error) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }
  const { createdLetters, groupsNeeded } = result;
  saveGuildStore(interaction.guildId, store);

  const payload = buildTournamentWizardPayload(store);
  await interaction.update(payload);
  await interaction.channel.send(
    `⚙️ Auto-created **${groupsNeeded}** group(s) — ${createdLetters.join(', ')} — covering **${total}** teams at up to **${perGroup}** per group.`
  ).catch(() => {});
}

// Public team registration, part 1 — the one-step details form (team name,
// owner name, WhatsApp, players as IGN,UID lines; see buildRegisterModal).
// After it validates, the player mentions their teammates and the actual slot
// assignment happens when they hit Confirm (see handleTourneyRegSelectPlayers
// / handleTourneyRegConfirm below).
async function handleRegisterTeamModalSubmit(interaction) {
  const tid = interaction.customId.split(':')[1];
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];

  if (!tournament) {
    return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (!tournament.open && !canBypassRegistration(interaction)) {
    return interaction.reply({ content: '❌ Registration is currently closed.', flags: MessageFlags.Ephemeral });
  }
  const submitRoleBlock = registerRoleBlock(interaction, tournament);
  if (submitRoleBlock) {
    return interaction.reply({ content: submitRoleBlock, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  const draft = {
    team: interaction.fields.getTextInputValue('team'),
    owner: interaction.fields.getTextInputValue('owner'),
    whatsapp: interaction.fields.getTextInputValue('whatsapp'),
    players: interaction.fields.getTextInputValue('players'),
  };
  const checked = validateRegistrationForm(tournament, draft);
  if (checked.error) {
    return rejectRegistrationForm(interaction, tid, draft, checked.error);
  }
  const { team, ownerName, whatsapp, playerIgns, playerUids } = checked.data;

  const requiredMentions = tournament.requiredMentions ?? 4;
  // 0 required mentions: nothing to pick, so skip the player select and go
  // straight to the review/confirm screen with an empty lineup.
  if (requiredMentions === 0) {
    startRegPending(interaction.user.id, interaction.guildId, { team, ownerName, whatsapp, playerIgns, playerUids, tournamentId: tid, selectedPlayerIds: [] });
    return interaction.reply({
      embeds: [buildTeamRegPreviewEmbed({ team, ownerName, whatsapp, playerIgns, playerUids, selectedPlayerIds: [] })],
      components: [tourneyConfirmRow()],
      flags: MessageFlags.Ephemeral,
    });
  }

  startRegPending(interaction.user.id, interaction.guildId, { team, ownerName, whatsapp, playerIgns, playerUids, tournamentId: tid });

  return interaction.reply({
    content: `Team name set to **${team}**. Now mention the **${requiredMentions} player${requiredMentions === 1 ? '' : 's'}** on your team:`,
    components: [buildMentionPlayersRow(requiredMentions)],
    flags: MessageFlags.Ephemeral,
  });
}

// Public team registration, part 2 — player mentions picked from the
// select menu shown after the details form. Just stages the pick and shows a
// review/confirm screen; nothing is saved to data.json yet.
async function handleTourneyRegSelectPlayers(interaction) {
  const pendingEntry = getRegPending(interaction.user.id);
  // No team on the pending record = it only holds an in-progress form draft
  // (see handleRegisterTeamModalSubmit), so this select menu belongs to an
  // older attempt.
  if (!pendingEntry || !pendingEntry.data.team) {
    return interaction.reply({ content: `❌ Your session expired or was interrupted. ${RESTART_HINT}`, flags: MessageFlags.Ephemeral });
  }

  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[pendingEntry.data.tournamentId];
  if (!tournament) {
    clearRegPending(interaction.user.id);
    return interaction.update({ content: '❌ This tournament no longer exists.', embeds: [], components: [] });
  }
  const confirmRoleBlock = registerRoleBlock(interaction, tournament);
  if (confirmRoleBlock) {
    clearRegPending(interaction.user.id);
    return interaction.update({ content: confirmRoleBlock, embeds: [], components: [], allowedMentions: { parse: [] } });
  }

  const requiredMentions = tournament.requiredMentions ?? 4;

  // Bots can't be a playing member of a team lineup.
  const botPicked = interaction.users.find(u => u.bot);
  if (botPicked) {
    return interaction.update({
      content: `❌ ${botPicked} is a bot and can't be picked as a player. Mention ${requiredMentions} human player${requiredMentions === 1 ? '' : 's'} below:`,
      embeds: [],
      components: [buildMentionPlayersRow(requiredMentions)],
    });
  }

  // A player can only be on one team's lineup at a time in this tournament.
  // Skipped when the admin has Fake Tag turned ON in the tournament settings.
  const conflict = tournament.allowFakeTag ? null : findTournamentLineupConflict(tournament, interaction.values);
  if (conflict) {
    return interaction.update({
      content: `❌ <@${conflict.conflictId}> is already registered as a player on **${conflict.team}** and can't be picked again. Mention a different lineup below:`,
      embeds: [],
      components: [buildMentionPlayersRow(requiredMentions)],
    });
  }

  updateRegPending(interaction.user.id, { selectedPlayerIds: interaction.values });
  const pending = getRegPending(interaction.user.id);

  return interaction.update({
    content: null,
    embeds: [buildTeamRegPreviewEmbed(pending.data)],
    components: [tourneyConfirmRow()],
  });
}

// ---------------------------------------------------------------------------
// Automatic group/slot assignment for public tournament registration —
// mirrors how scrims auto-assign slots into fixed-size groups, but starting
// at slot 1 (no reserved slots) and capped at MAX_GROUPS groups total.
// ---------------------------------------------------------------------------
function totalRegisteredTeams(tournament) {
  return Object.values(tournament.groups).reduce((sum, g) => sum + g.teams.length, 0);
}

// Non-mutating check for whether registration has hit capacity — either
// the admin's overall totalSlots cap, or every one of the MAX_GROUPS
// groups being completely full. Deliberately doesn't reuse
// autoAssignGroup() for this, since that function creates a new empty
// group as a side effect when it finds room; calling it just to "peek"
// would spuriously create groups.
function isRegistrationFull(tournament) {
  if (tournament.totalSlots && totalRegisteredTeams(tournament) >= tournament.totalSlots) {
    return true;
  }
  const capacity = tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY;
  for (let i = 1; i <= MAX_GROUPS; i++) {
    const group = tournament.groups[String(i)];
    if (!group || group.teams.length < group.capacity) return false;
  }
  return true;
}

// Finds (auto-creating if needed) the group the next team should land in:
// the first not-yet-full existing group, or the next new group number if
// every existing group is full. Returns null once the tournament's overall
// totalSlots cap or the MAX_GROUPS safety cap has been reached — at which
// point every group must be completely full before registration can grow.
function autoAssignGroup(tournament) {
  if (tournament.totalSlots && totalRegisteredTeams(tournament) >= tournament.totalSlots) {
    return null;
  }
  const capacity = tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY;
  for (let i = 1; i <= MAX_GROUPS; i++) {
    const key = String(i);
    const group = tournament.groups[key];
    if (!group) {
      tournament.groups[key] = { capacity, teams: [] };
      return key;
    }
    if (group.teams.length < group.capacity) {
      return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Round 2+ — teams qualified out of a group (via that group's "Result"
// button) get funneled into the next round's groups the same way Round 1
// fills up: first not-yet-full group in that round, or the next new one,
// capped at that round's groupSize. Every round beyond 1 gets its own
// role + private channel per group, created the moment it's first needed —
// this is what lets rounds chain indefinitely (up to getMaxRounds) instead
// of stopping at a hardcoded Round 2.
// ---------------------------------------------------------------------------

// tournament.maxRounds caps how many rounds the "Result" button will chain
// through — defaults to 2 (Round 1 registration + one promotion round) for
// tournaments that haven't touched Manage Rounds' Max Rounds setting.
function getMaxRounds(tournament) {
  return Math.min(Math.max(tournament.maxRounds || 2, 1), MAX_ROUND);
}

function findRoundEntry(tournament, roundNum, ownerId) {
  const groups = getRoundGroups(tournament, roundNum);
  for (const letter of Object.keys(groups)) {
    const g = groups[letter];
    const idx = g.teams.findIndex(t => t.ownerId === ownerId);
    if (idx !== -1) return { letter, group: g, idx, team: g.teams[idx] };
  }
  return null;
}

function autoAssignRoundGroup(tournament, roundNum) {
  const groups = getRoundGroups(tournament, roundNum);
  const capacity = roundNum <= 1
    ? (tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY)
    : (getRound(tournament, roundNum).groupSize || DEFAULT_GROUP_CAPACITY);
  for (let i = 1; i <= MAX_GROUPS; i++) {
    const key = String(i);
    const group = groups[key];
    if (!group) {
      groups[key] = { capacity, teams: [] };
      return key;
    }
    if (group.teams.length < group.capacity) {
      return key;
    }
  }
  return null;
}

// Creates (once per group) a role + private channel together for a Round
// 2+ group, the moment a team is promoted via "Result" — unlike Round 1
// registration, promotion is an admin action, not self-service, so there's
// no need to hold the channel back separately from the role here. Each
// round gets its own category, so Round 2's channels never mix with
// Round 3's, etc. Reuses ensureGroupRole so the role side is identical to
// Round 1's group roles.
async function ensureRoundGroupChannelAndRole(interaction, store, tournament, roundNum, groupKey) {
  const round = getRound(tournament, roundNum);
  const group = round.groups[groupKey];
  const botMember = interaction.guild.members.me;

  // Names come from Manage Rounds -> Round N (Channel / Role / Category
  // Name). Unset fields fall back to the original built-in names, so
  // tournaments that never touch those settings behave exactly as before.
  const naming = getRoundNaming(tournament, roundNum);
  const roleName = applyRoundNameFormat(naming.roleFormat, { roundNum, groupKey, separator: ' ' }).slice(0, 100);

  const role = await ensureGroupRole(
    interaction, store, group,
    roleName,
    `Auto-created for Round ${roundNum} Group ${groupKey}`,
  );

  if (!group.channelId || !interaction.guild.channels.cache.has(group.channelId)) {
    if (!botMember.permissions.has('ManageChannels')) {
      console.error(`[tournament-round-channel] Bot is missing the "Manage Channels" permission in guild ${interaction.guildId}.`);
    } else if (interaction.guild.channels.cache.size >= MAX_GUILD_CHANNELS - SAFETY_MARGIN) {
      console.error(`[tournament-round-channel] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_CHANNELS}-channel cap — skipping auto-create for Round ${roundNum} Group ${groupKey}.`);
    } else {
      try {
        let category = round.categoryId
          ? (interaction.guild.channels.cache.get(round.categoryId)
            ?? await interaction.guild.channels.fetch(round.categoryId).catch(() => null))
          : null;
        // A category picked via Select Category but since deleted falls
        // through here — the round.categoryId is stale, so drop it and
        // fall back to the Category Name template below.
        if (!category) round.categoryId = null;

        if (!category) {
          const categoryName = resolveRoundCategoryName(naming.categoryName, roundNum);
          // Reuse a category that already has this exact name (case-
          // insensitive) instead of spawning a duplicate — also lets two
          // rounds deliberately share one category by giving it one name.
          category = interaction.guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
          );
          if (!category) {
            category = await interaction.guild.channels.create({
              name: categoryName,
              type: ChannelType.GuildCategory,
              reason: `Auto-created to hold per-group Round ${roundNum} tournament channels`,
            });
          }
          round.categoryId = category.id;
        }

        // Category full (50 channels)? Continue into "<name> 2", "<name> 3"...
        category = await ensureCategoryWithRoom(interaction.guild, category, `Category full — continuing Round ${roundNum} group channels`);

        // Private to this one group's role only — same lockdown as every
        // other tournament group channel, no tournament-wide role added.
        const overwrites = [{ id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.MentionEveryone] }];
        // Created CLOSED — see the Round 1 note; staff press Open on the admin panel to let players chat.
        if (role) {
          overwrites.push({ id: role.id, allow: GROUP_CLOSED_ALLOW, deny: GROUP_CLOSED_DENY });
        }

        const staffOw = staffChannelOverwrite(interaction.guild, tournament);
        if (staffOw) overwrites.push(staffOw);
        overwrites.push(...allowedUserChannelOverwrites(interaction.guild));
        overwrites.push(...botRoleChannelOverwrites(interaction.guild));
        overwrites.push(...staffMemberOverwrites(interaction.guild, tournament));

        const channel = await withRetry(() => interaction.guild.channels.create({
          name: applyRoundNameFormat(naming.channelFormat, { roundNum, groupKey, separator: '-' }).toLowerCase().slice(0, 100),
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: overwrites,
          reason: `Auto-created for Round ${roundNum} Group ${groupKey}`,
        }));

        group.channelId = channel.id;
        saveGuildStore(interaction.guildId, store); // record it before anything else can fail
        const panelMessage = await channel.send(buildTournamentGroupAdminPanelPayload(tournament, roundNum, groupKey)).catch(() => null);
        if (panelMessage) group.adminPanelMessageId = panelMessage.id;
        saveGuildStore(interaction.guildId, store);
        await sortGroupChannels(interaction.guild, round.groups, [], { onlyNewIds: [channel.id] });
      } catch (err) {
        console.error(`[tournament-round-channel] Failed to auto-create channel for Round ${roundNum} Group ${groupKey} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      }
    }
  }

  return role;
}

// True if userId is still the owner or a tagged teammate on some OTHER
// active team in this tournament (any round), besides excludeTeam. The
// Registered role and each group's role are shared across every team —
// not per-team — so before stripping either from someone whose team just
// got cancelled/banned/disqualified, check whether they independently
// hold a separate, still-valid registration elsewhere. Without this, a
// player tagged as a teammate on a team that later gets removed loses
// their own perfectly valid role, even though nothing about their own
// registration changed.
function isStillRegisteredElsewhere(tournament, userId, excludeTeam) {
  const maxRounds = getMaxRounds(tournament);
  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    const groups = getRoundGroups(tournament, roundNum);
    for (const letter of Object.keys(groups)) {
      for (const t of groups[letter].teams) {
        if (t === excludeTeam) continue;
        if (t.ownerId === userId || (t.playerIds || []).includes(userId)) return true;
      }
    }
  }
  return false;
}

// Strips a team's access to a round's group (role + group role) and
// removes it from whichever group it was sitting in for that round —
// then keeps walking forward through every later round too, in case the
// team had already been promoted further (e.g. punished after reaching
// Round 3). Used when a team is un-qualified (Result re-run without
// them), punished, or self-service cancelled.
async function removeTeamFromRoundOnward(interaction, store, tournament, team, fromRound) {
  const maxRounds = getMaxRounds(tournament);
  for (let roundNum = fromRound; roundNum <= maxRounds; roundNum++) {
    const entry = findRoundEntry(tournament, roundNum, team.ownerId);
    if (!entry) continue;

    const { group, idx } = entry;
    group.teams.splice(idx, 1);
    saveGuildStore(interaction.guildId, store);

    const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
    for (const userId of targets) {
      const member = interaction.guild.members.cache.get(userId)
        ?? await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (isStillRegisteredElsewhere(tournament, userId, team)) continue;
      if (group.roleId) {
        await member.roles.remove(group.roleId).catch(() => {});
        await logRoleChange(interaction.guild, tournament, { member, roleId: group.roleId, added: false, reason: `removed from Round ${roundNum} — team "${team.team}"` });
      }
      if (roundNum === 1) await removeRegisteredRole(interaction.guild, tournament, member, `removed from Round ${roundNum} — team "${team.team}"`);
    }
  }
}

// Public team registration, step 3 — "Confirm Registration" pressed on the
// review screen. This is where the team actually gets a slot and the
// success role is handed out.
async function handleTourneyRegConfirm(interaction) {
  const pendingEntry = getRegPending(interaction.user.id);
  if (!pendingEntry || !pendingEntry.data.team) {
    return interaction.update({ content: `❌ Your session expired or was interrupted. ${RESTART_HINT}`, embeds: [], components: [] });
  }

  const { team, ownerName, whatsapp, playerIgns, playerUids, selectedPlayerIds = [], tournamentId } = pendingEntry.data;
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tournamentId];

  if (!tournament) {
    clearRegPending(interaction.user.id);
    return interaction.update({ content: '❌ This tournament no longer exists.', embeds: [], components: [] });
  }
  const confirmRoleBlock = registerRoleBlock(interaction, tournament);
  if (confirmRoleBlock) {
    clearRegPending(interaction.user.id);
    return interaction.update({ content: confirmRoleBlock, embeds: [], components: [], allowedMentions: { parse: [] } });
  }
  if (!tournament.open && !canBypassRegistration(interaction)) {
    clearRegPending(interaction.user.id);
    const content = tournament.closedReason === 'full'
      ? '🔒 Registration is closed — all slots are full.'
      : '❌ Registration is currently closed.';
    return interaction.update({ content, embeds: [], components: [] });
  }
  if (isBanned(tournament, team) || isDuplicateTeam(tournament, team)) {
    clearRegPending(interaction.user.id);
    return interaction.update({ content: `❌ **${team}** can no longer be registered. ${RESTART_HINT}`, embeds: [], components: [] });
  }

  // Belt-and-suspenders: re-check for a lineup conflict here too, in case
  // another team grabbed one of these players in the gap between the
  // player-select step and this confirm tap.
  const conflict = tournament.allowFakeTag ? null : findTournamentLineupConflict(tournament, selectedPlayerIds);
  if (conflict) {
    clearRegPending(interaction.user.id);
    return interaction.update({
      content: `❌ <@${conflict.conflictId}> just got locked into **${conflict.team}** by someone else. ${RESTART_HINT}`,
      embeds: [],
      components: [],
    });
  }

  const letter = autoAssignGroup(tournament);

  if (!letter) {
    // Someone else's registration filled the last slot in the moments
    // between this player opening the form and hitting Confirm — make sure
    // the tournament is marked closed too, not just this one submission.
    if (tournament.open) {
      tournament.open = false;
      tournament.closedReason = 'full';
      saveGuildStore(interaction.guildId, store);
      await refreshRegisterPanel(interaction.guild, tournament);
    }
    clearRegPending(interaction.user.id);
    return interaction.update({ content: '🔒 Registration is closed — all slots are full.', embeds: [], components: [] });
  }

  const teamRecord = {
    team,
    playerIds: selectedPlayerIds,
    players: selectedPlayerIds.map(id => `<@${id}>`),
    ownerId: interaction.user.id,
    ownerName,
    whatsapp,
    playerIgns,
    playerUids,
  };
  tournament.groups[letter].teams.push(teamRecord);

  // This team just took the last open slot — close registration
  // automatically so the next player to click Register Team sees a clear
  // "full" message immediately instead of filling out the whole form
  // first and getting rejected at the end.
  let justClosed = false;
  if (isRegistrationFull(tournament)) {
    tournament.open = false;
    tournament.closedReason = 'full';
    justClosed = true;
  }

  saveGuildStore(interaction.guildId, store);
  clearRegPending(interaction.user.id);


  // Registration gives the team owner the tournament's "<name> Registered"
  // role — NOT a group role. The group role (the one that shows a group's
  // channel) is handed out when an admin runs Create Channels → Auto Channels,
  // which gives it to every registered owner in each group it makes a channel
  // for. A team that registers into a group whose channel is already up gets
  // that group's role right away as well, since there's a channel to see.
  //
  // Only the player who actually submitted the registration (the "team
  // owner") gets roles — teammates mentioned in the form are on the roster
  // but didn't run Register Team.
  let roleWarning = null;
  const owner = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  const registeredRole = await ensureTournamentRegisteredRole(interaction, store, tournament).catch(() => null);
  if (registeredRole) {
    if (owner) {
      await owner.roles.add(registeredRole.id).then(() => {
        logRoleChange(interaction.guild, tournament, { member: owner, roleId: registeredRole.id, added: true, reason: 'registered a team' });
      }).catch(err => {
        console.error(`[tournament-registered-role] Failed to add role ${registeredRole.id} to ${interaction.user.id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
        roleWarning = `\n\n⚠️ Couldn't give you the registered role — ask an admin to check my **Manage Roles** permission and that my role sits above <@&${registeredRole.id}>.`;
      });
    } else {
      roleWarning = `\n\n⚠️ Couldn't give you the registered role — ask an admin to check my **Manage Roles** permission and that my role sits above <@&${registeredRole.id}>.`;
    }
  } else {
    console.warn(`[tournament-registered-role] Couldn't create/find the registered role in guild ${interaction.guildId} — check my Manage Roles permission.`);
  }

  const registeredGroup = tournament.groups[letter];
  if (registeredGroup.channelId && interaction.guild.channels.cache.has(registeredGroup.channelId)) {
    const groupRole = await ensureGroupRole(
      interaction, store, registeredGroup,
      applyRoundNameFormat(getRoundNaming(tournament, 1).roleFormat, { roundNum: 1, groupKey: letter, separator: ' ' }),
      `Auto-created for Group ${letter} tournament registration`,
    ).catch(() => null);
    if (groupRole && owner) {
      await owner.roles.add(groupRole.id).then(() => {
        logRoleChange(interaction.guild, tournament, { member: owner, roleId: groupRole.id, added: true, reason: `registered into Group ${letter} (channel already existed)` });
      }).catch(err => {
        console.error(`[tournament-group-role] Failed to add role ${groupRole.id} to ${interaction.user.id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
        roleWarning = (roleWarning || '') + `\n\n⚠️ Couldn't give you the Group ${letter} role — ask an admin to check my **Manage Roles** permission and that my role sits above <@&${groupRole.id}>.`;
      });
    }
  }

  if (tournament.confirmChannelId) {
    const confirmChannel = interaction.guild.channels.cache.get(tournament.confirmChannelId);
    if (confirmChannel) {
      // Confirmation embed — tournament, team name, the owner (tagged) and
      // the teammates they picked (tagged). Group, slot and IGNs are left
      // out of the public confirm channel (still saved + in the Excel
      // export). Mentions inside an embed don't notify anyone, so the same
      // tags are also put in the message content, which does ping them.
      const teammateIds = selectedPlayerIds.filter(id => id !== interaction.user.id);
      const confirmEmbed = new EmbedBuilder()
        .setTitle('<:1554185476272037989:1554190060537118860> Team Registered')
        .setColor(0x57F287)
        .setDescription(`<a:1554185482403848263:1554190063770931210> Registered for **${tournament.name || 'the tournament'}**`)
        .addFields(
          { name: '🏷️ Team Name', value: team },
          { name: '<a:1070235112987426826:1554190081755971595> Owner', value: `<@${interaction.user.id}>` },
        );
      if (teammateIds.length) {
        confirmEmbed.addFields({ name: '<:1554185494667989003:1554190047803084860> Players', value: teammateIds.map(id => `<@${id}>`).join('\n') });
      }
      // Image shown in the top-right of the embed. The file sits next to
      // this script and is uploaded with the message; if it's missing the
      // embed is simply sent without it.
      const confirmFiles = [];
      const confirmImagePath = require('path').join(__dirname, 'tn-registration-image.jpg');
      if (require('fs').existsSync(confirmImagePath)) {
        confirmFiles.push(new AttachmentBuilder(confirmImagePath, { name: 'registration-image.jpg' }));
        confirmEmbed.setThumbnail('attachment://registration-image.jpg');
      }
      const pingIds = [interaction.user.id, ...teammateIds];
      const confirmMessage = await confirmChannel.send({
        content: pingIds.map(id => `<@${id}>`).join(' '),
        embeds: [confirmEmbed],
        files: confirmFiles,
        allowedMentions: { users: pingIds },
      }).catch(() => null);
      if (confirmMessage) {
        // Remembered so the Excel exports can include a "Jump URL" straight
        // to this team's registration message.
        teamRecord.confirmMessageUrl = confirmMessage.url;
        saveGuildStore(interaction.guildId, store);
      }
      if (justClosed) {
        await confirmChannel.send(`🔒 Registration for **${tournament.name}** is now closed — all slots are full.`).catch(() => {});
      }
    }
  }

  // Reflect the new slot count (and closed status, if this was the last
  // one) on the public panel right away rather than waiting for someone
  // to re-post it.
  await refreshRegisterPanel(interaction.guild, tournament);

  return interaction.update({
    content: null,
    embeds: [
      new EmbedBuilder()
        .setTitle('🎯 Registration Complete!')
        .setColor(0x57F287)
        .setDescription(
          `**Team** — ${team}\n` +
          (formatTeamDetailLines({ ownerName, whatsapp, playerIgns, playerUids }) ? `${formatTeamDetailLines({ ownerName, whatsapp, playerIgns, playerUids })}\n` : '') +
          (selectedPlayerIds.length ? `**Discord Tags** — ${selectedPlayerIds.map(id => `<@${id}>`).join(' ')}\n` : '') +
          (roleWarning || '')
        ),
    ],
    components: [],
  });

}

// "Cancel" pressed on the review screen.
async function handleTourneyRegCancel(interaction) {
  clearRegPending(interaction.user.id);
  return interaction.update({
    content: `❌ Registration cancelled — nothing was saved. ${RESTART_HINT}`,
    embeds: [],
    components: [],
  });
}

async function handleRequiredMentionsModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    return interaction.reply({ content: '❌ Required Mentions must be a whole number between 0 and 4.', flags: MessageFlags.Ephemeral });
  }
  store.tournament.requiredMentions = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleTeamsPerGroupModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_GROUP_CAPACITY) {
    return interaction.reply({ content: `❌ Teams per Group must be a whole number between 1 and ${MAX_GROUP_CAPACITY}.`, flags: MessageFlags.Ephemeral });
  }
  store.tournament.teamsPerGroup = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleTotalSlotsModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TOTAL_SLOTS) {
    return interaction.reply({ content: `❌ Total Slots must be a whole number between 1 and ${MAX_TOTAL_SLOTS}.`, flags: MessageFlags.Ephemeral });
  }
  store.tournament.totalSlots = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleCreateSwapChannelSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }
  store.tournament.swapChannelId = interaction.channels.first().id;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleCreateLogChannelSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }
  store.tournament.logChannelId = interaction.channels.first().id;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleCreateRegisterRoleSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }
  const role = interaction.roles.first();
  // @everyone would make the requirement meaningless, and managed (bot /
  // integration) roles can't be held by players.
  if (!role || role.id === interaction.guildId || role.managed) {
    return interaction.update({ content: '❌ Pick a normal server role (not @everyone or a bot role).', embeds: [], components: [] });
  }
  store.tournament.registerRoleId = role.id;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
  await refreshRegisterPanel(interaction.guild, store.tournament);
}

async function handleCreateConfirmRoleSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }
  const role = interaction.roles.first();
  if (!role || role.id === interaction.guildId || role.managed) {
    return interaction.update({ content: '❌ Pick a normal server role (not @everyone or a bot role).', embeds: [], components: [] });
  }
  const botTop = interaction.guild.members.me.roles.highest;
  if (role.position >= botTop.position) {
    return interaction.update({ content: `❌ I can't hand out <@&${role.id}> — move my bot role above it in Server Settings → Roles, then pick it again.`, embeds: [], components: [] });
  }
  store.tournament.confirmRoleId = role.id;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

async function handleCreateConfirmChannelSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }
  store.tournament.confirmChannelId = interaction.channels.first().id;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildCreateSettingsPayload(store.tournament) });
}

// Category picker behind the "Create Channel" panel's Category button —
// admin picks an existing category directly; Auto Channels then fills it.
async function handleManualChannelsCategorySelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const category = interaction.channels.first();
  const data = setPendingChannelCreation(interaction.guildId, interaction.user.id, {
    categoryId: category.id,
    categoryName: category.name,
  });
  return interaction.update({ content: '', ...buildManualChannelCreationPayload(data) });
}

// ---------------------------------------------------------------------------
// Manage Rounds — set how many rounds the tournament chains through
// (Max Rounds), and configure every round 1..maxRounds: Channel Name, Role
// Name and Category Name (plus group size for Round 2+; Round 1's size is
// the tournament's own Teams-per-Group setting). Round 2+ groups are
// created lazily the first time a team is promoted into them (each gets
// its own auto-created role, same as Round 1's groups — there's no single
// shared "round role" to set).
// ---------------------------------------------------------------------------
function getRound(tournament, roundNum) {
  if (!tournament.rounds) tournament.rounds = {};
  if (!tournament.rounds[roundNum]) {
    tournament.rounds[roundNum] = { groupSize: DEFAULT_GROUP_CAPACITY, groups: {}, categoryId: null };
  }
  return tournament.rounds[roundNum];
}

// tournament.groups IS round 1 — this just picks the right container so
// the rest of the round-aware code can treat every round the same way.
function getRoundGroups(tournament, roundNum) {
  if (roundNum <= 1) return tournament.groups;
  const groups = getRound(tournament, roundNum).groups;
  // Stamp each Round 2+ group with its round number so slots.js knows a
  // promoted team's old Round 1 locked slot doesn't apply here.
  for (const g of Object.values(groups)) if (g && g.round !== roundNum) g.round = roundNum;
  return groups;
}

// ---- Per-round naming (Channel / Role / Category) -----------------------
// Every round 1..MAX_ROUND can carry its own channelFormat / roleFormat /
// categoryName under tournament.rounds[n]. Unset fields fall back to the
// defaults below (Round 2+ defaults match the names the bot always used, so
// existing tournaments are unaffected). Tokens: {round} = round number,
// {number} / {letter} = the group's number (groups are keyed 1, 2, 3...).
const ROUND_NAMING_FIELDS = {
  channel:  { key: 'channelFormat', title: 'Channel Name',  label: 'Channel name (empty = reset to default)',  maxLength: 80 },
  role:     { key: 'roleFormat',    title: 'Role Name',     label: 'Role name (empty = reset to default)',     maxLength: 80 },
  category: { key: 'categoryName',  title: 'Category Name', label: 'Category name (empty = reset to default)', maxLength: 100 },
  // Display name only — shown in the Manage Rounds picker and round settings
  // title. It never renames channels/roles/categories on its own.
  name:     { key: 'displayName',   title: 'Display Name',  label: 'Round name (empty = reset to default)',     maxLength: 50 },
};

function defaultRoundNaming(roundNum) {
  if (roundNum <= 1) {
    // Round 1's channel + category are normally chosen in Create Channel,
    // so they have no built-in default — only the role does.
    return { channelFormat: null, roleFormat: 'Tournament Group {letter}', categoryName: null };
  }
  return {
    channelFormat: 'round{round}-group-{number}',
    roleFormat: 'Round {round} - Group {number}',
    categoryName: '🏆 Round {round} Groups',
  };
}

function getRoundNaming(tournament, roundNum) {
  const saved = (tournament.rounds && tournament.rounds[roundNum]) || {};
  const defaults = defaultRoundNaming(roundNum);
  return {
    channelFormat: saved.channelFormat || defaults.channelFormat,
    roleFormat: saved.roleFormat || defaults.roleFormat,
    categoryName: saved.categoryName || defaults.categoryName,
    isCustom: {
      channel: Boolean(saved.channelFormat),
      role: Boolean(saved.roleFormat),
      category: Boolean(saved.categoryName),
    },
  };
}

// Fills {round}/{number}/{letter}. If the format has neither {number} nor
// {letter}, the group key is appended (with `separator`) so every group's
// name stays unique.
function applyRoundNameFormat(format, { roundNum, groupKey, separator }) {
  const hasGroupToken = /\{(letter|number)\}/i.test(format);
  let out = format.replace(/\{round\}/gi, String(roundNum)).replace(/\{(letter|number)\}/gi, String(groupKey));
  if (!hasGroupToken) out = `${out}${separator}${groupKey}`;
  return out;
}

function resolveRoundCategoryName(format, roundNum) {
  return format.replace(/\{round\}/gi, String(roundNum)).slice(0, 100);
}

// What a round is called in the Manage Rounds screens. Priority: the Round
// Name set for it -> its custom Category Name (if one was set) -> "Round N".
function getRoundDisplayName(tournament, roundNum) {
  const saved = (tournament.rounds && tournament.rounds[roundNum]) || {};
  const custom = (saved.displayName || '').trim();
  if (custom) return { name: custom.slice(0, 100), source: 'name' };
  if (saved.categoryName) {
    const fromCategory = resolveRoundCategoryName(saved.categoryName, roundNum).trim();
    if (fromCategory) return { name: fromCategory, source: 'category' };
  }
  return { name: `Round ${roundNum}`, source: 'default' };
}

function buildRoundListPayload(tournament) {
  const maxRounds = getMaxRounds(tournament);
  const options = [];
  for (let n = 1; n <= maxRounds; n++) {
    if (n === 1) {
      const registered = Object.values(tournament.groups || {}).reduce((sum, g) => sum + g.teams.length, 0);
      const r1 = getRoundDisplayName(tournament, 1);
      options.push({
        label: r1.name,
        description: `${r1.source === 'default' ? '' : 'Round 1 · '}${tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY} per group · ${registered} team${registered === 1 ? '' : 's'} registered`,
        value: '1',
      });
      continue;
    }
    const round = tournament.rounds && tournament.rounds[n];
    const teamCount = round ? Object.values(round.groups || {}).reduce((sum, g) => sum + g.teams.length, 0) : 0;
    const rn = getRoundDisplayName(tournament, n);
    options.push({
      label: rn.name,
      description: `${rn.source === 'default' ? '' : `Round ${n} · `}${round?.groupSize || DEFAULT_GROUP_CAPACITY} per group · ${teamCount} team${teamCount === 1 ? '' : 's'} promoted`,
      value: String(n),
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🏆 Manage Rounds')
    .setColor(0x5865F2)
    .addFields({ name: 'Max Rounds', value: String(maxRounds) })
    .setDescription(
      `Rounds chain off each other up to Max Rounds (currently **${maxRounds}**, up to ${MAX_ROUND} max) — clicking **Result** in a group's channel promotes its picked teams into the next round, filling that round's groups in order, until Max Rounds is reached. ` +
      'Pick a round below to set its **Round Name**, **Channel Name**, **Role Name** and **Category Name** (and group size for Round 2+). Anything you skip uses a sensible default.'
    );

  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_round_config_maxrounds').setLabel('Set Max Rounds').setEmoji('🔢').setStyle(ButtonStyle.Primary),
  )];

  const select = new StringSelectMenuBuilder()
    .setCustomId('tourney_round_config_select')
    .setPlaceholder('Pick a round to configure')
    .addOptions(options);
  components.push(new ActionRowBuilder().addComponents(select));

  return { embeds: [embed], components };
}

function buildRoundDetailPayload(tournament, roundNum) {
  const naming = getRoundNaming(tournament, roundNum);
  const show = (value, isCustom) => {
    if (!value) return '`Not set`';
    return `\`${value}\`${isCustom ? '' : ' (default)'}`;
  };
  const groupSize = roundNum <= 1
    ? `${tournament.teamsPerGroup || DEFAULT_GROUP_CAPACITY} (set in Edit Settings → Teams per Group)`
    : String(getRound(tournament, roundNum).groupSize || DEFAULT_GROUP_CAPACITY);

  const display = getRoundDisplayName(tournament, roundNum);
  // An explicitly-picked category (via the Select Category button) wins over
  // the Category Name template in both the embed and at channel-creation time
  // — see ensureRoundGroupChannelAndRole. Only rounds 2+ carry a persistent
  // round.categoryId; Round 1's category still comes from the Create Channel panel.
  const pickedCategoryId = roundNum >= 2 ? getRound(tournament, roundNum).categoryId : null;
  const categoryFieldValue = pickedCategoryId
    ? `<#${pickedCategoryId}> (picked)`
    : show(naming.categoryName, naming.isCustom.category);

  const embed = new EmbedBuilder()
    .setTitle(display.source === 'default' ? `🏆 Round ${roundNum} Settings` : `🏆 ${display.name} (Round ${roundNum}) Settings`.slice(0, 256))
    .setColor(0x5865F2)
    .setDescription(
      'Tokens: `{round}` = round number, `{number}` = group number (1, 2, 3...). ' +
      'Changes apply to channels and roles created **from now on** — ones that already exist keep their names ' +
      '(except the category, which is renamed if it already exists). Submit an empty box to reset a field. ' +
      (roundNum >= 2 ? 'Use **Select Category** to pin this round to an existing category directly — it overrides Category Name.' : '')
    )
    .addFields(
      { name: 'Round Name', value: display.source === 'name' ? `\`${display.name}\`` : `\`${display.name}\` (${display.source === 'category' ? 'from Category Name' : 'default'})` },
      { name: 'Group Size', value: groupSize },
      { name: 'Channel Name', value: show(naming.channelFormat, naming.isCustom.channel) },
      { name: 'Role Name', value: show(naming.roleFormat, naming.isCustom.role) },
      { name: 'Category', value: categoryFieldValue },
    );

  const namingRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_round_config_naming:name:${roundNum}`).setLabel('Round Name').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tourney_round_config_naming:channel:${roundNum}`).setLabel('Channel Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tourney_round_config_naming:role:${roundNum}`).setLabel('Role Name').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tourney_round_config_naming:category:${roundNum}`).setLabel('Category Name').setStyle(ButtonStyle.Primary),
  );

  const navRow = new ActionRowBuilder();
  if (roundNum >= 2) {
    navRow.addComponents(new ButtonBuilder().setCustomId(`tourney_round_config_size:${roundNum}`).setLabel('Set Group Size').setStyle(ButtonStyle.Secondary));
    navRow.addComponents(new ButtonBuilder().setCustomId(`tourney_round_config_pick_category:${roundNum}`).setLabel('Select Category').setEmoji('📁').setStyle(ButtonStyle.Primary));
    if (pickedCategoryId) {
      navRow.addComponents(new ButtonBuilder().setCustomId(`tourney_round_config_clear_category:${roundNum}`).setLabel('Clear Category').setStyle(ButtonStyle.Danger));
    }
  }
  navRow.addComponents(new ButtonBuilder().setCustomId('tourney_round_config_back').setLabel('Back').setStyle(ButtonStyle.Secondary));

  return { embeds: [embed], components: [namingRow, navRow] };
}

function buildRoundNamingModal(tournament, roundNum, field) {
  const meta = ROUND_NAMING_FIELDS[field];
  const saved = (tournament.rounds && tournament.rounds[roundNum]) || {};
  const defaults = defaultRoundNaming(roundNum);
  const fallbackPlaceholders = { channel: 'Group {number}', role: 'Tournament Group {letter}', category: '🥇 Tournament Groups', name: 'e.g. Semi Finals' };

  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(meta.label)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(meta.maxLength)
    .setPlaceholder((defaults[meta.key] || fallbackPlaceholders[field]).slice(0, 100));
  if (saved[meta.key]) input.setValue(saved[meta.key]);

  return new ModalBuilder()
    .setCustomId(`tourney_round_naming_modal:${field}:${roundNum}`)
    .setTitle(`Round ${roundNum} ${meta.title}`)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildRoundSizeModal(round, roundNum) {
  const input = new TextInputBuilder().setCustomId('value').setLabel(`Round ${roundNum} Group Size`).setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(4).setPlaceholder('e.g. 12');
  input.setValue(String(round.groupSize || DEFAULT_GROUP_CAPACITY));
  return new ModalBuilder().setCustomId(`tourney_round_size_modal:${roundNum}`).setTitle(`Round ${roundNum} Group Size`)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildMaxRoundsModal(tournament) {
  const input = new TextInputBuilder().setCustomId('value').setLabel(`Max Rounds (1-${MAX_ROUND})`).setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(2).setPlaceholder('e.g. 3');
  input.setValue(String(getMaxRounds(tournament)));
  return new ModalBuilder().setCustomId('tourney_round_maxrounds_modal').setTitle('Set Max Rounds')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function handleRoundConfigSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }
  const roundNum = parseInt(interaction.values[0], 10);
  if (!Number.isInteger(roundNum) || roundNum < 1 || roundNum > MAX_ROUND) {
    return interaction.reply({ content: '❌ Unknown round.', flags: MessageFlags.Ephemeral });
  }
  await interaction.update({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
}

// Dispatches the buttons under Manage Rounds — Set Max Rounds (modal),
// Channel / Role / Category Name for a specific round (modal), Set Group
// Size for a specific round (modal), and Back to the round list.
async function handleRoundConfigButton(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const { customId } = interaction;

  if (customId === 'tourney_round_config_maxrounds') {
    return interaction.showModal(buildMaxRoundsModal(store.tournament));
  }

  if (customId.startsWith('tourney_round_config_naming:')) {
    const [, field, roundNumStr] = customId.split(':');
    const roundNum = parseInt(roundNumStr, 10);
    if (!ROUND_NAMING_FIELDS[field] || !Number.isInteger(roundNum) || roundNum < 1 || roundNum > MAX_ROUND) {
      return interaction.reply({ content: '❌ Unknown round setting.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildRoundNamingModal(store.tournament, roundNum, field));
  }

  if (customId.startsWith('tourney_round_config_size:')) {
    const [, roundNumStr] = customId.split(':');
    const roundNum = parseInt(roundNumStr, 10);
    return interaction.showModal(buildRoundSizeModal(getRound(store.tournament, roundNum), roundNum));
  }

  if (customId.startsWith('tourney_round_config_pick_category:')) {
    const [, roundNumStr] = customId.split(':');
    const roundNum = parseInt(roundNumStr, 10);
    if (!Number.isInteger(roundNum) || roundNum < 2 || roundNum > MAX_ROUND) {
      return interaction.reply({ content: '❌ Unknown round.', flags: MessageFlags.Ephemeral });
    }
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`tourney_round_category_select:${roundNum}`)
      .setPlaceholder('Choose the category')
      .addChannelTypes(ChannelType.GuildCategory);
    const back = new ButtonBuilder().setCustomId(`tourney_round_config_category_back:${roundNum}`).setLabel('Back').setStyle(ButtonStyle.Secondary);
    return interaction.update({
      content: `Pick the category Round ${roundNum}'s group channels should go under:`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(back)],
    });
  }

  if (customId.startsWith('tourney_round_config_clear_category:')) {
    const [, roundNumStr] = customId.split(':');
    const roundNum = parseInt(roundNumStr, 10);
    if (!Number.isInteger(roundNum) || roundNum < 2 || roundNum > MAX_ROUND) {
      return interaction.reply({ content: '❌ Unknown round.', flags: MessageFlags.Ephemeral });
    }
    getRound(store.tournament, roundNum).categoryId = null;
    saveGuildStore(interaction.guildId, store);
    return interaction.update({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
  }

  if (customId.startsWith('tourney_round_config_category_back:')) {
    const [, roundNumStr] = customId.split(':');
    const roundNum = parseInt(roundNumStr, 10);
    return interaction.update({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
  }

  if (customId === 'tourney_round_config_back') {
    return interaction.update({ content: '', ...buildRoundListPayload(store.tournament) });
  }
}

// Category picker behind Manage Rounds' "Select Category" button — admin
// picks an existing category directly for a Round 2+, same UX as the Create
// Channel panel's Category button for Round 1. Persists straight to
// round.categoryId, which ensureRoundGroupChannelAndRole already prefers
// over the Category Name template when it creates that round's channels.
async function handleRoundCategorySelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const [, roundNumStr] = interaction.customId.split(':');
  const roundNum = parseInt(roundNumStr, 10);
  if (!Number.isInteger(roundNum) || roundNum < 2 || roundNum > MAX_ROUND) {
    return interaction.reply({ content: '❌ Unknown round.', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }
  const category = interaction.channels.first();
  getRound(store.tournament, roundNum).categoryId = category.id;
  saveGuildStore(interaction.guildId, store);
  return interaction.update({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
}

async function handleRoundNamingModalSubmit(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const [, field, roundNumStr] = interaction.customId.split(':');
  const roundNum = parseInt(roundNumStr, 10);
  const meta = ROUND_NAMING_FIELDS[field];
  if (!meta || !Number.isInteger(roundNum) || roundNum < 1 || roundNum > MAX_ROUND) {
    return interaction.reply({ content: '❌ Unknown round setting.', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  // Renaming an existing category can be slow (Discord rate-limits channel
  // renames), so acknowledge first and edit the panel once it's done.
  await interaction.deferUpdate();

  const value = interaction.fields.getTextInputValue('value').trim();
  const round = getRound(store.tournament, roundNum);
  if (value) round[meta.key] = value;
  else delete round[meta.key];
  saveGuildStore(interaction.guildId, store);

  // The category is the one thing that's already a single shared object per
  // round, so keep it in sync if it exists. Channels/roles already created
  // are left alone.
  if (field === 'category' && roundNum >= 2 && round.categoryId) {
    const category = interaction.guild.channels.cache.get(round.categoryId);
    if (category) {
      const newName = resolveRoundCategoryName(getRoundNaming(store.tournament, roundNum).categoryName, roundNum);
      if (category.name !== newName) {
        await category.setName(newName, `Round ${roundNum} category renamed via Manage Rounds`).catch(() => {});
      }
    }
  }

  await interaction.editReply({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
}

async function handleRoundSizeModalSubmit(interaction) {
  const [, roundNumStr] = interaction.customId.split(':');
  const roundNum = parseInt(roundNumStr, 10);
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_GROUP_CAPACITY) {
    return interaction.reply({ content: `❌ Group Size must be a whole number between 1 and ${MAX_GROUP_CAPACITY}.`, flags: MessageFlags.Ephemeral });
  }
  getRound(store.tournament, roundNum).groupSize = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildRoundDetailPayload(store.tournament, roundNum) });
}

async function handleMaxRoundsModalSubmit(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  const value = parseInt(interaction.fields.getTextInputValue('value').trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ROUND) {
    return interaction.reply({ content: `❌ Max Rounds must be a whole number between 1 and ${MAX_ROUND}.`, flags: MessageFlags.Ephemeral });
  }
  store.tournament.maxRounds = value;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: '', ...buildRoundListPayload(store.tournament) });
}

// "Create Channel" (manual) — Channel Format / Category Name modal
// submissions. Both just save into the in-memory pending state (see
// pendingManualChannelCreation below) and re-render the panel; actual
// creation happens on the "Create Channels" button once both are set.
async function handleManualChannelsFormatModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const value = interaction.fields.getTextInputValue('value').trim();
  if (!value) {
    return interaction.reply({ content: '❌ Channel format can\'t be empty.', flags: MessageFlags.Ephemeral });
  }
  const data = setPendingChannelCreation(interaction.guildId, interaction.user.id, { channelFormat: value });
  return interaction.update({ ...buildManualChannelCreationPayload(data) });
}

async function handleManualChannelsRoleNameModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const value = interaction.fields.getTextInputValue('value').trim();
  if (!value) {
    return interaction.reply({ content: '❌ Role name can\'t be empty.', flags: MessageFlags.Ephemeral });
  }
  const data = setPendingChannelCreation(interaction.guildId, interaction.user.id, { roleFormat: value });
  return interaction.update({ ...buildManualChannelCreationPayload(data) });
}


async function handleEditSettingsModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const name = interaction.fields.getTextInputValue('name').trim();
  if (!name) {
    return interaction.reply({ content: '❌ Name is required.', flags: MessageFlags.Ephemeral });
  }

  store.tournament.name = name;
  saveGuildStore(interaction.guildId, store);

  const payload = buildTournamentWizardPayload(store);
  await interaction.update(payload);
}

// Toggling the same team name again flips it back — ban if not banned,
// unban if already banned. Banning also evicts them from whatever group
// they're currently sitting in, since a banned team shouldn't keep a slot.
async function handleBanUnbanModalSubmit(interaction) {
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const teamRaw = interaction.fields.getTextInputValue('team').trim();
  if (!teamRaw) {
    return interaction.reply({ content: '❌ Team name is required.', flags: MessageFlags.Ephemeral });
  }
  const teamKey = teamRaw.toLowerCase();

  if (!tournament.bannedTeams) tournament.bannedTeams = [];
  const idx = tournament.bannedTeams.indexOf(teamKey);

  if (idx === -1) {
    tournament.bannedTeams.push(teamKey);
    let removedFrom = null;
    for (const [letter, group] of Object.entries(tournament.groups)) {
      const before = group.teams.length;
      group.teams = group.teams.filter(t => t.team.toLowerCase() !== teamKey);
      if (group.teams.length !== before) removedFrom = letter;
    }
    tournament.qualified = tournament.qualified.filter(name => name.toLowerCase() !== teamKey);
    saveGuildStore(interaction.guildId, store);
    return interaction.reply({
      content: `🔨 **${teamRaw}** is now banned from registering.${removedFrom ? ` Removed from Group ${removedFrom}.` : ''}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  tournament.bannedTeams.splice(idx, 1);
  saveGuildStore(interaction.guildId, store);
  return interaction.reply({ content: `✅ **${teamRaw}** has been unbanned and can register again.`, flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// Timed team ban — select a registered team, set how many days, and every
// player on that team gets a dedicated "<Tournament Name> Ban" role and is
// pulled out of their group. The role comes off automatically once the
// timer's up (see processExpiredBans, run on an interval from index.js).
//
// The ban record lives in store.timedBans (guild-level, see storage.js)
// rather than on the tournament object, specifically so that deleting the
// tournament early doesn't cut the ban short — see the delete-tournament
// handler above, which leaves the role and the record alone whenever an
// active ban still references it.
// ---------------------------------------------------------------------------

// Gets this tournament's ban role, creating it the first time it's needed.
// Reused across every timed ban for this tournament, so banning several
// teams (now or later) never creates duplicate roles.
async function getOrCreateBanRole(interaction, tournament) {
  if (tournament.banRoleId) {
    const existing = interaction.guild.roles.cache.get(tournament.banRoleId)
      ?? await interaction.guild.roles.fetch(tournament.banRoleId).catch(() => null);
    if (existing) return existing;
  }
  const role = await interaction.guild.roles.create({
    name: `${tournament.name} Ban`.slice(0, 100),
    color: 0x2C2F33,
    mentionable: false,
    reason: `Timed-ban role for tournament "${tournament.name}"`,
  }).catch(() => null);
  if (!role) return null;
  tournament.banRoleId = role.id;
  return role;
}

// Menu shown by the top-level "Ban/Unban" button — routes into the new
// timed-ban flow, early-unban, or the old name-only ban (for blocking a
// team name that hasn't even registered yet, which has no role/timer).
function buildBanUnbanMenuPayload(store, tournament) {
  const activeBans = (store.timedBans || []).filter(b => b.tournamentId === tournament.id);

  const embed = new EmbedBuilder()
    .setTitle('🔨 Ban / Unban')
    .setColor(0xED4245)
    .setDescription([
      '**Ban Team** — type the exact team name and how many days. Every player on that team gets this tournament\'s ban role and is removed from their group; the role is removed automatically once the days are up — even if this tournament is deleted first, they still serve the full ban.',
      '**Unban Team** — lift an active timed ban early.',
      '**Ban/Unban by Name** — block or unblock a team name from registering. No role or timer; for keeping a name out before it ever registers.',
    ].join('\n'));

  if (activeBans.length) {
    embed.addFields({ name: 'Currently Timed-Banned', value: String(activeBans.length), inline: true });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_ban_start').setLabel('Ban Team').setEmoji('🔨').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tourney_wizard_unban_pick').setLabel('Unban Team').setEmoji('🔓').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tourney_wizard_ban_modal_legacy').setLabel('Ban/Unban by Name').setEmoji('📝').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// "Ban Team" — admin types the exact team name plus a number of days,
// rather than picking from a select (a tournament can have thousands of
// teams, and typing is faster than hunting through group pickers anyway).
function buildTimedBanModal() {
  const modal = new ModalBuilder().setCustomId('tourney_ban_name_modal').setTitle('Ban Team');
  const teamInput = new TextInputBuilder()
    .setCustomId('team').setLabel('Team name').setStyle(TextInputStyle.Short)
    .setPlaceholder('Exact team name').setRequired(true).setMaxLength(100);
  const daysInput = new TextInputBuilder()
    .setCustomId('days').setLabel('Ban duration (in days)').setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 7').setRequired(true).setMaxLength(5);
  modal.addComponents(
    new ActionRowBuilder().addComponents(teamInput),
    new ActionRowBuilder().addComponents(daysInput),
  );
  return modal;
}

// Finds a registered team by exact name (case-insensitive) across every
// Round 1 group — same scope the legacy name-ban and Cancel Slots use.
function findTeamByName(tournament, teamName) {
  const key = teamName.toLowerCase();
  for (const letter of Object.keys(tournament.groups)) {
    const group = tournament.groups[letter];
    const team = group.teams.find(t => t.team.toLowerCase() === key);
    if (team) return { letter, group, team };
  }
  return null;
}

// Applies the ban: strips the team from their group (and any later round
// they'd been promoted into), hands the tournament's ban role to every
// player, blocks the team name from re-registering for the tournament,
// and records a guild-level timed-ban entry so the role gets removed
// automatically once the duration elapses.
async function handleTimedBanModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }

  const teamRaw = interaction.fields.getTextInputValue('team').trim();
  if (!teamRaw) {
    return interaction.reply({ content: '❌ Team name is required.', flags: MessageFlags.Ephemeral });
  }

  const daysRaw = interaction.fields.getTextInputValue('days').trim();
  const days = parseFloat(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    return interaction.reply({ content: '❌ Enter a valid number of days (e.g. 7).', flags: MessageFlags.Ephemeral });
  }

  const found = findTeamByName(tournament, teamRaw);
  if (!found) {
    return interaction.reply({ content: `❌ No registered team named **${teamRaw}** was found. Check the spelling — it has to match exactly.`, flags: MessageFlags.Ephemeral });
  }
  const { letter, group, team } = found;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const banRole = await getOrCreateBanRole(interaction, tournament);
  if (!banRole) {
    return interaction.editReply({ content: "❌ Couldn't create the ban role — check my **Manage Roles** permission." });
  }

  if (!tournament.bannedTeams) tournament.bannedTeams = [];
  if (!store.timedBans) store.timedBans = [];
  if (!tournament.bannedTeams.includes(team.team.toLowerCase())) {
    tournament.bannedTeams.push(team.team.toLowerCase());
  }

  await removeTeamFromRoundOnward(interaction, store, tournament, team, 2);

  const groupRoleId = group.roleId;
  const targets = [...new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean))];
  const stillRegistered = [];
  for (const userId of targets) {
    const member = interaction.guild.members.cache.get(userId)
      ?? await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    if (!isStillRegisteredElsewhere(tournament, userId, team)) {
      if (groupRoleId) {
        await member.roles.remove(groupRoleId).catch(() => {});
        await logRoleChange(interaction.guild, tournament, { member, roleId: groupRoleId, added: false, reason: `banned team "${team.team}" — by ${interaction.user.tag}` });
      }
      await removeRegisteredRole(interaction.guild, tournament, member, `banned team "${team.team}" — by ${interaction.user.tag}`);
    } else {
      stillRegistered.push(member.displayName || member.user.username);
    }
    await member.roles.add(banRole.id).catch(() => {});
    await logRoleChange(interaction.guild, tournament, { member, roleId: banRole.id, added: true, reason: `team "${team.team}" banned — by ${interaction.user.tag}` });
  }

  const now = Date.now();
  const expiresAt = now + Math.round(days * 24 * 60 * 60 * 1000);
  store.timedBans.push({
    id: crypto.randomBytes(6).toString('hex'),
    tournamentId: tournament.id,
    tournamentName: tournament.name,
    roleId: banRole.id,
    team: team.team,
    ownerId: team.ownerId,
    playerIds: team.playerIds || [],
    bannedAt: now,
    expiresAt,
  });

  group.teams = group.teams.filter(t => t !== team);
  tournament.qualified = tournament.qualified.filter(name => name !== team.team);
  saveGuildStore(interaction.guildId, store);

  const note = stillRegistered.length
    ? ` (${stillRegistered.join(', ')} ${stillRegistered.length === 1 ? 'is' : 'are'} already registered on another team, so ${stillRegistered.length === 1 ? 'their' : 'their'} tournament role was kept.)`
    : '';
  await interaction.editReply({
    content: `🔨 **${team.team}** banned from **${tournament.name}** for ${days} day(s) — removed from Group ${letter}, and the ban role was applied to ${targets.length} player(s).${note}`,
  });
}

// Lists this tournament's currently-active timed bans, for lifting one
// early.
function buildUnbanSelectPayload(store, tournament) {
  const activeBans = (store.timedBans || []).filter(b => b.tournamentId === tournament.id);
  if (!activeBans.length) {
    return { error: '❌ No teams are currently timed-banned in this tournament.' };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('tourney_unban_select')
    .setPlaceholder('Select a team to unban early')
    .addOptions(activeBans.slice(0, 25).map(b => ({
      label: b.team.slice(0, 100),
      description: `${Math.max(0, Math.ceil((b.expiresAt - Date.now()) / 86400000))} day(s) left`,
      value: b.id,
    })));

  const embed = new EmbedBuilder()
    .setTitle('🔓 Unban Team')
    .setColor(0x57F287)
    .setDescription('Select a team to remove their ban role and lift the ban early.');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function handleUnbanSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }

  const banId = interaction.values[0];
  const idx = (store.timedBans || []).findIndex(b => b.id === banId);
  if (idx === -1) {
    return interaction.update({ content: '❌ That ban record no longer exists — it may have already expired.', embeds: [], components: [] });
  }
  const ban = store.timedBans[idx];

  await interaction.deferUpdate();

  const role = interaction.guild.roles.cache.get(ban.roleId);
  const targets = [...new Set([ban.ownerId, ...(ban.playerIds || [])].filter(Boolean))];
  for (const userId of targets) {
    const member = interaction.guild.members.cache.get(userId)
      ?? await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    if (role) {
      await member.roles.remove(role.id).catch(() => {});
      await logRoleChange(interaction.guild, tournament, { member, roleId: role.id, added: false, reason: `team "${ban.team}" unbanned — by ${interaction.user.tag}` });
    }
  }

  store.timedBans.splice(idx, 1);
  if (tournament.bannedTeams) {
    tournament.bannedTeams = tournament.bannedTeams.filter(n => n !== ban.team.toLowerCase());
  }
  saveGuildStore(interaction.guildId, store);

  await interaction.editReply({ content: `✅ **${ban.team}** has been unbanned early and their role removed.`, embeds: [], components: [] });
}

// Background sweep — call on an interval from index.js. Finds every timed
// ban (across every guild) whose duration has elapsed, strips the ban
// role from each player, and clears the record. Works purely off
// store.timedBans, which is guild-level and outlives the tournament
// object itself — so a deleted tournament's bans still get served in
// full and still get cleaned up automatically once they expire.
async function processExpiredBans(client) {
  const now = Date.now();
  for (const guildId of listGuildIds()) {
    const store = getGuildStore(guildId);
    const bans = store.timedBans || [];
    const expired = bans.filter(b => b.expiresAt <= now);
    if (!expired.length) continue;

    const guild = client.guilds.cache.get(guildId);
    for (const ban of expired) {
      const tournament = store.tournaments && store.tournaments[ban.tournamentId];
      if (guild) {
        const role = guild.roles.cache.get(ban.roleId);
        const targets = new Set([ban.ownerId, ...(ban.playerIds || [])].filter(Boolean));
        for (const userId of targets) {
          const member = guild.members.cache.get(userId)
            ?? await guild.members.fetch(userId).catch(() => null);
          if (!member) continue;
          if (role) {
            await member.roles.remove(role.id).catch(() => {});
            // This runs on a background timer with no admin present — the
            // Log Channel line is the only record that this happened.
            await logRoleChange(guild, tournament, { member, roleId: role.id, added: false, reason: `timed ban expired — team "${ban.team}"` });
          }
        }
      }

      if (tournament && tournament.bannedTeams) {
        tournament.bannedTeams = tournament.bannedTeams.filter(n => n !== ban.team.toLowerCase());
      }
    }

    store.timedBans = bans.filter(b => b.expiresAt > now);
    saveGuildStore(guildId, store);
  }
}

// Admin version of team registration — picks the exact group instead of
// auto-assigning, and works even while registration is closed. The player
// to credit as the team's owner (and to hand the group role to) was
// already picked in the UserSelectMenu step before this modal ever opened,
// same for the group itself — both travel in via the modal's customId.
// Form answers from a failed Manually Add Slot attempt, so "Try Again"
// doesn't make the admin retype everything. In memory only, per admin.
const manualAddDrafts = new Map();
const manualAddDraftKey = (guildId, adminId) => `${guildId}:${adminId}`;

function rejectManualAddForm(interaction, userId, roundNum, letter, fields, message) {
  manualAddDrafts.set(manualAddDraftKey(interaction.guildId, interaction.user.id), { userId, fields });
  return interaction.reply({
    content: `${message} Tap **Try Again** to fix it — your other answers are kept.`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tourney_wizard_manual_add_retry:${userId}:${roundNum}:${letter}`).setLabel('Try Again').setEmoji('🔁').setStyle(ButtonStyle.Primary)
    )],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleManualAddSlotModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  // customId: tourney_wizard_manual_add_modal:<userId>:<round>:<group|new>
  // (older forms had no round part and were Round 1)
  const parts = interaction.customId.split(':');
  const userId = parts[1];
  const roundNum = parts.length >= 4 ? parseInt(parts[2], 10) : 1;
  const requestedLetter = parts.length >= 4 ? parts[3] : parts[2];

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.reply({ content: '❌ No tournament exists yet.', flags: MessageFlags.Ephemeral });
  }
  if (!Number.isInteger(roundNum) || roundNum < 1 || roundNum > getMaxRounds(tournament)) {
    return interaction.reply({ content: '❌ That round no longer exists — run **Manually Add Slot** again.', flags: MessageFlags.Ephemeral });
  }

  const groups = getRoundGroups(tournament, roundNum);
  const roundLabel = roundNum > 1 ? `Round ${roundNum} ` : '';
  const creating = requestedLetter === 'new';
  const letter = creating ? nextFreeGroupKey(groups) : requestedLetter;
  if (creating && (roundNum <= 1 || !letter)) {
    return interaction.reply({ content: '❌ No more groups can be created — run **Manually Add Slot** again.', flags: MessageFlags.Ephemeral });
  }
  if (!creating && !groups[letter]) {
    const existing = Object.keys(groups).join(', ') || 'none yet';
    return interaction.reply({ content: `❌ ${roundLabel}Group **${letter}** doesn't exist. Current groups: ${existing}.`, flags: MessageFlags.Ephemeral });
  }
  let overflowSlot = null;
  if (!creating) {
    const g = groups[letter];
    if (!hasEmptySlot(g)) {
      overflowSlot = nextLockedSlot(g);
      if (overflowSlot === null) {
        return interaction.reply({ content: `❌ ${roundLabel}Group **${letter}** is completely full — every locked slot is taken too.`, flags: MessageFlags.Ephemeral });
      }
    }
  }

  const draft = {
    team: interaction.fields.getTextInputValue('team'),
    owner: interaction.fields.getTextInputValue('owner'),
    whatsapp: interaction.fields.getTextInputValue('whatsapp'),
    players: interaction.fields.getTextInputValue('players'),
  };
  const checked = validateRegistrationForm(tournament, draft, { roundNum });
  if (checked.error) {
    return rejectManualAddForm(interaction, userId, roundNum, requestedLetter, draft, checked.error);
  }
  // Round 2+ promotion/swap logic finds a team by its owner, so one player
  // can't own two teams inside the same round.
  if (roundNum > 1) {
    const already = findRoundEntry(tournament, roundNum, userId);
    if (already) {
      return rejectManualAddForm(interaction, userId, roundNum, requestedLetter, draft,
        `❌ <@${userId}> is already in Round ${roundNum} (Group ${already.letter}, team **${already.team.team}**).`);
    }
  }
  const { team, ownerName, whatsapp, playerIgns, playerUids } = checked.data;

  manualAddDrafts.delete(manualAddDraftKey(interaction.guildId, interaction.user.id));
  // Creating a channel + role can take longer than Discord's 3s window.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (creating) {
    groups[letter] = { capacity: getRoundGroupCapacity(tournament, roundNum), teams: [] };
  }
  const group = groups[letter];
  const newTeam = {
    team,
    players: playerIgns,
    playerIds: [userId],
    ownerId: userId,
    ownerName,
    whatsapp,
    playerIgns,
    playerUids,
  };
  // Group not full: the team takes the first empty slot (4-23, in order).
  // Group full: it goes to the next locked slot (24, 25, 1, 2, 3).
  const firstEmpty = overflowSlot === null ? emptySlotNumbers(group)[0] : undefined;
  if (overflowSlot !== null) { newTeam.slotOverride = overflowSlot; newTeam.slotOverrideRound = roundNum; }
  group.teams.push(newTeam);
  if (firstEmpty !== undefined && groupSlotNumber(group, group.teams.length - 1) !== firstEmpty) {
    newTeam.slotOverride = firstEmpty;
    newTeam.slotOverrideRound = roundNum;
  }
  saveGuildStore(interaction.guildId, store);

  // Round 1 matches self-registration: the picked player gets the tournament's
  // "Registered" role, plus the group role only if that group's channel already
  // exists (otherwise Create Channels hands it out later). Round 2+ matches
  // promotion, which creates the group's private channel and role straight away.
  let roleWarning = '';
  const member = interaction.guild.members.cache.get(userId)
    ?? await interaction.guild.members.fetch(userId).catch(() => null);
  let groupRole = null;
  let grantedRole = null;

  if (roundNum <= 1) {
    grantedRole = await ensureTournamentRegisteredRole(interaction, store, tournament).catch(() => null);
    if (group.channelId && interaction.guild.channels.cache.has(group.channelId)) {
      groupRole = await ensureGroupRole(
        interaction, store, group,
        applyRoundNameFormat(getRoundNaming(tournament, 1).roleFormat, { roundNum: 1, groupKey: letter, separator: ' ' }),
        `Manually added to Group ${letter} by ${interaction.user.tag}`,
      ).catch(() => null);
    }
  } else {
    groupRole = await ensureRoundGroupChannelAndRole(interaction, store, tournament, roundNum, letter).catch(() => null);
    grantedRole = groupRole;
  }

  if (!member) {
    roleWarning = `\n\n⚠️ Couldn't find <@${userId}> in this server to give them their role.`;
  } else if (!grantedRole) {
    roleWarning = `\n\n⚠️ Couldn't create/find the ${roundNum <= 1 ? 'registered' : `${roundLabel}Group ${letter}`} role — check my **Manage Roles** permission.`;
  } else {
    for (const roleToAdd of [grantedRole, groupRole].filter((r, i, arr) => r && arr.indexOf(r) === i)) {
      await member.roles.add(roleToAdd.id).then(() => {
        logRoleChange(interaction.guild, tournament, { member, roleId: roleToAdd.id, added: true, reason: `manually added to Group ${letter} by ${interaction.user.tag}` });
      }).catch(err => {
        console.error(`[tournament-group-role] Failed to add role ${roleToAdd.id} to ${userId} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
        roleWarning = `\n\n⚠️ Couldn't give <@${userId}> the <@&${roleToAdd.id}> role — check my **Manage Roles** permission and that my role sits above it.`;
      });
    }
  }

  if (roundNum <= 1) await refreshRegisterPanel(interaction.guild, tournament);
  await refreshPublishedSlotList(interaction.guild, tournament, roundNum, letter, group);

  return interaction.editReply({
    content: `✅ **${team}** added to **${roundLabel}Group ${letter}**, Slot **${overflowSlot !== null ? `${overflowSlot} (locked)` : groupSlotNumber(group, group.teams.length - 1)}** — <@${userId}> ${roundNum <= 1 && !groupRole ? 'now has the registered role (the group role comes when channels are created)' : 'now has the group role'}.${roleWarning}`,
  });
}

// ---------------------------------------------------------------------------
// Qualify flow
// ---------------------------------------------------------------------------
function buildQualifySelectPayload(tournament, tid, roundNum, letter) {
  if (!letter) {
    return { error: "❌ Couldn't tell which group to qualify." };
  }

  const groups = getRoundGroups(tournament, roundNum);
  const label = roundNum > 1 ? `Round ${roundNum} — Group ${letter}` : `Group ${letter}`;
  const group = groups[letter];
  if (!group) {
    const existing = Object.keys(groups).join(', ') || 'none yet';
    return { error: `❌ ${label} doesn't exist. Current groups: ${existing}.` };
  }
  if (!group.teams.length) {
    return { error: `❌ ${label} has no registered teams yet.` };
  }
  if (group.teams.length > 25) {
    return { error: `❌ ${label} has ${group.teams.length} teams — Discord select menus cap at 25 options, so this group can't be shown as one list.` };
  }

  const alreadyQualified = new Set(tournament.qualified);
  const maxRounds = getMaxRounds(tournament);
  const isFinalRound = roundNum >= maxRounds;
  const select = new StringSelectMenuBuilder()
    .setCustomId(`qualify_select_teams:${tid}:${roundNum}:${letter}`)
    .setPlaceholder(isFinalRound ? `Select the tournament winner from ${label}` : `Select qualifying teams from ${label}`)
    .setMinValues(0)
    .setMaxValues(isFinalRound ? 1 : group.teams.length)
    .addOptions(group.teams.map((t, idx) => ({
      label: t.team.slice(0, 100),
      value: String(idx),
      default: isFinalRound ? tournament.winnerTeam === t.team : alreadyQualified.has(t.team),
    })));

  const embed = new EmbedBuilder()
    .setTitle(isFinalRound ? `🏆 Pick the Winner — ${label}` : `✅ Qualify Teams — ${label}`)
    .setColor(0x5865F2)
    .setDescription(
      isFinalRound
        ? `Select the **one** team that wins the tournament. They'll receive the **${tournament.name} Winner** role — this is the final round, so no one is promoted further.`
        : `Select every team from this group that qualifies, then confirm — they'll be promoted into Round ${roundNum + 1}. Already-qualified teams are pre-checked.`
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

// Picker shown after clicking "Qualify" — pick which group, then hand off
// to the existing per-group team picker (buildQualifySelectPayload).
function buildQualifyGroupSelectPayload(tournament) {
  const letters = Object.keys(tournament.groups);
  if (!letters.length) {
    return { error: '❌ No groups exist yet — add one first.' };
  }

  const groupOptions = letters.map(letter => ({
    label: `Group ${letter}`,
    description: `${tournament.groups[letter].teams.length}/${tournament.groups[letter].capacity} teams`,
    value: letter,
  }));

  const embed = new EmbedBuilder()
    .setTitle('✅ Qualify Teams')
    .setColor(0x5865F2)
    .setDescription('Pick a group, then choose which of its teams qualify.');

  return { embeds: [embed], components: buildChunkedSelectRows('tourney_qualify_group_select', 'Select a group to qualify teams from', groupOptions) };
}

async function handleQualifyGroupSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const [letter] = interaction.values;

  if (!tournament || !tournament.groups[letter]) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  const payload = buildQualifySelectPayload(tournament, tournament.id, 1, letter);
  if (payload.error) {
    return interaction.update({ content: payload.error, embeds: [], components: [] });
  }
  await interaction.update({ content: '', ...payload });
}

async function handleQualifySelect(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  const group = tournament && getRoundGroups(tournament, roundNum)[letter];

  if (!tournament || !group) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }
  if (!canUseGroupPanel(interaction, tournament)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  const selectedIdx = new Set(interaction.values.map(v => parseInt(v, 10)));
  const selectedTeams = group.teams.filter((t, idx) => selectedIdx.has(idx));
  const selectedNames = selectedTeams.map(t => t.team);
  const selectedOwnerIds = new Set(selectedTeams.map(t => t.ownerId));
  const label = roundNum > 1 ? `Round ${roundNum} Group ${letter}` : `Group ${letter}`;
  const maxRounds = getMaxRounds(tournament);
  const nextRound = roundNum + 1;

  // Re-running qualify on the same group cleanly replaces its previous
  // picks rather than piling up duplicates: drop every team from this
  // group out of the qualified list first, then add back only what's
  // selected now.
  const groupTeamNames = new Set(group.teams.map(t => t.team));
  tournament.qualified = tournament.qualified.filter(name => !groupTeamNames.has(name));
  tournament.qualified.push(...selectedNames);
  // Remember this group's result was published — the Swap Group button moves
  // on to the next round once every group of this round has one.
  group.resultPublished = true;
  saveGuildStore(interaction.guildId, store);

  // Un-promote anyone from this group who was in the next round but isn't
  // selected this time (e.g. Result re-run with a smaller pick).
  if (nextRound <= maxRounds) {
    for (const t of group.teams) {
      if (!selectedOwnerIds.has(t.ownerId)) {
        await removeTeamFromRoundOnward(interaction, store, tournament, t, nextRound);
      }
    }
  }

  // Promote newly-qualified teams into the next round — first not-yet-full
  // group there, or the next new one, filling in order the same way
  // Round 1 registration does. Already-promoted teams (Result re-run with
  // the same picks) are left where they are. Nothing is promoted once
  // this round is the last one Manage Rounds is configured for — instead,
  // the (at most one) selected team is crowned the tournament winner.
  const promoted = [];
  const failed = [];
  let winnerLine = null;
  if (nextRound <= maxRounds) {
    for (const t of selectedTeams) {
      if (findRoundEntry(tournament, nextRound, t.ownerId)) continue;

      const nextLetter = autoAssignRoundGroup(tournament, nextRound);
      if (!nextLetter) { failed.push(t.team); continue; }
      getRoundGroups(tournament, nextRound)[nextLetter].teams.push(t);
      saveGuildStore(interaction.guildId, store);

      const nextRole = await ensureRoundGroupChannelAndRole(interaction, store, tournament, nextRound, nextLetter).catch(() => null);

      // Matches registration/manual-add: only the team owner gets the
      // group role, not every tagged teammate.
      const owner = t.ownerId
        ? (interaction.guild.members.cache.get(t.ownerId) ?? await interaction.guild.members.fetch(t.ownerId).catch(() => null))
        : null;
      if (owner && nextRole) {
        await owner.roles.add(nextRole.id).catch(() => {});
        await logRoleChange(interaction.guild, tournament, { member: owner, roleId: nextRole.id, added: true, reason: `promoted to Round ${nextRound} Group ${nextLetter} — by ${interaction.user.tag}` });
      }
      promoted.push(`**${t.team}** → Round ${nextRound} Group ${nextLetter}`);
    }
  } else {
    // Final round: the select menu caps picks at 1, so selectedTeams has
    // at most one entry. No role is given for winning — just tracked so
    // the picker shows who's currently marked as champion.
    const winnerTeam = selectedTeams[0] || null;

    if (winnerTeam) {
      tournament.winnerTeam = winnerTeam.team;
      saveGuildStore(interaction.guildId, store);
      winnerLine = `🏆 **${winnerTeam.team}** is crowned the tournament winner!`;
    } else {
      tournament.winnerTeam = null;
      saveGuildStore(interaction.guildId, store);
    }
  }

  // The result is posted publicly in the channel as an embed (so everyone in
  // the group sees it and it stays). Only the admin-facing warning about
  // failed promotions stays in the private confirmation.
  const roundName = getRoundDisplayName(tournament, roundNum).name;
  const nextRoundName = getRoundDisplayName(tournament, nextRound).name;

  const resultEmbed = new EmbedBuilder()
    .setFooter({ text: tournament.name });

  if (winnerLine) {
    // Final round — champion announcement.
    const winner = selectedTeams[0];
    resultEmbed
      .setColor(0xF1C40F)
      .setTimestamp()
      .setTitle('🏆 Tournament Champions')
      .setDescription([
        `**${winner.team}** ${winner.ownerId ? `(<@${winner.ownerId}>) ` : ''}have won **${tournament.name}**!`,
        '',
        winnerLine.replace(/^🏆\s*/, '🎖️ '),
        '',
        'Congratulations to the champions and thank you to every team that played.',
      ].join('\n'));
  } else if (!selectedTeams.length) {
    resultEmbed
      .setColor(0x99AAB5)
      .setTitle(`📋 ${roundName} — Result Updated`)
      .setDescription('No teams are qualified from this group.');
  } else {
    // QUALIFIED TEAMS FOR <NEXT ROUND NAME>
    // - Team Name @owner
    const advancing = nextRound <= maxRounds;
    const teamLines = selectedTeams.map(t => `- ${t.team}${t.ownerId ? ` <@${t.ownerId}>` : ''}`);
    resultEmbed
      .setColor(0x57F287)
      .setTitle(`QUALIFIED TEAMS FOR ${(advancing ? nextRoundName : roundName).toUpperCase()}`)
      .setDescription(teamLines.join('\n'));
  }

  const posted = await interaction.channel.send({ embeds: [resultEmbed] }).catch(() => null);

  const privateLines = [posted ? '✅ Result posted in this channel.' : '⚠️ I couldn\'t post the result here — check my Send Messages / Embed Links permission.'];
  if (failed.length) privateLines.push(`⚠️ Couldn't find/create a Round ${nextRound} slot for: ${failed.map(t => `**${t}**`).join(', ')} — check my Manage Roles/Manage Channels permissions.`);

  await interaction.editReply({ content: privateLines.join('\n'), embeds: [], components: [] });
}

// ---------------------------------------------------------------------------
// Per-group admin panel — Publish Slot List / Punish Team (posted
// automatically in each group's own channel, see
// buildTournamentGroupAdminPanelPayload)
// ---------------------------------------------------------------------------

// "Publish Slot List" — publishes the group's current slot list into its
// own channel (where the button lives) only. Re-clicking edits the same
// message in place (new teams show up in it) instead of spamming a fresh
// copy every time — a message only gets (re-)sent if there's no previous
// one to edit, or that one was deleted.
async function handleTourneyGroupPublish(interaction, store, tournament, roundNum, letter) {
  const group = tournament && getRoundGroups(tournament, roundNum)[letter];
  if (!tournament || !group) {
    return interaction.reply({ content: '❌ That group no longer exists.', flags: MessageFlags.Ephemeral });
  }

  const slotListPayload = buildPublishedSlotListPayload(tournament, roundNum, letter, group);

  // Returns 'edited' (refreshed the existing slot list), 'sent' (posted a new
  // one because none exists) or 'failed'. It only posts a NEW message when
  // there is genuinely no slot list in the channel yet:
  //   1. the saved message id is edited directly (no history permission needed);
  //   2. if that id is missing/stale, the channel's recent messages are
  //      searched for this bot's existing slot list, which is adopted and edited;
  //   3. only then is a fresh one sent.
  const publishOnce = async (channel, messageIdKey) => {
    const payload = slotListPayload;
    const isUnknownMessage = err => err && (err.code === 10008 || err.status === 404);

    const existingId = group[messageIdKey];
    if (existingId) {
      try {
        await channel.messages.edit(existingId, payload);
        return 'edited';
      } catch (err) {
        if (!isUnknownMessage(err)) {
          console.error(`[tournament-slot-list] Couldn't edit slot list ${existingId} for group ${letter}: ${err.code ?? ''} ${err.message}`);
          return 'failed';
        }
        // The saved message was deleted — fall through and look for another.
      }
    }

    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const botId = interaction.client.user.id;
    const found = recent && recent.find(m => m.author.id === botId
      && m.embeds.some(e => e.title && e.title.startsWith('📋') && /Slot List$/.test(e.title)));
    if (found) {
      try {
        await found.edit(payload);
        group[messageIdKey] = found.id;
        return 'edited';
      } catch (err) {
        console.error(`[tournament-slot-list] Couldn't edit existing slot list ${found.id} for group ${letter}: ${err.code ?? ''} ${err.message}`);
        return 'failed';
      }
    }

    const sent = await channel.send(payload).catch(err => {
      console.error(`[tournament-slot-list] Couldn't post slot list for group ${letter}: ${err.code ?? ''} ${err.message}`);
      return null;
    });
    if (sent) { group[messageIdKey] = sent.id; return 'sent'; }
    return 'failed';
  };

  // Always post into THIS group's own channel, never wherever the button
  // happened to be pressed — otherwise a panel reposted/pressed in another
  // channel puts Group X's slot list under Group Y's channel name.
  const ownChannel = group.channelId
    ? (interaction.guild.channels.cache.get(group.channelId)
      ?? await interaction.guild.channels.fetch(group.channelId).catch(() => null))
    : null;
  const result = await publishOnce(ownChannel || interaction.channel, 'slotListMessageId');

  saveGuildStore(interaction.guildId, store);

  const where = `${roundNum > 1 ? `Round ${roundNum} ` : ''}Group **${letter}**`;
  return interaction.reply({
    content: result === 'failed'
      ? `❌ Couldn't publish the slot list for ${where} — check that I can send messages and embed links in that channel.`
      : result === 'edited'
        ? `🔄 Slot list refreshed for ${where} (the existing message was updated, nothing new was posted).`
        : `✅ Slot list published for ${where}.`,
    flags: MessageFlags.Ephemeral,
  });
}

// Team picker shown by "Punish Team" — same shape as the Qualify picker,
// just for banning instead.
function buildTournamentPunishSelectPayload(tournament, tid, roundNum, letter) {
  const group = getRoundGroups(tournament, roundNum)[letter];
  const label = roundNum > 1 ? `Round ${roundNum} — Group ${letter}` : `Group ${letter}`;
  if (!group) {
    return { error: `❌ ${label} doesn't exist.` };
  }
  if (!group.teams.length) {
    return { error: `❌ ${label} has no registered teams yet.` };
  }
  if (group.teams.length > 25) {
    return { error: `❌ ${label} has ${group.teams.length} teams — Discord select menus cap at 25 options.` };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tourney_punish_select_teams:${tid}:${roundNum}:${letter}`)
    .setPlaceholder(`Select team(s) to punish from ${label}`)
    .setMinValues(1)
    .setMaxValues(group.teams.length)
    .addOptions(group.teams.map((t, idx) => ({ label: t.team.slice(0, 100), value: String(idx) })));

  const embed = new EmbedBuilder()
    .setTitle(`🔨 Punish Teams — ${label}`)
    .setColor(0xED4245)
    .setDescription('Select every team to punish — each is banned from re-registering, removed from this group, and loses this group\'s role (and any later round they\'d already reached).');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

// On submit: bans the picked team name(s), evicts them from the group
// where "Punish Team" was clicked, and strips this group's role — plus
// cascades forward through any later round they'd already been promoted
// into (their standing in earlier rounds is left alone, since punishing
// from a Round 3 channel shouldn't quietly erase a team's Round 1 slot).
// Never lets one player's role removal fail block the rest.
async function handleTournamentPunishSelect(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  const group = tournament && getRoundGroups(tournament, roundNum)[letter];

  if (!tournament || !group) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const indices = new Set(interaction.values.map(v => parseInt(v, 10)));
  const punishedTeams = group.teams.filter((t, idx) => indices.has(idx));

  if (!punishedTeams.length) {
    return interaction.update({ content: '❌ Nothing selected.', embeds: [], components: [] });
  }

  await interaction.deferUpdate();

  if (!tournament.bannedTeams) tournament.bannedTeams = [];
  const groupRoleId = group.roleId;
  const label = roundNum > 1 ? `Round ${roundNum} Group ${letter}` : `Group ${letter}`;
  const lines = [];

  for (const team of punishedTeams) {
    if (!tournament.bannedTeams.includes(team.team.toLowerCase())) {
      tournament.bannedTeams.push(team.team.toLowerCase());
    }
    await removeTeamFromRoundOnward(interaction, store, tournament, team, roundNum + 1);
    const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
    for (const userId of targets) {
      const member = interaction.guild.members.cache.get(userId)
        ?? await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (groupRoleId) {
        await member.roles.remove(groupRoleId).catch(() => {});
        await logRoleChange(interaction.guild, tournament, { member, roleId: groupRoleId, added: false, reason: `punished (${label}) — by ${interaction.user.tag}` });
      }
      await removeRegisteredRole(interaction.guild, tournament, member, `punished (${label}) — by ${interaction.user.tag}`);
    }
    lines.push(`🔨 **${team.team}** banned and removed from ${label}.`);
  }

  group.teams = group.teams.filter(t => !punishedTeams.includes(t));
  tournament.qualified = tournament.qualified.filter(name => !punishedTeams.some(t => t.team === name));
  saveGuildStore(interaction.guildId, store);

  await interaction.editReply({ content: lines.join('\n'), embeds: [], components: [] });
}

// Discord caps a dropdown at 25 options, so a long list (e.g. 40 groups) is
// split across several dropdowns stacked in the same message — up to 5 rows,
// 125 options. The first uses `customIdBase` as-is; the rest get ":p1", ":p2"…
// appended, and every one is handled by the same handler (they all read
// interaction.values[0]).
function buildChunkedSelectRows(customIdBase, placeholder, options, reservedRows = 0) {
  const maxMenus = Math.max(1, 5 - reservedRows);
  const rows = [];
  for (let i = 0; i < maxMenus && i * 25 < options.length; i++) {
    const chunk = options.slice(i * 25, i * 25 + 25);
    const range = options.length > 25 ? ` (${i * 25 + 1}–${i * 25 + chunk.length} of ${options.length})` : '';
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(i === 0 ? customIdBase : `${customIdBase}:p${i}`)
        .setPlaceholder(`${placeholder}${range}`.slice(0, 150))
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(chunk)
    ));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Slot list flow
// ---------------------------------------------------------------------------
// Picker shown after clicking "Slot List" — pick which group to view.
// Returns { error } when there's nothing to pick from yet.
function buildSlotListGroupSelectPayload(tournament) {
  const options = [];
  const maxRounds = getMaxRounds(tournament);
  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    const groups = getRoundGroups(tournament, roundNum);
    const roundName = getRoundDisplayName(tournament, roundNum).name;
    for (const [letter, group] of Object.entries(groups)) {
      options.push({
        label: `${roundName} — Group ${letter}`.slice(0, 100),
        description: `${group.teams.length}/${group.capacity} teams`,
        value: `${roundNum}:${letter}`,
      });
    }
  }

  if (!options.length) {
    return { error: '❌ No groups exist yet — add one first.' };
  }


  const embed = new EmbedBuilder()
    .setTitle('🔢 Tournament Slot List')
    .setColor(0x5865F2)
    .setDescription('Pick a group (any round) — its slot list is generated automatically from current registrations.');

  return { embeds: [embed], components: buildChunkedSelectRows('tourney_slotlist_select', 'Select a group to view its slot list', options) };
}

async function handleSlotListSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const [roundNum, letter] = interaction.values[0].split(':');
  const round = Number(roundNum);
  const group = tournament ? getRoundGroups(tournament, round)[letter] : null;

  if (!tournament || !group) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  await interaction.update({ content: '', ...buildSlotListViewPayload(tournament, round, letter, group) });
}

// Re-renders the slot list embed for one group along with its "Edit Team
// Names" button — used both for the initial view and to return to it after
// an edit (or Back) without re-running the select-menu handler above.
function buildSlotListViewPayload(tournament, round, letter, group) {
  const embed = buildTournamentSlotListEmbed(tournament, letter, group, round, getRoundDisplayName(tournament, round).name);
  const editButton = new ButtonBuilder()
    .setCustomId(`tourney_wizard_slotlist_edit:${round}:${letter}`)
    .setLabel('Edit Team Names')
    .setEmoji('✏️')
    .setStyle(ButtonStyle.Secondary);
  const components = group.teams.length ? [new ActionRowBuilder().addComponents(editButton)] : [];
  return { embeds: [embed], components };
}

// ---------------------------------------------------------------------------
// "Edit Team Names" — from the slot list view above, an admin picks a team
// from that group and renames it. Three steps: pick-team select menu, a
// modal with the current name pre-filled, then back to the slot list view
// (refreshed) with the edit button restored.
// ---------------------------------------------------------------------------
function buildSlotListEditTeamSelectPayload(tournament, round, letter, group) {
  if (!group.teams.length) {
    return { error: '❌ This group has no teams to rename yet.' };
  }
  const options = group.teams.map((team, idx) => ({
    label: String(team.team).slice(0, 100),
    description: `Slot ${groupSlotNumber(group, idx)}`,
    value: String(idx),
  }));


  const backButton = new ButtonBuilder()
    .setCustomId(`tourney_wizard_slotlist_edit_back:${round}:${letter}`)
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);

  const embed = new EmbedBuilder()
    .setTitle(`✏️ Edit Team Names — Group ${letter}`)
    .setColor(0x5865F2)
    .setDescription('Pick the team whose name you want to edit.');

  return {
    embeds: [embed],
    components: [...buildChunkedSelectRows(`tourney_slotlist_edit_team_select:${round}:${letter}`, 'Select a team to rename', options, 1), new ActionRowBuilder().addComponents(backButton)],
  };
}

async function handleSlotListEditTeamSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const [, roundStr, letter] = interaction.customId.split(':');
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const round = Number(roundStr);
  const group = tournament ? getRoundGroups(tournament, round)[letter] : null;
  const idx = Number(interaction.values[0]);
  const team = group ? group.teams[idx] : null;

  if (!tournament || !group || !team) {
    return interaction.update({ content: '❌ That team no longer exists — reopen Manage Groups.', embeds: [], components: [] });
  }

  const modal = new ModalBuilder()
    .setCustomId(`tourney_slotlist_edit_team_modal:${round}:${letter}:${idx}`)
    .setTitle('Edit Team Name');
  const input = new TextInputBuilder()
    .setCustomId('team').setLabel('Team name').setStyle(TextInputStyle.Short)
    .setValue(team.team).setMaxLength(100).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

async function handleSlotListEditTeamModalSubmit(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const [, roundStr, letter, idxStr] = interaction.customId.split(':');
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const round = Number(roundStr);
  const group = tournament ? getRoundGroups(tournament, round)[letter] : null;
  const idx = Number(idxStr);
  const team = group ? group.teams[idx] : null;

  if (!tournament || !group || !team) {
    return interaction.reply({ content: '❌ That team no longer exists — reopen Manage Groups.', flags: MessageFlags.Ephemeral });
  }

  const newName = interaction.fields.getTextInputValue('team').trim();
  if (!newName) {
    return interaction.reply({ content: '❌ Team name cannot be empty.', flags: MessageFlags.Ephemeral });
  }

  const oldName = team.team;
  if (newName.toLowerCase() !== oldName.toLowerCase()) {
    const taken = Object.values(tournament.groups).some(g => g.teams.some(t => t !== team && t.team.toLowerCase() === newName.toLowerCase()));
    if (taken) {
      return interaction.reply({ content: `❌ A team named **${newName}** is already registered.`, flags: MessageFlags.Ephemeral });
    }
  }

  team.team = newName;
  const qIdx = (tournament.qualified || []).indexOf(oldName);
  if (qIdx !== -1) tournament.qualified[qIdx] = newName;
  saveGuildStore(interaction.guildId, store);
  await refreshPublishedSlotList(interaction.guild, tournament, round, letter, group);

  const payload = buildSlotListViewPayload(tournament, round, letter, group);
  return interaction.isFromMessage()
    ? interaction.update({ content: `✅ Renamed to **${newName}**.`, ...payload })
    : interaction.reply({ content: `✅ Renamed to **${newName}**.`, ...payload, flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// Edit / Info buttons on the PUBLISHED slot list (the message in each group
// channel). Edit = admins only: pick a team, type a new name, and it is renamed
// in EVERY round that team appears in. Info = admins + Select Staff: pick a
// team to see its details. Staff are matched per tournament (isTournamentStaff).
// ---------------------------------------------------------------------------
function buildPublishedSlotListPayload(tournament, roundNum, letter, group) {
  const embed = buildTournamentSlotListEmbed(tournament, letter, group, roundNum, getRoundDisplayName(tournament, roundNum).name);
  const tid = tournament.id;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_group_slotedit:${tid}:${roundNum}:${letter}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tourney_wizard_group_slotinfo:${tid}:${roundNum}:${letter}`).setLabel('Info').setEmoji('ℹ️').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

// Every { roundNum, letter, group } container of the tournament (Round 1 lives
// in tournament.groups, later rounds in tournament.rounds[n].groups). Reads
// only — never creates an empty round the way getRound() does.
function listAllRoundGroups(tournament) {
  const out = [];
  for (const [letter, group] of Object.entries(tournament.groups || {})) out.push({ roundNum: 1, letter, group });
  for (const [n, round] of Object.entries(tournament.rounds || {})) {
    const roundNum = Number(n);
    if (roundNum <= 1) continue;
    for (const [letter, group] of Object.entries((round && round.groups) || {})) out.push({ roundNum, letter, group });
  }
  return out;
}

// Same team in another round? Promotion copies the team record, and after a
// restart those copies are separate objects, so match on the owner (falling
// back to the old name for records that have no owner).
function isSameTeamRecord(a, b, oldName) {
  if (a === b) return true;
  if (a.ownerId && b.ownerId) return a.ownerId === b.ownerId;
  return String(b.team).toLowerCase() === String(oldName).toLowerCase();
}

// Renames `team` everywhere: every round's copy, the qualified list and the
// winner. Returns the { roundNum, letter, group } entries that were changed.
function renameTeamAcrossRounds(tournament, team, newName) {
  const oldName = team.team;
  const touched = [];
  for (const entry of listAllRoundGroups(tournament)) {
    let changed = false;
    for (const t of entry.group.teams || []) {
      if (isSameTeamRecord(team, t, oldName)) { t.team = newName; changed = true; }
    }
    if (changed) touched.push(entry);
  }
  team.team = newName;
  tournament.qualified = (tournament.qualified || []).map(n => (n === oldName ? newName : n));
  if (tournament.winnerTeam === oldName) tournament.winnerTeam = newName;
  return touched;
}

function buildSlotTeamPickerRows(customIdBase, placeholder, group) {
  const options = group.teams.map((team, idx) => ({
    label: String(team.team).slice(0, 100),
    description: `Slot ${groupSlotNumber(group, idx)}`,
    value: String(idx),
  }));
  return buildChunkedSelectRows(customIdBase, placeholder, options);
}

function resolveSlotListTarget(interaction, tid, roundStr, letter) {
  const tournament = getTournamentById(interaction.guildId, tid);
  const roundNum = parseInt(roundStr, 10);
  const group = tournament ? getRoundGroups(tournament, roundNum)[letter] : null;
  return { tournament, roundNum, group };
}

// The Edit / Info buttons under the published slot list.
async function handleSlotListButtons(interaction) {
  const [action, tid, roundStr, letter] = interaction.customId.split(':');
  const isEdit = action === 'tourney_wizard_group_slotedit';
  const { tournament, group } = resolveSlotListTarget(interaction, tid, roundStr, letter);

  if (!tournament || !group) {
    return interaction.reply({ content: '❌ This group no longer exists.', flags: MessageFlags.Ephemeral });
  }
  const allowed = isEdit
    ? hasTournamentAdminAccess(interaction)
    : (hasTournamentAdminAccess(interaction) || isTournamentStaff(interaction, tournament));
  if (!allowed) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  if (!group.teams.length) {
    return interaction.reply({ content: '❌ This group has no teams yet.', flags: MessageFlags.Ephemeral });
  }

  const base = `${isEdit ? 'tourney_slotedit_select' : 'tourney_slotinfo_select'}:${tid}:${roundStr}:${letter}`;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(isEdit ? '✏️ Edit Team Name' : 'ℹ️ Team Info')
    .setDescription(isEdit
      ? 'Pick the team to rename. The new name is applied in **every round** that team is in.'
      : 'Pick a team to see its details.');
  return interaction.reply({
    embeds: [embed],
    components: buildSlotTeamPickerRows(base, isEdit ? 'Select a team to rename' : 'Select a team', group),
    flags: MessageFlags.Ephemeral,
  });
}

// Team picker for Edit -> opens the rename modal.
async function handleSlotListEditPick(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const { tournament, group } = resolveSlotListTarget(interaction, tid, roundStr, letter);
  const idx = Number(interaction.values[0]);
  const team = group ? group.teams[idx] : null;
  if (!tournament || !group || !team) {
    return interaction.update({ content: '❌ That team no longer exists.', embeds: [], components: [] });
  }
  const modal = new ModalBuilder()
    .setCustomId(`tourney_slotedit_modal:${tid}:${roundStr}:${letter}:${idx}`)
    .setTitle('Edit Team Name');
  const input = new TextInputBuilder()
    .setCustomId('team').setLabel('New team name').setStyle(TextInputStyle.Short)
    .setValue(String(team.team).slice(0, 100)).setMaxLength(100).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

async function handleSlotListEditModalSubmit(interaction) {
  const [, tid, roundStr, letter, idxStr] = interaction.customId.split(':');
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const store = getGuildStore(interaction.guildId);
  const { tournament, group } = resolveSlotListTarget(interaction, tid, roundStr, letter);
  const team = group ? group.teams[Number(idxStr)] : null;
  if (!tournament || !group || !team) {
    return interaction.reply({ content: '❌ That team no longer exists.', flags: MessageFlags.Ephemeral });
  }

  const newName = interaction.fields.getTextInputValue('team').trim();
  if (!newName) {
    return interaction.reply({ content: '❌ Team name cannot be empty.', flags: MessageFlags.Ephemeral });
  }
  const oldName = team.team;
  if (newName === oldName) {
    return interaction.reply({ content: 'ℹ️ That is already the team\'s name — nothing changed.', flags: MessageFlags.Ephemeral });
  }
  if (newName.toLowerCase() !== oldName.toLowerCase()) {
    const taken = listAllRoundGroups(tournament).some(({ group: g }) =>
      g.teams.some(t => !isSameTeamRecord(team, t, oldName) && String(t.team).toLowerCase() === newName.toLowerCase()));
    if (taken) {
      return interaction.reply({ content: `❌ A team named **${newName}** is already registered.`, flags: MessageFlags.Ephemeral });
    }
  }

  const touched = renameTeamAcrossRounds(tournament, team, newName);
  saveGuildStore(interaction.guildId, store);

  // Keep every published slot list (all rounds this team is in) in sync.
  for (const { roundNum, letter: l, group: g } of touched) {
    await refreshPublishedSlotList(interaction.guild, tournament, roundNum, l, g);
  }

  const rounds = [...new Set(touched.map(t => t.roundNum))].sort((a, b) => a - b);
  const content = `✅ Renamed **${oldName}** → **${newName}** in ${rounds.length > 1 ? `rounds ${rounds.join(', ')}` : `round ${rounds[0] || roundStr}`}.`;
  return interaction.isFromMessage()
    ? interaction.update({ content, embeds: [], components: [], allowedMentions: { parse: [] } })
    : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

// Team picker for Info -> shows the team's details (picker stays so another
// team can be looked up straight away).
async function handleSlotListInfoPick(interaction) {
  const [, tid, roundStr, letter] = interaction.customId.split(':');
  const { tournament, roundNum, group } = resolveSlotListTarget(interaction, tid, roundStr, letter);
  if (!tournament || !group) {
    return interaction.update({ content: '❌ This group no longer exists.', embeds: [], components: [] });
  }
  if (!(hasTournamentAdminAccess(interaction) || isTournamentStaff(interaction, tournament))) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }
  const idx = Number(interaction.values[0]);
  const team = group.teams[idx];
  if (!team) {
    return interaction.update({ content: '❌ That team no longer exists.', embeds: [], components: [] });
  }

  const igns = (team.playerIgns && team.playerIgns.length)
    ? team.playerIgns
    : (team.players || []).filter(pl => !/^<@!?\d+>$/.test(pl));
  const uids = team.playerUids || [];
  const ids = team.playerIds || [];
  const lineup = [];
  const rows = Math.max(igns.length, uids.length, ids.length);
  for (let i = 0; i < rows; i++) {
    const parts = [];
    if (igns[i]) parts.push(`**${igns[i]}**`);
    if (uids[i]) parts.push(`UID \`${uids[i]}\``);
    if (ids[i]) parts.push(`<@${ids[i]}>`);
    if (parts.length) lineup.push(`${i + 1}. ${parts.join(' · ')}`);
  }

  // Where this team stands across rounds (matched by owner, see isSameTeamRecord).
  const journey = listAllRoundGroups(tournament)
    .filter(e => e.group.teams.some(t => isSameTeamRecord(team, t, team.team)))
    .sort((a, b) => a.roundNum - b.roundNum)
    .map(e => {
      const i = e.group.teams.findIndex(t => isSameTeamRecord(team, t, team.team));
      return `${getRoundDisplayName(tournament, e.roundNum).name} — Group ${e.letter}, Slot ${groupSlotNumber(e.group, i)}`;
    });

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`ℹ️ ${String(team.team).slice(0, 240)}`)
    .addFields(
      { name: 'Slot', value: `${getRoundDisplayName(tournament, roundNum).name} — Group ${letter}, Slot ${groupSlotNumber(group, idx)}`, inline: false },
      { name: 'Owner', value: team.ownerId ? `<@${team.ownerId}>${team.ownerName ? ` (${team.ownerName})` : ''}` : (team.ownerName || '—'), inline: false },
      { name: 'WhatsApp', value: team.whatsapp ? String(team.whatsapp).slice(0, 1000) : '—', inline: true },
      { name: 'Qualified', value: (tournament.qualified || []).includes(team.team) ? 'Yes' : 'No', inline: true },
      { name: `Players (${lineup.length})`, value: (lineup.join('\n') || '—').slice(0, 1024), inline: false },
      { name: 'Rounds', value: (journey.join('\n') || '—').slice(0, 1024), inline: false },
    );
  if (team.confirmMessageUrl) embed.addFields({ name: 'Registration', value: `[Jump to confirmation](${team.confirmMessageUrl})`, inline: false });

  return interaction.update({
    content: '',
    embeds: [embed],
    components: buildSlotTeamPickerRows(`tourney_slotinfo_select:${tid}:${roundStr}:${letter}`, 'Select another team', group),
    allowedMentions: { parse: [] },
  });
}

// ---------------------------------------------------------------------------
// "Group Panel" — repost a group's admin panel after it was accidentally
// deleted. Lists every group (any round) that already has its own channel,
// so an admin can pick the one to restore.
// ---------------------------------------------------------------------------
function buildGroupPanelRepostSelectPayload(tournament) {
  const options = [];
  const maxRounds = getMaxRounds(tournament);
  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    const groups = getRoundGroups(tournament, roundNum);
    for (const [letter, group] of Object.entries(groups)) {
      if (!group.channelId) continue;
      const roundName = getRoundDisplayName(tournament, roundNum).name;
      options.push({
        label: `${roundName} — Group ${letter}`.slice(0, 100),
        description: `${group.teams.length}/${group.capacity} teams`,
        value: `${roundNum}:${letter}`,
      });
    }
  }

  if (!options.length) {
    return { error: '❌ No group has a channel yet — create channels for a group first.' };
  }


  const embed = new EmbedBuilder()
    .setTitle('📨 Repost Group Panel')
    .setColor(0x5865F2)
    .setDescription('Pick a group — a fresh copy of its admin panel (Publish Slot List / Punish Team / Result / Config / Open-Close) is posted in that group\'s channel, using its current settings. Use this if the panel was accidentally deleted.');

  return { embeds: [embed], components: buildChunkedSelectRows('tourney_grouppanel_repost_select', 'Select a group to repost its admin panel in', options) };
}

async function handleGroupPanelRepostSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  if (!tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', embeds: [], components: [] });
  }

  const [roundStr, letter] = interaction.values[0].split(':');
  const roundNum = parseInt(roundStr, 10) || 1;
  const group = getRoundGroups(tournament, roundNum)[letter];
  if (!group) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }
  if (!group.channelId) {
    return interaction.update({ content: '❌ That group no longer has a channel to post in.', embeds: [], components: [] });
  }

  const channel = interaction.guild.channels.cache.get(group.channelId)
    ?? await interaction.guild.channels.fetch(group.channelId).catch(() => null);
  if (!channel) {
    return interaction.update({ content: '❌ That group\'s channel no longer exists.', embeds: [], components: [] });
  }

  const me = interaction.guild.members.me;
  if (!channel.permissionsFor(me).has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
    return interaction.update({
      content: `❌ I don't have permission to post in ${channel}. I need **View Channel**, **Send Messages**, and **Embed Links** there.`,
      embeds: [], components: [],
    });
  }

  const panelMessage = await channel.send(buildTournamentGroupAdminPanelPayload(tournament, roundNum, letter)).catch(() => null);
  if (!panelMessage) {
    return interaction.update({ content: `❌ Couldn't post the panel in ${channel}.`, embeds: [], components: [] });
  }

  group.adminPanelMessageId = panelMessage.id;
  saveGuildStore(interaction.guildId, store);

  return interaction.update({ content: `✅ Group ${letter} panel reposted in ${channel}.`, embeds: [], components: [] });
}

// ---------------------------------------------------------------------------
// Cancel Slots flow
// ---------------------------------------------------------------------------
function buildCancelGroupSelectPayload(tournament) {
  const letters = Object.keys(tournament.groups).filter(l => tournament.groups[l].teams.length > 0);
  if (!letters.length) {
    return { error: '❌ No registered teams in any group yet.' };
  }

  const groupOptions = letters.map(letter => ({
    label: `Group ${letter}`,
    description: `${tournament.groups[letter].teams.length}/${tournament.groups[letter].capacity} teams`,
    value: letter,
  }));

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Cancel Slots')
    .setColor(0xED4245)
    .setDescription('Pick a group, then choose which team(s) to remove.');

  return { embeds: [embed], components: buildChunkedSelectRows('tourney_cancel_group_select', 'Select a group to cancel slots from', groupOptions) };
}

function buildCancelTeamsSelectPayload(tournament, letter) {
  const group = tournament.groups[letter];
  if (!group) {
    return { error: `❌ Group **${letter}** doesn't exist.` };
  }
  if (!group.teams.length) {
    return { error: `❌ Group **${letter}** has no registered teams.` };
  }
  if (group.teams.length > 25) {
    return { error: `❌ Group **${letter}** has ${group.teams.length} teams — over Discord's 25-option select limit.` };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`cancel_select_teams:${letter}`)
    .setPlaceholder(`Select team(s) to remove from Group ${letter}`)
    .setMinValues(1)
    .setMaxValues(group.teams.length)
    .addOptions(group.teams.map((t, idx) => ({ label: t.team.slice(0, 100), value: String(idx) })));

  const embed = new EmbedBuilder()
    .setTitle(`🗑️ Cancel Slots — Group ${letter}`)
    .setColor(0xED4245)
    .setDescription('Select every team to remove, then confirm.');

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function handleCancelGroupSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;
  const [letter] = interaction.values;

  if (!tournament || !tournament.groups[letter]) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  const payload = buildCancelTeamsSelectPayload(tournament, letter);
  if (payload.error) {
    return interaction.update({ content: payload.error, embeds: [], components: [] });
  }
  await interaction.update({ content: '', ...payload });
}

async function handleCancelTeamsSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const [, letter] = interaction.customId.split(':');
  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  const tournament = store.tournament;

  if (!tournament || !tournament.groups[letter]) {
    return interaction.update({ content: '❌ That group no longer exists.', embeds: [], components: [] });
  }

  const group = tournament.groups[letter];
  const removeIndices = new Set(interaction.values.map(v => parseInt(v, 10)));
  const removedTeams = group.teams.filter((t, idx) => removeIndices.has(idx));
  const removedNames = removedTeams.map(t => t.team);
  group.teams = group.teams.filter((t, idx) => !removeIndices.has(idx));

  await interaction.deferUpdate();
  for (const team of removedTeams) {
    // Round 1's own group role + registered role aren't handled by
    // removeTeamFromRoundOnward (it only cleans up round 2+, since the
    // team is already spliced out of this group's array above) — strip
    // them here so cancelling a slot actually frees up the player.
    const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
    for (const userId of targets) {
      const member = interaction.guild.members.cache.get(userId)
        ?? await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (group.roleId) {
        await member.roles.remove(group.roleId).catch(() => {});
        await logRoleChange(interaction.guild, tournament, { member, roleId: group.roleId, added: false, reason: `slot cancelled — team "${team.team}" — by ${interaction.user.tag}` });
      }
      await removeRegisteredRole(interaction.guild, tournament, member, `slot cancelled — team "${team.team}" — by ${interaction.user.tag}`);
    }
    await removeTeamFromRoundOnward(interaction, store, tournament, team, 2);
  }

  const removedSet = new Set(removedNames);
  tournament.qualified = tournament.qualified.filter(name => !removedSet.has(name));
  saveGuildStore(interaction.guildId, store);
  await refreshPublishedSlotList(interaction.guild, tournament, 1, letter, group);

  await interaction.editReply({
    content: `🗑️ Removed from Group ${letter}: ${removedNames.map(n => `**${n}**`).join(', ')}`,
    embeds: [],
    components: [],
  });
}

// ---------------------------------------------------------------------------
// Slot-Manager channel select (ChannelSelectMenu)
// ---------------------------------------------------------------------------
async function handleSlotManagerChannelSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }

  const channel = interaction.channels.first();
  store.tournament.slotManagerChannelId = channel.id;
  const tid = store.tournament.id;
  saveGuildStore(interaction.guildId, store);

  await channel.send(buildSlotSelfServicePanelPayload(tid)).catch(() => {});

  await interaction.update({ content: `✅ Slot-Manager channel set to ${channel} — the self-service panel has been posted there.`, components: [] });
}

// Finds the team (if any) a given user belongs to — as the owner or as a
// listed player — across every group in the tournament. With Fake Tag ON a
// player can be listed on several teams, so a team they OWN always wins over
// one they were only tagged in (otherwise Cancel My Slot could hit the wrong
// team). With Fake Tag OFF there's only ever one match anyway.
function findUserTournamentEntry(tournament, userId) {
  for (const letter of Object.keys(tournament.groups)) {
    const group = tournament.groups[letter];
    const idx = group.teams.findIndex(t => t.ownerId === userId);
    if (idx !== -1) return { letter, group, idx, team: group.teams[idx] };
  }
  for (const letter of Object.keys(tournament.groups)) {
    const group = tournament.groups[letter];
    const idx = group.teams.findIndex(t => (t.playerIds || []).includes(userId));
    if (idx !== -1) return { letter, group, idx, team: group.teams[idx] };
  }
  return null;
}

// Public self-service panel — posted automatically in the configured
// Slot-Manager channel. Lets a registered player cancel their own slot,
// check which group they're in, or rename their own team, without needing
// an admin.
function buildSlotSelfServicePanelPayload(tid) {
  const embed = new EmbedBuilder()
    .setTitle('<a:30348trophyfixed:1551349161566412933> Tourney Slot Manager')
    .setColor(0x5865F2)
    .setDescription(
      '• Click **Cancel My Slot** below to cancel your slot.\n' +
      '• Click **My Groups** to see which group your team is in.\n' +
      '• Click **Change Team Name** if you want to update your team\'s name.\n' +
      '• Click **Swap Group** to swap groups with another team — both team owners have to accept.\n\n' +
      '*Note that slot cancel is irreversible.*'
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_cancel:${tid}`).setLabel('Cancel My Slot').setEmoji('<:1042034464005566474:1554190057890644068>').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_my_groups:${tid}`).setLabel('My Groups').setEmoji('<:1485354653951594497:1554190050860736562>').setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_change_name:${tid}`).setLabel('Change Team Name').setEmoji('<a:1527188665141563473:1554190045555073125>').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tourney_wizard_selfservice_swap:${tid}`).setLabel('Swap Group').setEmoji('<:1543164739864105102:1554190041583067206>').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// Submit handler for the "Change Team Name" modal above — renames the
// player's own team in place (same duplicate-name check registration
// uses) and keeps the qualified list in sync if that team already
// qualified under its old name.
async function handleSelfServiceChangeNameModalSubmit(interaction) {
  const tid = interaction.customId.split(':')[1];
  const store = getGuildStore(interaction.guildId);
  const tournament = store.tournaments && store.tournaments[tid];
  if (!tournament) {
    return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
  }

  const entry = findUserTournamentEntry(tournament, interaction.user.id);
  if (!entry) {
    return interaction.reply({ content: "❌ You're not registered for this tournament.", flags: MessageFlags.Ephemeral });
  }

  const newName = interaction.fields.getTextInputValue('team').trim();
  if (!newName) {
    return interaction.reply({ content: '❌ Team name cannot be empty.', flags: MessageFlags.Ephemeral });
  }

  const oldName = entry.team.team;
  if (newName.toLowerCase() !== oldName.toLowerCase()) {
    const taken = Object.values(tournament.groups).some(g => g.teams.some(t => t.team.toLowerCase() === newName.toLowerCase()));
    if (taken) {
      return interaction.reply({ content: `❌ A team named **${newName}** is already registered.`, flags: MessageFlags.Ephemeral });
    }
  }

  entry.team.team = newName;
  const qIdx = tournament.qualified.indexOf(oldName);
  if (qIdx !== -1) tournament.qualified[qIdx] = newName;
  saveGuildStore(interaction.guildId, store);

  return interaction.reply({ content: `✅ Team name updated to **${newName}**.`, flags: MessageFlags.Ephemeral });
}

async function handleRegisterPanelChannelSelect(interaction) {
  if (!hasTournamentAdminAccess(interaction)) {
    return interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral });
  }

  const store = getTournamentStore(interaction.guildId, interaction.user.id);
  if (!store.tournament) {
    return interaction.update({ content: '❌ No tournament exists yet.', components: [] });
  }

  const channel = interaction.channels.first();
  const me = interaction.guild.members.me;
  if (!channel.permissionsFor(me).has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
    return interaction.update({
      content: `❌ I don't have permission to post in ${channel}. I need **View Channel**, **Send Messages**, and **Embed Links** there.`,
      components: [],
    });
  }

  const message = await channel.send(buildTournamentRegisterPanelPayload(store.tournament));
  store.tournament.registerPanelChannelId = channel.id;
  store.tournament.registerPanelMessageId = message.id;
  saveGuildStore(interaction.guildId, store);
  await interaction.update({ content: `✅ Registration panel posted in ${channel}.`, components: [] });
}

// Keeps the standalone public registration panel (posted via "Post
// Register Panel") in sync the moment open/closed status changes —
// without this, players would keep seeing a stale "Open"/"Closed" status
// until someone manually re-posted the panel. Best-effort: if the message
// or channel was deleted, this just quietly gives up rather than erroring
// out whatever triggered the refresh. Takes the tournament object
// directly (rather than pulling it off an admin-bound store) since this
// also gets called from the public registration-confirm flow, which has
// no admin session to bind `store.tournament` to.
async function refreshRegisterPanel(guild, tournament) {
  if (!tournament.registerPanelChannelId || !tournament.registerPanelMessageId) return;
  try {
    const channel = await guild.channels.fetch(tournament.registerPanelChannelId).catch(() => null);
    if (!channel) return;
    const message = await channel.messages.fetch(tournament.registerPanelMessageId).catch(() => null);
    if (!message) return;
    await message.edit(buildTournamentRegisterPanelPayload(tournament));
  } catch (err) {
    console.error(`[tournament-register-panel] Failed to refresh register panel in guild ${guild.id}: ${err.message}`);
  }
}

// Keeps a group's already-published Slot List message (Publish Slot List)
// in sync whenever its teams change outside of that button — Manually Add
// Slot and admin Cancel Slots both call this. No-ops silently if this
// group's slot list was never published or its channel/message is gone.
async function refreshPublishedSlotList(guild, tournament, roundNum, letter, group) {
  if (!group || !group.channelId || !group.slotListMessageId) return;
  try {
    const channel = await guild.channels.fetch(group.channelId).catch(() => null);
    if (!channel) return;
    const message = await channel.messages.fetch(group.slotListMessageId).catch(() => null);
    if (!message) return;
    await message.edit(buildPublishedSlotListPayload(tournament, roundNum, letter, group));
  } catch (err) {
    console.error(`[tournament-slot-list] Failed to refresh published slot list for group ${letter} in guild ${guild.id}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Swap Group — two teams trade groups/slots, but only after BOTH team owners
// accept. Lives on the Slot-Manager panel.
//
// Admins (Manage Server) or the TOURNAMENT ELITE role can switch this whole
// feature on/off per tournament from the main panel's "Group Swap" button
// (tournament.groupSwapOpen). While it's off, no player can open the picker,
// send a request, or accept/reject one — admins can still use it themselves.
//
//   1. "Swap Group" opens a picker (ephemeral) with two dropdowns: Team A and
//      Team B. A normal owner can only pick their own team as Team A; admins
//      (Manage Server) can pick any two teams.
//   2. "Send Swap Request" posts a request in the channel, pinging both
//      owners, with Accept Swap / Reject Swap buttons. The owner who started
//      the request has already agreed, so only the other owner has to tap
//      Accept (an admin starting a swap for two other teams needs both).
//   3. Only once both owners have accepted does anything change: the two
//      teams take each other's group + slot, their group roles are moved
//      (which is also what controls access to the group channels), the
//      published slot lists are refreshed, and a confirmation is posted.
//      If either side rejects, the request is cancelled and nothing changes.
// undefined/missing (older tournaments, or never touched) counts as open.
function isGroupSwapOpen(tournament) {
  return tournament.groupSwapOpen !== false;
}
//
// Sessions and open requests live in memory only (like the registration flow),
// so a bot restart just cancels anything still waiting for an answer.
// ---------------------------------------------------------------------------
const SWAP_SESSION_TTL_MS = 15 * 60 * 1000;
const SWAP_REQUEST_TTL_MS = 12 * 60 * 60 * 1000;
const SWAP_PAGE_SIZE = 25; // Discord select menus hold at most 25 options
const swapSessions = new Map(); // userId -> { tid, a, b, pageA, pageB, createdAt }
const swapRequests = new Map(); // requestId -> request (see handleSwapSend)

function getSwapSession(userId) {
  const session = swapSessions.get(userId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SWAP_SESSION_TTL_MS) {
    swapSessions.delete(userId);
    return null;
  }
  return session;
}

// Which round the Swap Group button works on. It starts on Round 1. Once the
// results of EVERY Round 1 group are published (Result button) and teams have
// been promoted, it moves to Round 2; once every Round 2 group's results are
// published it moves to Round 3, and so on up to the tournament's max rounds.
// A group counts as "published" when its Result was run (group.resultPublished)
// or, for older data, when at least one of its teams already qualified.
function isGroupResultPublished(tournament, group, nextRound) {
  if (group.resultPublished) return true;
  return group.teams.some(t => t.ownerId && findRoundEntry(tournament, nextRound, t.ownerId));
}

function getActiveSwapRound(tournament) {
  const max = getMaxRounds(tournament);
  let active = 1;
  for (let r = 2; r <= max; r++) {
    const prevGroups = Object.values(getRoundGroups(tournament, r - 1)).filter(g => g.teams.length);
    if (!prevGroups.length || !prevGroups.every(g => isGroupResultPublished(tournament, g, r))) break;
    const hasTeams = tournament.rounds && tournament.rounds[r]
      && Object.values(tournament.rounds[r].groups || {}).some(g => g.teams && g.teams.length);
    if (!hasTeams) break;
    active = r;
  }
  return active;
}

// Every team of the given round, in group/slot order. `key` (the lowercase
// team name) is what identifies a team in the dropdowns — names are unique
// per tournament.
function listRoundTeams(tournament, roundNum) {
  const groups = getRoundGroups(tournament, roundNum);
  const list = [];
  for (const letter of Object.keys(groups).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const group = groups[letter];
    group.teams.forEach((team, idx) => {
      list.push({ key: team.team.toLowerCase(), name: team.team, letter, idx, team, group });
    });
  }
  return list;
}

function findRoundTeamByKey(tournament, roundNum, key) {
  return listRoundTeams(tournament, roundNum).find(e => e.key === key) || null;
}

// Everything Team B can be: every team of the round plus every empty slot,
// in group / slot order. An empty entry has `empty: true` and no `team`.
function listSwapTargets(tournament, roundNum) {
  const groups = getRoundGroups(tournament, roundNum);
  const list = listRoundTeams(tournament, roundNum).map(e => ({ ...e, slot: groupSlotNumber(e.group, e.idx) }));
  for (const [letter, group] of Object.entries(groups)) {
    for (const n of emptySlotNumbers(group)) {
      list.push({ key: `empty:${letter}:${n}`, empty: true, name: 'Empty slot', letter, slot: n, group, team: null });
    }
  }
  return list.sort((x, y) => x.letter.localeCompare(y.letter, undefined, { numeric: true }) || x.slot - y.slot);
}

// A team that already sits in the next round has qualified and can't swap.
function hasQualifiedFromRound(tournament, roundNum, team) {
  return roundNum < getMaxRounds(tournament) && Boolean(team.ownerId) && Boolean(findRoundEntry(tournament, roundNum + 1, team.ownerId));
}

// Search box for the swap picker. Matches team name, owner name, or the group
// ("17", "g17", "group 17"). "empty" / "free" shows empty slots.
function filterSwapList(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  const groupToken = (q.match(/^(?:g(?:roup)?\s*)?(\S+)$/) || [])[1];
  return list.filter(e => {
    if (groupToken && String(e.letter).toLowerCase() === groupToken) return true;
    if (e.empty) return q === 'empty' || q === 'free';
    return e.name.toLowerCase().includes(q)
      || String(e.team.ownerName || '').toLowerCase().includes(q);
  });
}

function buildSwapPickerPayload(tournament, session, viewer) {
  const targets = listSwapTargets(tournament, session.round);
  const all = targets.filter(e => !e.empty);
  const aListFull = viewer.isAdmin ? all : all.filter(e => e.team.ownerId === viewer.userId);
  const selA = session.a ? all.find(e => e.key === session.a) || null : null;
  const selB = session.b ? targets.find(e => e.key === session.b) || null : null;
  // Team B (a team OR an empty slot) has to be in a different group from
  // Team A (swapping inside one group would change nothing).
  const bListFull = targets.filter(e => !selA || (e.key !== selA.key && e.letter !== selA.letter));
  const aList = filterSwapList(aListFull, session.searchA);
  const bList = filterSwapList(bListFull, session.searchB);

  const pageCount = list => Math.max(1, Math.ceil(list.length / SWAP_PAGE_SIZE));
  session.pageA = Math.min(Math.max(session.pageA, 0), pageCount(aList) - 1);
  session.pageB = Math.min(Math.max(session.pageB, 0), pageCount(bList) - 1);
  const pageOf = (list, page) => list.slice(page * SWAP_PAGE_SIZE, (page + 1) * SWAP_PAGE_SIZE);
  const toOption = (e, selectedKey) => (e.empty
    ? {
      label: `🟢 Empty Slot ${e.slot}`,
      description: `Group ${e.letter} · Slot ${e.slot} · empty`,
      value: e.key,
      default: e.key === selectedKey,
    }
    : {
      label: e.name.slice(0, 100),
      description: `Group ${e.letter} · Slot ${e.slot ?? groupSlotNumber(e.group, e.idx)}${e.team.ownerName ? ` · ${e.team.ownerName}` : ''}`.slice(0, 100),
      value: e.key,
      default: e.key === selectedKey,
    });
  const describe = e => (e
    ? (e.empty ? `🟢 **Empty slot** — Group ${e.letter}, Slot ${e.slot}` : `**${e.name}** — Group ${e.letter}, Slot ${e.slot ?? groupSlotNumber(e.group, e.idx)}`)
    : '_not selected yet_');

  const embed = new EmbedBuilder()
    .setTitle(session.round > 1 ? `🔄 Swap Group — Round ${session.round}` : '🔄 Swap Group')
    .setColor(0x5865F2)
    .setDescription(
      `**Team A:** ${describe(selA)}\n**Team B:** ${describe(selB)}\n\n` +
      'Pick Team A, then Team B — another team, or a 🟢 empty slot in another group. Swapping with a team needs **both owners to accept**; moving into an empty slot happens right away.' +
      '\n\n🔍 Hard to find a team? Tap **Search Team B** and type a team name, owner name or group number.' +
      (bListFull.length === 0 ? '\n\n⚠️ There are no teams or empty slots in other groups.' : '') +
      (session.searchB && bList.length === 0 ? `\n\n⚠️ Nothing matches **${session.searchB}** — try another name or tap **Clear Search**.` : '') +
      (session.searchA && aList.length === 0 ? `\n\n⚠️ No Team A matches **${session.searchA}**.` : '')
    );
  const pagingNote = [];
  if (session.searchA) pagingNote.push(`Team A search: "${session.searchA}" (${aList.length})`);
  if (session.searchB) pagingNote.push(`Team B search: "${session.searchB}" (${bList.length})`);
  if (aList.length > SWAP_PAGE_SIZE) pagingNote.push(`Team A list ${session.pageA + 1}/${pageCount(aList)}`);
  if (bList.length > SWAP_PAGE_SIZE) pagingNote.push(`Team B list ${session.pageB + 1}/${pageCount(bList)}`);
  if (pagingNote.length) embed.setFooter({ text: pagingNote.join(' · ') });

  const components = [];
  const aOptions = pageOf(aList, session.pageA).map(e => toOption(e, session.a));
  if (aOptions.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('tourney_swap_select:a').setPlaceholder('Select Team A')
        .setMinValues(1).setMaxValues(1).addOptions(aOptions)
    ));
  }
  const bOptions = pageOf(bList, session.pageB).map(e => toOption(e, session.b));
  if (bOptions.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('tourney_swap_select:b').setPlaceholder('Select Team B')
        .setMinValues(1).setMaxValues(1).addOptions(bOptions)
    ));
  }

  const pagingRow = new ActionRowBuilder();
  if (aList.length > SWAP_PAGE_SIZE) {
    pagingRow.addComponents(
      new ButtonBuilder().setCustomId('tourney_wizard_swap_page:a:prev').setLabel('A ◀').setStyle(ButtonStyle.Secondary).setDisabled(session.pageA <= 0),
      new ButtonBuilder().setCustomId('tourney_wizard_swap_page:a:next').setLabel('A ▶').setStyle(ButtonStyle.Secondary).setDisabled(session.pageA >= pageCount(aList) - 1),
    );
  }
  if (bList.length > SWAP_PAGE_SIZE) {
    pagingRow.addComponents(
      new ButtonBuilder().setCustomId('tourney_wizard_swap_page:b:prev').setLabel('B ◀').setStyle(ButtonStyle.Secondary).setDisabled(session.pageB <= 0),
      new ButtonBuilder().setCustomId('tourney_wizard_swap_page:b:next').setLabel('B ▶').setStyle(ButtonStyle.Secondary).setDisabled(session.pageB >= pageCount(bList) - 1),
    );
  }
  if (pagingRow.components.length) components.push(pagingRow);

  const searchRow = new ActionRowBuilder();
  if (viewer.isAdmin) {
    searchRow.addComponents(new ButtonBuilder().setCustomId('tourney_wizard_swap_search:a').setLabel('Search Team A').setEmoji('🔍').setStyle(ButtonStyle.Primary));
  }
  searchRow.addComponents(new ButtonBuilder().setCustomId('tourney_wizard_swap_search:b').setLabel('Search Team B').setEmoji('🔍').setStyle(ButtonStyle.Primary));
  if (session.searchA || session.searchB) {
    searchRow.addComponents(new ButtonBuilder().setCustomId('tourney_wizard_swap_clear').setLabel('Clear Search').setStyle(ButtonStyle.Secondary));
  }
  components.push(searchRow);

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tourney_wizard_swap_send').setLabel('Send Swap Request').setEmoji('📨').setStyle(ButtonStyle.Success).setDisabled(!(selA && selB)),
    new ButtonBuilder().setCustomId('tourney_wizard_swap_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  ));

  return { content: '', embeds: [embed], components };
}

function buildSwapRequestEmbed(req) {
  const status = accepted => (accepted ? '✅ Accepted' : '⏳ Waiting for response');
  return new EmbedBuilder()
    .setTitle(req.round > 1 ? `<a:1217333775915290656:1554190054744662168> Group Swap Request — Round ${req.round}` : '<a:1217333775915290656:1554190054744662168> Group Swap Request')
    .setColor(0xFEE75C)
    .setDescription(`<@${req.requesterId}> wants to swap these two teams' groups. **Both owners must accept** — until then nothing changes.`)
    .addFields(
      { name: `Team A — ${req.a.name}`, value: `Group ${req.a.letter} · Slot ${req.a.slot}\nOwner: <@${req.a.ownerId}>\n${status(req.a.accepted)}`, inline: true },
      { name: `Team B — ${req.b.name}`, value: `Group ${req.b.letter} · Slot ${req.b.slot}\nOwner: <@${req.b.ownerId}>\n${status(req.b.accepted)}`, inline: true },
    )
    .setFooter({ text: 'This request expires in 12 hours.' });
}

function swapRequestButtons(reqId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tourney_wizard_swap_accept:${reqId}`).setLabel('Accept Swap').setEmoji('<a:1512382646666264696:1554190038764486807>').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tourney_wizard_swap_reject:${reqId}`).setLabel('Reject Swap').setEmoji('<a:1460709075493978112:1554190024403066890>').setStyle(ButtonStyle.Danger),
  );
}

async function handleSwapButton(interaction) {
  const id = interaction.customId;

  if (id.startsWith('tourney_wizard_selfservice_swap:')) {
    const tid = id.split(':')[1];
    const tournament = getTournamentById(interaction.guildId, tid);
    if (!tournament) {
      return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const swapRound = getActiveSwapRound(tournament);
    const teams = listSwapTargets(tournament, swapRound);
    const isAdmin = hasManageGuild(interaction);
    if (!isAdmin && !isGroupSwapOpen(tournament)) {
      return interaction.reply({ content: '❌ Group Swap is currently turned off for this tournament.', flags: MessageFlags.Ephemeral });
    }
    const owned = teams.filter(e => !e.empty && e.team.ownerId === interaction.user.id);
    if (!isAdmin && owned.length === 0) {
      return interaction.reply({ content: '❌ Only a registered team owner can request a group swap.', flags: MessageFlags.Ephemeral });
    }
    if (teams.length < 2 || new Set(teams.map(e => e.letter)).size < 2) {
      return interaction.reply({ content: '❌ There need to be teams or empty slots in at least two different groups before a swap is possible.', flags: MessageFlags.Ephemeral });
    }
    for (const [uid, sess] of swapSessions) {
      if (Date.now() - sess.createdAt > SWAP_SESSION_TTL_MS) swapSessions.delete(uid);
    }
    const session = {
      tid,
      round: swapRound,
      a: !isAdmin && owned.length === 1 ? owned[0].key : null, // an owner's own team is Team A by default
      b: null, pageA: 0, pageB: 0, searchA: '', searchB: '', createdAt: Date.now(),
    };
    swapSessions.set(interaction.user.id, session);
    return interaction.reply({
      ...buildSwapPickerPayload(tournament, session, { isAdmin, userId: interaction.user.id }),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (id === 'tourney_wizard_swap_cancel') {
    swapSessions.delete(interaction.user.id);
    return interaction.update({ content: '✅ Swap cancelled — nothing changed.', embeds: [], components: [] });
  }

  if (id.startsWith('tourney_wizard_swap_search:')) {
    const side = id.split(':')[1] === 'a' ? 'a' : 'b';
    const session = getSwapSession(interaction.user.id);
    if (!session) {
      return interaction.update({ content: '❌ Your swap session expired. Click **Swap Group** again.', embeds: [], components: [] });
    }
    const input = new TextInputBuilder()
      .setCustomId('query').setLabel('Team name, owner name or group number')
      .setPlaceholder('e.g. velvet, shady, 17 (leave empty to clear)')
      .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50)
      .setValue(side === 'a' ? (session.searchA || '') : (session.searchB || ''));
    const modal = new ModalBuilder().setCustomId(`tourney_swap_search_modal:${side}`).setTitle(`Search Team ${side.toUpperCase()}`);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (id === 'tourney_wizard_swap_clear') {
    const session = getSwapSession(interaction.user.id);
    if (!session) {
      return interaction.update({ content: '❌ Your swap session expired. Click **Swap Group** again.', embeds: [], components: [] });
    }
    const tournament = getTournamentById(interaction.guildId, session.tid);
    if (!tournament) {
      return interaction.update({ content: '❌ This tournament no longer exists.', embeds: [], components: [] });
    }
    session.searchA = ''; session.searchB = ''; session.pageA = 0; session.pageB = 0;
    return interaction.update(buildSwapPickerPayload(tournament, session, { isAdmin: hasManageGuild(interaction), userId: interaction.user.id }));
  }

  if (id.startsWith('tourney_wizard_swap_page:')) {
    const [, side, dir] = id.split(':');
    const session = getSwapSession(interaction.user.id);
    if (!session) {
      return interaction.update({ content: '❌ Your swap session expired. Click **Swap Group** again.', embeds: [], components: [] });
    }
    const tournament = getTournamentById(interaction.guildId, session.tid);
    if (!tournament) {
      return interaction.update({ content: '❌ This tournament no longer exists.', embeds: [], components: [] });
    }
    const key = side === 'a' ? 'pageA' : 'pageB';
    session[key] += dir === 'next' ? 1 : -1;
    return interaction.update(buildSwapPickerPayload(tournament, session, { isAdmin: hasManageGuild(interaction), userId: interaction.user.id }));
  }

  if (id === 'tourney_wizard_swap_send') return handleSwapSend(interaction);
  if (id.startsWith('tourney_wizard_swap_accept:')) return handleSwapResponse(interaction, id.split(':')[1], true);
  if (id.startsWith('tourney_wizard_swap_reject:')) return handleSwapResponse(interaction, id.split(':')[1], false);
}

// Search box submit (opened from the Search Team A / B buttons).
async function handleSwapSearchModalSubmit(interaction) {
  const side = interaction.customId.split(':')[1] === 'a' ? 'a' : 'b';
  const session = getSwapSession(interaction.user.id);
  if (!session) {
    return interaction.reply({ content: '❌ Your swap session expired. Click **Swap Group** again.', flags: MessageFlags.Ephemeral });
  }
  const tournament = getTournamentById(interaction.guildId, session.tid);
  if (!tournament) {
    return interaction.reply({ content: '❌ This tournament no longer exists.', flags: MessageFlags.Ephemeral });
  }
  const viewer = { isAdmin: hasManageGuild(interaction), userId: interaction.user.id };
  const query = interaction.fields.getTextInputValue('query').trim();
  if (side === 'a' && !viewer.isAdmin) return interaction.deferUpdate().catch(() => {});
  if (side === 'a') { session.searchA = query; session.pageA = 0; }
  else { session.searchB = query; session.pageB = 0; }
  return interaction.update(buildSwapPickerPayload(tournament, session, viewer));
}

// Team A / Team B dropdowns.
async function handleSwapSelect(interaction) {
  const side = interaction.customId.split(':')[1];
  const session = getSwapSession(interaction.user.id);
  if (!session) {
    return interaction.update({ content: '❌ Your swap session expired. Click **Swap Group** again.', embeds: [], components: [] });
  }
  const tournament = getTournamentById(interaction.guildId, session.tid);
  if (!tournament) {
    return interaction.update({ content: '❌ This tournament no longer exists.', embeds: [], components: [] });
  }
  const viewer = { isAdmin: hasManageGuild(interaction), userId: interaction.user.id };
  if (!viewer.isAdmin && !isGroupSwapOpen(tournament)) {
    swapSessions.delete(interaction.user.id);
    return interaction.update({ content: '❌ Group Swap is currently turned off for this tournament.', embeds: [], components: [] });
  }

  const all = listSwapTargets(tournament, session.round);
  const picked = all.find(e => e.key === interaction.values[0]);
  if (picked) {
    if (side === 'a') {
      if (!picked.empty && (viewer.isAdmin || picked.team.ownerId === viewer.userId)) {
        session.a = picked.key;
        const currentB = session.b && all.find(e => e.key === session.b);
        if (currentB && currentB.letter === picked.letter) session.b = null; // same group now — pick again
      }
    } else {
      session.b = picked.key;
    }
  }
  return interaction.update(buildSwapPickerPayload(tournament, session, viewer));
}

// Setting H (Group Swap Channel): the channel where swap requests AND completed
// swaps are posted. Returns null when it isn't set / can't be found, in which
// case callers fall back to the channel the request was made in.
async function getSwapChannel(guild, tournament) {
  if (!tournament || !tournament.swapChannelId) return null;
  return guild.channels.cache.get(tournament.swapChannelId)
    ?? await guild.channels.fetch(tournament.swapChannelId).catch(() => null);
}

// "Send Swap Request" — validates the pair and posts the request in the swap channel (or the current channel).
async function handleSwapSend(interaction) {
  const session = getSwapSession(interaction.user.id);
  if (!session) {
    return interaction.update({ content: '❌ Your swap session expired. Click **Swap Group** again.', embeds: [], components: [] });
  }
  const tournament = getTournamentById(interaction.guildId, session.tid);
  if (!tournament) {
    swapSessions.delete(interaction.user.id);
    return interaction.update({ content: '❌ This tournament no longer exists.', embeds: [], components: [] });
  }
  const viewer = { isAdmin: hasManageGuild(interaction), userId: interaction.user.id };
  if (!viewer.isAdmin && !isGroupSwapOpen(tournament)) {
    swapSessions.delete(interaction.user.id);
    return interaction.update({ content: '❌ Group Swap is currently turned off for this tournament.', embeds: [], components: [] });
  }

  if (session.round !== getActiveSwapRound(tournament)) {
    swapSessions.delete(interaction.user.id);
    return interaction.update({ content: '❌ The tournament moved on to another round while you were picking. Click **Swap Group** again.', embeds: [], components: [] });
  }
  const A = session.a && findRoundTeamByKey(tournament, session.round, session.a);
  const B = session.b && (session.b.startsWith('empty:')
    ? listSwapTargets(tournament, session.round).find(e => e.key === session.b)
    : findRoundTeamByKey(tournament, session.round, session.b));
  const refuse = message => interaction.update({
    ...buildSwapPickerPayload(tournament, session, viewer),
    content: message,
  });

  if (!A || !B) return refuse('❌ One of the selected teams or slots is no longer available — pick again.');
  if (!viewer.isAdmin && A.team.ownerId !== viewer.userId) return refuse('❌ Team A has to be your own team.');
  if (A.letter === B.letter) return refuse('❌ Both teams are in the same group — there is nothing to swap.');
  if (!viewer.isAdmin && (!A.team.ownerId || (!B.empty && !B.team.ownerId))) return refuse('❌ One of these teams has no owner on record, so it can\'t confirm a swap.');

  if (hasQualifiedFromRound(tournament, session.round, A.team) || (!B.empty && hasQualifiedFromRound(tournament, session.round, B.team))) {
    return refuse('❌ A team that has already qualified to the next round can\'t swap groups.');
  }
  for (const other of swapRequests.values()) {
    if (other.tid === session.tid && [other.a.key, other.b.key].some(k => k === A.key || k === B.key)) {
      return refuse('❌ One of these teams already has a swap request waiting for an answer.');
    }
  }

  await interaction.deferUpdate();

  const reqId = crypto.randomBytes(4).toString('hex');
  const req = {
    id: reqId,
    tid: session.tid,
    round: session.round,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    requesterId: interaction.user.id,
    status: 'pending',
    timer: null,
    // The person who started the request has already agreed to it.
    a: { key: A.key, name: A.name, letter: A.letter, slot: groupSlotNumber(A.group, A.idx), ownerId: A.team.ownerId, accepted: viewer.isAdmin || A.team.ownerId === interaction.user.id },
    b: B.empty
      ? { key: B.key, name: B.name, letter: B.letter, slot: B.slot, ownerId: null, empty: true, accepted: true }
      : { key: B.key, name: B.name, letter: B.letter, slot: groupSlotNumber(B.group, B.idx), ownerId: B.team.ownerId, accepted: viewer.isAdmin || B.team.ownerId === interaction.user.id },
  };
  swapSessions.delete(interaction.user.id);

  // The same person owns both teams (and started this) — nobody else to ask.
  if (req.a.accepted && req.b.accepted) {
    swapRequests.set(reqId, req);
    req.status = 'executing';
    const result = await executeSwap(interaction, req);
    swapRequests.delete(reqId);
    if (result.error) {
      return interaction.editReply({ content: `❌ Swap not done — ${result.error}`, embeds: [], components: [] });
    }
    const soloOwners = [...new Set([req.a.ownerId, req.b.ownerId].filter(Boolean))];
    const donePayloadSolo = {
      content: soloOwners.map(uid => `<@${uid}>`).join(' '),
      embeds: [buildSwapDoneEmbed(result)],
      allowedMentions: { users: soloOwners },
    };
    const soloSwapChannel = await getSwapChannel(interaction.guild, tournament);
    const postedSolo = soloSwapChannel ? await soloSwapChannel.send(donePayloadSolo).then(() => true).catch(() => false) : false;
    if (!postedSolo) await interaction.channel.send(donePayloadSolo).catch(() => {});
    return interaction.editReply({ content: '✅ Swap complete.', embeds: [], components: [] });
  }

  const ping = [...new Set([req.a.ownerId, req.b.ownerId])];
  const requestPayload = {
    content: ping.map(uid => `<@${uid}>`).join(' '),
    embeds: [buildSwapRequestEmbed(req)],
    components: [swapRequestButtons(reqId)],
    allowedMentions: { users: ping },
  };
  // Setting H: the request goes to the Group Swap Channel (same place the
  // completed message lands). If it isn't set, or I can't post there, fall
  // back to the channel the player clicked Swap Group in.
  let message = null;
  const requestSwapChannel = await getSwapChannel(interaction.guild, tournament);
  if (requestSwapChannel) message = await requestSwapChannel.send(requestPayload).catch(() => null);
  if (!message) {
    try {
      message = await interaction.channel.send(requestPayload);
    } catch (err) {
      console.error(`[tournament-swap] Couldn't post the swap request in channel ${interaction.channelId}: ${err.message}`);
      return interaction.editReply({ content: '❌ I couldn\'t post the request in this channel — check my permissions here.', embeds: [], components: [] });
    }
  }
  req.channelId = message.channelId;
  req.messageId = message.id;
  swapRequests.set(reqId, req);

  const client = interaction.client;
  req.timer = setTimeout(() => expireSwapRequest(client, reqId), SWAP_REQUEST_TTL_MS);
  if (req.timer.unref) req.timer.unref();

  return interaction.editReply({
    content: `✅ Swap request sent${req.channelId !== interaction.channelId ? ` in <#${req.channelId}>` : ''} — waiting for ${ping.filter(uid => uid !== interaction.user.id).map(uid => `<@${uid}>`).join(' ') || 'the owners'} to accept.`,
    embeds: [],
    components: [],
  });
}

async function expireSwapRequest(client, reqId) {
  const req = swapRequests.get(reqId);
  if (!req || req.status !== 'pending') return;
  swapRequests.delete(reqId);
  const channel = await client.channels.fetch(req.channelId).catch(() => null);
  const message = channel && await channel.messages.fetch(req.messageId).catch(() => null);
  if (message) {
    await message.edit({
      content: '',
      embeds: [new EmbedBuilder().setTitle('⌛ Swap Request Expired').setColor(0x99AAB5)
        .setDescription(`**${req.a.name}** ⇄ **${req.b.name}** — nobody finished accepting in time, so nothing changed.`)],
      components: [],
    }).catch(() => {});
  }
}

// Accept Swap / Reject Swap on the request message.
async function handleSwapResponse(interaction, reqId, accept) {
  const req = swapRequests.get(reqId);
  if (!req || req.status !== 'pending') {
    await interaction.update({ components: [] }).catch(() => {});
    return interaction.followUp({
      content: '⌛ This swap request is no longer active — nothing changed. Start a new one from the slot manager panel if you still want to swap.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const userId = interaction.user.id;
  const isOwner = userId === req.a.ownerId || userId === req.b.ownerId;
  const canReject = isOwner || userId === req.requesterId || hasManageGuild(interaction);
  if (accept ? !isOwner : !canReject) {
    return interaction.reply({
      content: accept
        ? '❌ Only the owners of these two teams can accept this swap.'
        : '❌ Only the team owners (or the person who requested it) can reject this swap.',
      flags: MessageFlags.Ephemeral,
    });
  }
  // Rejecting just cancels the request, so it's always allowed — but if Group
  // Swap got turned off after this request was already sent, a non-admin
  // owner can no longer accept it into an actual swap.
  if (accept && !hasManageGuild(interaction)) {
    const tournament = getTournamentById(interaction.guildId, req.tid);
    if (tournament && !isGroupSwapOpen(tournament)) {
      return interaction.reply({ content: '❌ Group Swap has been turned off for this tournament — this request can no longer be accepted.', flags: MessageFlags.Ephemeral });
    }
  }

  await interaction.deferUpdate();

  if (!accept) {
    req.status = 'rejected';
    clearTimeout(req.timer);
    swapRequests.delete(reqId);
    return interaction.editReply({
      content: '',
      embeds: [new EmbedBuilder().setTitle('❌ Swap Cancelled').setColor(0xED4245)
        .setDescription(`<@${userId}> rejected the swap between **${req.a.name}** and **${req.b.name}**. Nothing has changed.`)],
      components: [],
    });
  }

  if (userId === req.a.ownerId) req.a.accepted = true;
  if (userId === req.b.ownerId) req.b.accepted = true;

  if (!(req.a.accepted && req.b.accepted)) {
    return interaction.editReply({ embeds: [buildSwapRequestEmbed(req)], components: [swapRequestButtons(reqId)] });
  }

  // Both owners said yes — do the swap. 'executing' blocks a double-click.
  req.status = 'executing';
  clearTimeout(req.timer);
  const result = await executeSwap(interaction, req);
  swapRequests.delete(reqId);

  if (result.error) {
    return interaction.editReply({
      content: '',
      embeds: [new EmbedBuilder().setTitle('❌ Swap Not Done').setColor(0xED4245)
        .setDescription(`Both owners accepted, but the swap couldn't be completed: ${result.error}\nNothing has changed.`)],
      components: [],
    });
  }

  await interaction.editReply({
    content: '',
    embeds: [new EmbedBuilder().setTitle('✅ Swap Accepted').setColor(0x57F287)
      .setDescription(`Both owners accepted — **${req.a.name}** and **${req.b.name}** have been swapped.`)],
    components: [],
  });
  const owners = [...new Set([req.a.ownerId, req.b.ownerId])];
  const donePayload = {
    content: owners.map(uid => `<@${uid}>`).join(' '),
    embeds: [buildSwapDoneEmbed(result)],
    allowedMentions: { users: owners },
  };
  // Setting H (Group Swap Channel): completed swaps are shown there. If it
  // isn't set, or I can't post in it, fall back to the channel the request
  // was made in.
  const swapTournament = (getGuildStore(req.guildId).tournaments || {})[req.tid];
  const swapChannel = await getSwapChannel(interaction.guild, swapTournament);
  const postedInSwapChannel = swapChannel ? await swapChannel.send(donePayload).then(() => true).catch(() => false) : false;
  if (!postedInSwapChannel) await interaction.channel.send(donePayload).catch(() => {});
}

function buildSwapDoneEmbed(result) {
  const embed = new EmbedBuilder()
    .setTitle('🔄 Group Swap Complete')
    .setColor(0x57F287)
    .addFields(
      { name: result.a.name, value: `Group ${result.a.from.letter} · Slot ${result.a.from.slot}  →  **Group ${result.a.to.letter} · Slot ${result.a.to.slot}**`, inline: false },
    );
  if (result.b) embed.addFields({ name: result.b.name, value: `Group ${result.b.from.letter} · Slot ${result.b.from.slot}  →  **Group ${result.b.to.letter} · Slot ${result.b.to.slot}**`, inline: false });
  else embed.setTitle('🔄 Group Move Complete');
  if (result.warnings.length) embed.addFields({ name: 'Heads up', value: result.warnings.join('\n').slice(0, 1024) });
  return embed;
}

// The actual swap. Re-checks everything first (a team may have been cancelled,
// renamed or promoted while the request was waiting), then trades the two
// teams' places, moves their group roles, saves, and refreshes the slot lists
// that were already published.
async function executeSwap(interaction, req) {
  const store = getGuildStore(req.guildId);
  const tournament = store.tournaments && store.tournaments[req.tid];
  if (!tournament) return { error: 'this tournament no longer exists.' };

  const roundNum = req.round || 1;
  if (roundNum !== getActiveSwapRound(tournament)) return { error: 'the tournament has already moved on to another round.' };
  const groups = getRoundGroups(tournament, roundNum);
  const A = findRoundTeamByKey(tournament, roundNum, req.a.key);
  const emptyB = Boolean(req.b.empty);
  const B = emptyB ? { empty: true, letter: req.b.letter, slot: req.b.slot, name: 'an empty slot', team: null } : findRoundTeamByKey(tournament, roundNum, req.b.key);
  if (!A || !B) return { error: `**${!A ? req.a.name : req.b.name}** is no longer registered (cancelled or renamed).` };
  if (A.team.ownerId !== req.a.ownerId || (!emptyB && B.team.ownerId !== req.b.ownerId)) return { error: 'a team\'s owner changed.' };
  if (A.letter === B.letter) return { error: emptyB ? 'the team is already in that group.' : 'both teams are now in the same group.' };
  if (hasQualifiedFromRound(tournament, roundNum, A.team) || (!emptyB && hasQualifiedFromRound(tournament, roundNum, B.team))) return { error: 'a team has already qualified to the next round.' };

  const groupA = groups[A.letter];
  const groupB = groups[B.letter];
  if (!groupB) return { error: 'that group no longer exists.' };
  if (emptyB && !emptySlotNumbers(groupB).includes(B.slot)) return { error: `Slot ${B.slot} in Group ${B.letter} is no longer empty.` };
  const fromA = groupSlotNumber(groupA, A.idx);

  // Trade places — each team takes the other's exact group + slot (if either
  // team was manually placed into a locked overflow slot, that slot number
  // moves with the position, not with the team).
  // Team objects are shared between rounds, so only an override that belongs
  // to THIS round is moved — an old Round 1 slot is left untouched.
  const isActiveOverride = t => typeof t.slotOverride === 'number' && (t.slotOverrideRound || 1) === roundNum;
  let toSlot;
  if (emptyB) {
    // Moving into an empty slot. Everyone behind the team in its old group is
    // pinned to the slot they have now, so they don't shuffle up — the slot
    // it leaves simply becomes an empty one.
    const behind = groupA.teams.map((t, i) => ({ t, slot: groupSlotNumber(groupA, i), i })).filter(x => x.i > A.idx);
    for (const { t, slot } of behind) {
      if (!isActiveOverride(t)) { t.slotOverride = slot; t.slotOverrideRound = roundNum; }
    }
    groupA.teams.splice(A.idx, 1);
    if (isActiveOverride(A.team)) { delete A.team.slotOverride; delete A.team.slotOverrideRound; }
    groupB.teams.push(A.team);
    // If the next natural slot isn't the one picked, pin the team to the pick.
    if (groupSlotNumber(groupB, groupB.teams.length - 1) !== B.slot) {
      A.team.slotOverride = B.slot;
      A.team.slotOverrideRound = roundNum;
    }
    toSlot = groupSlotNumber(groupB, groupB.teams.length - 1);
  } else {
    const aOverride = isActiveOverride(A.team) ? A.team.slotOverride : undefined;
    const bOverride = isActiveOverride(B.team) ? B.team.slotOverride : undefined;
    for (const t of [A.team, B.team]) {
      if (isActiveOverride(t)) { delete t.slotOverride; delete t.slotOverrideRound; }
    }
    if (bOverride !== undefined) { A.team.slotOverride = bOverride; A.team.slotOverrideRound = roundNum; }
    if (aOverride !== undefined) { B.team.slotOverride = aOverride; B.team.slotOverrideRound = roundNum; }
    groupA.teams[A.idx] = B.team;
    groupB.teams[B.idx] = A.team;
  }

  // Group roles (they're also what gives access to each group's channel).
  const warnings = [];
  const roleNameFor = letter => applyRoundNameFormat(getRoundNaming(tournament, roundNum).roleFormat, { roundNum, groupKey: letter, separator: ' ' });
  const roleA = await ensureGroupRole(interaction, store, groupA, roleNameFor(A.letter), 'Group swap').catch(() => null);
  const roleB = await ensureGroupRole(interaction, store, groupB, roleNameFor(B.letter), 'Group swap').catch(() => null);

  if (!roleA || !roleB) {
    warnings.push('⚠️ I couldn\'t find or create one of the group roles, so roles weren\'t moved — ask an admin to check my **Manage Roles** permission.');
  } else {
    // Whoever holds the old group role on a swapped team (always the owner)
    // moves to the new group's role. Planned first, applied after, so a person
    // listed on both teams doesn't lose a role they still need.
    const plan = new Map(); // userId -> { member, remove:Set, add:Set }
    // The group role is only handed out once a group's channel exists (before
    // that, players just hold the tournament's Registered role), so a swap into
    // a channel-less group only takes the old role off — Create Channels gives
    // the new group's role later.
    const moves = [{ team: A.team, oldRole: roleA, newRole: roleB, newHasChannel: Boolean(groupB.channelId) }];
    if (!emptyB) moves.push({ team: B.team, oldRole: roleB, newRole: roleA, newHasChannel: Boolean(groupA.channelId) });
    for (const { team, oldRole, newRole, newHasChannel } of moves) {
      const ids = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
      for (const uid of ids) {
        const member = interaction.guild.members.cache.get(uid) ?? await interaction.guild.members.fetch(uid).catch(() => null);
        if (!member) {
          if (uid === team.ownerId) warnings.push(`⚠️ Couldn't find <@${uid}> in the server to update their role.`);
          continue;
        }
        const hadOld = member.roles.cache.has(oldRole.id);
        if (uid !== team.ownerId && !hadOld) continue;
        const entry = plan.get(uid) || { member, remove: new Set(), add: new Set() };
        if (hadOld) entry.remove.add(oldRole.id);
        if (newHasChannel) entry.add.add(newRole.id);
        plan.set(uid, entry);
      }
    }
    for (const [uid, { member, remove, add }] of plan) {
      const toRemove = [...remove].filter(rid => !add.has(rid));
      try {
        if (toRemove.length) {
          await member.roles.remove(toRemove, 'Group swap');
          for (const rid of toRemove) await logRoleChange(interaction.guild, tournament, { member, roleId: rid, added: false, reason: `Group Swap — "${A.team.team}" ↔ "${B.empty ? 'empty slot' : B.team.team}"` });
        }
        if (add.size) {
          await member.roles.add([...add], 'Group swap');
          for (const rid of add) await logRoleChange(interaction.guild, tournament, { member, roleId: rid, added: true, reason: `Group Swap — "${A.team.team}" ↔ "${B.empty ? 'empty slot' : B.team.team}"` });
        }
      } catch (err) {
        console.error(`[tournament-swap] Couldn't update roles for ${uid} in guild ${req.guildId}: ${err.code ?? ''} ${err.message}`);
        warnings.push(`⚠️ Couldn't update <@${uid}>'s group role — check my **Manage Roles** permission and role position.`);
      }
    }
  }

  saveGuildStore(req.guildId, store);

  // Refresh the slot lists that were already published (edits in place; never
  // posts a new one).
  for (const letter of [A.letter, B.letter]) {
    const group = groups[letter];
    const embed = buildTournamentSlotListEmbed(tournament, letter, group, roundNum, getRoundDisplayName(tournament, roundNum).name);
    const targets = [
      [group.channelId, group.slotListMessageId],
      [tournament.slotManagerChannelId, group.slotListManagerMessageId],
    ];
    for (const [channelId, messageId] of targets) {
      if (!channelId || !messageId) continue;
      const channel = interaction.guild.channels.cache.get(channelId);
      const message = channel && await channel.messages.fetch(messageId).catch(() => null);
      if (message) await message.edit(channelId === group.channelId ? buildPublishedSlotListPayload(tournament, roundNum, letter, group) : { embeds: [embed] }).catch(() => {});
    }
  }

  if (emptyB) {
    return { warnings, a: { name: A.name, from: { letter: A.letter, slot: fromA }, to: { letter: B.letter, slot: toSlot } }, b: null };
  }
  return {
    warnings,
    a: { name: A.name, from: { letter: A.letter, slot: groupSlotNumber(groupA, A.idx) }, to: { letter: B.letter, slot: groupSlotNumber(groupB, B.idx) } },
    b: { name: B.name, from: { letter: B.letter, slot: groupSlotNumber(groupB, B.idx) }, to: { letter: A.letter, slot: groupSlotNumber(groupA, A.idx) } },
  };
}


// True when the member holds the Select Staff role of tournament `tid`.
function isStaffOfTournamentId(interaction, tid) {
  return isTournamentStaff(interaction, getTournamentById(interaction.guildId, tid));
}

module.exports = {
  refreshRegisterPanel,
  isStaffOfTournamentId,
  handleSlotListEditPick,
  handleSlotListEditModalSubmit,
  handleSlotListInfoPick,
  buildTournamentListPayload,
  handleTournamentListSelect,
  buildTournamentWizardPayload,
  buildTournamentRegisterPanelPayload,
  handleTournamentWizardButton,
  handleTournamentCreateModalSubmit,
  handleAddGroupModalSubmit,
  handleAutoGroupsModalSubmit,
  handleRegisterTeamModalSubmit,
  handleTourneyRegSelectPlayers,
  handleEditSettingsModalSubmit,
  handleBanUnbanModalSubmit,
  handleTimedBanModalSubmit,
  handleUnbanSelect,
  processExpiredBans,
  handleManualAddSlotModalSubmit,
  handleManualAddUserSelect,
  handleStaffUserSelect,
  handleGroupConfigCountSelect,
  handleGroupConfigMatchSelect,
  handleGroupConfigMatchModalSubmit,
  handleGroupConfigDateModalSubmit,
  handleManualAddRoundSelect,
  handleManualAddGroupSelect,
  buildQualifySelectPayload,
  handleQualifySelect,
  buildQualifyGroupSelectPayload,
  handleQualifyGroupSelect,
  buildSlotListGroupSelectPayload,
  handleSlotListSelect,
  handleSlotListEditTeamSelect,
  handleSlotListEditTeamModalSubmit,
  buildGroupPanelRepostSelectPayload,
  handleGroupPanelRepostSelect,
  handleCancelGroupSelect,
  handleCancelTeamsSelect,
  handleSlotManagerChannelSelect,
  handleRegisterPanelChannelSelect,
  handleRequiredMentionsModalSubmit,
  handleTeamsPerGroupModalSubmit,
  handleTotalSlotsModalSubmit,
  handleCreateConfirmChannelSelect,
  handleCreateRegisterRoleSelect,
  handleCreateConfirmRoleSelect,
  handleCreateSwapChannelSelect,
  handleCreateLogChannelSelect,
  handleTournamentPunishSelect,
  handleSwapSelect,
  handleSwapSearchModalSubmit,
  handleManualChannelsFormatModalSubmit,
  handleManualChannelsCategorySelect,
  handleManualChannelsRoleNameModalSubmit,
  handleSelfServiceChangeNameModalSubmit,
  handleRoundConfigSelect,
  handleRoundConfigButton,
  handleRoundCategorySelect,
  handleRoundSizeModalSubmit,
  handleRoundNamingModalSubmit,
  handleMaxRoundsModalSubmit,
};
