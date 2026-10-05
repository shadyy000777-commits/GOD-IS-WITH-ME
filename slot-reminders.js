const {
  ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, MessageFlags,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const {
  groupDisplayName, slotRangeForGroup, isGroupClosed, hasGroupMatchStarted,
  listGroupsWithFreeSlots, groupTimeSummary, dayLabelForBatch, dayBatchForLetter, formatDDMMYYYY,
  todayDayNumber,
} = require('./group-schedule');

// How long the "slot is open" alert stays in the channel before it deletes itself.
const ALERT_DELETE_AFTER_MS = 60 * 1000;

// Storage shape (per guild): store.settings.slotReminders =
//   { [groupLetter]: { [userId]: channelIdToAlertIn } }

function getReminderMap(store) {
  if (!store.settings.slotReminders) store.settings.slotReminders = {};
  return store.settings.slotReminders;
}

// --- 🔔 Set Reminder button on the registration panel ---
async function handleSlotReminderButton(interaction) {
  const store = getGuildStore(interaction.guildId);
  const scrim = store.scrim;

  if (!scrim) {
    return interaction.reply({ content: '❌ No scrim is set up right now.', flags: MessageFlags.Ephemeral });
  }

  const reminders = getReminderMap(store);
  const mine = new Set(Object.keys(reminders).filter(l => reminders[l] && reminders[l][interaction.user.id]));

  // Only groups where a reminder actually makes sense: ones that are full
  // right now, plus any the player already subscribed to (so they can untick it).
  // Only groups playing today or tomorrow, and never one whose match has
  // already started (its day is past, or its Match 1 IDP time has passed).
  const today = todayDayNumber();
  const isUpcoming = (letter) => {
    const diff = dayLabelForBatch(scrim, dayBatchForLetter(letter)).dayNumber - today;
    return diff >= 0 && diff <= 1 && !hasGroupMatchStarted(store, letter);
  };

  const options = listGroupsWithFreeSlots(scrim)
    .filter(g => isUpcoming(g.letter))
    .slice(0, 25) // Discord's select menu option cap
    .map(g => ({
      label: `${groupDisplayName(g.letter)} — ${groupTimeSummary(g.letter, store)} (${formatDDMMYYYY(dayLabelForBatch(scrim, dayBatchForLetter(g.letter)).dayNumber)})`,
      description: g.freeCount === 0 ? 'Full — ping me when a slot opens' : `${g.freeCount} slot(s) free — ping me when another opens`,
      value: g.letter,
      default: mine.has(g.letter),
    }));

  if (options.length === 0) {
    return interaction.reply({
      content: '❌ There are no upcoming groups for today or tomorrow right now (their matches may have already started).',
      flags: MessageFlags.Ephemeral,
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('slot_reminder_select')
    .setPlaceholder('Pick the group(s) you want a slot reminder for')
    .setMinValues(0)
    .setMaxValues(options.length)
    .addOptions(options);

  await interaction.reply({
    content: '🔔 **Slot Reminder** — pick the group(s) you want. When someone cancels and a slot opens up, I\'ll tag you here for a minute. ' +
      'Un-pick a group to turn its reminder off.',
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

// --- Groups picked / cleared in the menu ---
async function handleSlotReminderSelect(interaction) {
  const store = getGuildStore(interaction.guildId);
  const reminders = getReminderMap(store);
  const picked = new Set(interaction.values);

  // The menu only ever offered certain groups, so only touch those — a
  // subscription for a group that wasn't on the menu must be left alone.
  let offered = new Set(
    (interaction.message?.components?.[0]?.components?.[0]?.options || []).map(o => o.value),
  );
  if (offered.size === 0 && store.scrim) {
    offered = new Set(listGroupsWithFreeSlots(store.scrim).map(g => g.letter));
  }

  for (const letter of offered) {
    if (!reminders[letter]) reminders[letter] = {};
    if (picked.has(letter)) reminders[letter][interaction.user.id] = interaction.channelId;
    else delete reminders[letter][interaction.user.id];
    if (Object.keys(reminders[letter]).length === 0) delete reminders[letter];
  }
  saveGuildStore(interaction.guildId, store);

  const content = picked.size
    ? `✅ Reminder set for ${[...picked].map(groupDisplayName).join(', ')}. I'll tag you in <#${interaction.channelId}> as soon as a slot opens.`
    : '🔕 All your slot reminders are off.';
  await interaction.update({ content, components: [] });
}

// --- Called whenever a slot may have just been freed in a group ---
// Never throws (it's called from cancel/remove/punish flows that must
// finish regardless). Tags everyone who asked for this group, in the
// channel where they set the reminder, and deletes the alert after 1 minute.
// Reminders are one-shot: a user's reminder for the group is removed once
// they've been alerted, so they aren't pinged for every later cancellation.
async function notifySlotOpened(client, guildId, groupLetter, excludeUserId = null) {
  try {
    const store = getGuildStore(guildId);
    const scrim = store.scrim;
    if (!scrim || isGroupClosed(scrim, groupLetter)) return;

    const reminders = getReminderMap(store);
    const subs = reminders[groupLetter];
    if (!subs || Object.keys(subs).length === 0) return;

    // Make sure a slot really is free, and the group hasn't already started.
    const { start, end } = slotRangeForGroup(groupLetter, scrim.totalSlots);
    let freeCount = 0;
    for (let i = start; i <= end; i++) if (!scrim.slots[i]) freeCount++;
    if (freeCount === 0 || hasGroupMatchStarted(store, groupLetter)) return;

    // Group the people to tag by the channel they set their reminder in.
    const byChannel = {};
    for (const [userId, channelId] of Object.entries(subs)) {
      if (userId === excludeUserId) continue;
      (byChannel[channelId] = byChannel[channelId] || []).push(userId);
    }

    const embed = new EmbedBuilder()
      .setTitle('🔔 Slot Available!')
      .setColor(0x57F287)
      .setDescription(
        `A slot just opened up in **${groupDisplayName(groupLetter)}** (${groupTimeSummary(groupLetter, store)}).\n` +
        `${freeCount} slot(s) free — hit **Register Team** now before someone else takes it! (Already have a slot? Use **Change Slot** to switch — your current slot stays untouched until you do.)\n\n` +
        '_This message deletes itself in 1 minute._',
      );

    for (const [channelId, userIds] of Object.entries(byChannel)) {
      try {
        const channel = await client.channels.fetch(channelId);
        const msg = await channel.send({
          content: userIds.map(id => `<@${id}>`).join(' '),
          embeds: [embed],
          allowedMentions: { users: userIds },
        });
        setTimeout(() => msg.delete().catch(() => {}), ALERT_DELETE_AFTER_MS);
        for (const id of userIds) delete subs[id];
      } catch (err) {
        console.error(`[slot-reminders] Couldn't alert channel ${channelId}:`, err.message);
      }
    }

    if (Object.keys(subs).length === 0) delete reminders[groupLetter];
    saveGuildStore(guildId, store);
  } catch (err) {
    console.error(`[slot-reminders] Failed for Group ${groupLetter} in guild ${guildId}:`, err.message);
  }
}

module.exports = { handleSlotReminderButton, handleSlotReminderSelect, notifySlotOpened };
