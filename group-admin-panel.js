const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { getGuildStore } = require('./storage');
const { isGroupChannelOpen } = require('./group-channel-access');

// Same bar every other admin-only action in this codebase uses (schedule
// edits, punishing teams, etc.) — keeps "who can click these buttons"
// consistent across the whole bot. Also lets in anyone holding the
// SCRIMS MANAGEMENT role (set via the admin panel's "Select Staff" button —
// see admin-panel-handlers.js): that role is only ever checked here, so
// staff with it can use this group admin panel and nothing else the bot
// gates behind Manage Server.
//
// Staff with that role may only use these four group panel actions:
// Publish Slot List, Reminder, Result (button + its modal) and Open/Close.
// Punish Team and Config stay Manage Server only.
const STAFF_ACTIONS = new Set([
  'group_admin_publish',
  'group_admin_reminder',
  'group_admin_result',
  'group_admin_result_modal',
  'group_admin_open',
]);

function hasAdminAccess(interaction, action) {
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  const store = getGuildStore(interaction.guildId);
  const staffRoleId = store.settings && store.settings.scrimsManagementRoleId;
  if (!staffRoleId || !action || !STAFF_ACTIONS.has(action)) return false;

  return interaction.member.roles.cache.has(staffRoleId);
}

// The control buttons, attached directly onto that group's header message
// (the "Slots filled + match schedule" embed) rather than a separate
// standalone message — so they sit right under that embed instead of
// introducing their own box. Everything here is admin-only (Manage Server,
// or the SCRIMS MANAGEMENT staff role) — anyone else tapping one gets an
// ephemeral "no permission" reply (see group-admin-handlers.js) and nothing
// in the channel changes. Change Slot is the one exception: it's meant for
// any player in the group to use on themselves, so it's routed separately
// (see group_change_slot: in index.js) instead of through
// handleGroupAdminButton's admin gate.
function buildGroupAdminPanelRows(groupLetter, store) {
  const open = isGroupChannelOpen(store, groupLetter);

  const publishRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`group_admin_publish:${groupLetter}`)
      .setLabel('Publish Slot List')
      .setEmoji('📤')
      .setStyle(ButtonStyle.Success),
  );

  const punishResultRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`group_admin_punish:${groupLetter}`)
      .setLabel('Punish Team')
      .setEmoji('🔨')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`group_admin_result:${groupLetter}`)
      .setLabel('Result')
      .setEmoji('🌟')
      .setStyle(ButtonStyle.Primary),
  );

  const configOpenRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`group_admin_manage:${groupLetter}`)
      .setLabel('Config')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary),
    // Single toggle button: shows "Open" (locked right now, click to
    // unlock) when closed, and flips to "Close" (unlocked right now, click
    // to lock) once opened — same customId either way, the handler reads
    // the group's current state itself to decide which way to flip it.
    new ButtonBuilder()
      .setCustomId(`group_admin_open:${groupLetter}`)
      .setLabel(open ? 'Close' : 'Open')
      .setEmoji(open ? '🔒' : '🔓')
      .setStyle(open ? ButtonStyle.Danger : ButtonStyle.Success),
  );

  const reminderRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`group_admin_reminder:${groupLetter}`)
      .setLabel('Reminder')
      .setEmoji('🔔')
      .setStyle(ButtonStyle.Danger),
  );

  // Not part of the reference layout — kept as a 5th row so Manage Slot
  // (players changing their own slot) doesn't silently lose its only UI
  // entry point. Discord caps messages at 5 action rows, so this is the
  // last one available; drop it if you'd rather match the reference
  // exactly. There's no manual delete button anymore — see
  // scheduleGroupAutoDelete in group-admin-handlers.js: a group's channel
  // and role are deleted automatically 5 hours after its result is posted.
  const extraRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`group_change_slot:${groupLetter}`)
      .setLabel('Manage Slot')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    // Team owners only (checked in group-transfer-handlers.js) — hands the
    // group role to another player, e.g. if the owner can't play that match.
    new ButtonBuilder()
      .setCustomId(`group_transfer_role:${groupLetter}`)
      .setLabel('Transfer Role')
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Secondary),
  );

  return [publishRow, punishResultRow, configOpenRow, reminderRow, extraRow];
}

module.exports = { hasAdminAccess, buildGroupAdminPanelRows };
