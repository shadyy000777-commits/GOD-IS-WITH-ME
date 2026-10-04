// A persistent, plain-English activity log for tournaments — who pressed
// what button, who ran Register Team, who created the group channels, who
// banned/cancelled/qualified a team, etc. Saved through storage.js (same
// tournament-data.json / Postgres your tournament data already lives in),
// so it survives restarts. Capped per guild so it can't grow forever.
//
// This module also drives the live "Log Channel" feature: every button
// click, dropdown pick, and form submission tied to a tournament (customId
// starting with tourney_, plus the group-panel select menus that don't) is
// turned into a short, readable line and posted to the tournament's
// configured Log Channel in real time, in addition to being saved here.

const { EmbedBuilder } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./tn-storage');

const MAX_ENTRIES = 1000; // per guild — oldest entries fall off the front

// Turns a raw customId / action code into a short human-readable label so
// the log (and the AI, if it's ever fed this) reads like a sentence
// instead of a wall of customId strings.
const LABELS = {
  'tourney_wizard_register_team': 'clicked Register Team',
  'tourney_wizard_group_publish': 'published the registration panel',
  'channels_created': 'created the group channels',
  'team_registered': 'registered a team',
  'team_banned': 'banned a team',
  'team_unbanned': 'unbanned a team',
  'team_cancelled': 'self-cancelled their registration',
  'team_qualified': 'marked teams as qualified',
};

