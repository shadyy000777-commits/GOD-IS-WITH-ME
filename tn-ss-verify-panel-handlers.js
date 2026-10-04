const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, ChannelType, ModalBuilder, TextInputBuilder,
  TextInputStyle, MessageFlags,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./tn-storage');
const {
  PLATFORMS, DEFAULT_REQUIRED_SS, MAX_REQUIRED_SS, normalizeName, displayName,
  describeSetup, newSetup, countVerifiedMembers, addExtraApiKey,
} = require('./tn-ss-verification');

// ---------------------------------------------------------------------
// /ss-verify-panel — manages every screenshot-verification setup in the
// server (one per submit channel). Everything here is ephemeral and only
// available to ALLOWED_USER_IDS (checked in index.js and the slash command).
//
// Creating / editing a setup happens on a "draft" that lives in memory while
// the admin fills it in (type, channel, role, details) and is only written to
// storage when they press Save. If the bot restarts mid-edit the draft is
// gone and the panel just asks them to start again.
// ---------------------------------------------------------------------

const DRAFT_TTL_MS = 30 * 60 * 1000;
const drafts = new Map(); // "guildId:userId" -> draft

const draftKey = interaction => `${interaction.guildId}:${interaction.user.id}`;

function pruneDrafts() {
  const now = Date.now();
  for (const [k, d] of drafts) if (now - d.touchedAt > DRAFT_TTL_MS) drafts.delete(k);
}

function getDraft(interaction) {
  const d = drafts.get(draftKey(interaction));
  if (!d) return null;
  if (Date.now() - d.touchedAt > DRAFT_TTL_MS) {
    drafts.delete(draftKey(interaction));
    return null;
  }
  d.touchedAt = Date.now();
  return d;
}

function startDraft(interaction, fields) {
  pruneDrafts();
  const d = {
    mode: 'new', editing: null, type: null, accountName: '', link: '', keywords: [],
    channelId: null, roleId: null, requiredSs: DEFAULT_REQUIRED_SS, allowSame: false,
    successMessage: null, ...fields, touchedAt: Date.now(),
  };
  drafts.set(draftKey(interaction), d);
  return d;
}

const expiredPayload = () => ({
  content: '⚠️ That session expired (or the bot restarted). Open the panel again with `/ss-verify-panel`.',
  embeds: [],
  components: [],
});

const backRow = (id = 'ssvp:main', label = '◀ Back to Panel') => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary),
);

// ------------------------------------------------------------ main view
function buildSsVerifyPanelPayload(store) {
  const setups = Object.values(store.ssSetups || {});
  const s = store.settings || {};

  const lines = setups.map(setup => {
    const p = PLATFORMS[setup.type];
    const label = p ? describeSetup(setup) : `Unknown type (${setup.type})`;
    return `• <#${setup.channelId}> — **${label}** → <@&${setup.roleId}> · ${setup.requiredSs} SS · ${countVerifiedMembers(store, setup)} verified`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📸 Screenshot Verification Panel')
    .setColor(0x5865F2)
    .setDescription(
      'Each **setup** is a submit channel where members post screenshots (of an Instagram / YouTube / Twitter follow, Rooter, Loco, any screenshot, or a custom keyword) and get a role once enough of them check out.\n\n'
      + (lines.length ? lines.join('\n') : '*No setups yet — press **New Setup** to create one.*'),
    )
    .addFields({
      name: 'Log Channel',
      value: s.ssVerifyLogChannelId ? `<#${s.ssVerifyLogChannelId}>` : '*Default (auto-created)*',
      inline: true,
    })
    .setFooter({ text: 'Only you can see this panel.' });
  embed.setDescription(embed.data.description.slice(0, 4000));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ssvp:new').setLabel('New Setup').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ssvp:edit').setLabel('Edit Setup').setEmoji('⚙️').setStyle(ButtonStyle.Secondary).setDisabled(setups.length === 0),
    new ButtonBuilder().setCustomId('ssvp:log').setLabel('Log Channel').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ssvp:faq').setLabel('FAQ').setEmoji('❓').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ssvp:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ssvp:addkey').setLabel('Add API Key').setEmoji('🔑').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row, row2] };
}

