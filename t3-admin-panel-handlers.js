const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./t3-storage');
const { getGroupsPerDay, groupDisplayName, letterForIndex } = require('./t3-group-schedule');
const { buildRegistrationPanelPayload } = require('./t3-registration-handlers');
const { postLivePanel, refreshLivePanel } = require('./t3-live-panel-handlers');
const { buildGroupSchedulePanelPayload, buildDailyScheduleModal } = require('./t3-group-schedule-handlers');
const { ensureGroupResultPanel } = require('./round-promotion-handlers');
const { T3_STAFF_ROLE_NAME, STAFF_CHANNEL_ALLOW } = require('./t3-staff-access');

// Same look and flow as the main Scrims admin panel (admin-panel-handlers.js):
// an ephemeral panel with one button per setting; a setting button swaps the
// panel for a picker with a "Back to Panel" button, and picking something
// saves it and returns to the refreshed panel with a ✅ banner.
//
// customIds: buttons "t3ap:<action>", channel pickers "t3ap_channel:<key>",
// role pickers "t3ap_role:<key>" (routed in t3-router.js).

function hasManageGuild(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

const NO_PERMISSION = { content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral };

// logChannelId keeps its original key (the punishment log and existing saved
// settings read it), it's just labelled "Private Register Channel" now.
const CHANNEL_SETTINGS = {
  registrationLogChannelId: { label: 'Register Channel', hint: 'Public registration summary card (team, group, slot, lineup — pings the players)', saved: 'A short public card will be posted there for each new T3 registration.' },
  logChannelId: { label: 'Private Register Channel', hint: 'Full registration card (IGN/UID, WhatsApp, email) — should be staff-only', saved: 'The full registration card will be posted there.' },
};

const ROLE_SETTINGS = {
  registeredRoleId: { label: 'Register Role', hint: 'Given automatically when a player registers a team', saved: 'It will be given to players when they register.', assignable: true },
  requiredRoleId: { label: 'Required Role', hint: 'Only members with this role can register for T3 Scrims', saved: 'Only members with it can now register for T3 Scrims.' },
};

// The role handed to whoever is picked in "Select Staff". It lets them use
// Publish Slot List, Match Reminder, Result and !open in the group lobbies —
// nothing else. Auto-created the first time it's needed.
async function getOrCreateStaffRole(interaction, store) {
  if (!store.settings) store.settings = {};
  const existingId = store.settings.scrimsManagementRoleId;
  const existing = existingId ? interaction.guild.roles.cache.get(existingId) : null;
  if (existing) return existing;

  const role = await interaction.guild.roles.create({
    name: T3_STAFF_ROLE_NAME,
    color: 0xED4245,
    mentionable: false,
    reason: 'Auto-created for the T3 admin panel\'s "Select Staff" list',
  });
  store.settings.scrimsManagementRoleId = role.id;
  saveGuildStore(interaction.guildId, store);
  return role;
}

// Lets the staff role see lobbies that were created before it existed.
async function grantStaffRoleToExistingLobbies(guild, store, roleId) {
  const ids = new Set(Object.values((store.settings && store.settings.groupChannels) || {}));
  for (const round of Object.values(store.rounds || {})) if (round.channelId) ids.add(round.channelId);
  for (const channelId of ids) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) continue;
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true, ReadMessageHistory: true, SendMessages: true, AttachFiles: true, EmbedLinks: true,
    }, { reason: 'T3 staff role access' }).catch(() => {});
  }
}

function settingsOf(interaction) {
  const store = getGuildStore(interaction.guildId);
  if (!store.settings) store.settings = {};
  return store;
}

const backRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('t3ap:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
);

// --- Main panel view ---

