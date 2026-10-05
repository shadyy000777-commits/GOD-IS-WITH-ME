const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./t3-storage');
const { getGroupsPerDay } = require('./t3-group-schedule');
const { buildRegistrationPanelPayload } = require('./t3-registration-handlers');
const { postLivePanel, refreshLivePanel } = require('./t3-live-panel-handlers');
const { buildGroupSchedulePanelPayload, buildDailyScheduleModal } = require('./t3-group-schedule-handlers');

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

const CHANNEL_SETTINGS = {
  logChannelId: { label: 'Log Channel', hint: 'Where each submitted T3 team registration is posted' },
};

const ROLE_SETTINGS = {
  requiredRoleId: { label: 'Required Role', hint: 'Only members with this role can register for T3 Scrims' },
};

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
      { name: '<:559950clipboard:1549274535579230238> Log Channel', value: ch(s.logChannelId), inline: true },
      { name: '<:767939ticket:1554519520096292874> Required Role', value: role(s.requiredRoleId), inline: true },
      { name: '🔢 Groups Per Day', value: String(groupsPerDay), inline: true },
      { name: '🏷️ Registration Fake Tags', value: s.allowFakeTags ? '✅ ON — a player can be picked in multiple teams' : '❌ OFF — a player can only be on one team', inline: true },
    )
    .setFooter({ text: 'Only you can see this panel.' });

  const postRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:post_register').setLabel('Post Registration Panel').setEmoji('📥').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('t3ap:post_live').setLabel('Post Live Panel').setEmoji('📡').setStyle(ButtonStyle.Success),
  );

  const settingsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:set_logChannelId').setLabel('Log Channel').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:set_requiredRoleId').setLabel('Required Role').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:clear_role').setLabel('Clear Role').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:toggle_fake_tags').setLabel(`Fake Tags: ${s.allowFakeTags ? 'ON' : 'OFF'}`).setEmoji('🏷️').setStyle(s.allowFakeTags ? ButtonStyle.Success : ButtonStyle.Danger),
  );

  const scheduleRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:groups_per_day').setLabel('Groups Per Day').setEmoji('🔢').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t3ap:daily_schedule').setLabel('Daily Schedule').setEmoji('🗓️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('t3ap:group_schedule').setLabel('Group Schedule').setEmoji('📅').setStyle(ButtonStyle.Primary),
  );

  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t3ap:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [postRow, settingsRow, scheduleRow, refreshRow] };
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
    payload.content = `✅ **${CHANNEL_SETTINGS[key].label}** set to ${channel}. Submitted T3 registrations will be posted there.`;
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

  store.settings[key] = role.id;
  saveGuildStore(interaction.guildId, store);
  const payload = buildAdminPanelPayload(store);
  payload.content = `✅ **${ROLE_SETTINGS[key].label}** set to ${role}. Only members with it can now register for T3 Scrims.`;
  return interaction.update(payload);
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
  handleGroupsPerDayModalSubmit,
  handleLegacyPanelInteraction,
};