function buildAddKeyModal() {
  const key = new TextInputBuilder()
    .setCustomId('key')
    .setLabel('Gemini API key')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(10)
    .setMaxLength(200)
    .setPlaceholder('AIza...');

  return new ModalBuilder()
    .setCustomId('ssvp_modal_addkey')
    .setTitle('Add a Gemini API Key')
    .addComponents(new ActionRowBuilder().addComponents(key));
}

// Add-key modal submit (customId ssvp_modal_addkey).
async function handleSsVerifyAddKeyModalSubmit(interaction) {
  const key = interaction.fields.getTextInputValue('key').trim();
  if (key.length < 10) {
    return interaction.reply({ content: '❌ That doesn\'t look like a full API key — paste the whole thing.', flags: MessageFlags.Ephemeral });
  }

  const added = addExtraApiKey(key);
  const store = getGuildStore(interaction.guildId);
  const content = added
    ? '✅ Key added — it\'s usable right away, and will be tried automatically whenever the earlier keys are benched or exhausted.'
    : '⚠️ That key is already configured.';
  return interaction.update({ content, ...buildSsVerifyPanelPayload(store) });
}

// ----------------------------------------------------------- draft view
function draftMissing(d) {
  const missing = [];
  const p = d.type ? PLATFORMS[d.type] : null;
  if (!p) missing.push('Type');
  else if (p.kind !== 'any' && !d.accountName) missing.push(p.nameLabel);
  if (!d.channelId) missing.push('Submit Channel');
  if (!d.roleId) missing.push('Verified Role');
  return missing;
}

function buildDraftPayload(d, content) {
  const p = d.type ? PLATFORMS[d.type] : null;
  const missing = draftMissing(d);

  const embed = new EmbedBuilder()
    .setTitle(d.mode === 'edit' ? '⚙️ Edit Screenshot Setup' : '➕ New Screenshot Setup')
    .setColor(0x5865F2)
    .addFields(
      { name: 'Type', value: p ? `${p.emoji} ${p.label}` : '*Not set*', inline: true },
      {
        name: p ? p.nameLabel : 'Name',
        value: d.accountName ? displayName(d) : (p && p.kind === 'any' ? '*Not needed*' : '*Not set*'),
        inline: true,
      },
      { name: 'Submit Channel', value: d.channelId ? `<#${d.channelId}>` : '*Not set*', inline: true },
      { name: 'Verified Role', value: d.roleId ? `<@&${d.roleId}>` : '*Not set*', inline: true },
      { name: 'Screenshots Required', value: String(d.requiredSs), inline: true },
      { name: 'Allow Same Screenshot', value: d.allowSame ? 'Yes' : 'No', inline: true },
    );

  if (d.link) embed.addFields({ name: 'Link', value: d.link.slice(0, 200), inline: false });
  if (d.keywords.length) embed.addFields({ name: 'Extra Keywords', value: d.keywords.join(', ').slice(0, 500), inline: false });
  if (d.successMessage) embed.addFields({ name: 'Success Message', value: d.successMessage.slice(0, 300), inline: false });
  if (missing.length) embed.addFields({ name: '⚠️ Still needed', value: missing.join(', ') });
  embed.setFooter({ text: 'Nothing is saved until you press Save.' });

  const typeSelect = new StringSelectMenuBuilder()
    .setCustomId('ssvp_platform_select')
    .setPlaceholder('Choose the screenshot type')
    .addOptions(Object.values(PLATFORMS).map(pl => new StringSelectMenuOptionBuilder()
      .setLabel(pl.label)
      .setValue(pl.id)
      .setEmoji(pl.emoji)
      .setDefault(pl.id === d.type)));

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('ssvp_channel_select:submit')
    .setPlaceholder('Choose the submit channel')
    .addChannelTypes(ChannelType.GuildText);

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('ssvp_role_select')
    .setPlaceholder('Choose the role to give on verification');

  const buttons = [
    new ButtonBuilder().setCustomId('ssvp:details').setLabel('Details').setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(!p),
    new ButtonBuilder().setCustomId('ssvp:toggle_dup').setLabel(`Same SS: ${d.allowSame ? 'Allowed' : 'Blocked'}`).setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ssvp:save').setLabel('Save').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(missing.length > 0),
  ];
  if (d.mode === 'edit') {
    buttons.push(new ButtonBuilder().setCustomId('ssvp:delete').setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger));
  }
  buttons.push(new ButtonBuilder().setCustomId('ssvp:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));

  return {
    content: content || null,
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(typeSelect),
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(roleSelect),
      new ActionRowBuilder().addComponents(...buttons),
    ],
  };
}