function buildAdminPanelPayload(store) {
  const s = store.settings || {};
  const groupsPerDay = getGroupsPerDay(store.scrim);
  const ch = id => (id ? `<#${id}>` : '*Not set*');
  const role = id => (id ? `<@&${id}>` : '*Not set — registration closed*');

  const embed = new EmbedBuilder()
    .setTitle('<:Gemini_Generated_Image_2vjc222vj:1554520428456841306> T3 Scrims — Admin Panel')
    .setColor(0x5865F2)
    .setDescription('Configure T3 registration, roles, channels and schedule — all from here.')
    .addFields(
      { name: '<:559950clipboard:1549274535579230238> Register Channel', value: ch(s.registrationLogChannelId), inline: true },
      { name: '<:687464ticketsupportroleicon:1554519524445790369> Register Role', value: role(s.registeredRoleId), inline: true },
      { name: '<:767939ticket:1554519520096292874> Required Role', value: role(s.requiredRoleId), inline: true },
      { name: '<:63116helperroleicon:1554519005010722948> Scrims Management Staff', value: `${s.scrimsManagementRoleId ? `<@&${s.scrimsManagementRoleId}>` : '*Not set*'} — ${(s.scrimsManagementStaffIds || []).length} member(s)`, inline: true },
      { name: '<:414779lock:1554519522260680724> Private Register Channel', value: ch(s.logChannelId), inline: true },
      { name: '🔢 Groups Per Day', value: String(groupsPerDay), inline: true },
      { name: '🏷️ Registration Fake Tags', value: s.allowFakeTags ? '✅ ON — a player can be picked in multiple teams' : '❌ OFF — a player can only be on one team', inline: true },
    )
    .setFooter({ text: 'Only members with Manage Server can use this panel.' });

  const postRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:post_register').setLabel('Post Registration Panel').setEmoji('📥').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('t3ap:post_live').setLabel('Post Live Panel').setEmoji('📡').setStyle(ButtonStyle.Success),
  );

  const registerRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:set_registrationLogChannelId').setLabel('Register Channel').setEmoji('📥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:set_registeredRoleId').setLabel('Register Role').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:set_requiredRoleId').setLabel('Required Role').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
  );

  const settingsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:set_logChannelId').setLabel('Private Register Channel').setEmoji('🔐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:clear_role').setLabel('Clear Role').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:toggle_fake_tags').setLabel(`Fake Tags: ${s.allowFakeTags ? 'ON' : 'OFF'}`).setEmoji('🏷️').setStyle(s.allowFakeTags ? ButtonStyle.Success : ButtonStyle.Danger),
  );

  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:select_staff').setLabel('Select Staff').setEmoji('👮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:group_panel').setLabel('Group Panel').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  const scheduleRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:groups_per_day').setLabel('Groups Per Day').setEmoji('🔢').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:daily_schedule').setLabel('Daily Schedule').setEmoji('🗓️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('t3ap:group_schedule').setLabel('Group Schedule').setEmoji('📅').setStyle(ButtonStyle.Primary),
  );

  // Discord allows 5 action rows per message; Refresh lives in the staff row.
  return { embeds: [embed], components: [postRow, registerRow, settingsRow, staffRow, scheduleRow] };
}

// --- Sub-views ---

function buildChannelPickerView(key, label, hint) {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`t3ap_channel:${key}`)
    .setPlaceholder(`Choose the ${label}`)
    .addChannelTypes(ChannelType.GuildText);
  return {
    content: `**${label}** — ${hint}\n\nPick a channel below:`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow()],
  };
}

function buildRolePickerView(key, label, hint) {
  const select = new RoleSelectMenuBuilder()
    .setCustomId(`t3ap_role:${key}`)
    .setPlaceholder(`Choose the ${label}`);
  return {
    content: `**${label}** — ${hint}\n\nPick a role below:`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow()],
  };
}

// Multi-user picker for "Select Staff" — pre-filled with the current roster.
function buildStaffPickerView(currentStaffIds) {
  const select = new UserSelectMenuBuilder()
    .setCustomId('t3ap_staff_select')
    .setPlaceholder(`Choose staff members (${T3_STAFF_ROLE_NAME} role)`)
    .setMinValues(0)
    .setMaxValues(25);
  if (currentStaffIds && currentStaffIds.length) select.setDefaultUsers(currentStaffIds.slice(0, 25));
  return {
    content: `**Select Staff** — picks who holds the **${T3_STAFF_ROLE_NAME}** role. Adding someone gives them the role; removing someone here takes it away. Staff can use **Publish Slot List**, **Match Reminder**, **Result** and \`!open\` in the group lobbies — nothing else.\n\nPick staff members below:`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow()],
  };
}

