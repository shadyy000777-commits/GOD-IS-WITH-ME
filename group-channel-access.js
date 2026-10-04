const { PermissionFlagsBits } = require('discord.js');

// Every channel-level permission shown in Discord's "Permission Overrides"
// screen. The group role gets ALL of these explicitly set: the ones in the
// allowed list below are granted, everything else is denied.
const CHANNEL_PERMISSIONS = [
  'ViewChannel', 'ManageChannels', 'ManageRoles', 'ManageWebhooks',
  'CreateInstantInvite',
  'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads',
  'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis', 'UseExternalStickers',
  'MentionEveryone', 'ManageMessages', 'PinMessages', 'BypassSlowmode', 'ManageThreads',
  'ReadMessageHistory', 'SendTTSMessages', 'SendVoiceMessages', 'SendPolls',
  'UseApplicationCommands', 'UseEmbeddedActivities', 'UseExternalApps',
].filter(name => PermissionFlagsBits[name] !== undefined); // skip any this discord.js version doesn't know

// Before the group is opened: only see the channel + read history.
// After it is opened: view, send messages, attach files, read history.
// Everything else (threads, embeds, reactions, mentions, polls, ...) stays denied.
const CLOSED_ALLOWED = ['ViewChannel', 'ReadMessageHistory'];
const OPEN_ALLOWED = ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'AttachFiles'];

// { allow: [...bits], deny: [...bits] } for channel creation.
function groupRoleOverwrite(open) {
  const allowedNames = open ? OPEN_ALLOWED : CLOSED_ALLOWED;
  return {
    allow: allowedNames.map(n => PermissionFlagsBits[n]),
    deny: CHANNEL_PERMISSIONS.filter(n => !allowedNames.includes(n)).map(n => PermissionFlagsBits[n]),
  };
}

// Locks or unlocks a group's channel for its role by rewriting the role's
// whole overwrite (see groupRoleOverwrite). Admins bypass this automatically
// via Discord's own Administrator permission, which ignores overwrites.
// Thread permissions stay denied in both states — otherwise, once
// SendMessages is denied, Discord flips the channel into "threads only"
// mode and lets players post inside threads even while it is closed.
async function setGroupChannelOpen(channel, roleId, open, reason) {
  const allowedNames = open ? OPEN_ALLOWED : CLOSED_ALLOWED;
  const perms = {};
  for (const name of CHANNEL_PERMISSIONS) perms[name] = allowedNames.includes(name);
  await channel.permissionOverwrites.edit(roleId, perms, { reason });
}

// Lets the SCRIMS MANAGEMENT staff role see and talk in a group's channel so
// they can actually reach its panel (group channels are hidden from
// everyone except the group's own role). Only touches Discord if the role
// has no overwrite there yet, so it's cheap to call on every refresh.
async function ensureStaffChannelAccess(channel, staffRoleId) {
  if (!channel || !staffRoleId) return;
  if (channel.permissionOverwrites.cache.has(staffRoleId)) return;
  await channel.permissionOverwrites.edit(staffRoleId, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: true,
    AttachFiles: true,
    EmbedLinks: true,
  }, { reason: 'SCRIMS MANAGEMENT staff access to group channel' });
}

// Tracks each group's open/closed state in the guild store (separately from
// the actual Discord permission overwrites) purely so the admin panel's
// toggle button knows which label/style to render — "Open" (locked right
// now) or "Close" (unlocked right now) — without an extra API call to read
// permission overwrites back. Defaults to closed/locked, matching the
// permission overwrites a group's channel is created with (see
// giveGroupChannel in register-handlers.js).
function isGroupChannelOpen(store, letter) {
  return !!(store.settings && store.settings.groupChannelOpenState && store.settings.groupChannelOpenState[letter]);
}

function setGroupChannelOpenState(store, letter, open) {
  if (!store.settings) store.settings = {};
  if (!store.settings.groupChannelOpenState) store.settings.groupChannelOpenState = {};
  store.settings.groupChannelOpenState[letter] = open;
}

module.exports = { ensureStaffChannelAccess, groupRoleOverwrite, setGroupChannelOpen, isGroupChannelOpen, setGroupChannelOpenState };
