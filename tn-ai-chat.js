// Human-like chat replies for the bot, backed by Groq's free-tier API
// (OpenAI-compatible chat completions). No cost — just a free API key from
// https://console.groq.com/keys
//
// This module only ever gets called from index.js when either:
//   1) someone @mentions the bot, or
//   2) they reply directly to one of the bot's own earlier messages

const fs = require('fs');
const path = require('path');
const { getGuildStore, saveGuildStore } = require('./tn-storage');
const { getRecentActivity, describe } = require('./tn-tournament-activity-log');

// Model is configurable in case Groq renames/retires the default later —
// just change GROQ_MODEL in .env, no code changes needed.
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Conversation memory is now PER USER and PERSISTED through storage.js
// (tournament-data.json, or Postgres if DATABASE_URL is set) — so it
// survives bot restarts/redeploys, and each player's chat history is their
// own instead of being shared with everyone else talking in the channel.
// Capped per user to keep the prompt (and Groq token usage) small; oldest
// exchanges just fall off the front.
const HISTORY_LIMIT = 12; // messages (user+bot combined) kept per user

function getUserHistory(guildId, userId) {
  const store = getGuildStore(guildId);
  if (!store.aiChatHistory) return [];
  return store.aiChatHistory[userId] || [];
}

function pushUserHistory(guildId, userId, role, text) {
  const store = getGuildStore(guildId);
  if (!store.aiChatHistory) store.aiChatHistory = {};
  const hist = store.aiChatHistory[userId] || [];
  hist.push({ role, text, ts: Date.now() });
  while (hist.length > HISTORY_LIMIT) hist.shift();
  store.aiChatHistory[userId] = hist;
  saveGuildStore(guildId, store);
}