function buildGroupPanelModal() {
  return new ModalBuilder()
    .setCustomId('t3ap_group_panel_modal')
    .setTitle("Re-post a Group's Admin Panel")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('group_number')
        .setLabel('Group number (or letter)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 1, or the channel's group letter like A")
        .setRequired(true)
        .setMaxLength(10)
    ));
}

function buildGroupsPerDayModal(store) {
  return new ModalBuilder()
    .setCustomId('admin_groups_per_day_modal')
    .setTitle('Set Groups Per Day')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('count')
          .setLabel('How many groups should play per day? (1-25)')
          .setStyle(TextInputStyle.Short)
          .setValue(String(getGroupsPerDay(store.scrim)))
          .setRequired(true)
          .setMaxLength(2)
      )
    );
}

// --- Button handler ---

async function handleButton(interaction) {
  if (!hasManageGuild(interaction)) return interaction.reply(NO_PERMISSION);

  const action = interaction.customId.slice('t3ap:'.length);
  const store = settingsOf(interaction);

  if (action === 'refresh' || action === 'back') {
    return interaction.update({ content: null, ...buildAdminPanelPayload(store) });
  }

  if (action === 'toggle_fake_tags') {
    store.settings.allowFakeTags = !store.settings.allowFakeTags;
    saveGuildStore(interaction.guildId, store);
    return interaction.update({ content: null, ...buildAdminPanelPayload(store) });
  }

  if (action === 'select_staff') {
    return interaction.update(buildStaffPickerView(store.settings.scrimsManagementStaffIds));
  }

  if (action === 'group_panel') {
    return interaction.showModal(buildGroupPanelModal());
  }

  if (action === 'clear_role') {
    store.settings.requiredRoleId = null;
    saveGuildStore(interaction.guildId, store);
    const payload = buildAdminPanelPayload(store);
    payload.content = '✅ **Required Role** cleared — registration is now **closed** until a new required role is set (there\'s no "open to everyone" mode).';
    return interaction.update(payload);
  }

  if (action === 'post_register' || action === 'post_live') {
    const label = action === 'post_register' ? 'Registration Panel' : 'Live Panel';
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`t3ap_channel:${action}`)
      .setPlaceholder(`Choose a channel to post the ${label} in`)
      .addChannelTypes(ChannelType.GuildText);
    return interaction.update({
      content: `Pick a channel to post the **${label}** in:`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), backRow()],
    });
  }

  if (action.startsWith('set_')) {
    const key = action.slice('set_'.length);
    if (CHANNEL_SETTINGS[key]) {
      const { label, hint } = CHANNEL_SETTINGS[key];
      return interaction.update(buildChannelPickerView(key, label, hint));
    }
    if (ROLE_SETTINGS[key]) {
      const { label, hint } = ROLE_SETTINGS[key];
      return interaction.update(buildRolePickerView(key, label, hint));
    }
  }

  if (action === 'groups_per_day') {
    return interaction.showModal(buildGroupsPerDayModal(store));
  }

  if (action === 'daily_schedule') {
    const groupsPerDay = getGroupsPerDay(store.scrim);
    if (groupsPerDay !== 2) {
      return interaction.reply({
        content: `❌ This only works with exactly 2 groups/day (currently ${groupsPerDay}). Use **Group Schedule** instead.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(buildDailyScheduleModal(store));
  }

  if (action === 'group_schedule') {
    return interaction.reply({ ...buildGroupSchedulePanelPayload(store), flags: MessageFlags.Ephemeral });
  }
}

// --- Channel select handler ---

async function handleChannelSelect(interaction) {
  if (!hasManageGuild(interaction)) return interaction.reply(NO_PERMISSION);

  const key = interaction.customId.slice('t3ap_channel:'.length);
  const channel = interaction.channels.first();
  const store = settingsOf(interaction);

  if (key === 'post_register' || key === 'post_live') {
    const me = interaction.guild.members.me;
    if (!channel.permissionsFor(me).has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      return interaction.update({
        content: `❌ I don't have permission to post in ${channel}. I need **View Channel**, **Send Messages** and **Embed Links** there.`,
        components: [backRow()],
      });
    }
    try {
      if (key === 'post_register') await channel.send(buildRegistrationPanelPayload());
      else await postLivePanel(interaction, channel);
    } catch (err) {
      console.error('Failed to post T3 panel from admin panel:', err);
      return interaction.update({
        content: `❌ Couldn't post to ${channel}. Please check my permissions there.`,
        components: [backRow()],
      });
    }
    const payload = buildAdminPanelPayload(store);
    payload.content = `✅ ${key === 'post_register' ? 'Registration' : 'Live'} panel posted to ${channel}.`;
    return interaction.update(payload);
  }

  if (CHANNEL_SETTINGS[key]) {
    store.settings[key] = channel.id;
    saveGuildStore(interaction.guildId, store);
    const payload = buildAdminPanelPayload(store);
    payload.content = `✅ **${CHANNEL_SETTINGS[key].label}** set to ${channel}. ${CHANNEL_SETTINGS[key].saved}`;
    return interaction.update(payload);
  }
}

