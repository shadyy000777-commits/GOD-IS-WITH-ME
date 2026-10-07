// Website -> bot control API.
// The NOBLE website calls this to run tournament actions on behalf of a logged-in server admin.
//   WEB_API_SECRET  required (long random string, same value on the website). Without it the API stays OFF.
//   WEB_API_PORT    optional, default 8080 (the website reaches it over Railway's private network,
//                   e.g. http://<bot-service-name>.railway.internal:8080)
// Security: only requests carrying the secret are accepted. The website has ALREADY checked that the
// person manages the server; the bot re-checks that the bot itself is in that server.
const http = require('http');
const crypto = require('crypto');
const { getGuildStore, saveGuildStore } = require('./storage');
const { logActivity, logRoleChange } = require('./tournament-activity-log');

const SECRET = process.env.WEB_API_SECRET || '';
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const keyOk = k => SECRET && crypto.timingSafeEqual(sha(k || ''), sha(SECRET));
const clean = (v, n = 80) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

class ApiError extends Error { constructor(m, code = 400) { super(m); this.code = code; } }

// Every group object of a tournament: round 1 (tournament.groups) plus later rounds (tournament.rounds[n].groups).
function allGroups(t) {
  const out = [];
  for (const g of Object.values(t.groups || {})) if (g && Array.isArray(g.teams)) out.push(g);
  for (const r of Object.values(t.rounds || {})) for (const g of Object.values((r && r.groups) || {})) if (g && Array.isArray(g.teams)) out.push(g);
  return out;
}
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function member(guild, id) {
  return guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
}

// Same limits as the bot's own settings screen (tn-tournament-wizard-handlers.js).
const MAX_GROUP_CAPACITY = 1000, MAX_TOTAL_SLOTS = 15000;

// Actions that work on the whole server (no existing tournament needed).
const GUILD_ACTIONS = new Set(['create_tournament']);

const ACTIONS = {

  // Create a new tournament (same starting values as the bot's "Create Tournament" button).
  async create_tournament({ guild, store, params, actor }) {
    const name = clean(params.name, 80); if (!name) throw new ApiError('Tournament name is required');
    if (!store.tournaments) store.tournaments = {};
    const all = Object.values(store.tournaments);
    if (all.length >= 25) throw new ApiError('This server already has 25 tournaments - delete one first');
    if (all.some(x => sameName(x.name, name))) throw new ApiError('A tournament called "' + name + '" already exists', 409);
    const id = require('./tournament-store').generateTournamentId();
    store.tournaments[id] = {
      id, name, open: false, groups: {}, qualified: [], bannedTeams: [],
      slotManagerChannelId: null, confirmChannelId: null,
      requiredMentions: 4, allowFakeTag: false, teamsPerGroup: 20, totalSlots: null,
      rounds: {},
    };
    saveGuildStore(guild.id, store);
    return { message: '"' + name + '" was created. Set it up below.', tid: id, label: 'created tournament ' + name };
  },
  // Start / pause registration (same as the "Start/Pause Reg" button)
  async toggle_registration({ t, guild, store }) {
    t.open = !t.open; t.closedReason = null;
    saveGuildStore(guild.id, store);
    try { await require('./tournament-wizard-handlers').refreshRegisterPanel(guild, t); } catch (e) { console.error('[web-api] refresh panel:', e.message); }
    return { message: t.open ? 'Registration opened.' : 'Registration closed.', open: t.open, label: (t.open ? 'opened' : 'closed') + ' registration for ' + t.name };
  },

  // Block a team name from registering (same as the old name-only Ban/Unban). Calling it again unbans.
  async ban_toggle({ t, guild, store, params }) {
    const raw = clean(params.team, 60); if (!raw) throw new ApiError('Team name is required');
    const key = raw.toLowerCase();
    if (!t.bannedTeams) t.bannedTeams = [];
    const i = t.bannedTeams.indexOf(key);
    if (i === -1) {
      t.bannedTeams.push(key);
      let removed = 0;
      for (const g of allGroups(t)) { const b = g.teams.length; g.teams = g.teams.filter(x => !sameName(x.team, raw)); removed += b - g.teams.length; }
      t.qualified = (t.qualified || []).filter(n => !sameName(n, raw));
      saveGuildStore(guild.id, store);
      return { message: raw + ' is now banned' + (removed ? ' and was removed from ' + removed + ' group slot(s).' : '.'), label: 'banned team ' + raw };
    }
    t.bannedTeams.splice(i, 1);
    saveGuildStore(guild.id, store);
    return { message: raw + ' has been unbanned.', label: 'unbanned team ' + raw };
  },

  // Cancel a team's slot: remove it from every group and take its roles away.
  async remove_team({ t, guild, store, params, actor }) {
    const raw = clean(params.team, 60); if (!raw) throw new ApiError('Team name is required');
    const removedTeams = [];
    for (const g of allGroups(t)) {
      const keep = [];
      for (const tm of g.teams) { if (sameName(tm.team, raw)) removedTeams.push({ tm, g }); else keep.push(tm); }
      g.teams = keep;
    }
    if (!removedTeams.length) throw new ApiError('No team named "' + raw + '" is registered in this tournament', 404);
    saveGuildStore(guild.id, store);
    const still = userId => allGroups(t).some(g => g.teams.some(x => x.ownerId === userId || (x.playerIds || []).includes(userId)));
    for (const { tm, g } of removedTeams) {
      for (const uid of new Set([tm.ownerId, ...(tm.playerIds || [])].filter(Boolean))) {
        if (still(uid)) continue;
        const m = await member(guild, uid); if (!m) continue;
        for (const roleId of [g.roleId, t.confirmRoleId, t.registeredRoleId]) {
          if (roleId && m.roles.cache.has(roleId)) {
            await m.roles.remove(roleId).catch(() => {});
            await logRoleChange(guild, t, { member: m, roleId, added: false, reason: 'slot cancelled from website by ' + actor.name + ' - team "' + raw + '"' });
          }
        }
      }
    }
    return { message: raw + ' was removed and their roles taken away.', label: 'cancelled the slot of ' + raw };
  },
  // Edit tournament settings (same fields and limits as the bot's "Edit Settings" screen).
  // Everything is validated first; nothing is saved unless every field passes.
  async update_settings({ t, guild, store, params }) {
    const s = params.settings;
    if (!s || typeof s !== 'object' || !Object.keys(s).length) throw new ApiError('No settings sent');
    const whole = (v, lo, hi, label) => {
      const n = Number(v);
      if (v === '' || v === null || !Number.isInteger(n) || n < lo || n > hi) throw new ApiError(label + ' must be a whole number between ' + lo + ' and ' + hi);
      return n;
    };
    const pick = (v, label, kind) => {
      const x = String(v == null ? '' : v).trim();
      if (!x) return null;                                   // empty = clear it
      if (!/^\d{15,25}$/.test(x)) throw new ApiError(label + ' must be a Discord ID (numbers only)');
      const found = kind === 'role' ? guild.roles.cache.has(x) : guild.channels.cache.has(x);
      if (!found) throw new ApiError(label + ' was not found in this server');
      return x;
    };
    const next = {}, changed = [];
    if ('name' in s) { const n = clean(s.name, 80); if (!n) throw new ApiError('Tournament name cannot be empty'); next.name = n; }
    if ('requiredMentions' in s) next.requiredMentions = whole(s.requiredMentions, 0, 4, 'Required mentions');
    if ('teamsPerGroup' in s) next.teamsPerGroup = whole(s.teamsPerGroup, 1, MAX_GROUP_CAPACITY, 'Teams per group');
    if ('totalSlots' in s) next.totalSlots = (s.totalSlots === '' || s.totalSlots === null) ? null : whole(s.totalSlots, 1, MAX_TOTAL_SLOTS, 'Total slots');
    if ('allowFakeTag' in s) next.allowFakeTag = s.allowFakeTag === true || s.allowFakeTag === 'true';
    for (const [k, label] of [['confirmChannelId', 'Confirm channel'], ['swapChannelId', 'Group swap channel'], ['logChannelId', 'Log channel'], ['slotManagerChannelId', 'Slot manager channel']]) {
      if (k in s) next[k] = pick(s[k], label, 'channel');
    }
    for (const [k, label] of [['registerRoleId', 'Register role'], ['confirmRoleId', 'Registration role']]) {
      if (k in s) next[k] = pick(s[k], label, 'role');
    }
    for (const k of Object.keys(next)) { if (t[k] !== next[k]) { t[k] = next[k]; changed.push(k); } }
    if (!changed.length) return { message: 'Nothing changed.', label: 'saved settings for ' + t.name + ' (no changes)' };
    saveGuildStore(guild.id, store);
    try { await require('./tournament-wizard-handlers').refreshRegisterPanel(guild, t); } catch (e) { console.error('[web-api] refresh panel:', e.message); }
    return { message: 'Settings saved (' + changed.length + ' changed).', label: 'changed settings of ' + t.name + ': ' + changed.join(', ') };
  },
};