// ------------------------------------------------------------ sub-views
function buildEditSelectView(interaction, store) {
  const setups = Object.values(store.ssSetups || {}).slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId('ssvp_edit_select')
    .setPlaceholder('Choose a setup to edit')
    .addOptions(setups.map(setup => {
      const channel = interaction.guild.channels.cache.get(setup.channelId);
      const p = PLATFORMS[setup.type];
      return new StringSelectMenuOptionBuilder()
        .setLabel(`#${channel ? channel.name : setup.channelId}`.slice(0, 100))
        .setValue(setup.channelId)
        .setDescription(`${p ? p.label : setup.type} · ${setup.requiredSs} SS · ${countVerifiedMembers(store, setup)} verified`.slice(0, 100));
    }));

  return {
    content: '**Edit Setup** — which submit channel\'s setup do you want to change?',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow()],
  };
}

function buildLogChannelView() {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId('ssvp_channel_select:log')
    .setPlaceholder('Choose the log channel')
    .addChannelTypes(ChannelType.GuildText);
  return {
    content: '**Log Channel** — where completed verifications get logged (optional — falls back to an auto-created staff-only channel).\n\nPick a channel below:',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select), backRow()],
  };
}

function buildFaqView() {
  const embed = new EmbedBuilder()
    .setTitle('📸 Screenshot Verification — FAQ')
    .setColor(0x5865F2)
    .setDescription([
      '**How does it work?** Members post screenshots in a setup\'s submit channel. Each one is checked on its own and counted if it passes; when a member reaches the required number they get the verified role.',
      '**Failed screenshots?** Only the ones that failed need to be resent — the passed ones stay counted.',
      '**Duplicates?** Re-saved or recompressed copies of the same screenshot are caught too, and so is the same screenshot sent by two different members. Turn on *Same SS: Allowed* to skip that check.',
      '**Types:** Instagram / YouTube / Twitter-X / Rooter / Loco check the profile shows the account as followed. *Any Screenshot* accepts any png/jpg. *Custom Filter* needs the name (or one of the extra keywords) visible.',
      '**Limits:** 1 submission per member every 7s, 10 per server per minute.',
      '**Staff:** members with a role named `tourney-mod` are ignored in submit channels.',
      '**Deleting** the submit channel or the verified role removes that setup.',
      'The bot\'s role must sit **above** the verified role.',
    ].join('\n\n'));
  return { content: null, embeds: [embed], components: [backRow()] };
}

