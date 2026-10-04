const { PermissionFlagsBits } = require('discord.js');
const { saveGuildStore } = require('./tn-storage');

const LOG_CHANNEL_NAME = 'verification-logs';

// Fallback log channel for screenshot verifications. If an admin picked a
// Log Channel in /ss-verify-panel, that one is used (see resolveLogChannel).
// Otherwise this creates a staff-only channel once per guild — @everyone is
// denied, and any role holding Administrator or Manage Server can view it —
// and reuses it afterwards.
//
// (This is a snapshot at creation time: if admin roles change later, the
// channel's permissions don't automatically follow.)
//
// Stored in guild settings as `logChannelId`. This is separate from each
// tournament's own Log Channel (Edit Settings → J), which is per-tournament.
async function getOrCreateLogChannel(guild, store) {
  if (!store.settings) store.settings = {};
  const existingId = store.settings.logChannelId;
  const existing = existingId ? guild.channels.cache.get(existingId) : null;
  if (existing) return existing;

  const botMember = guild.members.me;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    console.error(`[log-channel] Bot is missing "Manage Channels" in guild ${guild.id} — can't auto-create the log channel.`);
    return null;
  }

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
  ];
  for (const role of guild.roles.cache.values()) {
    if (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild)) {
      overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
    }
  }

  try {
    const channel = await guild.channels.create({
      name: LOG_CHANNEL_NAME,
      permissionOverwrites: overwrites,
      reason: 'Auto-created to log screenshot verifications',
    });
    store.settings.logChannelId = channel.id;
    saveGuildStore(guild.id, store);
    return channel;
  } catch (err) {
    console.error(`[log-channel] Failed to auto-create the log channel in guild ${guild.id}:`, err.message);
    return null;
  }
}

// The channel to actually log to: a manually-configured one
// (fallbackChannelId, e.g. the panel's Log Channel) if it's set and still
// exists, otherwise the auto-created log channel.
async function resolveLogChannel(guild, store, fallbackChannelId) {
  if (fallbackChannelId) {
    const configured = guild.channels.cache.get(fallbackChannelId);
    if (configured) return configured;
  }
  return getOrCreateLogChannel(guild, store);
}

module.exports = { getOrCreateLogChannel, resolveLogChannel, LOG_CHANNEL_NAME };
