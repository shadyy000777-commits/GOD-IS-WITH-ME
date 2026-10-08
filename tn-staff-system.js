// Staff management data layer for the !staff panel — members, ranks, check-ins,
// work (tasks), leave, reports, history and the weekly report numbers.
// Everything lives under store.staffSystem in the per-guild store (storage.js),
// so it works the same on the JSON file and on PostgreSQL. All functions here
// are synchronous: read the store, change it, save it.
const { getGuildStore, saveGuildStore } = require('./tn-storage');
const staffActivity = require('./tn-staff-activity');

// Promotion ladder — edit this list to rename / add ranks.
const RANKS = ['Trial Staff', 'Staff', 'Senior Staff', 'Head Staff', 'Manager'];

// Active = checked in within this many hours. Anyone who hasn't (and isn't on
// leave) counts as inactive. Check-in is the only thing that makes someone active.
const CHECKIN_WINDOW_HOURS = 24;

// Staff leave dates are typed by people in India — read them as IST (UTC+05:30).
const IST_OFFSET_MS = 5.5 * 3600000;
const MAX_LEAVE_DAYS = 90;
const MAX_FORMER = 300;

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
    formerStaff: [],      // removed members: { userId, name, rankName, position, joinedAt, removedAt, removedBy, checkins, tasksDone }
    rules: '',
    reportChannelId: null,   // weekly report channel
    privateChannelId: null,  // private channel: report forms + leave notices
    leaveRoleId: null,       // "Staff On Leave" role
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

function lastCheckinOf(member) {
  if (member.lastCheckinAt) return member.lastCheckinAt;
  const recent = member.recentCheckins || [];
  return recent.length ? recent[recent.length - 1] : null;
}

function isOnLeave(member, now = Date.now()) {
  return Boolean(member.leaveUntil && member.leaveUntil > now && (member.leaveFrom || 0) <= now);
}

function statusOf(member, now = Date.now()) {
  if (isOnLeave(member, now)) return 'leave';
  const last = lastCheckinOf(member);
  if (last && now - last <= CHECKIN_WINDOW_HOURS * 3600000) return 'active';
  return 'inactive';
}

function decorate(member, openCounts, now) {
  return {
    ...member,
    lastCheckinAt: lastCheckinOf(member),
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
      leaveFrom: null, leaveUntil: null, leaveReason: '', leaveRoleGiven: false,
      lastCheckinAt: null, recentCheckins: [],
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
  const old = sys.members[userId];
  if (!old) return false;
  sys.formerStaff.push({
    userId, name: old.name || '', rankName: RANKS[old.rank] || RANKS[0], position: old.position || '',
    joinedAt: old.joinedAt, removedAt: Date.now(), removedBy: by || null,
    checkins: old.checkins || 0, tasksDone: old.tasksDone || 0,
  });
  if (sys.formerStaff.length > MAX_FORMER) sys.formerStaff.splice(0, sys.formerStaff.length - MAX_FORMER);
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
  m.lastCheckinAt = now;
  m.recentCheckins = [...(m.recentCheckins || []), now].slice(-60);
  if (isOnLeave(m, now)) { // checking in ends a running leave early
    m.leaveUntil = null;
    m.leaveFrom = null;
    pushHistory(sys, 'leave_end', userId, 'Ended leave early by checking in', userId);
  }
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
// Reads "DD/MM/YYYY", "DD-MM-YYYY" or "YYYY-MM-DD" as a calendar day in IST.
// Returns { y, m, d } or null.
function parseDateParts(text) {
  const t = String(text || '').trim();
  let y, m, d, match;
  if ((match = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/))) { d = +match[1]; m = +match[2]; y = +match[3]; }
  else if ((match = t.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/))) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

// Start of that IST day / end of that IST day, as UTC milliseconds.
function istDayStart({ y, m, d }) { return Date.UTC(y, m - 1, d, 0, 0, 0) - IST_OFFSET_MS; }
function istDayEnd({ y, m, d }) { return Date.UTC(y, m - 1, d, 23, 59, 59) - IST_OFFSET_MS; }

// Turns the two typed dates into { fromMs, toMs } or { error }.
function parseLeaveRange(fromText, toText, now = Date.now()) {
  const from = parseDateParts(fromText);
  const to = parseDateParts(toText);
  if (!from) return { error: 'The **From** date isn\'t valid — use DD/MM/YYYY, e.g. 15/10/2026.' };
  if (!to) return { error: 'The **To** date isn\'t valid — use DD/MM/YYYY, e.g. 18/10/2026.' };
  const fromMs = istDayStart(from);
  const toMs = istDayEnd(to);
  if (toMs < fromMs) return { error: 'The **To** date can\'t be before the **From** date.' };
  if (toMs <= now) return { error: 'That leave is already over — pick dates from today onwards.' };
  const todayStart = istDayStart(istParts(now));
  if (fromMs < todayStart) return { error: 'The **From** date can\'t be in the past.' };
  if ((toMs - fromMs) / DAY_MS > MAX_LEAVE_DAYS) return { error: `Leave can be at most ${MAX_LEAVE_DAYS} days.` };
  return { fromMs, toMs };
}

function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function setLeave(guildId, userId, fromMs, toMs, reason) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m) return null;
  m.leaveFrom = fromMs;
  m.leaveUntil = toMs;
  m.leaveReason = String(reason || '').slice(0, 300);
  const day = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
  pushHistory(sys, 'leave', userId, `${day(fromMs)} → ${day(toMs)}${reason ? ` — ${reason}` : ''}`, userId);
  commit(guildId, store);
  return decorate(m, openCountsOf(sys), Date.now());
}