function buildDeleteConfirmView(store, d) {
  const setup = store.ssSetups && store.ssSetups[d.editing];
  const stored = ((store.ssData && store.ssData[d.editing]) || []).length;
  return {
    content: `🗑️ Delete the setup for <#${d.editing}>${setup ? ` (${describeSetup(setup)})` : ''}? This also erases **${stored}** stored screenshot record(s) — members will have to submit again if you recreate it. Roles already given are **not** removed.`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ssvp:delete_confirm').setLabel('Yes, delete').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ssvp:draft').setLabel('No, go back').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function buildDetailsModal(d) {
  const p = PLATFORMS[d.type];
  const isAny = p.kind === 'any';

  const name = new TextInputBuilder()
    .setCustomId('name')
    .setLabel(p.nameLabel.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setRequired(!isAny)
    .setMaxLength(100)
    .setPlaceholder(p.nameHint.slice(0, 100));
  if (d.accountName) name.setValue(d.accountName);

  const link = new TextInputBuilder()
    .setCustomId('link')
    .setLabel('Profile / channel link (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(200)
    .setPlaceholder('https://...');
  if (d.link) link.setValue(d.link);

  const keywords = new TextInputBuilder()
    .setCustomId('keywords')
    .setLabel('Extra keywords (custom type only)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(300)
    .setPlaceholder('Comma separated');
  if (d.keywords.length) keywords.setValue(d.keywords.join(', '));

  const count = new TextInputBuilder()
    .setCustomId('count')
    .setLabel(`Screenshots required (1-${MAX_REQUIRED_SS})`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(2)
    .setValue(String(d.requiredSs));

  const message = new TextInputBuilder()
    .setCustomId('message')
    .setLabel('Success message (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500)
    .setPlaceholder('Shown when a member finishes verification. Leave empty for the default.');
  if (d.successMessage) message.setValue(d.successMessage);

  return new ModalBuilder()
    .setCustomId('ssvp_modal_details')
    .setTitle(`Screenshot setup — ${p.label}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(name),
      new ActionRowBuilder().addComponents(link),
      new ActionRowBuilder().addComponents(keywords),
      new ActionRowBuilder().addComponents(count),
      new ActionRowBuilder().addComponents(message),
    );
}

// ------------------------------------------------------ button handler
async function handleSsVerifyPanelButton(interaction) {
  const action = interaction.customId.slice('ssvp:'.length);
  const store = getGuildStore(interaction.guildId);

  if (action === 'main' || action === 'refresh') {
    return interaction.update({ content: null, ...buildSsVerifyPanelPayload(store) });
  }

  if (action === 'cancel') {
    drafts.delete(draftKey(interaction));
    return interaction.update({ content: null, ...buildSsVerifyPanelPayload(store) });
  }

  if (action === 'new') {
    return interaction.update(buildDraftPayload(startDraft(interaction, {})));
  }

  if (action === 'edit') {
    if (!Object.keys(store.ssSetups || {}).length) {
      return interaction.update({ content: null, ...buildSsVerifyPanelPayload(store) });
    }
    return interaction.update(buildEditSelectView(interaction, store));
  }

  if (action === 'log') return interaction.update(buildLogChannelView());
  if (action === 'faq') return interaction.update(buildFaqView());
  if (action === 'addkey') return interaction.showModal(buildAddKeyModal());

  // Everything below works on the draft.
  const d = getDraft(interaction);
  if (!d) return interaction.update(expiredPayload());

  if (action === 'draft') return interaction.update(buildDraftPayload(d));

  if (action === 'details') {
    if (!d.type) return interaction.update(buildDraftPayload(d, '❌ Pick a type first.'));
    return interaction.showModal(buildDetailsModal(d));
  }

  if (action === 'toggle_dup') {
    d.allowSame = !d.allowSame;
    return interaction.update(buildDraftPayload(d));
  }

  if (action === 'save') return saveDraft(interaction, store, d);

  if (action === 'delete') {
    if (d.mode !== 'edit') return interaction.update(buildDraftPayload(d));
    return interaction.update(buildDeleteConfirmView(store, d));
  }

  if (action === 'delete_confirm') {
    if (d.mode === 'edit' && store.ssSetups && store.ssSetups[d.editing]) {
      delete store.ssSetups[d.editing];
      if (store.ssData) delete store.ssData[d.editing];
      saveGuildStore(interaction.guildId, store);
    }
    drafts.delete(draftKey(interaction));
    return interaction.update({ content: '🗑️ Setup deleted.', ...buildSsVerifyPanelPayload(store) });
  }
}

async function saveDraft(interaction, store, d) {
  const missing = draftMissing(d);
  if (missing.length) {
    return interaction.update(buildDraftPayload(d, `❌ Still needed: ${missing.join(', ')}.`));
  }

  if (!store.ssSetups) store.ssSetups = {};
  if (!store.ssData) store.ssData = {};

  if (d.channelId !== d.editing && store.ssSetups[d.channelId]) {
    return interaction.update(buildDraftPayload(d, `❌ <#${d.channelId}> already has a screenshot setup. Pick a different submit channel (or edit that one).`));
  }

  const role = interaction.guild.roles.cache.get(d.roleId);
  if (!role) {
    return interaction.update(buildDraftPayload(d, '❌ That role no longer exists — pick the verified role again.'));
  }
  if (role.position >= interaction.guild.members.me.roles.highest.position) {
    return interaction.update(buildDraftPayload(d, `❌ I can't assign **${role.name}** — it's above my highest role. Move my bot's role above it in Server Settings → Roles.`));
  }

  const old = d.editing ? store.ssSetups[d.editing] : null;
  const setup = newSetup({
    channelId: d.channelId,
    type: d.type,
    accountName: d.accountName,
    link: d.link,
    keywords: d.keywords,
    roleId: d.roleId,
    requiredSs: d.requiredSs,
    allowSame: d.allowSame,
    successMessage: d.successMessage,
    createdAt: old ? old.createdAt : undefined,
    legacyVerified: Boolean(old && old.legacyVerified),
  });

  // The submit channel was changed while editing: move the setup (and the
  // screenshots already counted for it) over to the new channel.
  if (d.editing && d.editing !== d.channelId) {
    if (store.ssData[d.editing]) {
      store.ssData[d.channelId] = store.ssData[d.editing];
      delete store.ssData[d.editing];
    }
    delete store.ssSetups[d.editing];
  }

  store.ssSetups[d.channelId] = setup;
  saveGuildStore(interaction.guildId, store);
  drafts.delete(draftKey(interaction));

  return interaction.update({
    content: `✅ Saved — members can now post screenshots in <#${setup.channelId}> (${describeSetup(setup)}).`,
    ...buildSsVerifyPanelPayload(store),
  });
}

// ----------------------------------------------------- select handlers
// Type select (customId ssvp_platform_select).
async function handleSsVerifyPlatformSelect(interaction) {
  const d = getDraft(interaction);
  if (!d) return interaction.update(expiredPayload());

  const platformId = interaction.values[0];
  const platform = PLATFORMS[platformId];
  if (!platform) return;

  d.type = platformId;
  const hint = platform.kind === 'any'
    ? `✅ Type set to **${platform.emoji} ${platform.label}** — no details needed.`
    : `✅ Type set to **${platform.emoji} ${platform.label}** — press **Details** to enter the ${platform.nameLabel.toLowerCase()}.`;
  return interaction.update(buildDraftPayload(d, hint));
}

// Edit picker (customId ssvp_edit_select).
async function handleSsVerifyEditSelect(interaction) {
  const store = getGuildStore(interaction.guildId);
  const setup = store.ssSetups && store.ssSetups[interaction.values[0]];
  if (!setup) {
    return interaction.update({ content: '❌ That setup no longer exists.', ...buildSsVerifyPanelPayload(store) });
  }
  const d = startDraft(interaction, {
    mode: 'edit',
    editing: setup.channelId,
    type: setup.type,
    accountName: setup.accountName,
    link: setup.link,
    keywords: [...(setup.keywords || [])],
    channelId: setup.channelId,
    roleId: setup.roleId,
    requiredSs: setup.requiredSs,
    allowSame: setup.allowSame,
    successMessage: setup.successMessage,
  });
  return interaction.update(buildDraftPayload(d));
}

// Role select (customId ssvp_role_select).
async function handleSsVerifyRoleSelect(interaction) {
  const d = getDraft(interaction);
  if (!d) return interaction.update(expiredPayload());

  const role = interaction.roles.first();

  if (role.managed) {
    return interaction.update(buildDraftPayload(d, '❌ That role is managed by an integration (e.g. a bot or booster role) and can\'t be assigned manually. Pick a regular role instead.'));
  }
  if (role.position >= interaction.guild.members.me.roles.highest.position) {
    return interaction.update(buildDraftPayload(d, `❌ I can't assign **${role.name}** — it's positioned above my highest role. Move my bot's role above it in Server Settings → Roles.`));
  }

  d.roleId = role.id;
  return interaction.update(buildDraftPayload(d, `✅ **Verified Role** set to ${role}.`));
}

// Channel selects (customId ssvp_channel_select:submit | :log).
async function handleSsVerifyChannelSelect(interaction) {
  const key = interaction.customId.slice('ssvp_channel_select:'.length);
  const channel = interaction.channels.first();

  if (key === 'log') {
    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    store.settings.ssVerifyLogChannelId = channel.id;
    saveGuildStore(interaction.guildId, store);
    return interaction.update({ content: `✅ **Log Channel** set to ${channel}.`, ...buildSsVerifyPanelPayload(store) });
  }

  if (key === 'submit') {
    const d = getDraft(interaction);
    if (!d) return interaction.update(expiredPayload());

    const store = getGuildStore(interaction.guildId);
    if (channel.id !== d.editing && store.ssSetups && store.ssSetups[channel.id]) {
      return interaction.update(buildDraftPayload(d, `❌ ${channel} already has a screenshot setup. Pick a different channel (or edit that setup instead).`));
    }
    d.channelId = channel.id;
    return interaction.update(buildDraftPayload(d, `✅ **Submit Channel** set to ${channel}.`));
  }
}

// ------------------------------------------------------- modal handler
// Details modal (customId ssvp_modal_details).
async function handleSsVerifyDetailsModalSubmit(interaction) {
  const d = getDraft(interaction);
  if (!d || !d.type) return interaction.reply({ ...expiredPayload(), flags: MessageFlags.Ephemeral });

  const platform = PLATFORMS[d.type];
  const fail = content => interaction.reply({ content: `❌ ${content}`, flags: MessageFlags.Ephemeral });

  const rawName = interaction.fields.getTextInputValue('name').trim();
  let accountName = '';
  if (rawName || platform.kind !== 'any') {
    const result = normalizeName(platform, rawName);
    if (!result.ok) return fail(result.error);
    accountName = result.value;
  }

  const link = interaction.fields.getTextInputValue('link').trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) return fail('The link must start with `http://` or `https://`.');

  const count = Number.parseInt(interaction.fields.getTextInputValue('count').trim(), 10);
  if (!Number.isInteger(count) || count < 1 || count > MAX_REQUIRED_SS) {
    return fail(`Screenshots required must be a number from 1 to ${MAX_REQUIRED_SS}.`);
  }

  const keywords = platform.kind === 'custom'
    ? [...new Set(interaction.fields.getTextInputValue('keywords').split(',').map(k => k.trim()).filter(Boolean))]
        .map(k => k.slice(0, 50))
        .slice(0, 10)
    : [];

  const successMessage = interaction.fields.getTextInputValue('message').trim();

  d.accountName = accountName;
  d.link = link;
  d.keywords = keywords;
  d.requiredSs = count;
  d.successMessage = successMessage || null;

  return interaction.update(buildDraftPayload(d, '✅ Details updated.'));
}

module.exports = {
  buildSsVerifyPanelPayload,
  handleSsVerifyPanelButton,
  handleSsVerifyPlatformSelect,
  handleSsVerifyEditSelect,
  handleSsVerifyRoleSelect,
  handleSsVerifyChannelSelect,
  handleSsVerifyDetailsModalSubmit,
  handleSsVerifyAddKeyModalSubmit,
};
