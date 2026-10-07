require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Collection, MessageFlags,
  PermissionFlagsBits, REST, Routes, ActivityType, Events,
} = require('discord.js');

// ---------------------------------------------------------------------
// Tournament bot — runs on its own Discord token, separate from the
// scrims / T3 bot. Everything tournament-related lives here: the
// `!tournament` wizard, public registration panels, slot manager, swaps,
// round promotion, punishments and exports.
// ---------------------------------------------------------------------
const tournamentWizard = require('./tournament-wizard-handlers');
const { initStorage, flushStorage, getGuildStore } = require('./storage');
const { canManageBot, envAllowedIds, isAllowedUser, canUseBot } = require('./access');
const aiChat = require('./ai-chat');
const staffActivity = require('./staff-activity');
const staffPanel = require('./pcmd-staff');
const staffPanelHandlers = require('./staff-panel-handlers');
const tournamentLog = require('./tournament-activity-log');
const panelInactivity = require('./panel-inactivity');
const { getTournamentStore, getTournamentById } = require('./tournament-store');
const ssVerification = require('./ss-verification');
const ssVerifyPanel = require('./ss-verify-panel-handlers');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // privileged — enable in the Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — needed for !prefix commands
    GatewayIntentBits.GuildVoiceStates, // needed for !staff's voice-time tracking
  ],
});
client.commands = new Collection();
client.prefixCommands = new Collection();

// Loads every cmd-*.js (slash) and pcmd-*.js (prefix) file in this folder.
// There are no slash commands yet, but the loader is kept so any cmd-*.js
// you add later is picked up and registered automatically.
function loadCommands(dir) {
  const commandFiles = fs.readdirSync(dir).filter(f => f.startsWith('cmd-') && f.endsWith('.js'));
  for (const file of commandFiles) {
    const command = require(path.join(dir, file));
    if (client.commands.has(command.data.name)) {
      throw new Error(`Duplicate slash command name "${command.data.name}" from ${dir}/${file}`);
    }
    client.commands.set(command.data.name, command);
  }

  const prefixCommandFiles = fs.readdirSync(dir).filter(f => f.startsWith('pcmd-') && f.endsWith('.js'));
  for (const file of prefixCommandFiles) {
    const command = require(path.join(dir, file));
    if (client.prefixCommands.has(command.name)) {
      throw new Error(`Duplicate prefix command name "${command.name}" from ${dir}/${file}`);
    }
    client.prefixCommands.set(command.name, command);
    for (const alias of command.aliases || []) {
      if (client.prefixCommands.has(alias)) {
        throw new Error(`Duplicate prefix command alias "${alias}" from ${dir}/${file}`);
      }
      client.prefixCommands.set(alias, command);
    }
  }
}

loadCommands(__dirname);

async function registerCommandsForGuild(guild, commandData, rest) {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id),
    { body: commandData }
  );
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const allowedCount = envAllowedIds().length;
  console.log(`[access] ALLOWED_USER_IDS: ${allowedCount} user ID(s) loaded${process.env.ALLOWED_USER_IDS && !allowedCount ? ' — WARNING: the variable is set but no valid user ID was found in it' : ''}.`);
  console.log(`Loaded ${client.commands.size} slash commands, ${client.prefixCommands.size} prefix command entries.`);
  console.log(`Currently in ${client.guilds.cache.size} server(s).`);
  try { require('./web-api').start(client); } catch (e) { console.error('[web-api] failed to start:', e); }

  client.user.setPresence({
    activities: [{
      name: 'Custom Status',
      state: process.env.BOT_STATUS_TEXT || '🏆 BGMI Tournaments',
      type: ActivityType.Custom,
    }],
    status: 'online',
  });

  if (client.commands.size === 0) {
    console.log('No slash commands to register (this bot uses !prefix commands and panels).');
    return;
  }
  if (!process.env.CLIENT_ID) {
    console.warn('CLIENT_ID not set — skipping automatic slash command registration.');
    return;
  }

  const commandData = client.commands.map(c => c.data.toJSON());
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  let successCount = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      await registerCommandsForGuild(guild, commandData, rest);
      successCount++;
    } catch (err) {
      console.error(`Failed to register commands in guild ${guild.id} (${guild.name}):`, err);
    }
  }
  console.log(`Registered ${commandData.length} commands in ${successCount}/${client.guilds.cache.size} server(s).`);
});

