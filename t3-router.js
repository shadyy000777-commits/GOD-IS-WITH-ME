// Plugs the T3 scrims bot into this bot. Everything T3-specific lives behind
// the t3* namespaces and the "t3-" prefixed files, and T3's buttons / menus /
// modals are matched by their own (non-overlapping) customIds here, so they
// can never fire a main-bot handler or vice versa. index.js only calls:
//   routeT3Interaction(interaction)  -> true if T3 handled it
//   startT3Jobs(client)              -> T3 background timers
//   handleT3ChannelDelete(channel)   -> T3 cleanup when a channel is deleted
const t3Registration = require('./t3-registration-handlers');
const t3LivePanel = require('./t3-live-panel-handlers');
const t3GroupSchedule = require('./t3-group-schedule-handlers');
const t3AdminPanel = require('./t3-admin-panel-handlers');
const t3RoundPromotion = require('./round-promotion-handlers');
const t3Slotlist = require('./slotlist-handlers');
const t3Punish = require('./t3-punish-handlers');
const t3ManageSlot = require('./manage-slot-handlers');
const t3ChannelCleanup = require('./channel-cleanup-handlers');

const T3 = {
  button: [
    ['=', 't3reg_start', t3Registration.handleRegisterButton],
    ['=', 't3reg_edit_start', t3Registration.handleEditButton],
    ['=', 't3reg_continue_2', t3Registration.handleStep2Button],
    ['=', 't3reg_continue_3', t3Registration.handleStep3Button],
    ['=', 't3reg_retry_step1', t3Registration.handleRetryStep1],
    ['=', 't3reg_retry_step2', t3Registration.handleRetryStep2],
    ['=', 't3reg_retry_step3', t3Registration.handleRetryStep3],
    ['^', 't3ap:', t3AdminPanel.handleButton],
    // Buttons from the pre-redesign admin panel (already posted in channels).
    ['=', 'admin_post_reg_panel', t3AdminPanel.handleLegacyPanelInteraction],
    ['=', 'admin_post_live_panel', t3AdminPanel.handleLegacyPanelInteraction],
    ['=', 'admin_clear_role', t3AdminPanel.handleLegacyPanelInteraction],
    ['=', 'admin_set_groups_per_day', t3AdminPanel.handleLegacyPanelInteraction],
    ['=', 'admin_edit_daily_schedule', t3AdminPanel.handleLegacyPanelInteraction],
    ['=', 'admin_group_schedule', t3AdminPanel.handleLegacyPanelInteraction],
    ['^', 't3_result:', t3RoundPromotion.handleResultButton],
    ['^', 't3_reminder:', t3RoundPromotion.handleReminderButton],
    ['^', 't3_publish:', t3Slotlist.handlePublishButton],
    ['^', 't3_open:', t3RoundPromotion.handleOpenToggleButton],
    ['^', 't3_manage:', t3ManageSlot.handleManageSlotButton],
    ['^', 't3_punish:', t3Punish.handlePunishButton],
    ['^', 't3_delete_confirm:', t3RoundPromotion.handleDeleteConfirmButton],
    ['^', 't3_delete_cancel:', t3RoundPromotion.handleDeleteCancelButton],
    ['^', 't3_delete:', t3RoundPromotion.handleDeleteButton],
  ],
  userSelect: [
    ['=', 't3reg_select_players', t3Registration.handleSelectPlayers],
    ['=', 't3ap_staff_select', t3AdminPanel.handleStaffSelect],
  ],
  channelSelect: [
    ['^', 't3ap_channel:', t3AdminPanel.handleChannelSelect],
    ['=', 'admin_log_channel_select', t3AdminPanel.handleLegacyPanelInteraction],
    ['=', 'admin_post_reg_panel_channel_select', t3AdminPanel.handleLegacyPanelInteraction],
    ['=', 'admin_post_live_panel_channel_select', t3AdminPanel.handleLegacyPanelInteraction],
  ],
  roleSelect: [
    ['^', 't3ap_role:', t3AdminPanel.handleRoleSelect],
    ['=', 'admin_role_select', t3AdminPanel.handleLegacyPanelInteraction],
  ],
  stringSelect: [
    ['=', 't3_group_schedule_select', t3GroupSchedule.handleGroupScheduleSelect],
    ['^', 't3_qualify:', t3RoundPromotion.handleQualifySelectSubmit],
    ['^', 't3_punish_select:', t3Punish.handlePunishSelect],
    ['=', 't3_manage_group_select', t3ManageSlot.handleManageSlotGroupSelect],
  ],
  modal: [
    ['=', 't3reg_step1', t3Registration.handleStep1Submit],
    ['=', 't3reg_step2', t3Registration.handleStep2Submit],
    ['=', 't3reg_step3', t3Registration.handleStep3Submit],
    ['^', 't3_group_schedule_modal:', t3GroupSchedule.handleGroupScheduleModalSubmit],
    ['=', 'daily_schedule_modal', t3GroupSchedule.handleDailyScheduleModalSubmit],
    ['=', 'admin_groups_per_day_modal', t3AdminPanel.handleGroupsPerDayModalSubmit],
    ['=', 't3ap_group_panel_modal', t3AdminPanel.handleGroupPanelModalSubmit],
  ],
};

function findHandler(table, id) {
  for (const [kind, key, fn] of table) {
    if (kind === '=' ? id === key : id.startsWith(key)) return fn;
  }
  return null;
}

async function routeT3Interaction(interaction) {
  let table = null;
  if (interaction.isButton()) table = T3.button;
  else if (interaction.isUserSelectMenu()) table = T3.userSelect;
  else if (interaction.isChannelSelectMenu()) table = T3.channelSelect;
  else if (interaction.isRoleSelectMenu()) table = T3.roleSelect;
  else if (interaction.isStringSelectMenu()) table = T3.stringSelect;
  else if (interaction.isModalSubmit()) table = T3.modal;
  if (!table) return false;
  const fn = findHandler(table, interaction.customId);
  if (!fn) return false;
  await fn(interaction);
  return true;
}

function startT3Jobs(client) {
  t3LivePanel.startLivePanelDayRollover(client);
  t3Punish.startScrimsBanExpiry(client);
}

function handleT3ChannelDelete(channel) {
  t3ChannelCleanup.handleChannelDeleted(channel).catch((err) =>
    console.error('[t3] Failed to clean up after channel deletion:', err));
}

module.exports = { routeT3Interaction, startT3Jobs, handleT3ChannelDelete };
