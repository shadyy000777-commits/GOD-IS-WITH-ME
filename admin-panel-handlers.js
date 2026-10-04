const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { buildVerifyPanelPayload, buildRegisterPanelPayload } = require('./panel-payloads');
const { groupDisplayName, letterForIndex } = require('./group-schedule');
const { refreshGroupSlotList } = require('./live-panel-handlers');

// One place that describes every channel/role/message setting the panel
// can edit — the main view, the select-menu prompts, and the save logic
// all read from these instead of repeating the key/label everywhere.
const CHANNEL_SETTINGS = {
  verifyLogChannelId: { label: 'Verify Channel', hint: 'Public verification summary card' },
  privateVerifyLogChannelId: { label: 'Private Verify Channel', hint: 'Full verification card (WhatsApp, email, IGN/UID) — should be staff-only' },
  registrationLogChannelId: { label: 'Register Channel', hint: 'Public registration summary card' },
  privateRegistrationLogChannelId: { label: 'Private Register Channel', hint: 'Full registration card (team #, IGN/UID, substitute) — should be staff-only' },
};

const ROLE_SETTINGS = {
  verifiedRoleId: { label: 'Verify Role', hint: 'Given automatically when a player verifies their team' },
  registeredRoleId: { label: 'Register Role', hint: 'Given automatically when a player registers a team' },
  requiredVerifyRoleId: { label: 'Required Role', hint: 'Only members with this role can use the Verification panel — leave unset to allow everyone' },
};

const MESSAGE_SETTINGS = {
  verifyConfirmationMessage: { label: 'Verify Confirmation Message', hint: 'Footer shown on the "Verified" card a player gets after verifying' },
  registerConfirmationMessage: { label: 'Register Confirmation Message', hint: 'Footer shown on the "Registration Complete" card a player gets' },
};

// The role handed out to whoever is picked in "Select Staff" below — gives
// access to the group admin panel posted in each group's channel (see
// group-admin-panel.js's hasAdminAccess) without granting Manage Server or
// anything else the bot gates. Auto-created the first time it's needed,
// same pattern as the "Scrims Ban" role in punish-handlers.js.
const SCRIMS_MANAGEMENT_ROLE_NAME = 'SCRIMS MANAGEMENT';

async function getOrCreateScrimsManagementRole(interaction, store) {
  if (!store.settings) store.settings = {};
  const existingId = store.settings.scrimsManagementRoleId;
  const existing = existingId ? interaction.guild.roles.cache.get(existingId) : null;
  if (existing) return existing;

  const role = await interaction.guild.roles.create({
    name: SCRIMS_MANAGEMENT_ROLE_NAME,
    color: 0xED4245,
    mentionable: false,
    reason: 'Auto-created for the admin panel\'s "Select Staff" list (grants group admin panel access)',
  });
  store.settings.scrimsManagementRoleId = role.id;
  saveGuildStore(interaction.guildId, store);
  return role;
}

function settingsOf(interaction) {
  const store = getGuildStore(interaction.guildId);
  if (!store.settings) store.settings = {};
  return store;
}

// --- Main panel view ---

