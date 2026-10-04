// Plugs the Tournament bot into this bot (same pattern as t3-router.js).
//
// Everything tournament-specific lives behind the "tn-" / "cmd-tn-" / "pcmd-tn-"
// file names and its own storage (tournament-data.json / the tournament_guilds
// table), so it can never read or overwrite Rebound's or T3's data.
//
// Tournament buttons / menus / modals are matched here by their own customIds
// (tourney_*, qualify_select_teams:, cancel_select_teams:, staffp:,
// staffactivity_*, ssvp*), none of which any Rebound or T3 handler uses, so
// they can never fire a Rebound / T3 handler or vice versa. index.js only calls:
//
//   initTournament()                        -> tournament storage (before login)
//   flushTournament()                       -> flush on shutdown
//   registerTournamentEvents(client)        -> timers + gateway listeners
//   routeTournamentInteraction(interaction) -> true if it was a tournament interaction
//   handleTournamentMessage(message)        -> true if a tournament feature consumed the message
//   guardTournamentCommand(ctx, command)    -> lock check for slash / prefix tournament commands
//   isTournamentCommand(command)            -> true for cmd-tn-* / pcmd-tn-* commands
const { MessageFlags, Events } = require('discord.js');

const tnWizard = require('./tn-tournament-wizard-handlers');
const { initStorage, flushStorage, getGuildStore, peekGuildStore } = require('./tn-storage');
const { canManageBot, envAllowedIds, isAllowedUser, canUseBot } = require('./tn-access');
const tnAiChat = require('./tn-ai-chat');
const staffActivity = require('./tn-staff-activity');
const staffPanel = require('./pcmd-tn-staff');
const staffPanelHandlers = require('./tn-staff-panel-handlers');
const tournamentLog = require('./tn-tournament-activity-log');
const panelInactivity = require('./tn-panel-inactivity');
const { getTournamentStore, getTournamentById } = require('./tn-tournament-store');
const ssVerification = require('./tn-ss-verification');
const ssVerifyPanel = require('./tn-ss-verify-panel-handlers');

const NOT_AUTHORIZED = '<a:qg_hehe128:1553059818833584298>';

// ---------------------------------------------------------------------------
// Which commands belong to the tournament bot
// ---------------------------------------------------------------------------
function isTournamentCommand(command) {
  return Boolean(command && command.namespace === 'tn');
}

function canUseBotMember(member) {
  return canUseBot(member);
}

// Slash: returns true if the interaction may continue. Replies itself if not.
async function guardTournamentCommand(interaction, command) {
  if (canUseBot(interaction.member)) return true;
  await interaction.reply({ content: NOT_AUTHORIZED, flags: MessageFlags.Ephemeral }).catch(() => {});
  return false;
}