// --- Role select handler ---

async function handleRoleSelect(interaction) {
  if (!hasManageGuild(interaction)) return interaction.reply(NO_PERMISSION);

  const key = interaction.customId.slice('t3ap_role:'.length);
  const role = interaction.roles.first();
  const store = settingsOf(interaction);
  if (!ROLE_SETTINGS[key]) return;

  // The bot hands out the Register Role, so it must be a normal role below the
  // bot's own. (Required Role is only checked, never assigned, so no guard.)
  if (ROLE_SETTINGS[key].assignable) {
    if (role.managed) {
      return interaction.update({
        content: '❌ That role is managed by an integration (e.g. a bot or booster role) and can\'t be assigned manually. Pick a regular role instead.',
        components: [backRow()],
      });
    }
    if (role.position >= interaction.guild.members.me.roles.highest.position) {
      return interaction.update({
        content: `❌ I can't assign **${role.name}** — it's positioned above my highest role. Move my bot's role above it in Server Settings → Roles.`,
        components: [backRow()],
      });
    }
  }

  store.settings[key] = role.id;
  saveGuildStore(interaction.guildId, store);
  const payload = buildAdminPanelPayload(store);
  payload.content = `✅ **${ROLE_SETTINGS[key].label}** set to ${role}. ${ROLE_SETTINGS[key].saved}`;
  return interaction.update(payload);
}

// --- Staff select handler ("Select Staff" -> T3 staff role) ---