async function run(body, client) {
  const guildId = String(body.guildId || ''), tid = String(body.tid || ''), action = String(body.action || '');
  if (!/^\d{15,25}$/.test(guildId)) throw new ApiError('Bad server id');
  const fn = ACTIONS[action]; if (!fn) throw new ApiError('Unknown action', 404);
  const guild = client.guilds.cache.get(guildId); if (!guild) throw new ApiError('The bot is not in that server', 404);
  const store = getGuildStore(guildId);
  let t = null;
  if (!GUILD_ACTIONS.has(action)) { t = (store.tournaments || {})[tid]; if (!t) throw new ApiError('Tournament not found', 404); }
  const actor = { id: clean(body.actor && body.actor.id, 30), name: clean(body.actor && body.actor.name, 40) || 'Website user' };
  const res = await fn({ t, guild, store, params: body.params || {}, actor });
  logActivity(guildId, { action: 'web_' + action, userId: actor.id, username: actor.name + ' (website)', label: res.label });
  return { ok: true, message: res.message, open: res.open, tid: res.tid };
}

function start(client) {
  if (!SECRET) { console.log('[web-api] WEB_API_SECRET not set - website control API is OFF.'); return; }
  if (SECRET.length < 24) console.warn('[web-api] WEB_API_SECRET is short - use a long random one.');
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || req.url !== '/web/action') return send(404, { error: 'Not found' });
    if (!keyOk(req.headers['x-web-key'])) return send(401, { error: 'Unauthorized' });
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 20000) { send(413, { error: 'Too large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, { error: 'Bad JSON' }); }
      try { send(200, await run(body, client)); }
      catch (e) { if (e instanceof ApiError) return send(e.code, { error: e.message }); console.error('[web-api]', e); send(500, { error: 'Bot error' }); }
    });
  });
  const port = Number(process.env.WEB_API_PORT) || 8080;
  server.listen(port, () => console.log('[web-api] listening on :' + port));
}
module.exports = { start };
