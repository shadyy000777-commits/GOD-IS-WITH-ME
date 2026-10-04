// Auto-deletes the `!tournament` panel message after it sits untouched for
// a while — the panel itself is just a UI surface (buttons/selects/modals),
// so removing it never touches tournament data, settings, players, groups,
// bans, etc. Admins just run `!tournament` again to bring up a fresh one.
//
// Every sub-screen of the wizard (Edit Settings, Manage Groups, Ban/Unban,
// ...) is an in-place edit of the SAME message via interaction.update(), so
// tracking by message.id covers the whole flow, not just the top-level menu.

const INACTIVITY_MS = 3 * 60 * 1000; // 3 minutes

const timers = new Map(); // messageId -> Timeout

// Prefixes for panels that live on their OWN persistent message elsewhere
// (a group's channel, the public Register panel, or the slot-manager
// self-service panel) — these must never be swept into the tournament
// panel's 3-minute auto-delete. Only the top-level `!tournament` panel —
// and its ephemeral admin sub-screens, which all share that one message
// via interaction.update() — should ever be tracked here.
const EXCLUDED_PREFIXES = [
  'tourney_wizard_register_',    // public "Register Team" panel (register_team, register_retry)
  'tourney_wizard_reg_',         // register flow confirm/cancel
  'tourney_wizard_selfservice_', // slot-manager self-service panel
];

// Every real per-group channel admin panel button carries `tid:round:letter`
// on its customId (tourney_wizard_group_publish:..., _punish:..., _result:...,
// _config:..., _configdate:..., _chat:..., _reminder:...) — always followed by
// a colon, which is what tells them apart from unrelated ids like the
// (unused) tourney_wizard_group_modal.
const GROUP_PANEL_RE = /^tourney_wizard_group_[a-z]+:/;

// Swap flow: everything except the admin "Group Swap: On/Off" toggle
// (which lives on the main panel) is a picker/request/accept-reject
// message posted elsewhere and must be excluded too.
function isSwapFlow(customId) {
  return customId !== 'tourney_wizard_swap_toggle'
    && (customId.startsWith('tourney_wizard_swap_') || customId.startsWith('tourney_swap_select') || customId.startsWith('tourney_swap_search_modal'));
}

// Whether an interaction's customId belongs to the top-level tournament
// panel (and its in-place admin sub-screens) rather than to some other
// panel that happens to share the `tourney_` prefix.
function belongsToMainPanel(customId) {
  if (!customId) return false;
  if (isSwapFlow(customId)) return false;
  if (GROUP_PANEL_RE.test(customId)) return false;
  return !EXCLUDED_PREFIXES.some(prefix => customId.startsWith(prefix));
}

function clear(messageId) {
  const existing = timers.get(messageId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(messageId);
  }
}

// Call after posting the panel, and again after every interaction on it, to
// (re)start the 3-minute countdown. Safe to call with an undefined/null
// message (e.g. a modal submit interaction without one) — just a no-op.
function touch(message) {
  if (!message || !message.id) return;
  clear(message.id);
  const timeout = setTimeout(() => {
    timers.delete(message.id);
    message.delete().catch(() => {});
  }, INACTIVITY_MS);
  timers.set(message.id, timeout);
}

// Call if the panel message is deleted or replaced some other way, so a
// stale timer doesn't try (and harmlessly fail) to delete it again later.
function cancel(messageId) {
  clear(messageId);
}

module.exports = { touch, cancel, belongsToMainPanel };