async function handleStaffSelect(interaction) {
  if (!hasManageGuild(interaction)) return interaction.reply(NO_PERMISSION);

  const store = settingsOf(interaction);
  const selectedIds = interaction.values;

  const bots = selectedIds.filter(id => interaction.users.get(id)?.bot);
  if (bots.length) {
    return interaction.update({
      content: `❌ Bots can't be selected as staff: ${bots.map(id => `<@${id}>`).join(', ')}. Remove them and pick staff members again.`,
      components: [backRow()],
    });
  }

  await interaction.deferUpdate();

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    return interaction.editReply({ content: '❌ I need the **Manage Roles** permission to manage the staff role.', embeds: [], components: [backRow()] });
  }

  let role;
  try {
    role = await getOrCreateStaffRole(interaction, store);
  } catch (err) {
    return interaction.editReply({ content: `❌ Couldn't create the **${T3_STAFF_ROLE_NAME}** role: ${err.message}`, embeds: [], components: [backRow()] });
  }
  if (role.position >= botMember.roles.highest.position) {
    return interaction.editReply({
      content: `❌ I can't manage **${role.name}** — my role has to be positioned above it in Server Settings → Roles.`,
      embeds: [], components: [backRow()],
    });
  }

  const previousIds = store.settings.scrimsManagementStaffIds || [];
  const toAdd = selectedIds.filter(id => !previousIds.includes(id));
  const toRemove = previousIds.filter(id => !selectedIds.includes(id));

  for (const id of toAdd) {
    try {
      const member = await interaction.guild.members.fetch(id);
      if (!member.roles.cache.has(role.id)) await member.roles.add(role.id);
    } catch (err) {
      console.error(`[t3-staff] Failed to add role to ${id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    }
  }
  for (const id of toRemove) {
    try {
      const member = await interaction.guild.members.fetch(id);
      if (member.roles.cache.has(role.id)) await member.roles.remove(role.id);
    } catch (err) {
      console.error(`[t3-staff] Failed to remove role from ${id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    }
  }

  store.settings.scrimsManagementStaffIds = selectedIds;
  saveGuildStore(interaction.guildId, store);

  // Staff need to be able to see lobbies that already exist.
  await grantStaffRoleToExistingLobbies(interaction.guild, store, role.id);

  const payload = buildAdminPanelPayload(store);
  payload.content = `✅ **Scrims Management Staff** updated — ${selectedIds.length} member(s) now hold ${role}.`;
  return interaction.editReply(payload);
}

// --- Group panel modal submit ("Group Panel" button) ---

// Accepts the group number players see ("1" -> Group 1) or the internal
// letter ("A"), same as !open.
function resolveGroupLetterFromInput(raw) {
  const value = raw.trim();
  if (/^[0-9]+$/.test(value)) return letterForIndex(parseInt(value, 10) - 1);
  return value.toUpperCase();
}

async function handleGroupPanelModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) return interaction.reply(NO_PERMISSION);

  const store = settingsOf(interaction);
  const letter = resolveGroupLetterFromInput(interaction.fields.getTextInputValue('group_number'));
  const channelId = store.settings.groupChannels && store.settings.groupChannels[letter];

  if (!channelId) {
    return interaction.reply({
      content: `❌ No channel exists for **${groupDisplayName(letter)}** — it's only created automatically once someone registers into it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel) {
    return interaction.editReply({ content: `❌ **${groupDisplayName(letter)}**'s lobby channel no longer exists.` });
  }

  try {
    const result = await ensureGroupResultPanel(channel, 1, letter);
    return interaction.editReply({
      content: result === 'posted'
        ? `✅ **${groupDisplayName(letter)}**'s admin panel had been deleted — posted a fresh one in <#${channelId}>.`
        : `✅ **${groupDisplayName(letter)}**'s admin panel is already live in <#${channelId}>.`,
    });
  } catch (err) {
    console.error(`[t3-group-panel] Failed to post panel for ${groupDisplayName(letter)}: ${err.message}`);
    return interaction.editReply({ content: `❌ Couldn't post in <#${channelId}>. Check that I can view and send messages there.` });
  }
}

// --- Groups-per-day modal submit ---

async function handleGroupsPerDayModalSubmit(interaction) {
  if (!hasManageGuild(interaction)) return interaction.reply(NO_PERMISSION);

  const raw = interaction.fields.getTextInputValue('count').trim();
  const count = parseInt(raw, 10);
  if (!Number.isInteger(count) || count < 1 || count > 25) {
    return interaction.reply({ content: `❌ "${raw}" isn't valid — enter a whole number from 1 to 25.`, flags: MessageFlags.Ephemeral });
  }

  const store = settingsOf(interaction);
  const previous = getGroupsPerDay(store.scrim);
  store.scrim.groupsPerDay = count;
  saveGuildStore(interaction.guildId, store);

  let note = '';
  if (count > previous) {
    note += `\n⚠️ New time slots (positions ${previous + 1}-${count}) have no match times set yet — use **Group Schedule** to set them.`;
  }
  if (count !== 2) {
    note += '\nℹ️ **Daily Schedule** only works when the count is exactly 2 — use **Group Schedule** otherwise.';
  }

  const payload = buildAdminPanelPayload(store);
  payload.content = `✅ Groups per day changed from **${previous}** to **${count}**.${note}`;
  // Modal submits that came from a panel button can update that message in place.
  if (interaction.isFromMessage && interaction.isFromMessage()) await interaction.update(payload);
  else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });

  await refreshLivePanel(interaction.client, interaction.guildId);
}

// Old panels posted before this redesign used different button IDs, which no
// longer do anything. Tell the admin to open the new one instead of failing silently.
async function handleLegacyPanelInteraction(interaction) {
  return interaction.reply({
    content: '⚠️ This is an old version of the T3 admin panel. Run **/t3-admin-panel** to get the new one.',
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  buildAdminPanelPayload,
  handleButton,
  handleChannelSelect,
  handleRoleSelect,
  handleStaffSelect,
  handleGroupPanelModalSubmit,
  handleGroupsPerDayModalSubmit,
  handleLegacyPanelInteraction,
};
