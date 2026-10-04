// Staff management data layer for the !staff panel — members, ranks, check-ins,
// work (tasks), leave, reports, history and the weekly report numbers.
// Everything lives under store.staffSystem in the per-guild store (storage.js),
// so it works the same on the JSON file and on PostgreSQL. All functions here
// are synchronous: read the store, change it, save it.
const { getGuildStore, saveGuildStore } = require('./tn-storage');
const staffActivity = require('./tn-staff-activity');

// Promotion ladder — edit this list to rename / add ranks.
const RANKS = ['Trial Staff', 'Staff', 'Senior Staff', 'Head Staff', 'Manager'];

// A staff member with no check-in / finished work / report for this many days
// (and not on leave) counts as inactive.
const INACTIVE_AFTER_DAYS = 7;

// The weekly report goes out every Sunday at this hour, UTC (18 = 23:30 IST).
const WEEKLY_HOUR_UTC = 18;

const DAY_MS = 86400000;
const MAX_HISTORY = 1000;
const MAX_REPORTS = 200;
const MAX_DONE_TASKS = 400;

function defaults() {
  return {
    members: {},          // userId -> member (see registerMember)
    tasks: [],            // { id, title, details, assigneeId, by, createdAt, done, doneAt }
    reports: [],          // { id, userId, subject, details, at }
    history: [],          // { at, type, userId, by, text }
    rules: '',
    reportChannelId: null,
    weeklyEnabled: true,
    lastWeeklyAt: null,
    nextTaskId: 1,
    nextReportId: 1,
  };
}

function open(guildId) {
  const store = getGuildStore(guildId);
  const d = defaults();
  if (!store.staffSystem) store.staffSystem = d;
  for (const key of Object.keys(d)) {
    if (store.staffSystem[key] === undefined) store.staffSystem[key] = d[key];
  }
  return { store, sys: store.staffSystem };
}

function commit(guildId, store) {
  saveGuildStore(guildId, store);
}

function pushHistory(sys, type, userId, text, by) {
  sys.history.push({ at: Date.now(), type, userId: userId || null, by: by || null, text: String(text || '').slice(0, 300) });
  if (sys.history.length > MAX_HISTORY) sys.history.splice(0, sys.history.length - MAX_HISTORY);
}

function statusOf(member, now = Date.now()) {
  if (member.leaveUntil && member.leaveUntil > now) return 'leave';
  const last = member.lastActiveAt || member.joinedAt || 0;
  if (now - last > INACTIVE_AFTER_DAYS * DAY_MS) return 'inactive';
  return 'active';
}

function decorate(member, openCounts, now) {
  return {
    ...member,
    status: statusOf(member, now),
    openTasks: openCounts[member.userId] || 0,
    rankName: RANKS[member.rank] || RANKS[0],
  };
}

function openCountsOf(sys) {
  const counts = {};
  for (const t of sys.tasks) if (!t.done) counts[t.assigneeId] = (counts[t.assigneeId] || 0) + 1;
  return counts;
}

// ---------------------------------------------------------------- members
function listMembers(guildId) {
  const { sys } = open(guildId);
  const now = Date.now();
  const counts = openCountsOf(sys);
  return Object.values(sys.members)
    .map(m => decorate(m, counts, now))
    .sort((a, b) => (b.rank - a.rank) || String(a.name).localeCompare(String(b.name)));
}

function getMember(guildId, userId) {
  const { sys } = open(guildId);
  const m = sys.members[userId];
  return m ? decorate(m, openCountsOf(sys), Date.now()) : null;
}

// Adds a staff member, or updates their entry form if they're already listed.
// info: { name, position, availability, notes } — all optional.
function registerMember(guildId, userId, info = {}, by = null) {
  const { store, sys } = open(guildId);
  const now = Date.now();
  let m = sys.members[userId];
  const isNew = !m;
  if (!m) {
    m = sys.members[userId] = {
      userId, name: '', position: 'Staff', availability: '', notes: '',
      rank: 0, joinedAt: now, lastActiveAt: now, checkins: 0, tasksDone: 0,
      leaveUntil: null, recentCheckins: [],
    };
  }
  if (info.name) m.name = String(info.name).slice(0, 60);
  if (info.position) m.position = String(info.position).slice(0, 60);
  if (info.availability !== undefined) m.availability = String(info.availability).slice(0, 100);
  if (info.notes !== undefined) m.notes = String(info.notes).slice(0, 500);
  pushHistory(sys, isNew ? 'join' : 'update', userId, isNew ? `Joined as ${m.position}` : 'Updated their entry form', by || userId);
  commit(guildId, store);
  return { member: decorate(m, openCountsOf(sys), now), isNew };
}