function setLeaveRoleGiven(guildId, userId, given) {
  const { store, sys } = open(guildId);
  const m = sys.members[userId];
  if (!m || Boolean(m.leaveRoleGiven) === Boolean(given)) return;
  m.leaveRoleGiven = Boolean(given);
  commit(guildId, store);
}

function getLeaveRoleId(guildId) { return open(guildId).sys.leaveRoleId || null; }
function setLeaveRoleId(guildId, roleId) {
  const { store, sys } = open(guildId);
  sys.leaveRoleId = roleId;
  // Forget who we gave the old role to, so the next sync re-applies the new one.
  for (const m of Object.values(sys.members)) m.leaveRoleGiven = false;
  commit(guildId, store);
}

// ---------------------------------------------------------------- reports
function addReport(guildId, { userId, subject, about, details, evidence }) {
  const { store, sys } = open(guildId);
  const report = {
    id: sys.nextReportId++, userId,
    subject: String(subject).slice(0, 100), about: String(about || '').slice(0, 100),
    details: String(details).slice(0, 1500), evidence: String(evidence || '').slice(0, 500), at: Date.now(),
  };
  sys.reports.push(report);
  if (sys.reports.length > MAX_REPORTS) sys.reports.splice(0, sys.reports.length - MAX_REPORTS);
  const m = sys.members[userId];
  if (m) m.lastActiveAt = report.at;
  pushHistory(sys, 'report', userId, `#${report.id} ${report.subject}`, userId);
  commit(guildId, store);
  return report;
}

function getReportCount(guildId, userId) {
  return open(guildId).sys.reports.filter(r => r.userId === userId).length;
}

// ---------------------------------------------------------------- history
function getHistory(guildId, limit = 20, userId = null) {
  const { sys } = open(guildId);
  return sys.history
    .filter(h => !userId || h.userId === userId)
    .slice(-limit)
    .reverse();
}

function getFormerStaff(guildId) {
  return [...open(guildId).sys.formerStaff].reverse(); // newest removal first
}

// ---------------------------------------------------------------- settings
function getPrivateChannelId(guildId) { return open(guildId).sys.privateChannelId || null; }
function setPrivateChannelId(guildId, channelId) {
  const { store, sys } = open(guildId);
  sys.privateChannelId = channelId;
  commit(guildId, store);
}

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
  RANKS, CHECKIN_WINDOW_HOURS, WEEKLY_HOUR_UTC, MAX_LEAVE_DAYS,
  listMembers, getMember, registerMember, removeMember,
  checkIn, promote,
  createTasks, pickLeastBusy, getOpenTasks, getTask, completeTask,
  parseLeaveRange, setLeave, setLeaveRoleGiven, getLeaveRoleId, setLeaveRoleId,
  addReport, getReportCount, getHistory, getFormerStaff, getPrivateChannelId, setPrivateChannelId,
  getRules, setRules,
  getReportChannelId, setReportChannelId,
  getWeeklySettings, setWeeklyEnabled,
  lastScheduledMoment, isWeeklyDue, markWeeklySent, weeklyData,
};
