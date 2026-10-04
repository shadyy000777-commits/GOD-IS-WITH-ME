const {
  ActionRowBuilder, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');
const { getGuildStore, saveGuildStore, listGuildIds } = require('./storage');
const {
  groupDisplayName, slotRangeForGroup, localSlotNumber, DISPLAY_FIRST_SLOT, resolveGroupSchedule, closeGroup, isGroupClosed,
} = require('./group-schedule');
const { publishGroupRoster, refreshLivePanel, refreshGroupSlotList } = require('./live-panel-handlers');
const { buildGroupResultEmbed } = require('./embeds');
const { buildScheduleModalForLetter } = require('./group-schedule-handlers');
const { buildPunishSelectPayload } = require('./punish-handlers');
const { hasAdminAccess } = require('./group-admin-panel');
const { setGroupChannelOpen, isGroupChannelOpen, setGroupChannelOpenState } = require('./group-channel-access');

function denyReply(interaction) {
  return interaction.reply({
    content: '❌ You need the **Manage Server** permission to use this (staff can only use Publish Slot List, Reminder, Result and Open/Close).',
    flags: MessageFlags.Ephemeral,
  });
}

// Routes every `group_admin_<action>:<letter>` button from the admin panel
// posted in each group's channel (see group-admin-panel.js).
async function handleGroupAdminButton(interaction) {
  const [rawAction, groupLetter] = interaction.customId.split(':');
  if (!hasAdminAccess(interaction, rawAction)) return denyReply(interaction);

  const store = getGuildStore(interaction.guildId);
  if (!store.scrim) {
    return interaction.reply({ content: '❌ No scrim is set up right now.', flags: MessageFlags.Ephemeral });
  }

  switch (rawAction) {
    case 'group_admin_reminder':
      return sendMatchReminder(interaction, store, groupLetter);
    case 'group_admin_publish': {
      const result = await publishGroupRoster(interaction.client, interaction.guildId, groupLetter);
      if (result.error) return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      return interaction.reply({
        content: `✅ Slot list published for **${groupDisplayName(groupLetter)}** — it'll now stay live-updated as teams register.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    case 'group_admin_manage':
      return interaction.showModal(buildScheduleModalForLetter(groupLetter, store));
    case 'group_admin_open': {
      const channelId = store.settings.groupChannels && store.settings.groupChannels[groupLetter];
      const roleId = store.settings.groupRoles && store.settings.groupRoles[groupLetter];
      if (!channelId || !roleId) {
        return interaction.reply({ content: `❌ ${groupDisplayName(groupLetter)} doesn't have a channel/role yet.`, flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel) {
        return interaction.reply({ content: `❌ ${groupDisplayName(groupLetter)}'s channel no longer exists.`, flags: MessageFlags.Ephemeral });
      }

      // Toggle: currently open -> close it (lock messages/files/threads),
      // currently closed -> open it. Same button either way — see
      // buildGroupAdminPanelRows in group-admin-panel.js for the label flip.
      const wasOpen = isGroupChannelOpen(store, groupLetter);
      const nextOpen = !wasOpen;

      // Ack immediately — editing permission overwrites is a real API call
      // and can occasionally take longer than Discord's 3-second window to
      // acknowledge a button press, which is what was showing up as "This
      // interaction failed" / bot not responding in time.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await setGroupChannelOpen(channel, roleId, nextOpen, `${nextOpen ? 'Opened' : 'Closed'} by ${interaction.user.tag} via the group admin panel`);
      } catch (err) {
        console.error(`[group-admin-open] Failed to ${nextOpen ? 'open' : 'close'} ${groupDisplayName(groupLetter)} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
        return interaction.editReply({ content: `❌ Something went wrong ${nextOpen ? 'opening' : 'closing'} this channel — make sure my role sits above the group's role.` });
      }

      setGroupChannelOpenState(store, groupLetter, nextOpen);
      saveGuildStore(interaction.guildId, store);
      // Re-render the panel's own button so it now shows the opposite action.
      await refreshGroupSlotList(interaction.client, interaction.guildId, groupLetter);

      if (nextOpen) {
        // Opening posts the SS-submission prompt publicly in the group's
        // channel (embed + group role ping) instead of a private confirmation.
        const embed = new EmbedBuilder()
          .setColor(0xF5A623)
          .setDescription(
            '**SUBMIT YOUR SS HERE**\n' +
            '**TEAM NAME-**\n' +
            '**SLOT-**\n' +
            '**SUBMIT UR SS  OF BOTH MATCHES**'
          );
        try {
          await channel.send({
            content: `<@&${roleId}>`,
            embeds: [embed],
            allowedMentions: { roles: [roleId] },
          });
        } catch (err) {
          console.error(`[group-admin-open] Failed to post SS prompt in ${groupDisplayName(groupLetter)}: ${err.code ?? ''} ${err.message}`);
          return interaction.editReply({ content: `✅ ${groupDisplayName(groupLetter)} is open, but I couldn't post the SS message in its channel — check my permissions there.` });
        }
        return interaction.editReply({ content: `🔓 **${groupDisplayName(groupLetter)}** is now open — the SS submission message was posted in <#${channelId}>.` });
      }

      return interaction.editReply({
        content: `🔒 **${groupDisplayName(groupLetter)}** is now closed — nobody with that group's role can send messages, attach files, or use threads here anymore.`,
      });
    }
    case 'group_admin_punish': {
      const payload = buildPunishSelectPayload(store.scrim, groupLetter);
      if (payload.error) return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
    case 'group_admin_result':
      if (isGroupClosed(store.scrim, groupLetter)) {
        return interaction.reply({
          content: `❌ ${groupDisplayName(groupLetter)}'s result was already posted — this group is closed.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.showModal(buildResultModal(groupLetter));
    default:
      return;
  }
}

// How long a group's channel/role stay up after its result is posted
// before they're automatically deleted.
const AUTO_DELETE_DELAY_MS = 5 * 60 * 60 * 1000; // 5 hours

// Deletes the group's channel and role (whichever exist) and cleans up
// every stored reference to them — the standing header/roster message
// ids, the "published" flag, and the auto-created-role/channel tracking
// lists — so nothing points at a now-deleted channel or role afterward.
// Doesn't touch scrim.slots — registered teams stay on record even after
// their channel/role are cleaned up.
//
// Takes the Discord client + guildId directly (not an interaction) so it
// can run unattended from a timer — see scheduleGroupAutoDelete below —
// as well as re-reading the guild's store fresh right before deleting,
// since this can fire hours after it was scheduled.
async function deleteGroupChannelAndRole(client, guildId, groupLetter, reason) {
  const store = getGuildStore(guildId);
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { deleted: [], failed: ['guild (bot is no longer in this server)'] };

  const channelId = store.settings.groupChannels && store.settings.groupChannels[groupLetter];
  const roleId = store.settings.groupRoles && store.settings.groupRoles[groupLetter];
  const deleted = [];
  const failed = [];

  if (channelId) {
    try {
      const channel = guild.channels.cache.get(channelId);
      if (channel) await channel.delete(reason);
      deleted.push('channel');
    } catch (err) {
      failed.push(`channel (${err.code ?? err.message})`);
    }
  }

  if (roleId) {
    try {
      const role = guild.roles.cache.get(roleId);
      if (role) await role.delete(reason);
      deleted.push('role');
    } catch (err) {
      failed.push(`role (${err.code ?? err.message})`);
    }
  }

  if (!store.settings.groupChannels) store.settings.groupChannels = {};
  if (!store.settings.groupRoles) store.settings.groupRoles = {};
  delete store.settings.groupChannels[groupLetter];
  delete store.settings.groupRoles[groupLetter];
  if (store.settings.groupSlotListMessageIds) delete store.settings.groupSlotListMessageIds[groupLetter];
  if (store.settings.groupRosterMessageIds) delete store.settings.groupRosterMessageIds[groupLetter];
  if (store.settings.groupRosterPublished) delete store.settings.groupRosterPublished[groupLetter];
  if (store.settings.groupFinalRosters) delete store.settings.groupFinalRosters[groupLetter];
  if (store.settings.autoGroupChannelIds) store.settings.autoGroupChannelIds = store.settings.autoGroupChannelIds.filter(id => id !== channelId);
  if (store.settings.autoGroupRoleIds) store.settings.autoGroupRoleIds = store.settings.autoGroupRoleIds.filter(id => id !== roleId);
  if (store.settings.pendingGroupDeletions) delete store.settings.pendingGroupDeletions[groupLetter];
  saveGuildStore(guildId, store);

  if (failed.length) {
    console.error(`[group-auto-delete] ${groupDisplayName(groupLetter)} in guild ${guildId} — couldn't delete: ${failed.join(', ')}.`);
  }
  return { deleted, failed };
}

// Marks a group for automatic deletion 5 hours from now and arms an
// in-process timer for it. The timestamp is also persisted to the guild
// store (settings.pendingGroupDeletions) so resumePendingGroupAutoDeletes
// (called once at startup — see index.js) can re-arm it after a redeploy
// or crash instead of losing it, since a plain setTimeout doesn't survive
// the process restarting.
function scheduleGroupAutoDelete(client, guildId, groupLetter) {
  const store = getGuildStore(guildId);
  if (!store.settings.pendingGroupDeletions) store.settings.pendingGroupDeletions = {};
  const deleteAt = Date.now() + AUTO_DELETE_DELAY_MS;
  store.settings.pendingGroupDeletions[groupLetter] = deleteAt;
  saveGuildStore(guildId, store);
  armAutoDeleteTimer(client, guildId, groupLetter, AUTO_DELETE_DELAY_MS);
}

function armAutoDeleteTimer(client, guildId, groupLetter, delayMs) {
  setTimeout(() => {
    deleteGroupChannelAndRole(
      client, guildId, groupLetter,
      `Auto-deleted 5 hours after ${groupDisplayName(groupLetter)}'s result was published`,
    ).catch((err) => {
      console.error(`[group-auto-delete] Unexpected error deleting ${groupDisplayName(groupLetter)} in guild ${guildId}:`, err);
    });
  }, Math.max(delayMs, 0));
}

// Called once when the bot logs in (see index.js) — re-arms every pending
// auto-delete that was scheduled before the last restart. Anything whose
// 5-hour window already fully elapsed while the bot was offline gets
// deleted right away instead of being silently dropped.
function resumePendingGroupAutoDeletes(client) {
  for (const guildId of listGuildIds()) {
    const store = getGuildStore(guildId);
    const pending = store.settings && store.settings.pendingGroupDeletions;
    if (!pending) continue;
    for (const [groupLetter, deleteAt] of Object.entries(pending)) {
      armAutoDeleteTimer(client, guildId, groupLetter, deleteAt - Date.now());
    }
  }
}


const REMINDER_DELETE_AFTER_MS = 10 * 60 * 1000;

// Posted publicly in-channel so players actually see it — not ephemeral.
async function sendMatchReminder(interaction, store, groupLetter) {
  const roleId = store.settings && store.settings.groupRoles && store.settings.groupRoles[groupLetter];
  const resolved = resolveGroupSchedule(groupLetter, store);

  const scheduleText = resolved
    ? resolved.matchesToShow
        .map((m, i) => `⏰ **Match ${i + 1}** — IDP ${m.idp} PM | Start ${m.start} PM | ${m.map}`)
        .join('\n')
    : 'Match schedule not set yet — ask an admin.';

  const mention = roleId ? `<@&${roleId}>` : `@everyone`;

  // Mentions inside an embed don't ping, so the role/@everyone mention stays
  // in the message content (that's what notifies players) and the actual
  // reminder is the embed below it.
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle(`📢 ${groupDisplayName(groupLetter)} — Match Reminder`)
    .setDescription(`Get ready!\n\n${scheduleText}\n\nBe online and ready **5 minutes before IDP**. Good luck! 🏆`)
    .setTimestamp();

  // Send as a normal channel message (not an interaction reply) so it doesn't
  // show up as a "reply" to the admin panel message. The button click is
  // acknowledged with a throwaway ephemeral reply that's deleted right away.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sent = await interaction.channel.send({
    content: mention,
    embeds: [embed],
    allowedMentions: roleId ? { roles: [roleId] } : { parse: ['everyone'] },
  });
  await interaction.deleteReply().catch(() => {});

  // Auto-delete the reminder after 10 minutes. If the bot restarts within
  // those 10 minutes the message is simply left in place.
  setTimeout(() => {
    sent.delete().catch(() => {});
  }, REMINDER_DELETE_AFTER_MS);
}

function buildResultModal(groupLetter) {
  return new ModalBuilder()
    .setCustomId(`group_admin_result_modal:${groupLetter}`)
    .setTitle(`${groupDisplayName(groupLetter)} — Result`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('slot1')
          .setLabel('1st Place — Slot Number')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 6')
          .setRequired(true)
          .setMaxLength(3),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('slot2')
          .setLabel('2nd Place — Slot Number')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 11')
          .setRequired(true)
          .setMaxLength(3),
      ),
    );
}

// Looks up the team registered in a group-local slot number (the numbers
// players actually see, e.g. "Slot 6") and resolves it back to the
// underlying global slot key used everywhere else in storage.
function resolveLocalSlot(scrim, groupLetter, localNum) {
  const { start, end } = slotRangeForGroup(groupLetter, scrim.totalSlots);
  if (Number.isNaN(localNum)) return { error: `"${localNum}" isn't a number.` };

  const globalSlot = start + (localNum - DISPLAY_FIRST_SLOT);
  if (globalSlot < start || globalSlot > end) {
    return { error: `Slot ${localNum} is out of range for this group (${localSlotNumber(start)}-${localSlotNumber(end)}).` };
  }

  const slot = scrim.slots[globalSlot];
  if (!slot) return { error: `Slot ${localNum} is empty.` };

  return { team: slot.team, userId: slot.userId };
}

// After a result is posted, wipes every team's registration in this group
// (their scrim.slots entry) so the slot list is empty and they have to
// register again for the next match — either fresh via "Register Team" or
// instantly via "Use Old Team" (their saved /verify-panel profile is
// untouched, only the slot assignment goes). This also strips the
// "Registered" role from each of them, since that role is meant to reflect
// an active registration, not the group itself. The group role is
// deliberately left alone here — it only ever comes off when the group's
// channel/role are auto-deleted 5 hours after the result (see
// scheduleGroupAutoDelete above), which removes it from everyone at once
// by deleting the role.
//
// Deliberately re-reads the store itself (twice — once before the role
// loop, once right before saving) instead of being handed the store the
// caller loaded earlier. Removing roles from a full group means a Discord
// API call per player, which can take several seconds — long enough for
// someone to register or re-verify elsewhere in the meantime. Saving a
// store snapshot from before that loop started would blindly overwrite
// whatever they just saved with the old copy, silently erasing it. Reading
// fresh right before the final write and only applying this function's own
// two changes on top keeps that from happening.
async function clearGroupRegistrations(interaction, groupLetter) {
  const store = getGuildStore(interaction.guildId);
  const scrim = store.scrim;
  const slotEntries = scrim ? Object.entries(scrim.slots).filter(([, slot]) => slot.group === groupLetter) : [];

  const roleId = store.settings && store.settings.registeredRoleId;
  const botMember = interaction.guild.members.me;
  let canManageRole = false;
  if (roleId) {
    const role = interaction.guild.roles.cache.get(roleId);
    canManageRole = !!role && botMember.permissions.has('ManageRoles') && role.position < botMember.roles.highest.position;
  }

  const failed = [];
  for (const [, slot] of slotEntries) {
    if (canManageRole) {
      try {
        const member = await interaction.guild.members.fetch(slot.userId);
        if (member.roles.cache.has(roleId)) await member.roles.remove(roleId);
      } catch (err) {
        failed.push(`<@${slot.userId}> (${err.code ?? err.message})`);
      }
    }
  }

  // Re-read one more time right before writing — the role-removal loop
  // above is exactly the kind of multi-second gap described above. Apply
  // just this function's own two changes (close the group, clear its
  // slots) on top of whatever's newest on disk, rather than saving a copy
  // from before the loop started.
  const freshStore = getGuildStore(interaction.guildId);
  if (!freshStore.scrim) freshStore.scrim = scrim;
  closeGroup(freshStore.scrim, groupLetter);

  // Freeze a copy of this group's roster exactly as it stood when the
  // result was posted, before its slots get cleared below — so the
  // published slot list keeps showing who actually played instead of
  // flipping to "empty" the moment registration reopens for the next
  // match. buildGroupHeaderEmbed/buildGroupRosterEmbed read from this
  // snapshot instead of the live (now-cleared) scrim.slots once a group
  // is closed — see live-panel-handlers.js.
  if (!freshStore.settings.groupFinalRosters) freshStore.settings.groupFinalRosters = {};
  const roster = {};
  for (const [slotKey, slot] of Object.entries(freshStore.scrim.slots)) {
    if (slot.group === groupLetter) roster[slotKey] = slot;
  }
  freshStore.settings.groupFinalRosters[groupLetter] = roster;

  let cleared = 0;
  for (const [slotKey, slot] of Object.entries(freshStore.scrim.slots)) {
    if (slot.group === groupLetter) {
      delete freshStore.scrim.slots[slotKey];
      cleared++;
    }
  }
  saveGuildStore(interaction.guildId, freshStore);

  return { cleared, failed };
}

// On submit: reads the two slot numbers, looks up each team, and posts a
// winner embed in that group's own channel. No roles are given out here —
// this is purely an announcement.
async function handleGroupAdminResultModalSubmit(interaction) {
  const [, groupLetter] = interaction.customId.split(':');
  if (!hasAdminAccess(interaction, 'group_admin_result_modal')) return denyReply(interaction);

  const store = getGuildStore(interaction.guildId);
  const scrim = store.scrim;
  if (!scrim) {
    return interaction.reply({ content: '❌ No scrim is set up right now.', flags: MessageFlags.Ephemeral });
  }
  if (isGroupClosed(scrim, groupLetter)) {
    return interaction.reply({
      content: `❌ ${groupDisplayName(groupLetter)}'s result was already posted — this group is closed.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const entries = [
    { label: '🥇 1st', localNum: parseInt(interaction.fields.getTextInputValue('slot1').trim(), 10) },
    { label: '🥈 2nd', localNum: parseInt(interaction.fields.getTextInputValue('slot2').trim(), 10) },
  ].map(e => ({ ...e, ...resolveLocalSlot(scrim, groupLetter, e.localNum) }));

  await interaction.deferReply();

  const lines = entries.map((entry) => (entry.error
    ? `❌ ${entry.label} — ${entry.error}`
    : `✅ ${entry.label} — **${entry.team}** — <@${entry.userId}>`));

  // Post the winner embed in this group's own channel — the only visible
  // result of submitting this form. No role is assigned to anyone.
  const resultChannelId = store.settings.groupChannels && store.settings.groupChannels[groupLetter];
  const resultChannel = resultChannelId ? interaction.guild.channels.cache.get(resultChannelId) : null;
  if (resultChannel) {
    try {
      await resultChannel.send({ embeds: [buildGroupResultEmbed(groupDisplayName(groupLetter), entries)] });
      lines.push(`📣 Result embed posted in ${resultChannel}.`);
    } catch (err) {
      console.error(`[group-admin-result] Failed to post result embed in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      lines.push(`⚠️ Couldn't post the result embed in ${resultChannel} — check my **Send Messages**/**Embed Links** permissions there.`);
    }
  } else {
    lines.push(`⚠️ No channel is set up for ${groupDisplayName(groupLetter)} — the result embed wasn't posted anywhere.`);
  }

  // Result is in — retire this group for good: mark it closed (so
  // registration skips straight past it into the next group from here on,
  // and "Change Slot" can no longer switch into it) and clear out its
  // registrations so the players in it have to register again — fresh, or
  // instantly via "Use Old Team" — for whichever group is now active.
  // Their group role/channel access is untouched; that only comes off when
  // an admin deletes this group's channel/role. (clearGroupRegistrations
  // re-reads and saves the store itself — see its comment for why.)
  const clearResult = await clearGroupRegistrations(interaction, groupLetter);
  lines.push(`🔒 ${groupDisplayName(groupLetter)} is now closed — registration moves on to the next group.`);
  if (clearResult.cleared) {
    lines.push(`🧹 Cleared ${clearResult.cleared} registration(s) — those players keep their group role and can register again (or **Use Old Team**) for the next match.`);
  }
  if (clearResult.failed.length) {
    lines.push(`⚠️ Couldn't remove the Registered role from: ${clearResult.failed.join(', ')}.`);
  }

  // groupRoleId is a read-only lookup here — setGroupChannelOpen edits
  // Discord channel permission overwrites directly, nothing in data.json
  // needs saving for this step (clearGroupRegistrations already saved its
  // own changes above). Reuses the resultChannel looked up above rather
  // than fetching the same channel a second time.
  const groupRoleId = store.settings.groupRoles && store.settings.groupRoles[groupLetter];

  if (resultChannel && groupRoleId) {
    try {
      await setGroupChannelOpen(resultChannel, groupRoleId, false, `Closed automatically after ${groupDisplayName(groupLetter)} result was submitted`);
      lines.push(`🔇 ${groupDisplayName(groupLetter)}'s channel is now closed to players.`);
    } catch (err) {
      console.error(`[group-admin-result] Failed to close ${groupDisplayName(groupLetter)}'s channel in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      lines.push(`⚠️ Couldn't close ${groupDisplayName(groupLetter)}'s channel automatically — check my **Manage Roles** permission.`);
    }
  }

  await refreshLivePanel(interaction.client, interaction.guildId);
  await refreshGroupSlotList(interaction.client, interaction.guildId, groupLetter);

  // Nothing left to do for this group once its result is in — schedule its
  // channel and role to delete themselves 5 hours from now instead of
  // requiring an admin to come back and delete it by hand.
  scheduleGroupAutoDelete(interaction.client, interaction.guildId, groupLetter);
  lines.push(`🗑️ ${groupDisplayName(groupLetter)}'s channel and role will be automatically deleted in 5 hours.`);

  await interaction.editReply({ content: `🌟 **Result — ${groupDisplayName(groupLetter)}**\n${lines.join('\n')}` });
}

module.exports = { handleGroupAdminButton, handleGroupAdminResultModalSubmit, resumePendingGroupAutoDeletes };