function removeMember(guildId, userId, by = null) {
  const { store, sys } = open(guildId);
  if (!sys.members[userId]) return false;
  delete sys.members[userId];
  // Their unfinished work goes away with them; finished work stays for the record.
  sys.tasks = sys.tasks.filter(t => t.done || t.assigneeId !== userId);
  pushHistory(sys, 'remove', userId, 'Removed from the staff list', by);
  commit(guildId, store);
  return true;
}

// ---------------------------------------------------------------- check-in
function checkIn(guildId, userId, note) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  const now = Date.now();
  m.checkins = (m.checkins || 0) + 1;
  m.lastActiveAt = now;
  m.recentCheckins = [...(m.recentCheckins || []), now].slice(-60);
  if (m.leaveUntil && m.leaveUntil > now) m.leaveUntil = null; // checking in ends leave early
  pushHistory(sys, 'checkin', userId, note, userId);
  commit(guildId, store);
  return decorate(m, openCountsOf(sys), now);
}

// ---------------------------------------------------------------- promote
// Returns null (not staff), { maxed: true, rankName } or { from, to }.
function promote(guildId, userId, by = null) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  if (m.rank >= RANKS.length - 1) return { maxed: true, rankName: RANKS[m.rank] };
  const from = RANKS[m.rank];
  m.rank += 1;
  const to = RANKS[m.rank];
  pushHistory(sys, 'promote', userId, `${from} → ${to}`, by);
  commit(guildId, store);
  return { from, to };
}

// ---------------------------------------------------------------- work
function createTasks(guildId, { title, details, assigneeIds, by }) {
  const { store, sys } = open(guildId);
  const created = [];
  for (const assigneeId of assigneeIds) {
    if (!sys.members[assigneeId]) continue;
    const task = {
      id: sys.nextTaskId++,
      title: String(title).slice(0, 100),
      details: String(details || '').slice(0, 500),
      assigneeId, by, createdAt: Date.now(), done: false, doneAt: null,
    };
    sys.tasks.push(task);
    pushHistory(sys, 'task_assigned', assigneeId, `#${task.id} ${task.title}`, by);
    created.push(task);
  }
  // Keep the file small: drop the oldest finished tasks past the cap.
  const done = sys.tasks.filter(t => t.done);
  if (done.length > MAX_DONE_TASKS) {
    const drop = new Set(done.sort((a, b) => a.doneAt - b.doneAt).slice(0, done.length - MAX_DONE_TASKS).map(t => t.id));
    sys.tasks = sys.tasks.filter(t => !drop.has(t.id));
  }
  commit(guildId, store);
  return created;
}

// The n least-busy staff members who aren't on leave (active ones first).
function pickLeastBusy(guildId, n = 1) {
  const members = listMembers(guildId).filter(m => m.status !== 'leave');
  const pool = members.some(m => m.status === 'active') ? members.filter(m => m.status === 'active') : members;
  return pool
    .sort((a, b) => (a.openTasks - b.openTasks) || (a.tasksDone - b.tasksDone))
    .slice(0, n)
    .map(m => m.userId);
}