function buildAdminPanelPayload(store) {
  const s = store.settings || {};
  const ch = id => (id ? `<#${id}>` : '*Not set*');
  const role = id => (id ? `<@&${id}>` : '*Not set*');

  const embed = new EmbedBuilder()
    .setTitle('<:Gemini_Generated_Image_2vjc222vj:1554520428456841306> Admin Panel')
    .setColor(0x5865F2)
    .setDescription('Configure verification, registration, roles and channels — all from here.')
    .addFields(
      { name: '<a:452028tick:1549274499789365339> Verify Channel', value: ch(s.verifyLogChannelId), inline: true },
      { name: '<:53678verified:1549274529535234109> Verify Role', value: role(s.verifiedRoleId), inline: true },
      { name: '<:559950clipboard:1549274535579230238> Register Channel', value: ch(s.registrationLogChannelId), inline: true },
      { name: '<:687464ticketsupportroleicon:1554519524445790369> Register Role', value: role(s.registeredRoleId), inline: true },
      { name: '<:767939ticket:1554519520096292874> Required Role', value: role(s.requiredVerifyRoleId), inline: true },
      { name: '<:63116helperroleicon:1554519005010722948> Scrims Management Staff', value: `${role(s.scrimsManagementRoleId)} — ${(s.scrimsManagementStaffIds || []).length} member(s)`, inline: true },
      { name: '<:414779lock:1554519522260680724> Private Verify Channel', value: ch(s.privateVerifyLogChannelId), inline: true },
      { name: '<:414779lock:1554519522260680724> Private Register Channel', value: ch(s.privateRegistrationLogChannelId), inline: true },
      { name: '🏷️ Registration Fake Tags', value: s.allowFakeTags ? '✅ ON — a player can be picked in multiple teams' : '❌ OFF — a player can only be on one team', inline: true },
    )
    .setFooter({ text: 'Only you can see this panel.' });

  const postRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:post_verify').setLabel('Post Verification Panel').setEmoji('📋').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('admin_panel:post_register').setLabel('Post Registration Panel').setEmoji('📥').setStyle(ButtonStyle.Success),
  );

  const verifyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:set_verifyLogChannelId').setLabel('Verify Channel').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:set_verifiedRoleId').setLabel('Verify Role').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:set_requiredVerifyRoleId').setLabel('Required Role').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
  );

  const registerRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:set_registrationLogChannelId').setLabel('Register Channel').setEmoji('📥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:set_registeredRoleId').setLabel('Register Role').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:toggle_fake_tags').setLabel(`Fake Tags: ${s.allowFakeTags ? 'ON' : 'OFF'}`).setEmoji('🏷️').setStyle(s.allowFakeTags ? ButtonStyle.Success : ButtonStyle.Danger),
  );

  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:select_staff').setLabel('Select Staff').setEmoji('👮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:group_panel').setLabel('Group Panel').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_panel:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  // No `content` key here on purpose — callers that need to clear a
  // leftover banner from a sub-view (channel/role picker) before showing
  // this again do so via `.update()`, which only needs `content: null`
  // when replacing an *existing* message's text. The very first
  // `interaction.reply()` in cmd-admin-panel.js doesn't have that problem.
  return { embeds: [embed], components: [postRow, verifyRow, registerRow, refreshRow] };
}

// --- Sub-views: pick a channel / pick a role ---

function buildChannelPickerView(key, label, hint) {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`admin_panel_channel_select:${key}`)
    .setPlaceholder(`Choose the ${label}`)
    .addChannelTypes(ChannelType.GuildText);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
  );

  return {
    content: `**${label}** — ${hint}\n\nPick a channel below:`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow],
  };
}

function buildRolePickerView(key, label, hint) {
  const select = new RoleSelectMenuBuilder()
    .setCustomId(`admin_panel_role_select:${key}`)
    .setPlaceholder(`Choose the ${label}`);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
  );

  return {
    content: `**${label}** — ${hint}\n\nPick a role below:`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow],
  };
}

// Multi-user picker for "Select Staff" — pre-fills with whoever is
// currently on the list (setDefaultUsers) so re-opening it shows the
// existing roster instead of a blank menu. Discord caps select menus at
// 25 options/defaults, matching the guild role limit this bot already
// respects elsewhere.
function buildStaffPickerView(currentStaffIds) {
  const select = new UserSelectMenuBuilder()
    .setCustomId('admin_panel_staff_select')
    .setPlaceholder('Choose staff members (SCRIMS MANAGEMENT role)')
    .setMinValues(0)
    .setMaxValues(25);

  if (currentStaffIds && currentStaffIds.length) {
    select.setDefaultUsers(currentStaffIds.slice(0, 25));
  }

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
  );

  return {
    content: '**Select Staff** — picks who holds the **SCRIMS MANAGEMENT** role. Adding someone gives them the role; removing someone here takes it away. Staff with this role can only use the group admin panel posted in each group\'s channel.\n\nPick staff members below:',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow],
  };
}

