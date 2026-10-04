// Locked slots — slot numbers that are never given to a registered team.
// Teams fill the remaining numbers (4-23) in order, so a full lobby holds 20
// teams and 5 slots stay reserved. Order here is also the order Manually Add
// Slot uses once a group has no empty slot left (see nextLockedSlot below):
// the first overflow team gets 24, then 25, then 1, 2 and 3.
const LOCKED_SLOTS = [24, 25, 1, 2, 3];

const lockedSet = new Set(LOCKED_SLOTS);

// Shows up in the deploy logs on startup — proof this version is the one running.
console.log(`[slots] locked slots active: ${LOCKED_SLOTS.join(', ')}`);

function isLockedSlot(n) {
  return lockedSet.has(n);
}

// Slot number for the team at 0-based position `idx` in a group's team list:
// the (idx+1)-th slot number that isn't locked.
function slotNumber(idx) {
  let found = -1;
  for (let n = 1; ; n++) {
    if (!lockedSet.has(n)) found++;
    if (found === idx) return n;
  }
}

// ---------------------------------------------------------------------------
// Manually Add Slot, once a group is already full, places the extra player
// into one of the reserved LOCKED_SLOTS instead of being turned away — that
// team's object gets an explicit `slotOverride` (one of LOCKED_SLOTS) instead
// of relying on registration order. Everything below makes the rest of the
// bot slot-number-aware of that override.
// ---------------------------------------------------------------------------

// A team's slotOverride only counts in the round it was given in
// (team.slotOverrideRound — missing on older data means Round 1). When a team
// is promoted to the next round it is the same team object, so without this
// check it would carry its old locked slot along; instead it now takes the
// normal in-sequence slot (4, 5, 6...) in the new round. Groups know their
// round through group.round (absent = Round 1).
function activeOverride(group, team) {
  if (!team || typeof team.slotOverride !== 'number') return null;
  const overrideRound = team.slotOverrideRound || 1;
  const groupRound = (group && group.round) || 1;
  return overrideRound === groupRound ? team.slotOverride : null;
}

// Locked slot numbers already claimed by an overflow team in this group.
function usedLockedSlots(group) {
  const used = new Set();
  for (const team of group.teams || []) {
    const ov = activeOverride(group, team);
    if (ov !== null) used.add(ov);
  }
  return used;
}

// Next free locked slot for a new overflow team, or null if all of
// LOCKED_SLOTS are already taken by overflow teams in this group. Hands
// them out in LOCKED_SLOTS order (24, 25, 1, 2, 3).
function nextLockedSlot(group) {
  const used = usedLockedSlots(group);
  return LOCKED_SLOTS.find(n => !used.has(n)) ?? null;
}

// The real slot number for the team at 0-based position `idx` in
// group.teams — a team's own slotOverride if it has one (overflow teams in a
// locked slot, or teams pinned to a slot by the Swap Group button),
// otherwise the normal registration-order number: the next slot that isn't
// locked and isn't claimed by another team's override. Only non-override
// teams before it are counted, so pinned teams never shift anyone else.
function groupSlotNumber(group, idx) {
  const team = group.teams[idx];
  const own = activeOverride(group, team);
  if (own !== null) return own;
  const claimed = usedLockedSlots(group);
  let regularIdx = 0;
  for (let i = 0; i < idx; i++) {
    if (activeOverride(group, group.teams[i]) === null) regularIdx++;
  }
  let found = -1;
  for (let n = 1; ; n++) {
    if (lockedSet.has(n) || claimed.has(n)) continue;
    found++;
    if (found === regularIdx) return n;
  }
}

// Slot numbers still free in a group, ascending — every normal (non-locked)
// slot of the lobby that no team holds, whatever the group's capacity. With
// the default locked list that's the full 4-23 range, so a group with 6 teams
// shows its 14 free slots and an empty group shows all 20.
function emptySlotNumbers(group) {
  const taken = new Set((group.teams || []).map((_, i) => groupSlotNumber(group, i)));
  const last = Math.max(...LOCKED_SLOTS, group.capacity > 0 ? slotNumber(group.capacity - 1) : 0);
  const out = [];
  for (let n = 1; n <= last; n++) {
    if (!lockedSet.has(n) && !taken.has(n)) out.push(n);
  }
  return out;
}

// True while the group still has a normal (4-23) slot free.
function hasEmptySlot(group) {
  return emptySlotNumbers(group).length > 0;
}

// How many normal (non-locked) slots a lobby has — 20 with the default list.
function normalSlotTotal() {
  let count = 0;
  for (let n = 1; n <= Math.max(...LOCKED_SLOTS); n++) if (!lockedSet.has(n)) count++;
  return count;
}

module.exports = { hasEmptySlot, normalSlotTotal, LOCKED_SLOTS, isLockedSlot, slotNumber, usedLockedSlots, nextLockedSlot, groupSlotNumber, emptySlotNumbers, activeOverride };
