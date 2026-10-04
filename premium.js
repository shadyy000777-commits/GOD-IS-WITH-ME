// Tracks which guilds have premium access. Stored under a reserved
// top-level key in data.json — same pattern as _dmThreads in storage.js —
// so it can never collide with a real guild ID (guild IDs are pure
// numeric snowflakes, this key isn't).
const { loadAll, saveAll } = require('./storage');

function isPremiumGuild(guildId) {
  const all = loadAll();
  return Boolean(all._premiumGuilds && all._premiumGuilds[guildId]);
}

function setPremiumGuild(guildId, enabled) {
  const all = loadAll();
  if (!all._premiumGuilds) all._premiumGuilds = {};
  if (enabled) {
    all._premiumGuilds[guildId] = true;
  } else {
    delete all._premiumGuilds[guildId];
  }
  saveAll(all);
}

function listPremiumGuildIds() {
  const all = loadAll();
  return Object.keys(all._premiumGuilds || {});
}

// Only this Discord user (you, the bot owner) can grant/revoke premium —
// deliberately NOT gated by server permissions like ManageGuild, since a
// server admin obviously shouldn't be able to grant themselves premium.
function isBotOwner(userId) {
  return Boolean(process.env.OWNER_ID) && userId === process.env.OWNER_ID;
}

module.exports = { isPremiumGuild, setPremiumGuild, listPremiumGuildIds, isBotOwner };