function buildMessageModal(key, label, currentValue) {
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(label.slice(0, 45))
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(300)
    .setPlaceholder('Leave blank to reset to the default message');

  if (currentValue) input.setValue(currentValue);

  return new ModalBuilder()
    .setCustomId(`admin_panel_modal:${key}`)
    .setTitle(label.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildGroupPanelModal() {
  const input = new TextInputBuilder()
    .setCustomId('group_number')
    .setLabel('Group number (or letter)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 1, or the channel\'s group letter like A')
    .setRequired(true)
    .setMaxLength(10);

  return new ModalBuilder()
    .setCustomId('admin_panel_group_panel_modal')
    .setTitle("Re-post a Group's Admin Panel")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

// --- Button handler ---

async function handleAdminPanelButton(interaction) {
  const action = interaction.customId.slice('admin_panel:'.length);
  const store = settingsOf(interaction);

  if (action === 'refresh' || action === 'back') {
    // content: null explicitly clears any leftover banner text from a
    // sub-view (channel/role picker) this is returning from — omitting it
    // would leave that old text sitting above the panel embed.
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

  if (action === 'post_verify' || action === 'post_register') {
    const label = action === 'post_verify' ? 'Verification Panel' : 'Registration Panel';
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`admin_panel_channel_select:${action}`)
      .setPlaceholder(`Choose a channel to post the ${label} in`)
      .addChannelTypes(ChannelType.GuildText);

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
    );

    return interaction.update({
      content: `Pick a channel to post the **${label}** in:`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(select), backRow],
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

  if (action.startsWith('msg_')) {
    const key = action.slice('msg_'.length);
    if (MESSAGE_SETTINGS[key]) {
      const { label } = MESSAGE_SETTINGS[key];
      return interaction.showModal(buildMessageModal(key, label, store.settings[key]));
    }
  }
}

// --- Channel select handler ---

async function handleAdminPanelChannelSelect(interaction) {
  const key = interaction.customId.slice('admin_panel_channel_select:'.length);
  const channel = interaction.channels.first();
  const store = settingsOf(interaction);

  if (key === 'post_verify' || key === 'post_register') {
    const me = interaction.guild.members.me;
    if (!channel.permissionsFor(me).has(['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'])) {
      return interaction.update({
        content: `❌ I don't have permission to post in ${channel}. I need **View Channel**, **Send Messages**, **Embed Links**, and **Attach Files** there.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
        )],
      });
    }

    try {
      const payload = key === 'post_verify' ? buildVerifyPanelPayload() : buildRegisterPanelPayload();
      await channel.send(payload);
    } catch (err) {
      console.error('Failed to post panel from admin panel:', err);
      return interaction.update({
        content: `❌ Couldn't post to ${channel}. Please check my permissions there.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
        )],
      });
    }

    const payload = buildAdminPanelPayload(store);
    payload.content = `✅ ${key === 'post_verify' ? 'Verification' : 'Registration'} panel posted to ${channel}.`;
    return interaction.update(payload);
  }

  if (CHANNEL_SETTINGS[key]) {
    store.settings[key] = channel.id;
    saveGuildStore(interaction.guildId, store);
    const payload = buildAdminPanelPayload(store);
    payload.content = `✅ **${CHANNEL_SETTINGS[key].label}** set to ${channel}.`;
    return interaction.update(payload);
  }
}

// --- Role select handler ---

async function handleAdminPanelRoleSelect(interaction) {
  const key = interaction.customId.slice('admin_panel_role_select:'.length);
  const role = interaction.roles.first();
  const store = settingsOf(interaction);

  if (!ROLE_SETTINGS[key]) return;

  // Same guardrails the standalone /set-*-role commands already use — a
  // managed role can't be assigned by hand, and the bot can't hand out a
  // role positioned above its own highest role.
  if (role.managed) {
    return interaction.update({
      content: '❌ That role is managed by an integration (e.g. a bot or booster role) and can\'t be assigned manually. Pick a regular role instead.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  const botMember = interaction.guild.members.me;
  if (role.position >= botMember.roles.highest.position) {
    return interaction.update({
      content: `❌ I can't assign **${role.name}** — it's positioned above my highest role. Move my bot's role above it in Server Settings → Roles.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  store.settings[key] = role.id;
  saveGuildStore(interaction.guildId, store);
  const payload = buildAdminPanelPayload(store);
  payload.content = `✅ **${ROLE_SETTINGS[key].label}** set to ${role}.`;
  return interaction.update(payload);
}

// --- Staff select handler ("Select Staff" → SCRIMS MANAGEMENT role) ---

async function handleAdminPanelStaffSelect(interaction) {
  const store = settingsOf(interaction);
  const selectedIds = interaction.values;

  // UserSelectMenu can surface bot accounts too — staff should always be
  // real members, so bail out with the same fields still shown (Discord
  // remembers the picker's current selection) instead of silently role-ing
  // a bot.
  const bots = selectedIds.filter(id => interaction.users.get(id)?.bot);
  if (bots.length) {
    return interaction.update({
      content: `❌ Bots can't be selected as staff: ${bots.map(id => `<@${id}>`).join(', ')}. Remove them and pick staff members again.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  await interaction.deferUpdate();

  const role = await getOrCreateScrimsManagementRole(interaction, store);

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles') || role.position >= botMember.roles.highest.position) {
    return interaction.editReply({
      content: `❌ I can't manage **${role.name}** — make sure I have **Manage Roles** and that my role is positioned above it in Server Settings → Roles.`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_panel:back').setLabel('◀ Back to Panel').setStyle(ButtonStyle.Secondary),
      )],
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
      console.error(`[scrims-management] Failed to add role to ${id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    }
  }
  for (const id of toRemove) {
    try {
      const member = await interaction.guild.members.fetch(id);
      if (member.roles.cache.has(role.id)) await member.roles.remove(role.id);
    } catch (err) {
      // Member may have left the server — nothing to clean up on their end.
      console.error(`[scrims-management] Failed to remove role from ${id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    }
  }

  store.settings.scrimsManagementStaffIds = selectedIds;
  saveGuildStore(interaction.guildId, store);

  const payload = buildAdminPanelPayload(store);
  payload.content = `✅ **Scrims Management Staff** updated — ${selectedIds.length} member(s) now hold ${role}.`;
  return interaction.editReply(payload);
}

// --- Group panel modal handler ---

// Resolves either the group number players see ("1" -> "Group 1"'s
// internal letter) or the internal letter typed directly ("A"), same
// accepted formats as !open/!close (pcmd-open.js/pcmd-close.js).
function resolveGroupLetterFromInput(raw) {
  const value = raw.trim();
  if (/^[0-9]+$/.test(value)) return letterForIndex(parseInt(value, 10) - 1);
  return value.toUpperCase();
}

async function handleAdminPanelGroupPanelModalSubmit(interaction) {
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

  // Reuses the same upsert this bot already runs after every roster
  // change: edits the panel in place if it's still there, or posts a
  // brand-new one if it was deleted — either way it ends up live.
  await refreshGroupSlotList(interaction.client, interaction.guildId, letter);

  return interaction.editReply({
    content: `✅ **${groupDisplayName(letter)}**'s admin panel is live in <#${channelId}> — re-posted if it had been deleted, otherwise just refreshed.`,
  });
}

// --- Confirmation-message modal handler ---

async function handleAdminPanelModalSubmit(interaction) {
  const key = interaction.customId.slice('admin_panel_modal:'.length);
  if (!MESSAGE_SETTINGS[key]) return;

  const value = interaction.fields.getTextInputValue('value').trim();
  const store = settingsOf(interaction);
  store.settings[key] = value || null;
  saveGuildStore(interaction.guildId, store);

  const payload = buildAdminPanelPayload(store);
  payload.content = value
    ? `✅ **${MESSAGE_SETTINGS[key].label}** updated.`
    : `✅ **${MESSAGE_SETTINGS[key].label}** reset to the default.`;
  return interaction.update(payload);
}

module.exports = {
  buildAdminPanelPayload,
  handleAdminPanelButton,
  handleAdminPanelChannelSelect,
  handleAdminPanelRoleSelect,
  handleAdminPanelStaffSelect,
  handleAdminPanelGroupPanelModalSubmit,
  handleAdminPanelModalSubmit,
};
