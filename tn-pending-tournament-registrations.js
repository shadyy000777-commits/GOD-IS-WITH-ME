// Holds in-progress "Register Team" data between the team-name modal and
// the player-mention select menu for the public tournament registration
// panel (tourney_wizard_register_team). Kept separate from
// pending-team-registrations.js / pending-registrations.js so a player
// registering for a scrim and a tournament at the same time (edge case,
// but possible) don't overwrite each other's in-progress data.
//
// In-memory only: if the bot restarts mid-flow, the player just clicks
// "Register Team" again and starts over. Nothing is saved to data.json
// until "Confirm Registration" succeeds.

const pending = new Map();
const TTL_MS = 15 * 60 * 1000; // 15 minutes to finish the flow

function startPending(userId, guildId, data = {}) {
  clearPending(userId);
  const entry = {
    guildId,
    data,
    timer: setTimeout(() => pending.delete(userId), TTL_MS),
  };
  pending.set(userId, entry);
  return entry;
}

function getPending(userId) {
  return pending.get(userId) || null;
}

function updatePending(userId, fields) {
  const entry = pending.get(userId);
  if (!entry) return null;
  Object.assign(entry.data, fields);
  return entry;
}

function clearPending(userId) {
  const entry = pending.get(userId);
  if (entry && entry.timer) clearTimeout(entry.timer);
  pending.delete(userId);
}

module.exports = { startPending, getPending, updatePending, clearPending };