function getOpenTasks(guildId, userId = null) {
  const { sys } = open(guildId);
  return sys.tasks
    .filter(t => !t.done && (!userId || t.assigneeId === userId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function getTask(guildId, taskId) {
  const { sys } = open(guildId);
  return sys.tasks.find(t => t.id === Number(taskId)) || null;
}

function completeTask(guildId, taskId, by = null) {
  const { store, sys } = open(guildId);
  const task = sys.tasks.find(t => t.id === Number(taskId));
  if (!task || task.done) return null;
  const now = Date.now();
  task.done = true;
  task.doneAt = now;
  const m = sys.members[task.assigneeId];
  if (m) { m.tasksDone = (m.tasksDone || 0) + 1; m.lastActiveAt = now; }
  pushHistory(sys, 'task_done', task.assigneeId, `#${task.id} ${task.title}`, by);
  commit(guildId, store);
  return task;
}

// ---------------------------------------------------------------- leave
function setLeave(guildId, userId, days, reason) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  m.leaveUntil = Date.now() + days * DAY_MS;
  pushHistory(sys, 'leave', userId, `${days} day(s)${reason ? ` — ${reason}` : ''}`, userId);
  commit(guildId, store);
  return decorate(m, openCountsOf(sys), Date.now());
}

// ---------------------------------------------------------------- reports
function addReport(guildId, { userId, subject, details }) {
  const { store, sys } = open(guildId);
  const report = {
    id: sys.nextReportId++, userId,
    subject: String(subject).slice(0, 100), details: String(details).slice(0, 1500), at: Date.now(),
  };
  sys.reports.push(report);
  if (sys.reports.length > MAX_REPORTS) sys.reports.splice(0, sys.reports.length - MAX_REPORTS);
  const m = sys.members[userId];
  if (m) m.lastActiveAt = report.at;
  pushHistory(sys, 'report', userId, `#${report.id} ${report.subject}`, userId);
  commit(guildId, store);
  return report;
}

// ---------------------------------------------------------------- history
function getHistory(guildId, limit = 20, userId = null) {
  const { sys } = open(guildId);
  return sys.history
    .filter(h => !userId || h.userId === userId)
    .slice(-limit)
    .reverse();
}

// ---------------------------------------------------------------- settings
function getRules(guildId) { return open(guildId).sys.rules || ''; }
function setRules(guildId, text) {
  const { store, sys } = open(guildId);
  sys.rules = String(text || '').slice(0, 4000);
  commit(guildId, store);
}

function getReportChannelId(guildId) { return open(guildId).sys.reportChannelId || null; }
function setReportChannelId(guildId, channelId) {
  const { store, sys } = open(guildId);
  sys.reportChannelId = channelId;
  if (!sys.lastWeeklyAt) sys.lastWeeklyAt = Date.now(); // don't fire for a Sunday that already passed
  commit(guildId, store);
}

function getWeeklySettings(guildId) {
  const { sys } = open(guildId);
  return { enabled: Boolean(sys.weeklyEnabled), channelId: sys.reportChannelId || null, lastWeeklyAt: sys.lastWeeklyAt || null };
}
function setWeeklyEnabled(guildId, enabled) {
  const { store, sys } = open(guildId);
  sys.weeklyEnabled = Boolean(enabled);
  if (!sys.lastWeeklyAt) sys.lastWeeklyAt = Date.now();
  commit(guildId, store);
}

// ---------------------------------------------------------------- weekly
// Most recent Sunday WEEKLY_HOUR_UTC:00 that is not in the future.
function lastScheduledMoment(now = Date.now()) {
  const d = new Date(now);
  let moment = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WEEKLY_HOUR_UTC, 0, 0)
    - d.getUTCDay() * DAY_MS;
  if (moment > now) moment -= 7 * DAY_MS;
  return moment;
}

// True once per week, after the scheduled moment, if auto-report is on and a
// channel is set. The first time a guild is seen it just starts the clock.
function isWeeklyDue(guildId, now = Date.now()) {
  const { store, sys } = open(guildId);
  if (!sys.weeklyEnabled || !sys.reportChannelId) return false;
  if (!sys.lastWeeklyAt) {
    sys.lastWeeklyAt = now;
    commit(guildId, store);
    return false;
  }
  return sys.lastWeeklyAt < lastScheduledMoment(now);
}

function markWeeklySent(guildId, now = Date.now()) {
  const { store, sys } = open(guildId);
  sys.lastWeeklyAt = now;
  commit(guildId, store);
}

// Per-member numbers for the last `days` days, best performer first.
function weeklyData(guildId, days = 7, now = Date.now()) {
  const { sys } = open(guildId);
  const since = now - days * DAY_MS;
  const counts = openCountsOf(sys);
  const rows = Object.values(sys.members).map(m => {
    const act = staffActivity.getUserRangeStats(guildId, m.userId, days);
    return {
      userId: m.userId,
      name: m.name,
      rankName: RANKS[m.rank] || RANKS[0],
      status: statusOf(m, now),
      checkins: (m.recentCheckins || []).filter(t => t >= since).length,
      tasksDone: sys.tasks.filter(t => t.done && t.assigneeId === m.userId && t.doneAt >= since).length,
      tasksOpen: counts[m.userId] || 0,
      reports: sys.reports.filter(r => r.userId === m.userId && r.at >= since).length,
      messages: act.messageTotal,
      voiceSeconds: act.voiceSeconds,
    };
  });
  rows.sort((a, b) =>
    (b.tasksDone - a.tasksDone) || (b.checkins - a.checkins) ||
    (b.messages - a.messages) || (b.voiceSeconds - a.voiceSeconds));
  return { since, now, rows };
}

module.exports = {
  RANKS, INACTIVE_AFTER_DAYS, WEEKLY_HOUR_UTC,
  listMembers, getMember, registerMember, removeMember,
  checkIn, promote,
  createTasks, pickLeastBusy, getOpenTasks, getTask, completeTask,
  setLeave, addReport, getHistory,
  getRules, setRules,
  getReportChannelId, setReportChannelId,
  getWeeklySettings, setWeeklyEnabled,
  lastScheduledMoment, isWeeklyDue, markWeeklySent, weeklyData,
};