// Friendly display names for the tournament bot's customIds, keyed by the
// base id (the part before the first ':'). Used for the live Log Channel
// feed. Not every customId needs to be listed — anything missing falls
// back to a readable auto-generated name (see humanizeCustomId below), so
// new buttons/menus still produce a sensible log line without this map
// being kept perfectly in sync.
const NAMES = {
  // Main tournament panel
  tourney_wizard_toggle: 'Start/Pause Registration',
  tourney_wizard_manage_groups: 'Manage Groups',
  tourney_wizard_edit_settings: 'Edit Settings',
  tourney_wizard_edit_modal: 'the Edit Settings form',
  tourney_wizard_create_channels: 'Create Channels',
  tourney_wizard_create_channels_manual: 'Create Channels (manual)',
  tourney_wizard_ban_unban: 'Ban/Unban',
  tourney_wizard_cancel_slots: 'Cancel Slots',
  tourney_wizard_manual_add: 'Manually Add Slot',
  tourney_wizard_post_register_panel: 'Post Register Panel',
  tourney_wizard_slot_manager_channel: 'Slot Manager',
  tourney_wizard_excel_export: 'Excel Export',
  tourney_wizard_export_data: 'Export Data',
  tourney_wizard_select_staff: 'Select Staff',
  tourney_wizard_reset: 'Reset Tournament',
  tourney_wizard_reset_confirm: 'Reset Tournament (confirmed)',
  tourney_wizard_reset_cancel: 'Reset Tournament (cancelled)',
  tourney_wizard_delete: 'Delete Tournament',
  tourney_wizard_delete_confirm: 'Delete Tournament (confirmed)',
  tourney_wizard_delete_cancel: 'Delete Tournament (cancelled)',
  tourney_wizard_back_to_list: 'Back to Tournament List',
  tourney_wizard_help: 'Help',
  tourney_wizard_refresh: 'Refresh Panel',
  tourney_wizard_create: 'Create Tournament',
  tourney_wizard_create_modal: 'the Create Tournament form',
  tourney_wizard_manage_rounds: 'Manage Rounds',
  tourney_list_select: 'the Tournament List menu',

  // Settings screen (letters match the panel)
  tourney_create_settings_b: 'Settings — B. Confirm Channel',
  tourney_create_settings_c: 'Settings — C. Required Mentions',
  tourney_create_settings_d: 'Settings — D. Teams per Group',
  tourney_create_settings_e: 'Settings — E. Total Slots',
  tourney_create_settings_fake_tag: 'Settings — F. Fake Tag toggle',
  tourney_create_settings_g: 'Settings — G. Register Role',
  tourney_create_settings_h: 'Settings — H. Group Swap Channel',
  tourney_create_settings_i: 'Settings — I. Registration Role',
  tourney_create_settings_j: 'Settings — J. Log Channel',
  tourney_create_settings_save: 'Settings — Save',
  tourney_create_settings_back: 'Settings — Go Back',
  tourney_create_confirmchannel_select: 'Settings — Confirm Channel picker',
  tourney_create_registerrole_select: 'Settings — Register Role picker',
  tourney_create_confirmrole_select: 'Settings — Registration Role picker',
  tourney_create_swapchannel_select: 'Settings — Group Swap Channel picker',
  tourney_create_logchannel_select: 'Settings — Log Channel picker',
  'tourney_create_settings_d_modal': 'Settings — Required Mentions form',
  'tourney_create_settings_e_modal': 'Settings — Teams per Group form',
  'tourney_create_settings_f_modal': 'Settings — Total Slots form',

  // Groups / rounds
  tourney_wizard_group_config: 'a Group Config panel',
  tourney_wizard_group_publish: 'Publish Slot List',
  tourney_wizard_group_slotedit: 'Slot List — Edit button',
  tourney_wizard_group_slotinfo: 'Slot List — Info button',
  tourney_slotedit_select: 'the Slot List Edit team picker',
  tourney_slotedit_modal: 'the Slot List Edit Team Name form',
  tourney_slotinfo_select: 'the Slot List Info team picker',
  tourney_wizard_group_punish: 'Punish Team',
  tourney_wizard_group_result: 'Result',
  tourney_wizard_group_chat: 'the group channel Open/Close toggle',
  tourney_wizard_group_configdate: 'Group Config — date',
  tourney_group_cfg_count: 'Group Config — match count',
  tourney_group_cfg_match: 'Group Config — edit a match',
  tourney_group_cfg_match_modal: 'Group Config — match timing form',
  tourney_group_cfg_date_modal: 'Group Config — match date form',
  tourney_round_config_select: 'the Round Config menu',
  tourney_round_config_maxrounds: 'Round Config — Max Rounds',
  tourney_round_config_back: 'Round Config — Back',
  tourney_round_config_size: 'Round Config — round size',
  tourney_round_config_pick_category: 'Round Config — pick category',
  tourney_round_config_clear_category: 'Round Config — clear category',
  tourney_round_config_naming: 'Round Config — edit naming',
  tourney_round_config_category_back: 'Round Config — category back',
  tourney_round_category_select: 'a category picker for a round',
  tourney_round_size_modal: 'a round size form',
  tourney_round_naming_modal: 'a round naming form',
  tourney_round_maxrounds_modal: 'the Max Rounds form',

  // Registration
  tourney_wizard_register_retry: 'Register Team (retry)',
  tourney_wizard_register_modal: 'the Register Team form',
  tourney_reg_select_players: 'the Register Team teammate picker',
  tourney_wizard_reg_confirm: 'Register Team — confirmed',
  tourney_wizard_reg_cancel: 'Register Team — cancelled',

  // Manually Add Slot
  tourney_manual_add_user_select: 'Manually Add Slot — player picker',
  tourney_manual_add_round_select: 'Manually Add Slot — round picker',
  tourney_manual_add_group_select: 'Manually Add Slot — group picker',
  tourney_wizard_manual_add_modal: 'the Manually Add Slot form',
  tourney_wizard_manual_add_retry: 'Manually Add Slot (retry)',

  // Ban / unban
  tourney_wizard_ban_start: 'Ban/Unban — Ban a team',
  tourney_wizard_ban_modal: 'the Ban Team form',
  tourney_wizard_ban_modal_legacy: 'the Ban Team form',
  tourney_ban_name_modal: 'a timed ban form',
  tourney_wizard_unban_pick: 'Ban/Unban — Unban a team',
  tourney_unban_select: 'the Unban Team picker',

  // Cancel / qualify
  tourney_cancel_group_select: 'Cancel Slots — group picker',
  cancel_select_teams: 'Cancel Slots — team picker',
  tourney_qualify_group_select: 'the Qualify Teams group picker',
  qualify_select_teams: 'the Qualify Teams picker',
  tourney_punish_select_teams: 'the Punish Team picker',

  // Channel creation
  tourney_wizard_manual_channels_set_format: 'Create Channels — channel name format',
  tourney_wizard_manual_channels_set_category: 'Create Channels — category name',
  tourney_wizard_manual_channels_set_role: 'Create Channels — role name',
  tourney_wizard_manual_channels_auto_create: 'Create Channels — Auto Channels',
  tourney_wizard_manual_channels_cancel: 'Create Channels — cancelled',
  tourney_manual_channels_format_modal: 'the channel name format form',
  tourney_manual_channels_rolename_modal: 'the role name form',
  tourney_wizard_manual_channels_category_select: 'the group-channels category picker',
  tourney_wizard_manual_channels_category_back: 'Create Channels — back',

  // Staff
  tourney_staff_user_select: 'the Select Staff picker',

  // Slot manager / register panel placement
  tourney_slotmanager_channel_select: 'the Slot Manager channel picker',
  tourney_slotlist_select: 'the Slot List menu',
  tourney_wizard_slotlist_edit: 'Edit Team Names',
  tourney_wizard_slotlist_edit_back: 'Edit Team Names — back',
  tourney_slotlist_edit_team_select: 'the Edit Team Names team picker',
  tourney_slotlist_edit_team_modal: 'the Edit Team Name form',
  tourney_register_panel_channel_select: 'the Register Panel channel picker',

  // Player self-service
  tourney_wizard_selfservice_cancel: 'Cancel My Registration',
  tourney_wizard_selfservice_cancel_confirm: 'Cancel My Registration — confirmed',
  tourney_wizard_selfservice_cancel_abort: 'Cancel My Registration — backed out',
  tourney_wizard_selfservice_my_groups: 'My Groups',
  tourney_wizard_selfservice_change_name: 'Change Team Name',
  tourney_selfservice_change_name_modal: 'the Change Team Name form',
  tourney_wizard_selfservice_swap: 'Group Swap',

  // Swaps
  tourney_swap_select: 'the Group Swap team picker',
  tourney_wizard_swap_send: 'Send Swap Request',
  tourney_wizard_swap_cancel: 'Cancel Swap Request',
  tourney_wizard_swap_page: 'paged the Group Swap list',
  tourney_wizard_swap_accept: 'Accept Swap Request',
  tourney_wizard_swap_reject: 'Reject Swap Request',
  tourney_wizard_swap_toggle: 'the Group Swap toggle',
};

