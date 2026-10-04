// Lets a guild run several tournaments at once. Tournaments live in
// store.tournaments (keyed by id) instead of the old single store.tournament
// field. Since every existing wizard handler reads/writes `store.tournament`
// as if there were only ever one, bindActiveTournament() redefines that
// property (via a getter/setter) to transparently point at whichever
// tournament a given admin currently has "open" in the wizard — so none of
// that existing code had to change to become multi-tournament-aware.
//
// Anything reachable by someone OTHER than the admin currently driving the
// wizard (a public Register Team button, a per-group channel panel, etc.)
// can't rely on that per-admin pointer — those instead carry the
// tournament's id explicitly (in a customId or in pending registration
// state) and look it up directly via getTournamentById.
const { getGuildStore, saveGuildStore } = require('./tn-storage');

function generateTournamentId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function bindActiveTournament(store, userId) {
  if (!store.tournaments) store.tournaments = {};
  if (!store.activeTournamentByUser) store.activeTournamentByUser = {};

  Object.defineProperty(store, 'tournament', {
    configurable: true,
    enumerable: false,
    get() {
      const id = store.activeTournamentByUser[userId];
      return id ? (store.tournaments[id] || null) : null;
    },
    set(val) {
      if (val === null || val === undefined) {
        const id = store.activeTournamentByUser[userId];
        if (id) delete store.tournaments[id];
        delete store.activeTournamentByUser[userId];
      } else {
        // Assigning a whole new object (not mutating store.tournament.x)
        // only ever happens on creation — always mint a fresh id rather
        // than reusing whatever this admin had active before, otherwise
        // "Create Tournament" while managing an existing one would
        // silently overwrite it instead of adding a new one.
        const id = val.id || generateTournamentId();
        val.id = id;
        store.tournaments[id] = val;
        store.activeTournamentByUser[userId] = id;
      }
    },
  });
  return store;
}

// Fresh guild store with `.tournament` bound to this admin's current
// selection — drop-in replacement for `getGuildStore(guildId)` anywhere the
// code is acting on behalf of one specific admin managing the wizard.
function getTournamentStore(guildId, userId) {
  return bindActiveTournament(getGuildStore(guildId), userId);
}

function listTournaments(guildId) {
  const store = getGuildStore(guildId);
  return Object.values(store.tournaments || {});
}

function getTournamentById(guildId, tid) {
  const store = getGuildStore(guildId);
  return (store.tournaments && store.tournaments[tid]) || null;
}

function setActiveTournament(guildId, userId, tid) {
  const store = getGuildStore(guildId);
  if (!store.tournaments || !store.tournaments[tid]) return false;
  if (!store.activeTournamentByUser) store.activeTournamentByUser = {};
  store.activeTournamentByUser[userId] = tid;
  saveGuildStore(guildId, store);
  return true;
}

function clearActiveTournament(guildId, userId) {
  const store = getGuildStore(guildId);
  if (store.activeTournamentByUser) delete store.activeTournamentByUser[userId];
  saveGuildStore(guildId, store);
}

module.exports = {
  bindActiveTournament,
  getTournamentStore,
  listTournaments,
  getTournamentById,
  setActiveTournament,
  clearActiveTournament,
  generateTournamentId,
};
