// Per-group match schedule — how many matches a tournament group plays and
// each match's IDP time / start time / map. Stored on the group itself:
//   group.schedule = { date: 'YYYY-MM-DD' | null, matches: [{ idp: 'HH:MM' | null, start: 'HH:MM' | null, map: string | null }] }
// Times are stored 24h ("13:04") and shown 12h ("01:04 PM"). "Today" /
// "Tomorrow" labels are worked out in TOURNAMENT_TZ (default Asia/Kolkata).

const MAX_MATCHES = 10;

function getTz() {
  return process.env.TOURNAMENT_TZ || 'Asia/Kolkata';
}

const pad = n => String(n).padStart(2, '0');

// "1:04 PM", "1.04pm", "13:04", "1pm" -> "13:04" (null if unreadable)
function parseTimeInput(str) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a|p)?$/i.exec(String(str || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] ? m[3][0].toLowerCase() : null;
  if (min > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === 'p' && h !== 12) h += 12;
    if (mer === 'a' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(min)}`;
}

// "13:04" -> "01:04 PM"
function formatTime(hhmm) {
  if (!hhmm) return 'TBD';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${pad(h12)}:${pad(m)} ${suffix}`;
}

function todayString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: getTz(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// "today" / "tomorrow" / "DD/MM" / "DD/MM/YYYY" -> "YYYY-MM-DD" (null if unreadable)
function parseDateInput(str) {
  const text = String(str || '').trim().toLowerCase();
  if (text === 'today') return todayString();
  if (text === 'tomorrow') return addDays(todayString(), 1);
  const m = /^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2}|\d{4}))?$/.exec(text);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  let year = m[3] ? parseInt(m[3], 10) : parseInt(todayString().slice(0, 4), 10);
  if (m[3] && m[3].length === 2) year += 2000;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// "Today, Friday, September 4" / "Tomorrow, Saturday, September 5" / "Sunday, September 6"
function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  const today = todayString();
  if (dateStr === today) return `Today, ${base}`;
  if (dateStr === addDays(today, 1)) return `Tomorrow, ${base}`;
  return base;
}

function matchLine(match, idx) {
  const parts = [`IDP ${formatTime(match.idp)}`, `Start ${formatTime(match.start)}`];
  if (match.map) parts.push(match.map);
  return `⏰ **Match ${idx + 1}** — ${parts.join(' | ')}`;
}

// Lines for the slot-list embed (empty array when nothing is configured).
function buildScheduleLines(group) {
  const schedule = group && group.schedule;
  if (!schedule || !schedule.matches || !schedule.matches.length) return [];
  const lines = [];
  if (schedule.date) lines.push(`📅 **${formatDateLabel(schedule.date)}**`);
  schedule.matches.forEach((match, idx) => lines.push(matchLine(match, idx)));
  return lines;
}

// Sets the number of matches, keeping existing ones and adding blanks.
function setMatchCount(group, count) {
  if (count <= 0) {
    group.schedule = null;
    return;
  }
  if (!group.schedule) group.schedule = { date: todayString(), matches: [] };
  const matches = group.schedule.matches;
  while (matches.length < count) matches.push({ idp: null, start: null, map: null });
  matches.length = count;
}

module.exports = {
  MAX_MATCHES, parseTimeInput, formatTime, parseDateInput, formatDateLabel,
  matchLine, buildScheduleLines, setMatchCount,
};