// Prefix: returns true if the message may continue. Replies itself if not.
async function guardTournamentPrefixCommand(message, command) {
  if (!canUseBot(message.member)) {
    await message.reply(NOT_AUTHORIZED).catch(() => {});
    return false;
  }
  if (command.adminOnly && !canManageBot(message.member)) {
    await message.reply(NOT_AUTHORIZED).catch(() => {});
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Interaction routing
// ---------------------------------------------------------------------------
// Is this customId one the tournament bot owns?
function isTournamentCustomId(id) {
  if (!id) return false;
  return id.startsWith('tourney_')
    || id.startsWith('qualify_select_teams:')
    || id.startsWith('cancel_select_teams:')
    || id.startsWith('staffp:')
    || id.startsWith('staffactivity_')
    || id.startsWith('ssvp');
}

// Player-facing parts of the tournament system that EVERYONE may use, even
// without TOURNAMENT ADMIN / ELITE or being in ALLOWED_USER_IDS (public Register
// panel, Slot-Manager self-service panel, group-swap requests). Their handlers
// do their own checks. Everything else stays behind the tournament lock.
const PUBLIC_BUTTON_PREFIXES = [
  'tourney_wizard_register_team:',
  'tourney_wizard_register_retry:',
  'tourney_wizard_selfservice_',
];
const PUBLIC_BUTTON_IDS = ['tourney_wizard_reg_confirm', 'tourney_wizard_reg_cancel'];
const PUBLIC_USER_SELECT_IDS = ['tourney_reg_select_players'];
const PUBLIC_STRING_SELECT_PREFIXES = ['tourney_swap_select:'];
const PUBLIC_MODAL_PREFIXES = ['tourney_wizard_register_modal:', 'tourney_selfservice_change_name_modal:', 'tourney_swap_search_modal:'];

function isPublicPlayerInteraction(interaction) {
  const id = interaction.customId;
  if (!id) return false;
  if (id.startsWith('staffp:') && staffActivity.isTrackedMember(interaction.guildId, interaction.member)) return true;
  if (interaction.isButton() && id.startsWith('tourney_wizard_group_')) return true;
  if (interaction.isStringSelectMenu() && id.startsWith('qualify_select_teams:')) return true;
  if (interaction.isStringSelectMenu() && id.startsWith('tourney_slotinfo_select:')) {
    return tnWizard.isStaffOfTournamentId(interaction, id.split(':')[1]);
  }
  const cfgPrefixes = ['tourney_group_cfg_count:', 'tourney_group_cfg_match:', 'tourney_group_cfg_match_modal:', 'tourney_group_cfg_date_modal:'];
  if ((interaction.isStringSelectMenu() || interaction.isModalSubmit()) && cfgPrefixes.some(p => id.startsWith(p))) {
    return tnWizard.isStaffOfTournamentId(interaction, id.split(':')[1]);
  }
  if (interaction.isButton()) {
    if (PUBLIC_BUTTON_IDS.includes(id)) return true;
    if (PUBLIC_BUTTON_PREFIXES.some(p => id.startsWith(p))) return true;
    return id.startsWith('tourney_wizard_swap_') && id !== 'tourney_wizard_swap_toggle';
  }
  if (interaction.isUserSelectMenu()) return PUBLIC_USER_SELECT_IDS.includes(id);
  if (interaction.isStringSelectMenu()) return PUBLIC_STRING_SELECT_PREFIXES.some(p => id.startsWith(p));
  if (interaction.isModalSubmit()) return PUBLIC_MODAL_PREFIXES.some(p => id.startsWith(p));
  return false;
}

// Dispatch tables. kind: '=' exact, '^' startsWith, ':' exact OR startsWith(key + ':').
// First match wins (same order as the standalone tournament bot).
const W = tnWizard;
const TABLES = {
  button: [
    ['^', 'tourney_wizard_', W.handleTournamentWizardButton],
    ['^', 'tourney_create_settings_', W.handleTournamentWizardButton],
    ['^', 'tourney_round_config_', W.handleRoundConfigButton],
    ['^', 'staffactivity_mode:', staffPanel.handleModeButton],
    ['=', 'staffactivity_leaderboard', staffPanel.handleLeaderboardButton],
    ['^', 'ssvp:', ssVerifyPanel.handleSsVerifyPanelButton],
  ],
  userSelect: [
    ['=', 'tourney_reg_select_players', W.handleTourneyRegSelectPlayers],
    ['=', 'tourney_manual_add_user_select', W.handleManualAddUserSelect],
    ['=', 'tourney_staff_user_select', W.handleStaffUserSelect],
  ],
  roleSelect: [
    ['=', 'tourney_create_registerrole_select', W.handleCreateRegisterRoleSelect],
    ['=', 'ssvp_role_select', ssVerifyPanel.handleSsVerifyRoleSelect],
    ['=', 'tourney_create_confirmrole_select', W.handleCreateConfirmRoleSelect],
  ],
  channelSelect: [
    ['=', 'tourney_slotmanager_channel_select', W.handleSlotManagerChannelSelect],
    ['=', 'tourney_register_panel_channel_select', W.handleRegisterPanelChannelSelect],
    ['=', 'tourney_create_confirmchannel_select', W.handleCreateConfirmChannelSelect],
    ['=', 'tourney_wizard_manual_channels_category_select', W.handleManualChannelsCategorySelect],
    ['=', 'tourney_create_swapchannel_select', W.handleCreateSwapChannelSelect],
    ['=', 'tourney_create_logchannel_select', W.handleCreateLogChannelSelect],
    ['^', 'tourney_round_category_select:', W.handleRoundCategorySelect],
    ['^', 'ssvp_channel_select:', ssVerifyPanel.handleSsVerifyChannelSelect],
  ],
  stringSelect: [
    ['=', 'tourney_list_select', W.handleTournamentListSelect],
    ['^', 'qualify_select_teams:', W.handleQualifySelect],
    [':', 'tourney_qualify_group_select', W.handleQualifyGroupSelect],
    [':', 'tourney_cancel_group_select', W.handleCancelGroupSelect],
    ['^', 'tourney_manual_add_round_select:', W.handleManualAddRoundSelect],
    ['^', 'tourney_manual_add_group_select:', W.handleManualAddGroupSelect],
    ['=', 'tourney_round_config_select', W.handleRoundConfigSelect],
    ['^', 'cancel_select_teams:', W.handleCancelTeamsSelect],
    [':', 'tourney_slotlist_select', W.handleSlotListSelect],
    ['^', 'tourney_slotedit_select:', W.handleSlotListEditPick],
    ['^', 'tourney_slotinfo_select:', W.handleSlotListInfoPick],
    ['^', 'tourney_slotlist_edit_team_select:', W.handleSlotListEditTeamSelect],
    [':', 'tourney_grouppanel_repost_select', W.handleGroupPanelRepostSelect],
    ['^', 'tourney_punish_select_teams:', W.handleTournamentPunishSelect],
    ['^', 'tourney_swap_select:', W.handleSwapSelect],
    ['=', 'tourney_unban_select', W.handleUnbanSelect],
    ['^', 'tourney_group_cfg_count:', W.handleGroupConfigCountSelect],
    ['=', 'staffactivity_user_select', staffPanel.handleUserSelect],
    ['=', 'ssvp_platform_select', ssVerifyPanel.handleSsVerifyPlatformSelect],
    ['=', 'ssvp_edit_select', ssVerifyPanel.handleSsVerifyEditSelect],
    ['^', 'tourney_group_cfg_match:', W.handleGroupConfigMatchSelect],
  ],
  modal: [
    ['=', 'tourney_wizard_create_modal', W.handleTournamentCreateModalSubmit],
    ['=', 'tourney_wizard_group_modal', W.handleAddGroupModalSubmit],
    ['=', 'tourney_wizard_auto_groups_modal', W.handleAutoGroupsModalSubmit],
    ['^', 'tourney_wizard_register_modal:', W.handleRegisterTeamModalSubmit],
    ['=', 'tourney_wizard_edit_modal', W.handleEditSettingsModalSubmit],
    ['=', 'tourney_wizard_ban_modal', W.handleBanUnbanModalSubmit],
    ['=', 'tourney_ban_name_modal', W.handleTimedBanModalSubmit],
    ['^', 'tourney_wizard_manual_add_modal:', W.handleManualAddSlotModalSubmit],
    ['=', 'tourney_create_settings_d_modal', W.handleRequiredMentionsModalSubmit],
    ['=', 'tourney_create_settings_e_modal', W.handleTeamsPerGroupModalSubmit],
    ['=', 'tourney_create_settings_f_modal', W.handleTotalSlotsModalSubmit],
    ['=', 'tourney_manual_channels_format_modal', W.handleManualChannelsFormatModalSubmit],
    ['=', 'tourney_manual_channels_rolename_modal', W.handleManualChannelsRoleNameModalSubmit],
    ['^', 'tourney_swap_search_modal:', W.handleSwapSearchModalSubmit],
    ['^', 'tourney_selfservice_change_name_modal:', W.handleSelfServiceChangeNameModalSubmit],
    ['^', 'tourney_slotedit_modal:', W.handleSlotListEditModalSubmit],
    ['^', 'tourney_slotlist_edit_team_modal:', W.handleSlotListEditTeamModalSubmit],
    ['^', 'tourney_round_size_modal:', W.handleRoundSizeModalSubmit],
    ['^', 'tourney_round_naming_modal:', W.handleRoundNamingModalSubmit],
    ['=', 'tourney_round_maxrounds_modal', W.handleMaxRoundsModalSubmit],
    ['^', 'tourney_group_cfg_match_modal:', W.handleGroupConfigMatchModalSubmit],
    ['^', 'tourney_group_cfg_date_modal:', W.handleGroupConfigDateModalSubmit],
    ['=', 'ssvp_modal_details', ssVerifyPanel.handleSsVerifyDetailsModalSubmit],
    ['=', 'ssvp_modal_addkey', ssVerifyPanel.handleSsVerifyAddKeyModalSubmit],
  ],
};

function findHandler(table, id) {
  for (const [kind, key, fn] of table) {
    if (kind === '=' ? id === key
      : kind === '^' ? id.startsWith(key)
        : (id === key || id.startsWith(key + ':'))) return fn;
  }
  return null;
}

function tableFor(interaction) {
  if (interaction.isButton()) return TABLES.button;
  if (interaction.isUserSelectMenu()) return TABLES.userSelect;
  if (interaction.isRoleSelectMenu()) return TABLES.roleSelect;
  if (interaction.isChannelSelectMenu()) return TABLES.channelSelect;
  if (interaction.isStringSelectMenu()) return TABLES.stringSelect;
  if (interaction.isModalSubmit()) return TABLES.modal;
  return null;
}

// Fires on every tournament button / select / modal: posts a line to the
// tournament's Log Channel (if one is set). Never throws, never delays the real action.
function logTournamentInteraction(interaction) {
  Promise.resolve().then(async () => {
    let tournament = null;
    try {
      const boundStore = getTournamentStore(interaction.guildId, interaction.user.id);
      tournament = boundStore.tournament;
      if (!tournament) {
        for (const part of interaction.customId.split(':').slice(1)) {
          const found = getTournamentById(interaction.guildId, part);
          if (found) { tournament = found; break; }
        }
      }
    } catch (err) {
      console.error('[log] Failed to resolve tournament for logging:', err);
    }
    if (tournament) await tournamentLog.logInteraction(interaction, tournament);
  }).catch(err => console.error('[log] logInteraction failed:', err));
}

// Returns true if this interaction belonged to the tournament bot (whether it
// was handled or refused by the lock) so index.js stops there.
async function routeTournamentInteraction(interaction) {
  if (!interaction.customId || !isTournamentCustomId(interaction.customId)) return false;
  const table = tableFor(interaction);
  if (!table) return false;

  // Global tournament lock — see tn-access.js canUseBot(). Public player
  // panels are exempt (see isPublicPlayerInteraction).
  if (!canUseBot(interaction.member) && !isPublicPlayerInteraction(interaction)) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: NOT_AUTHORIZED, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return true;
  }

  const id = interaction.customId;

  if (id.startsWith('tourney_') || id.startsWith('cancel_select_teams') || id.startsWith('qualify_select_teams')) {
    // Any touch on the tournament panel resets its 3-minute auto-delete countdown.
    if (panelInactivity.belongsToMainPanel(id)) panelInactivity.touch(interaction.message);
    logTournamentInteraction(interaction);
  }

  // Screenshot-verification panel: ALLOWED_USER_IDS members only.
  if (id.startsWith('ssvp') && !isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: '❌ Only users listed in `ALLOWED_USER_IDS` can use the screenshot verification panel.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  // !staff control panel — every button / modal / select starts with "staffp:".
  if (id.startsWith('staffp:')) {
    await staffPanelHandlers.handleInteraction(interaction);
    return true;
  }

  const fn = findHandler(table, id);
  if (!fn) return false;
  await fn(interaction);
  return true;
}

// ---------------------------------------------------------------------------
// Messages (non-prefix features owned by the tournament bot)
// ---------------------------------------------------------------------------
const PING_OWNER_REGEX = /^\s*ping[.!?]?\s*$|\bping\s+(shady|owner|dev|developer|creator|him|her|them)\b/i;

// Returns true if a tournament feature consumed the message (index.js then
// stops). Returns false to let Rebound's own handling (AI mention, prefix
// commands, ...) continue. Prefix commands themselves are NOT handled here —
// they live in the shared prefixCommands collection and are lock-checked by
// guardTournamentPrefixCommand().
async function handleTournamentMessage(message) {
  // Everything below is locked to ALLOWED_USER_IDS / TOURNAMENT ADMIN / TOURNAMENT
  // ELITE (same as the standalone tournament bot), so everyone else is skipped
  // right here — no storage read for ordinary chat — and Rebound's own handling
  // carries on untouched.
  if (!canUseBot(message.member)) return false;

  const store = peekGuildStore(message.guild.id) || {}; // read-only peek, never mutated
  const prefix = process.env.PREFIX || '!';
  const looksLikePrefixCommand = message.content.startsWith(prefix);

  staffActivity.recordMessage(message.guild.id, message.member, message.channelId);

  // Screenshot verification: every message in a tournament Submit Channel
  // (any setup created with /ss-verify-panel) is a verification submission.
  if (store.ssSetups && store.ssSetups[message.channelId]) {
    try {
      if (await ssVerification.handleSsVerifyMessage(message)) return true;
    } catch (err) {
      console.error('Error handling SS-verify screenshot:', err);
      await message.reply('❌ Something went wrong verifying that screenshot. Please try again.').catch(() => {});
      return true;
    }
  }

  // Tournament AI channel (set with /set-ai-channel) — separate from Rebound's
  // @mention AI, which keeps working everywhere else.
  const aiChannelId = store.settings && store.settings.aiChannelId;
  if (!looksLikePrefixCommand && aiChannelId && message.channelId === aiChannelId) {
    const cleanContent = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!cleanContent) return true;
    try {
      const ownerId = process.env.OWNER_ID;
      if (ownerId && PING_OWNER_REGEX.test(cleanContent)) {
        await message.reply({ content: `<@${ownerId}>`, allowedMentions: { users: [ownerId] } });
        return true;
      }
      await message.channel.sendTyping();
      const reply = await tnAiChat.getAIReply({
        guildId: message.guild.id,
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userDisplayName: message.member?.displayName || message.author.username,
        userMessage: cleanContent,
      });
      if (reply) {
        const chunks = reply.match(/[\s\S]{1,1900}/g) || [reply];
        for (const chunk of chunks) await message.reply(chunk).catch(() => {});
      }
    } catch (err) {
      console.error('Error generating tournament AI reply:', err);
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Startup / background jobs / gateway listeners
// ---------------------------------------------------------------------------
async function initTournament() {
  await initStorage();
}

async function flushTournament() {
  staffActivity.flushAll();
  await flushStorage().catch(() => {});
}

const BAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function registerTournamentEvents(client) {
  client.once(Events.ClientReady, () => {
    const allowedCount = envAllowedIds().length;
    console.log(`[tournament] ALLOWED_USER_IDS: ${allowedCount} user ID(s) loaded${process.env.ALLOWED_USER_IDS && !allowedCount ? ' — WARNING: the variable is set but no valid user ID was found in it' : ''}.`);

    // Timed team bans: sweep for expired bans on its own timer.
    tnWizard.processExpiredBans(client).catch(err => console.error('[timed-bans] initial sweep failed:', err));
    setInterval(() => {
      tnWizard.processExpiredBans(client).catch(err => console.error('[timed-bans] sweep failed:', err));
    }, BAN_SWEEP_INTERVAL_MS);

    ssVerification.migrateAllGuilds();
    staffActivity.startAutoFlush();
    staffPanelHandlers.startWeeklyScheduler(client);
  });

  client.on(Events.ChannelDelete, (channel) => {
    try { ssVerification.handleChannelDelete(channel); } catch (err) { console.error('[ss-verify] channel delete cleanup failed:', err); }
  });
  client.on(Events.GuildRoleDelete, (role) => {
    try { ssVerification.handleRoleDelete(role); } catch (err) { console.error('[ss-verify] role delete cleanup failed:', err); }
  });

  // !staff voice-time tracking. Mute/deafen-only updates are ignored.
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (oldState.channelId === newState.channelId) return;
    const guildId = newState.guild.id;
    const member = newState.member || oldState.member;
    if (!oldState.channelId && newState.channelId) {
      staffActivity.voiceJoin(guildId, member, newState.channelId);
    } else if (oldState.channelId && !newState.channelId) {
      staffActivity.voiceLeave(guildId, oldState.id);
    } else if (oldState.channelId && newState.channelId) {
      staffActivity.voiceSwitch(guildId, member, newState.channelId);
    }
  });

  // New-member welcome (/set-welcome-channel).
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const store = getGuildStore(member.guild.id);
      const welcomeChannelId = store.settings && store.settings.welcomeChannelId;
      if (!welcomeChannelId) return;
      const channel = await member.guild.channels.fetch(welcomeChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;
      const staffRoleId = store.settings.welcomeStaffRoleId;
      const staffLine = staffRoleId ? ` <@&${staffRoleId}> give them a hand if they need anything!` : '';
      await channel.send({
        content: `Hey <@${member.id}>, I'm glad you're here ☺${staffLine}`,
        allowedMentions: { users: [member.id], roles: staffRoleId ? [staffRoleId] : [] },
      });
    } catch (err) {
      console.error('[welcome] Failed to send welcome message:', err);
    }
  });
}

module.exports = {
  initTournament, flushTournament, registerTournamentEvents,
  routeTournamentInteraction, handleTournamentMessage,
  guardTournamentCommand, guardTournamentPrefixCommand, isTournamentCommand, canUseBotMember,
};