function humanizeCustomId(base) {
  return base
    .replace(/^tourney_(wizard_|create_|round_|group_)?/, '')
    .replace(/_/g, ' ')
    .trim() || base;
}

// customId -> a short display name, e.g. 'tourney_wizard_manage_groups' ->
// 'Manage Groups', 'tourney_wizard_group_publish:123:1:A' -> 'Publish Slot List'.
function friendlyName(customId) {
  const base = customId.split(':')[0];
  return NAMES[base] || humanizeCustomId(base);
}

function describe(entry) {
  if (entry.label) return entry.label;
  const baseId = entry.customId ? entry.customId.split(':')[0] : null;
  const known = LABELS[entry.action] || LABELS[entry.customId] || LABELS[baseId];
  if (known) return known;
  if (entry.customId) return `used ${entry.customId}`;
  return entry.action || 'did something';
}

function logActivity(guildId, entry) {
  if (!guildId) return;
  try {
    const store = getGuildStore(guildId);
    if (!store.activityLog) store.activityLog = [];
    store.activityLog.push({ ts: Date.now(), ...entry });
    while (store.activityLog.length > MAX_ENTRIES) store.activityLog.shift();
    saveGuildStore(guildId, store);
  } catch (err) {
    console.error('[activity-log] Failed to record activity:', err);
  }
}

// Newest first.
function getRecentActivity(guildId, limit = 25) {
  const store = getGuildStore(guildId);
  const log = store.activityLog || [];
  return log.slice(-limit).reverse();
}

function getFullActivityText(guildId) {
  const store = getGuildStore(guildId);
  const log = store.activityLog || [];
  return log
    .map(e => `[${new Date(e.ts).toISOString()}] ${e.username || e.userId || 'unknown'} — ${describe(e)}`)
    .join('\n');
}

// ---------------------------------------------------------------------
// Live Log Channel feed
// ---------------------------------------------------------------------