// ---------------------------------------------------------------------
// Timed team bans — sweeps every guild for bans whose duration has
// elapsed and removes the ban role. Runs on its own timer (independent
// of any tournament) so a ban keeps being served — and eventually gets
// cleaned up — even if the tournament it came from was deleted early.
// ---------------------------------------------------------------------
const BAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
client.once(Events.ClientReady, () => {
  tournamentWizard.processExpiredBans(client).catch(err => console.error('[timed-bans] initial sweep failed:', err));
  setInterval(() => {
    tournamentWizard.processExpiredBans(client).catch(err => console.error('[timed-bans] sweep failed:', err));
  }, BAN_SWEEP_INTERVAL_MS);
});

// Screenshot verification: convert the old single-channel settings (first
// version of the feature) into the multi-setup format, once.
client.once(Events.ClientReady, () => {
  ssVerification.migrateAllGuilds();
});

// A deleted submit channel / verified role removes its screenshot setup.
client.on(Events.ChannelDelete, (channel) => {
  try { ssVerification.handleChannelDelete(channel); } catch (err) { console.error('[ss-verify] channel delete cleanup failed:', err); }
});
client.on(Events.GuildRoleDelete, (role) => {
  try { ssVerification.handleRoleDelete(role); } catch (err) { console.error('[ss-verify] role delete cleanup failed:', err); }
});

// !staff activity tracking — batched in memory, flushed to storage on a timer.
client.once(Events.ClientReady, () => {
  staffActivity.startAutoFlush();
  staffPanelHandlers.startWeeklyScheduler(client); // weekly staff report (see staff-system.js)
});

// Voice-channel time for !staff — join / leave / switch between channels.
// Mute/deafen-only updates (channelId unchanged) are ignored.
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

client.on('guildCreate', async (guild) => {
  if (!process.env.CLIENT_ID || client.commands.size === 0) return;
  try {
    const commandData = client.commands.map(c => c.data.toJSON());
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await registerCommandsForGuild(guild, commandData, rest);
    console.log(`Joined new server "${guild.name}" — registered ${commandData.length} commands there.`);
  } catch (err) {
    console.error(`Failed to register commands in new guild ${guild.id} (${guild.name}):`, err);
  }
});

// ---------------------------------------------------------------------
// New-member welcome — Gungun pings the new member with a short, warm
// hello and (if a staff role is configured) pings staff too so someone
// jumps in to help them get settled. Configured per-guild via
// /set-welcome-channel. Silently does nothing if no channel is set.
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Prefix commands (!tournament, !export_tournament, ...)
// ---------------------------------------------------------------------
const PING_OWNER_REGEX = /^\s*ping[.!?]?\s*$|\bping\s+(shady|owner|dev|developer|creator|him|her|them)\b/i;

