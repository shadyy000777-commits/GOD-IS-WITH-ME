const { PermissionFlagsBits } = require('discord.js');
const { getGuildStore } = require('./t3-storage');

// The T3 staff role is handed out through the T3 admin panel's "Select Staff"
// button. It is deliberately separate from the main Scrims bot's
// "SCRIMS MANAGEMENT" role (they live in different stores), so changing one
// staff list never strips the other.
const T3_STAFF_ROLE_NAME = 'T3 SCRIMS MANAGEMENT';

// Anyone with Manage Server always passes. Members holding the T3 staff role
// also pass, but only for the group-panel actions that call this helper:
// Publish Slot List, Match Reminder, Result and !open. Punish Team, Manage
// Slot, Delete Group and the admin panel itself stay Manage Server only.
function hasStaffAccess(interaction) {
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const store = getGuildStore(interaction.guildId);
  const staffRoleId = store.settings && store.settings.scrimsManagementRoleId;
  return !!staffRoleId && interaction.member.roles.cache.has(staffRoleId);
}

// Same check for prefix commands (!open), which receive a message instead of
// an interaction.
function hasStaffAccessMessage(message) {
  if (message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const store = getGuildStore(message.guildId);
  const staffRoleId = store.settings && store.settings.scrimsManagementRoleId;
  return !!staffRoleId && message.member.roles.cache.has(staffRoleId);
}

// Permissions the staff role gets inside group lobby channels so staff can
// actually see them (the lobbies are hidden from @everyone).
const STAFF_CHANNEL_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

module.exports = { T3_STAFF_ROLE_NAME, hasStaffAccess, hasStaffAccessMessage, STAFF_CHANNEL_ALLOW };