async function sendToLogChannel(guild, tournament, description) {
  if (!guild || !tournament || !tournament.logChannelId) return;
  try {
    const channel = guild.channels.cache.get(tournament.logChannelId)
      ?? await guild.channels.fetch(tournament.logChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(description.slice(0, 4000))
      .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error('[tournament-log] Failed to send to log channel:', err);
  }
}

// Logs a role being added to or taken from a member — the piece that
// interaction-click logging alone can't see, since plenty of role changes
// happen deep inside handler code (or on the background ban-expiry timer,
// with no admin present at all) rather than as a direct response to a
// click. Call this right after every roles.add()/roles.remove() in the
// tournament code so nothing slips through silently.
async function logRoleChange(guild, tournament, { member, roleId, added, reason }) {
  if (!tournament || !tournament.logChannelId || !guild || !roleId || !member) return;
  try {
    const role = guild.roles.cache.get(roleId);
    const roleLabel = role ? `**@${role.name}**` : `role \`${roleId}\``;
    const who = `**${member.user?.tag ?? member.displayName ?? member.id}** (<@${member.id}>)`;
    const verb = added ? 'was given the' : 'lost the';
    let line = `🔧 ${who} ${verb} ${roleLabel} role`;
    if (reason) line += ` — ${reason}`;
    await sendToLogChannel(guild, tournament, line);
  } catch (err) {
    console.error('[tournament-log] logRoleChange failed:', err);
  }
}

// Best-effort: pull whatever the user picked/typed out of a component or
// modal interaction, so the log line carries real detail (which channel,
// which role, which team name, which ban reason...) and not just "used X".
function extractDetail(interaction) {
  try {
    if (interaction.isStringSelectMenu?.()) {
      return interaction.values?.length ? `Picked: ${interaction.values.join(', ')}` : null;
    }
    if (interaction.isUserSelectMenu?.()) {
      const users = [...(interaction.users?.values() || [])].map(u => u.tag).join(', ');
      return users ? `Picked: ${users}` : null;
    }
    if (interaction.isRoleSelectMenu?.()) {
      const roles = [...(interaction.roles?.values() || [])].map(r => r.name).join(', ');
      return roles ? `Picked: @${roles}` : null;
    }
    if (interaction.isChannelSelectMenu?.()) {
      const channels = [...(interaction.channels?.values() || [])].map(c => `#${c.name}`).join(', ');
      return channels ? `Picked: ${channels}` : null;
    }
    if (interaction.isModalSubmit?.()) {
      const fields = [...(interaction.fields?.fields?.values() || [])]
        .map(f => `${f.customId}: ${f.value}`)
        .filter(line => line.trim().length > 0);
      return fields.length ? fields.join('\n') : null;
    }
  } catch (err) {
    console.error('[tournament-log] Failed to extract interaction detail:', err);
  }
  return null;
}

function verbFor(interaction) {
  if (interaction.isButton?.()) return 'clicked';
  if (interaction.isModalSubmit?.()) return 'submitted';
  return 'used';
}

// Fires on every tournament-related button, select menu, and modal submit
// (see index.js) and, if that tournament has a Log Channel configured,
// posts a one-line summary of what just happened. Never throws — logging
// must never be able to break the actual bot action.
async function logInteraction(interaction, tournament) {
  if (!tournament || !tournament.logChannelId || !interaction.guild) return;
  try {
    const name = friendlyName(interaction.customId);
    const verb = verbFor(interaction);
    const channelName = interaction.channel?.name;
    const panelTitle = interaction.message?.embeds?.[0]?.title;
    let line = `**${interaction.user.tag}** (<@${interaction.user.id}>) ${verb} **${name}**`;
    if (channelName) line += ` in #${channelName}`;
    if (panelTitle) line += ` (panel: “${panelTitle}”)`;
    const detail = extractDetail(interaction);
    if (detail) line += `\n> ${detail.replace(/\n/g, '\n> ')}`;

    logActivity(interaction.guildId, {
      userId: interaction.user.id,
      username: interaction.user.tag,
      customId: interaction.customId,
      label: `${verb} ${name}`,
    });
    await sendToLogChannel(interaction.guild, tournament, line);
  } catch (err) {
    console.error('[tournament-log] logInteraction failed:', err);
  }
}

module.exports = {
  logActivity, getRecentActivity, getFullActivityText, describe,
  sendToLogChannel, logInteraction, friendlyName, logRoleChange,
};