async function tryHandlePingOwner(message, cleanContent) {
  if (!PING_OWNER_REGEX.test(cleanContent)) return false;
  const ownerId = process.env.OWNER_ID;
  if (!ownerId) {
    console.warn('[ping-owner] OWNER_ID not set in .env — skipping.');
    return false;
  }
  await message.reply({ content: `<@${ownerId}>`, allowedMentions: { users: [ownerId] } });
  return true;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const prefix = process.env.PREFIX || '!';
  const looksLikePrefixCommand = message.content.startsWith(prefix);
  const mentionsBot = message.mentions.has(client.user);

  // Global lock — see access.js canUseBot(). Nobody gets a response, an AI
  // reply, or activity tracking until they're allowlisted or hold
  // TOURNAMENT ADMIN / TOURNAMENT ELITE. Anyone blocked here who was actually
  // trying to use the bot (a !command or an @mention) gets the "not
  // authorized" emoji back; ordinary chat from them is still ignored so the
  // bot doesn't spam every message they send.
  if (!canUseBot(message.member)) {
    if (looksLikePrefixCommand || mentionsBot) {
      await message.reply('<a:qg_hehe128:1553059818833584298>').catch(() => {});
    }
    return;
  }

  staffActivity.recordMessage(message.guild.id, message.member, message.channelId);

  // Screenshot verification — every message in a Submit Channel (any setup
  // created in /ss-verify-panel) is treated as a verification submission and
  // doesn't fall through to the AI chat or prefix commands. The one exception
  // is staff with a "tourney-mod" role: the handler hands their messages back.
  const aiStore = getGuildStore(message.guild.id);
  if (aiStore.ssSetups && aiStore.ssSetups[message.channelId]) {
    try {
      if (await ssVerification.handleSsVerifyMessage(message)) return;
    } catch (err) {
      console.error('Error handling SS-verify screenshot:', err);
      await message.reply('❌ Something went wrong verifying that screenshot. Please try again.').catch(() => {});
      return;
    }
  }

  const aiChannelId = aiStore.settings && aiStore.settings.aiChannelId;
  const isReplyToBot = message.reference?.messageId
    ? await message.channel.messages.fetch(message.reference.messageId)
        .then(referenced => referenced.author.id === client.user.id)
        .catch(() => false)
    : false;

  // AI chat — everyone can talk to it in the configured AI channel (set via
  // /set-ai-channel). Outside that channel, @mentioning the bot or replying
  // to one of its messages only triggers a reply for OWNER_ID — nobody else,
  // including other admins, gets AI replies outside the AI channel.
  const isOwner = process.env.OWNER_ID && message.author.id === process.env.OWNER_ID;
  const inAiChannel = aiChannelId && message.channelId === aiChannelId;
  const ownerMentionOrReply = isOwner && (mentionsBot || isReplyToBot);
  if (!looksLikePrefixCommand && (inAiChannel || ownerMentionOrReply)) {
    const cleanContent = message.content.replace(/<@!?\d+>/g, '').trim();
    if (cleanContent) {
      try {
        const handledAsPingOwner = await tryHandlePingOwner(message, cleanContent);
        if (!handledAsPingOwner) {
          await message.channel.sendTyping();
          const reply = await aiChat.getAIReply({
            guildId: message.guild.id,
            guildName: message.guild.name,
            channelId: message.channelId,
            userId: message.author.id,
            userDisplayName: message.member?.displayName || message.author.username,
            userMessage: cleanContent,
          });
          if (reply) {
            const chunks = reply.match(/[\s\S]{1,1900}/g) || [reply];
            for (const chunk of chunks) {
              await message.reply(chunk).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.error('Error generating AI reply:', err);
      }
    }
    return;
  }

  if (!looksLikePrefixCommand) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const commandName = args.shift().toLowerCase();
  if (!commandName) return;

  const command = client.prefixCommands.get(commandName);
  if (!command) return;

  if (command.adminOnly && !canManageBot(message.member)) {
    return message.reply('<a:qg_hehe128:1553059818833584298>').catch(() => {});
  }

  try {
    await command.execute(message, args);
  } catch (err) {
    console.error(`Error running prefix command "${commandName}":`, err);
    message.reply('❌ Something went wrong running that command.').catch(() => {});
  }
});

// Player-facing parts of the tournament system that EVERYONE may use, even
// without TOURNAMENT ADMIN / ELITE or being in ALLOWED_USER_IDS: the public
// Register panel (Register Team -> form -> player picker -> Confirm) and the
// Slot-Manager self-service panel (Cancel My Slot / My Groups / Change Team
// Name / Swap Group, including accepting or rejecting a swap request). Their
// handlers already do their own checks (register role, registration open,
// team ownership, Group Swap on/off). Everything else — every admin button,
// the group panels, slash/prefix commands — stays behind the global lock.
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
  // !staff panel: members holding the tracked staff role may press it even
  // without TOURNAMENT ADMIN / ELITE — the handler itself limits them to the
  // self-service buttons (check-in, entry form, own work, leave, report, rules).
  if (id.startsWith('staffp:') && staffActivity.isTrackedMember(interaction.guildId, interaction.member)) return true;
  // Tournament Staff (Select Staff) hold neither TOURNAMENT ADMIN/ELITE nor an
  // allowlist entry, so let the per-group panel buttons and their pickers
  // through the global lock — the handlers check the Staff role themselves.
  if (interaction.isButton() && id.startsWith('tourney_wizard_group_')) return true;
  // Result picker, and the group Config selects / modals (only for that
  // tournament's Staff role — these handlers have no gate of their own).
  // Punish Team stays behind the lock: staff can't use it.
  if (interaction.isStringSelectMenu() && id.startsWith('qualify_select_teams:')) return true;
  // Slot-list Info picker — staff of that tournament (handler re-checks).
  if (interaction.isStringSelectMenu() && id.startsWith('tourney_slotinfo_select:')) {
    return tournamentWizard.isStaffOfTournamentId(interaction, id.split(':')[1]);
  }
  const cfgPrefixes = ['tourney_group_cfg_count:', 'tourney_group_cfg_match:', 'tourney_group_cfg_match_modal:', 'tourney_group_cfg_date_modal:'];
  if ((interaction.isStringSelectMenu() || interaction.isModalSubmit()) && cfgPrefixes.some(p => id.startsWith(p))) {
    return tournamentWizard.isStaffOfTournamentId(interaction, id.split(':')[1]);
  }
  if (interaction.isButton()) {
    if (PUBLIC_BUTTON_IDS.includes(id)) return true;
    if (PUBLIC_BUTTON_PREFIXES.some(p => id.startsWith(p))) return true;
    // Group-swap picker/request/accept/reject — but NOT the admin on/off toggle.
    return id.startsWith('tourney_wizard_swap_') && id !== 'tourney_wizard_swap_toggle';
  }
  if (interaction.isUserSelectMenu()) return PUBLIC_USER_SELECT_IDS.includes(id);
  if (interaction.isStringSelectMenu()) return PUBLIC_STRING_SELECT_PREFIXES.some(p => id.startsWith(p));
  if (interaction.isModalSubmit()) return PUBLIC_MODAL_PREFIXES.some(p => id.startsWith(p));
  return false;
}

// ---------------------------------------------------------------------
// interactionCreate — buttons / selects / modals are matched by customId
// and handed to the tournament wizard module.
// ---------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  // Global lock — see access.js canUseBot(). Nobody gets a response from any
  // button, select, modal, or slash command until they're allowlisted or
  // hold TOURNAMENT ADMIN / TOURNAMENT ELITE. Autocomplete can't take a
  // normal reply, so that stays silent; everything else gets the "not
  // authorized" emoji back.
  if (interaction.guildId && !canUseBot(interaction.member) && !isPublicPlayerInteraction(interaction)) {
    if (!interaction.isAutocomplete() && interaction.isRepliable()) {
      await interaction.reply({ content: '<a:qg_hehe128:1553059818833584298>', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // Slash-command autocomplete (e.g. the tournament picker in /owner).
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command && typeof command.autocomplete === 'function' && interaction.guildId) {
      try { await command.autocomplete(interaction); } catch (err) { console.error('Autocomplete failed:', err); }
    }
    return;
  }

  if (!interaction.guildId) {
    if (interaction.isRepliable()) {
      return interaction.reply({ content: 'This bot only works inside a server.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // ---------------------------------------------------------------------
  // Universal Log Channel feed — fires on every tournament-related button,
  // select menu, and modal submit, and (if that tournament has a Log
  // Channel configured in Edit Settings) posts a line saying who touched
  // what. Runs independently of the actual handling below, and never
  // throws, so it can't affect or delay the real action.
  // ---------------------------------------------------------------------
  if (
    interaction.customId
    && (interaction.isButton?.() || interaction.isModalSubmit?.() || interaction.isAnySelectMenu?.()
      || interaction.isStringSelectMenu?.() || interaction.isUserSelectMenu?.()
      || interaction.isRoleSelectMenu?.() || interaction.isChannelSelectMenu?.())
    && (interaction.customId.startsWith('tourney_') || interaction.customId.startsWith('cancel_select_teams')
      || interaction.customId.startsWith('qualify_select_teams'))
  ) {
    // Any touch on the *tournament panel itself* resets its 3-minute
    // auto-delete countdown — see panel-inactivity.js. Every admin
    // sub-screen edits that same message via interaction.update(), so this
    // alone covers the whole wizard flow. Persistent panels that live on
    // their own message elsewhere (a group's channel panel, the public
    // Register panel, the self-service panel, swap request messages) are
    // filtered out by belongsToMainPanel() so they never get auto-deleted.
    if (panelInactivity.belongsToMainPanel(interaction.customId)) {
      panelInactivity.touch(interaction.message);
    }

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

  // Screenshot-verification panel: ALLOWED_USER_IDS members only, checked on
  // every button / menu / modal of the panel (not just the slash command).
  if (interaction.customId && interaction.customId.startsWith('ssvp') && !isAllowedUser(interaction.user.id)) {
    return interaction.reply({
      content: '❌ Only users listed in `ALLOWED_USER_IDS` can use the screenshot verification panel.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  try {
    // !staff control panel — every button / modal / select starts with "staffp:".
    if (interaction.customId && interaction.customId.startsWith('staffp:')) {
      await staffPanelHandlers.handleInteraction(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
    } else if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('tourney_wizard_') || id.startsWith('tourney_create_settings_')) await tournamentWizard.handleTournamentWizardButton(interaction);
      else if (id.startsWith('tourney_round_config_')) await tournamentWizard.handleRoundConfigButton(interaction);
      else if (id.startsWith('staffactivity_mode:')) await staffPanel.handleModeButton(interaction);
      else if (id === 'staffactivity_leaderboard') await staffPanel.handleLeaderboardButton(interaction);
      else if (id.startsWith('ssvp:')) await ssVerifyPanel.handleSsVerifyPanelButton(interaction);
    } else if (interaction.isUserSelectMenu()) {
      const id = interaction.customId;
      if (id === 'tourney_reg_select_players') await tournamentWizard.handleTourneyRegSelectPlayers(interaction);
      else if (id === 'tourney_manual_add_user_select') await tournamentWizard.handleManualAddUserSelect(interaction);
      else if (id === 'tourney_staff_user_select') await tournamentWizard.handleStaffUserSelect(interaction);
    } else if (interaction.isRoleSelectMenu()) {
      const id = interaction.customId;
      if (id === 'tourney_create_registerrole_select') await tournamentWizard.handleCreateRegisterRoleSelect(interaction);
      else if (id === 'ssvp_role_select') await ssVerifyPanel.handleSsVerifyRoleSelect(interaction);
      else if (id === 'tourney_create_confirmrole_select') await tournamentWizard.handleCreateConfirmRoleSelect(interaction);
    } else if (interaction.isChannelSelectMenu()) {
      const id = interaction.customId;
      if (id === 'tourney_slotmanager_channel_select') await tournamentWizard.handleSlotManagerChannelSelect(interaction);
      else if (id === 'tourney_register_panel_channel_select') await tournamentWizard.handleRegisterPanelChannelSelect(interaction);
      else if (id === 'tourney_create_confirmchannel_select') await tournamentWizard.handleCreateConfirmChannelSelect(interaction);
      else if (id === 'tourney_wizard_manual_channels_category_select') await tournamentWizard.handleManualChannelsCategorySelect(interaction);
      else if (id === 'tourney_create_swapchannel_select') await tournamentWizard.handleCreateSwapChannelSelect(interaction);
      else if (id === 'tourney_create_logchannel_select') await tournamentWizard.handleCreateLogChannelSelect(interaction);
      else if (id.startsWith('tourney_round_category_select:')) await tournamentWizard.handleRoundCategorySelect(interaction);
      else if (id.startsWith('ssvp_channel_select:')) await ssVerifyPanel.handleSsVerifyChannelSelect(interaction);
    } else if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      if (id === 'tourney_list_select') await tournamentWizard.handleTournamentListSelect(interaction);
      else if (id.startsWith('qualify_select_teams:')) await tournamentWizard.handleQualifySelect(interaction);
      else if (id === 'tourney_qualify_group_select' || id.startsWith('tourney_qualify_group_select:')) await tournamentWizard.handleQualifyGroupSelect(interaction);
      else if (id === 'tourney_cancel_group_select' || id.startsWith('tourney_cancel_group_select:')) await tournamentWizard.handleCancelGroupSelect(interaction);
      else if (id.startsWith('tourney_manual_add_round_select:')) await tournamentWizard.handleManualAddRoundSelect(interaction);
      else if (id.startsWith('tourney_manual_add_group_select:')) await tournamentWizard.handleManualAddGroupSelect(interaction);
      else if (id === 'tourney_round_config_select') await tournamentWizard.handleRoundConfigSelect(interaction);
      else if (id.startsWith('cancel_select_teams:')) await tournamentWizard.handleCancelTeamsSelect(interaction);
      else if (id === 'tourney_slotlist_select' || id.startsWith('tourney_slotlist_select:')) await tournamentWizard.handleSlotListSelect(interaction);
      else if (id.startsWith('tourney_slotedit_select:')) await tournamentWizard.handleSlotListEditPick(interaction);
      else if (id.startsWith('tourney_slotinfo_select:')) await tournamentWizard.handleSlotListInfoPick(interaction);
      else if (id.startsWith('tourney_slotlist_edit_team_select:')) await tournamentWizard.handleSlotListEditTeamSelect(interaction);
      else if (id === 'tourney_grouppanel_repost_select' || id.startsWith('tourney_grouppanel_repost_select:')) await tournamentWizard.handleGroupPanelRepostSelect(interaction);
      else if (id.startsWith('tourney_punish_select_teams:')) await tournamentWizard.handleTournamentPunishSelect(interaction);
      else if (id.startsWith('tourney_swap_select:')) await tournamentWizard.handleSwapSelect(interaction);
      else if (id === 'tourney_unban_select') await tournamentWizard.handleUnbanSelect(interaction);
      else if (id.startsWith('tourney_group_cfg_count:')) await tournamentWizard.handleGroupConfigCountSelect(interaction);
      else if (id === 'staffactivity_user_select') await staffPanel.handleUserSelect(interaction);
      else if (id === 'ssvp_platform_select') await ssVerifyPanel.handleSsVerifyPlatformSelect(interaction);
      else if (id === 'ssvp_edit_select') await ssVerifyPanel.handleSsVerifyEditSelect(interaction);
      else if (id.startsWith('tourney_group_cfg_match:')) await tournamentWizard.handleGroupConfigMatchSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      if (id === 'tourney_wizard_create_modal') await tournamentWizard.handleTournamentCreateModalSubmit(interaction);
      else if (id === 'tourney_wizard_group_modal') await tournamentWizard.handleAddGroupModalSubmit(interaction);
      else if (id === 'tourney_wizard_auto_groups_modal') await tournamentWizard.handleAutoGroupsModalSubmit(interaction);
      else if (id.startsWith('tourney_wizard_register_modal:')) await tournamentWizard.handleRegisterTeamModalSubmit(interaction);
      else if (id === 'tourney_wizard_edit_modal') await tournamentWizard.handleEditSettingsModalSubmit(interaction);
      else if (id === 'tourney_wizard_ban_modal') await tournamentWizard.handleBanUnbanModalSubmit(interaction);
      else if (id === 'tourney_ban_name_modal') await tournamentWizard.handleTimedBanModalSubmit(interaction);
      else if (id.startsWith('tourney_wizard_manual_add_modal:')) await tournamentWizard.handleManualAddSlotModalSubmit(interaction);
      else if (id === 'tourney_create_settings_d_modal') await tournamentWizard.handleRequiredMentionsModalSubmit(interaction);
      else if (id === 'tourney_create_settings_e_modal') await tournamentWizard.handleTeamsPerGroupModalSubmit(interaction);
      else if (id === 'tourney_create_settings_f_modal') await tournamentWizard.handleTotalSlotsModalSubmit(interaction);
      else if (id === 'tourney_manual_channels_format_modal') await tournamentWizard.handleManualChannelsFormatModalSubmit(interaction);
      else if (id === 'tourney_manual_channels_rolename_modal') await tournamentWizard.handleManualChannelsRoleNameModalSubmit(interaction);
      else if (id.startsWith('tourney_swap_search_modal:')) await tournamentWizard.handleSwapSearchModalSubmit(interaction);
      else if (id.startsWith('tourney_selfservice_change_name_modal:')) await tournamentWizard.handleSelfServiceChangeNameModalSubmit(interaction);
      else if (id.startsWith('tourney_slotedit_modal:')) await tournamentWizard.handleSlotListEditModalSubmit(interaction);
      else if (id.startsWith('tourney_slotlist_edit_team_modal:')) await tournamentWizard.handleSlotListEditTeamModalSubmit(interaction);
      else if (id.startsWith('tourney_round_size_modal:')) await tournamentWizard.handleRoundSizeModalSubmit(interaction);
      else if (id.startsWith('tourney_round_naming_modal:')) await tournamentWizard.handleRoundNamingModalSubmit(interaction);
      else if (id === 'tourney_round_maxrounds_modal') await tournamentWizard.handleMaxRoundsModalSubmit(interaction);
      else if (id.startsWith('tourney_group_cfg_match_modal:')) await tournamentWizard.handleGroupConfigMatchModalSubmit(interaction);
      else if (id.startsWith('tourney_group_cfg_date_modal:')) await tournamentWizard.handleGroupConfigDateModalSubmit(interaction);
      else if (id === 'ssvp_modal_details') await ssVerifyPanel.handleSsVerifyDetailsModalSubmit(interaction);
      else if (id === 'ssvp_modal_addkey') await ssVerifyPanel.handleSsVerifyAddKeyModalSubmit(interaction);
    }
  } catch (err) {
    console.error(`Error handling interaction (${interaction.type}):`, err);
    const payload = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// Load tournament data (PostgreSQL when DATABASE_URL is set) before the bot
// goes online, so no interaction can arrive before the data is in memory.
// If AUTO_IMPORT_CSV is set (see auto-import-on-boot.js), this also imports
// a CSV of team registrations into a new tournament once, before login —
// otherwise it's a no-op and changes nothing about normal startup.
const { runAutoImportOnBoot } = require('./auto-import-on-boot');
initStorage()
  .then(() => runAutoImportOnBoot())
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch((err) => {
    console.error('Failed to start (storage / Discord login):', err);
    process.exit(1);
  });

// Let pending database writes finish when the host stops/redeploys the bot.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    staffActivity.flushAll();
    await flushStorage().catch(() => {});
    process.exit(0);
  });
}

client.on('error', (err) => console.error('Discord client error:', err));
client.on('shardError', (err) => console.error('Discord shard error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