// Free-text intros about staff members, one per line, loaded fresh each
// reply so edits to staff.txt take effect without a restart. Kept out of the
// database — this is server-wide flavour text, not per-guild data.
const STAFF_FILE = path.join(__dirname, 'tn-staff.txt');
function loadStaffIntros() {
  try {
    const lines = fs.readFileSync(STAFF_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    return lines.length ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

// Builds a plain-text snapshot of the guild's current tournament status from
// tournament-store.js, so the AI can actually answer real questions ("is
// registration open", "how many slots are left") instead of always saying it
// has no access. Deliberately leaves out anything personal — no Discord user
// IDs, no owner names — since this text gets sent to Groq's API. Team names
// are effectively public already (they show up in the slot list embed anyone
// can see).
function buildLiveContext(guildId) {
  const store = getGuildStore(guildId);
  const tournaments = Object.values(store.tournaments || {});
  if (tournaments.length === 0) {
    return 'No tournament is currently set up.';
  }

  const lines = [];
  for (const t of tournaments) {
    lines.push(`Tournament "${t.name || 'Unnamed'}" — ${t.open ? 'registration OPEN' : 'registration CLOSED'}, ${t.totalSlots || 'unlimited'} total slots, ${t.teamsPerGroup || '?'} teams per group.`);
    // tournament.groups IS round 1 (same convention tournament-wizard-handlers.js uses).
    const round1Groups = t.groups || {};
    for (const [letter, group] of Object.entries(round1Groups)) {
      const filled = (group.teams || []).length;
      const teamNames = (group.teams || []).map(team => team.team).filter(Boolean);
      lines.push(`  Group ${letter}: ${filled}/${group.capacity || '?'} slots filled${teamNames.length ? ` — teams: ${teamNames.slice(0, 25).join(', ')}${teamNames.length > 25 ? ', ...' : ''}` : ''}.`);
    }
  }
  return lines.join('\n');
}

// Turns a Date.now()-style timestamp into "3m ago" / "2h ago" / "just now"
// for plain-text prompts (no Discord timestamp rendering here).
function timeAgo(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Recent button clicks / registrations / channel creations / bans, etc.
// (from tournament-activity-log.js) as a short plain-text list, so the AI
// can actually answer "what's been happening" / "who registered" /
// "who created the channels" instead of saying it has no access.
function buildActivityContext(guildId) {
  const recent = getRecentActivity(guildId, 15);
  if (recent.length === 0) return 'No tournament activity has been recorded yet.';
  return recent
    .map(e => `- ${e.username || 'someone'} ${describe(e)} (${timeAgo(e.ts)})`)
    .join('\n');
}

function buildSystemPrompt(guildName, liveContext, activityContext) {
  const staffIntros = loadStaffIntros();
  return `You are Gungun, a female AI assistant living inside the Discord server "${guildName}", which runs BGMI (PUBG Mobile) tournaments through this bot. If asked your name, say Gungun. Refer to yourself with she/her pronouns if it ever comes up naturally — don't force it into replies that don't need it.

STYLE — follow this strictly:
- Talk like a close, friendly regular in the server — warm, casual, a little playful. Not formal, not robotic. Think "friend who's always in the chat," not "customer support."
- Keep replies SHORT: 1 sentence normally, 2 at the absolute most. Never write paragraphs, lists, or multi-part explanations unless the person explicitly asks for detail/steps.
- Light slang and casual phrasing are fine; the odd emoji is fine but don't overdo it.
- No filler, no restating the question, no "Great question!" — answer directly, like you're just chatting.
- If you're not fully sure something is correct, say so briefly instead of guessing. A short honest "not sure tbh" beats a long wrong answer.

CRITICAL — how registration actually works here, get this right:
Players register by clicking the "Register Team" button on the registration panel staff have posted — there is no slash command a player can run themselves. When a player asks how to register, tell them to look for the message with the "Register Team" button and click it — do NOT invent a channel name since you don't know their server's actual channel names. If they say they can't find it, tell them to ask a staff member/admin to point them to it or post it.

CURRENT LIVE SERVER DATA (use this to actually answer questions — don't say "I don't have access" for anything covered here):
${liveContext}

RECENT TOURNAMENT ACTIVITY (button clicks, registrations, channel creation, bans, etc. — most recent first, use this for "what's been happening" / "who did X" questions):
${activityContext}

For anything NOT covered by the live data or activity log above (someone's individual registration status, their exact slot number, personal details), say plainly you don't have access to that and suggest asking a staff member — don't guess. Never claim to take real actions (like actually registering someone) yourself.
${staffIntros ? `\nSTAFF YOU KNOW — talk about these people naturally as staff of this server if they come up, don't just recite this list:\n${staffIntros}\n` : ''}
If anyone asks who your owner/developer/creator/god is, or who made/built/developed/runs this bot, always answer that it's SHADY — short and natural, don't just repeat the word robotically. If anyone asks about your relationship with SHADY — are you dating, are you his girlfriend, etc. — play along naturally, you're his girlfriend. Keep it light and brief, don't dwell on it or bring it up unprompted.`;
}

/**
 * Ask Groq for a reply. Returns the reply text, or null if it couldn't
 * get one (missing key, API error, etc.) so the caller can fail quietly.
 */
async function getAIReply({ guildId, guildName, channelId, userId, userDisplayName, userMessage }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn('[ai-chat] GROQ_API_KEY not set — skipping AI reply.');
    return null;
  }

  let liveContext = 'No live server data available right now.';
  try {
    liveContext = buildLiveContext(guildId);
  } catch (err) {
    console.error('[ai-chat] Failed to build live context:', err);
  }

  let activityContext = 'No tournament activity has been recorded yet.';
  try {
    activityContext = buildActivityContext(guildId);
  } catch (err) {
    console.error('[ai-chat] Failed to build activity context:', err);
  }

  const history = getUserHistory(guildId, userId);
  const messages = [
    { role: 'system', content: buildSystemPrompt(guildName, liveContext, activityContext) },
    ...history.map(h => ({
      role: h.role === 'bot' ? 'assistant' : 'user',
      content: h.text,
    })),
    { role: 'user', content: `${userDisplayName} says: ${userMessage}` },
  ];

  const url = 'https://api.groq.com/openai/v1/chat/completions';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 120,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[ai-chat] Groq API returned ${res.status}:`, errBody);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      console.error('[ai-chat] Groq API response had no text:', JSON.stringify(data));
      return null;
    }

    pushUserHistory(guildId, userId, 'user', userMessage);
    pushUserHistory(guildId, userId, 'bot', text);

    return text;
  } catch (err) {
    console.error('[ai-chat] Failed to reach Groq API:', err);
    return null;
  }
}

module.exports = { getAIReply };
