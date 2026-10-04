const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const {
  getGuildStore, saveGuildStore, listGuildIds, getGlobalData, saveGlobalData,
} = require('./tn-storage');
const { resolveLogChannel } = require('./tn-log-channel');

// ---------------------------------------------------------------------
// Screenshot verification — modelled on Quotient's SS verify.
//
//  • Several setups per server: each submit channel has its own type
//    (Instagram / YouTube / Twitter-X / Rooter / Loco / Any SS / Custom),
//    verified role and screenshot count. Configured in /ss-verify-panel.
//  • Every screenshot is judged on its own and counted on its own — the
//    member only has to resend the ones that failed. Once they reach the
//    required count they get the role.
//  • Duplicate detection uses perceptual hashes (dHash + pHash), so a
//    re-saved / recompressed copy of the same screenshot is caught, as is
//    the same screenshot being submitted by two different members.
//  • Rate limits: 1 submission / 7s per member, 10 / minute per server.
//  • The "does this screenshot show what it should" check is done by
//    Google's Gemini vision model (GEMINI_API_KEY) — Quotient uses its own
//    OCR server for that, which isn't part of its public source.
// ---------------------------------------------------------------------

// Vision-capable model on Google's Gemini API. Configurable via .env in
// case Google renames/retires this model later — no code changes needed.
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-3.6-flash';

const DEFAULT_REQUIRED_SS = 4;
const MAX_REQUIRED_SS = 10;

// Two screenshots from the SAME member whose dHash differs by this many bits
// or fewer (out of 64) count as "the same screenshot" (Quotient uses 7).
const NEAR_DUPLICATE_DISTANCE = 7;

const MEMBER_COOLDOWN_MS = 7 * 1000;      // 1 submission per member per 7s
const GUILD_WINDOW_MS = 60 * 1000;        // ...and 10 per server per minute
const GUILD_MAX_PER_WINDOW = 10;

// Members with a role of this name are ignored in submit channels, so
// staff can talk there without the bot replying to them (same as Quotient).
const STAFF_BYPASS_ROLE_NAME = 'tourney-mod';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];

// Every screenshot type the panel offers. `kind` decides how a screenshot
// is judged: 'follow' = must show the account's profile with the "already
// following / subscribed" button state, 'custom' = must show one of the
// keywords, 'any' = any image counts (only the duplicate check applies).
const PLATFORMS = {
  instagram: {
    id: 'instagram', label: 'Instagram', emoji: '📸', kind: 'follow',
    action: 'following', buttonLabel: 'Following', notButtonLabel: 'Follow',
    nameLabel: 'Instagram Username',
    nameHint: 'Instagram handle (e.g. reboundesports or @reboundesports)',
    namePattern: /^[A-Za-z0-9._]{1,30}$/,
    urlRegex: /instagram\.com\/([A-Za-z0-9._]+)/i,
    linkBase: 'https://instagram.com/',
  },
  youtube: {
    id: 'youtube', label: 'YouTube', emoji: '▶️', kind: 'follow',
    action: 'subscribing to', buttonLabel: 'Subscribed', notButtonLabel: 'Subscribe',
    nameLabel: 'YouTube Channel',
    nameHint: 'YouTube handle (e.g. @reboundesports) or channel name',
    namePattern: /^[A-Za-z0-9._-]{1,100}$/,
    urlRegex: /youtube\.com\/(?:@|c\/|channel\/)?([A-Za-z0-9._-]+)/i,
    linkBase: 'https://youtube.com/@',
  },
  twitter: {
    id: 'twitter', label: 'Twitter / X', emoji: '✖️', kind: 'follow',
    action: 'following', buttonLabel: 'Following', notButtonLabel: 'Follow',
    nameLabel: 'Twitter / X Username',
    nameHint: 'Twitter/X handle (e.g. reboundesports or @reboundesports)',
    namePattern: /^[A-Za-z0-9_]{1,15}$/,
    urlRegex: /(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i,
    linkBase: 'https://x.com/',
  },
  rooter: {
    id: 'rooter', label: 'Rooter', emoji: '🎮', kind: 'follow',
    action: 'following', buttonLabel: 'Following', notButtonLabel: 'Follow',
    nameLabel: 'Rooter Channel Name',
    nameHint: 'The channel name exactly as shown on Rooter',
    namePattern: /^[^\n]{1,50}$/,
    urlRegex: null,
    linkBase: null,
  },
  loco: {
    id: 'loco', label: 'Loco', emoji: '🕹️', kind: 'follow',
    action: 'following', buttonLabel: 'Following', notButtonLabel: 'Follow',
    nameLabel: 'Loco Channel Name',
    nameHint: 'The channel name exactly as shown on Loco',
    namePattern: /^[^\n]{1,50}$/,
    urlRegex: null,
    linkBase: null,
  },
  any: {
    id: 'any', label: 'Any Screenshot', emoji: '🖼️', kind: 'any',
    nameLabel: 'Name (optional)',
    nameHint: 'Not needed — any png/jpg counts',
    namePattern: null, urlRegex: null, linkBase: null,
  },
  custom: {
    id: 'custom', label: 'Custom Filter', emoji: '🧩', kind: 'custom',
    nameLabel: 'Name / label',
    nameHint: 'What the screenshot is of (e.g. Discord server, app name)',
    namePattern: /^[^\n]{1,50}$/,
    urlRegex: null, linkBase: null,
  },
};

// ------------------------------------------------------------- helpers

// Cleans a name/handle typed into the panel: pulls the handle out of a pasted
// profile link, drops a leading "@", and checks it against the platform's
// pattern. Returns { ok: true, value } or { ok: false, error }.
function normalizeName(platform, raw) {
  let value = String(raw || '').trim();
  if (platform.urlRegex) {
    const m = value.match(platform.urlRegex);
    if (m) value = m[1];
  }
  value = value.replace(/^@/, '');
  if (!value) return { ok: false, error: `Enter the ${platform.nameLabel.toLowerCase()}.` };
  if (platform.namePattern && !platform.namePattern.test(value)) {
    return {
      ok: false,
      error: `That doesn't look like a valid ${platform.nameLabel.toLowerCase()}. Use the name itself${platform.urlRegex ? ' or a full profile/channel link' : ''}.`,
    };
  }
  return { ok: true, value };
}

function displayName(setup) {
  if (!setup.accountName) return '';
  const p = PLATFORMS[setup.type];
  return p && ['instagram', 'twitter', 'youtube'].includes(p.id) ? `@${setup.accountName}` : setup.accountName;
}

function setupLink(setup) {
  if (setup.link) return setup.link;
  const p = PLATFORMS[setup.type];
  return p && p.linkBase && setup.accountName ? p.linkBase + setup.accountName : null;
}

function describeSetup(setup) {
  const p = PLATFORMS[setup.type];
  if (!p) return `Unknown type (${setup.type})`;
  const name = displayName(setup);
  return `${p.emoji} ${p.label}${name ? ` — ${name}` : ''}`;
}

function newSetup(fields) {
  return {
    channelId: fields.channelId,
    type: fields.type,
    accountName: fields.accountName || '',
    link: fields.link || '',
    keywords: fields.keywords || [],
    roleId: fields.roleId,
    requiredSs: fields.requiredSs || DEFAULT_REQUIRED_SS,
    allowSame: Boolean(fields.allowSame),
    successMessage: fields.successMessage || null,
    createdAt: fields.createdAt || new Date().toISOString(),
    ...(fields.legacyVerified ? { legacyVerified: true } : {}),
  };
}

function recordsOf(store, setup) {
  return (store.ssData && store.ssData[setup.channelId]) || [];
}

function countFor(records, userId) {
  return records.filter(r => r.authorId === userId).length;
}

function isUserVerified(store, setup, userId) {
  if (countFor(recordsOf(store, setup), userId) >= setup.requiredSs) return true;
  return Boolean(setup.legacyVerified && store.ssVerifications && store.ssVerifications[userId]);
}

// How many members have fully verified through this setup (for the panel).
function countVerifiedMembers(store, setup) {
  const perUser = new Map();
  for (const r of recordsOf(store, setup)) perUser.set(r.authorId, (perUser.get(r.authorId) || 0) + 1);
  let n = 0;
  for (const c of perUser.values()) if (c >= setup.requiredSs) n++;
  return n;
}

function jumpUrl(guildId, record) {
  return `https://discord.com/channels/${guildId}/${record.channelId}/${record.messageId}`;
}

function validAttachments(message) {
  return [...message.attachments.values()].filter(a => ACCEPTED_TYPES.includes((a.contentType || '').split(';')[0]));
}

// -------------------------------------------------------- image hashing
// dHash / pHash are the same perceptual hashes Quotient uses (python's
// `imagehash`): 64 bits each, written as 16 hex characters. "sharp" does the
// image decoding; if it isn't installed we fall back to hashing the raw file
// bytes, which still catches an identical file re-sent but not re-saved copies.
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('[ss-verify] "sharp" is not installed — duplicate detection falls back to exact-file matching. Run `npm install`.');
}

function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

// px: 9 wide x 8 tall greyscale, row-major (72 values).
function dHashFromPixels(px) {
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += px[y * 9 + x + 1] > px[y * 9 + x] ? '1' : '0';
  }
  return bitsToHex(bits);
}

const PHASH_N = 32;
const PHASH_K = 8;
const COS_TABLE = (() => {
  const t = [];
  for (let k = 0; k < PHASH_K; k++) {
    const row = [];
    for (let n = 0; n < PHASH_N; n++) row.push(Math.cos((Math.PI * (2 * n + 1) * k) / (2 * PHASH_N)));
    t.push(row);
  }
  return t;
})();

// px: 32x32 greyscale, row-major (1024 values). Keeps the 8x8 lowest DCT
// frequencies and marks which are above their median.
function pHashFromPixels(px) {
  const N = PHASH_N;
  const K = PHASH_K;
  const rowDct = []; // rowDct[y][k]
  for (let y = 0; y < N; y++) {
    const r = new Array(K).fill(0);
    for (let k = 0; k < K; k++) {
      let sum = 0;
      for (let x = 0; x < N; x++) sum += px[y * N + x] * COS_TABLE[k][x];
      r[k] = sum;
    }
    rowDct.push(r);
  }
  const low = []; // 64 values, [j][k] flattened
  for (let j = 0; j < K; j++) {
    for (let k = 0; k < K; k++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += rowDct[y][k] * COS_TABLE[j][y];
      low.push(sum);
    }
  }
  const sorted = [...low].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  return bitsToHex(low.map(v => (v > median ? '1' : '0')).join(''));
}

async function readGrey(buf, width, height) {
  const { data, info } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stride = info.channels || 1;
  const out = new Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = data[i * stride];
  return out;
}

async function computeImageHashes(buf) {
  if (sharp) {
    try {
      const [small, big] = await Promise.all([readGrey(buf, 9, 8), readGrey(buf, PHASH_N, PHASH_N)]);
      return { dhash: dHashFromPixels(small), phash: pHashFromPixels(big) };
    } catch (err) {
      console.error('[ss-verify] Perceptual hashing failed, using exact-file hash for this image:', err.message);
    }
  }
  const sha = 'sha:' + crypto.createHash('sha256').update(buf).digest('hex');
  return { dhash: sha, phash: sha };
}

// Number of differing bits between two hashes (64 if they can't be compared).
function hashDistance(a, b) {
  if (a === b) return 0;
  if (/^[0-9a-f]{16}$/.test(a) && /^[0-9a-f]{16}$/.test(b)) {
    let x = BigInt('0x' + a) ^ BigInt('0x' + b);
    let count = 0;
    while (x > 0n) { count += Number(x & 1n); x >>= 1n; }
    return count;
  }
  return 64;
}

// Mirrors Quotient's duplicate rules: first, a near-identical screenshot from
// the same member; then an identical (dHash + pHash) one from anyone.
function findDuplicate(records, authorId, hashes) {
  for (const r of records) {
    if (r.authorId === authorId && r.dhash && hashDistance(hashes.dhash, r.dhash) <= NEAR_DUPLICATE_DISTANCE) {
      return r;
    }
  }
  for (const r of records) {
    if (r.dhash === hashes.dhash && r.phash === hashes.phash) return r;
  }
  return null;
}

// ---------------------------------------------------------- rate limits
const memberLast = new Map(); // "guildId:userId" -> last submission timestamp
const guildHits = new Map();  // guildId -> [timestamps within the window]

function checkRateLimit(guildId, userId, now = Date.now()) {
  if (memberLast.size > 5000) {
    for (const [k, t] of memberLast) if (now - t > MEMBER_COOLDOWN_MS) memberLast.delete(k);
  }
  const memberKey = `${guildId}:${userId}`;
  const last = memberLast.get(memberKey);
  if (last && now - last < MEMBER_COOLDOWN_MS) {
    return { scope: 'member', retry: (MEMBER_COOLDOWN_MS - (now - last)) / 1000 };
  }
  const hits = (guildHits.get(guildId) || []).filter(t => now - t < GUILD_WINDOW_MS);
  if (hits.length >= GUILD_MAX_PER_WINDOW) {
    return { scope: 'guild', retry: (GUILD_WINDOW_MS - (now - hits[0])) / 1000 };
  }
  hits.push(now);
  guildHits.set(guildId, hits);
  memberLast.set(memberKey, now);
  return null;
}

// One AI call at a time — keeps a busy channel from blowing through Gemini's
// per-minute limits (Quotient does the same with a lock).
let aiChain = Promise.resolve();
function runExclusive(fn) {
  const run = aiChain.then(fn);
  aiChain = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------ AI checker
function filteredKeywords(setup) {
  const seen = new Set();
  const out = [];
  for (const k of [setup.accountName, ...(setup.keywords || [])]) {
    const v = String(k || '').trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
}

function buildFollowPrompt(platform, username, count) {
  return `You are checking ${count} screenshot${count === 1 ? '' : 's'} submitted as proof of ${platform.action} the ${platform.label} account "@${username}". They are attached in order as Screenshot 1, Screenshot 2, etc.

For EACH screenshot, decide whether it clearly shows the ${platform.label} app open on that account's profile/channel page, with a "${platform.buttonLabel}" state on the button (not a "${platform.notButtonLabel}" button, which means they have NOT done it yet).

Be strict, for each screenshot independently:
- It must clearly be the ${platform.label} app (not an unrelated image or a different app).
- The username/handle visible in the screenshot must match "${username}" (a leading "@" or minor case difference is fine).
- The follow/subscribe button must clearly read "${platform.buttonLabel}" (an already-following indicator), not "${platform.notButtonLabel}".
- If the username/handle doesn't match, or the button isn't visible/says "${platform.notButtonLabel}", or you can't clearly tell, mark it NOT verified rather than guessing.

Respond with ONLY a JSON array, nothing else, with exactly ${count} objects in the same order as the screenshots:
[{"verified": true or false, "reason": "<one short sentence explaining the decision>"}, ...]`;
}

function buildCustomPrompt(setup, count) {
  const keywords = filteredKeywords(setup).map(k => `"${k}"`).join(', ');
  return `You are checking ${count} screenshot${count === 1 ? '' : 's'} submitted for a "${setup.accountName}" verification. They are attached in order as Screenshot 1, Screenshot 2, etc.

For EACH screenshot independently, decide whether it is a genuine screenshot that clearly shows at least one of these keywords or names somewhere in its visible text: ${keywords}. Case and spacing differences are fine.

Mark a screenshot NOT verified if none of the keywords is clearly visible, if it is not a real screenshot (e.g. an obviously edited or mocked-up image), or if you can't clearly tell — don't guess.

Respond with ONLY a JSON array, nothing else, with exactly ${count} objects in the same order as the screenshots:
[{"verified": true or false, "reason": "<one short sentence explaining the decision>"}, ...]`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 503s from Gemini ("model is currently experiencing high demand") are
// transient overload, not a real failure — worth a quick retry on the SAME
// key before moving on. A 429 (RESOURCE_EXHAUSTED / quota) is NOT transient —
// that key is done for the day, so instead of waiting we rotate to the next
// configured key and retry immediately.
const OVERLOAD_RETRY_DELAY_MS = 1000;

// ------------------------------------------------------- API key rotation
// Supports multiple Gemini API keys so a single free-tier key's 20/day quota
// doesn't take verification down for the whole server. Configure as
// GEMINI_API_KEYS="key1,key2,key3,..." (comma-separated). GEMINI_API_KEY
// (singular) still works as a fallback for a single key.
let apiKeysCache = null;
function getApiKeys() {
  if (apiKeysCache) return apiKeysCache;
  const multi = process.env.GEMINI_API_KEYS;
  const single = process.env.GEMINI_API_KEY;
  const raw = multi || single || '';
  const envKeys = raw.split(',').map(k => k.trim()).filter(Boolean);
  // Env keys always come first (and are tried first) — admin-added keys from
  // the panel are appended after, so they're only reached once every
  // .env-configured key is benched.
  apiKeysCache = [...envKeys, ...getExtraApiKeys()];
  return apiKeysCache;
}

// ---------------------------------------------------- manually-added keys
// Lets an admin paste a spare Gemini API key into the /ss-verify-panel "API
// Keys" screen as a stopgap if every key in GEMINI_API_KEYS / GEMINI_API_KEY
// gets benched (daily quota) at once. Stored via storage.js (not .env), so
// it's picked up immediately and survives restarts/redeploys.
function getExtraApiKeys() {
  return getGlobalData().extraApiKeys || [];
}

function addExtraApiKey(key) {
  const trimmed = (key || '').trim();
  if (!trimmed) return false;
  const data = getGlobalData();
  if (!data.extraApiKeys) data.extraApiKeys = [];
  if (data.extraApiKeys.includes(trimmed)) return false; // already added
  data.extraApiKeys.push(trimmed);
  saveGlobalData(data);
  apiKeysCache = null; // rebuild next getApiKeys() call so it's usable right away
  return true;
}

// Removes the manually-added key at position `extraIndex` within the
// extra-keys list (NOT the combined env+extra index used elsewhere).
function removeExtraApiKeyAt(extraIndex) {
  const data = getGlobalData();
  const keys = data.extraApiKeys || [];
  if (extraIndex < 0 || extraIndex >= keys.length) return false;
  keys.splice(extraIndex, 1);
  data.extraApiKeys = keys;
  saveGlobalData(data);
  apiKeysCache = null;
  // Combined-list indices shift when a key is removed from the middle, so
  // drop all cooldown bookkeeping rather than risk it pointing at the wrong
  // key. Worst case a still-exhausted key gets one wasted retry.
  keyExhaustedUntil.clear();
  return true;
}

function maskApiKey(key) {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// Status of every configured key (env first, then manual), for the panel.
function getKeyStatus() {
  const keys = getApiKeys();
  const extra = getExtraApiKeys();
  const envCount = keys.length - extra.length;
  const now = Date.now();
  return keys.map((k, i) => {
    const until = keyExhaustedUntil.get(i) || null;
    return {
      index: i,
      extraIndex: i >= envCount ? i - envCount : null,
      source: i < envCount ? 'env' : 'manual',
      masked: maskApiKey(k),
      benched: Boolean(until && until > now),
      benchedUntil: until,
    };
  });
}

// index -> timestamp (ms) when that key's daily quota is assumed to free up
// again. Kept in memory only — resets naturally on redeploy/restart, which
// is fine since the quota resets daily anyway.
const keyExhaustedUntil = new Map();
let nextKeyIndex = 0;
const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h — free-tier quota window

function markKeyExhausted(index) {
  keyExhaustedUntil.set(index, Date.now() + QUOTA_COOLDOWN_MS);
}

// Returns the indices of every key not currently marked exhausted, starting
// from nextKeyIndex so load spreads round-robin across calls.
function availableKeyOrder(keys) {
  const now = Date.now();
  const order = [];
  for (let i = 0; i < keys.length; i++) {
    const idx = (nextKeyIndex + i) % keys.length;
    const until = keyExhaustedUntil.get(idx);
    if (!until || until <= now) order.push(idx);
  }
  return order;
}

/**
 * Sends the given screenshots to Gemini in ONE request and returns
 * { ok: true, results: [{ verified, reason }] } (same order as `images`), or
 * { ok: false, error } if the model couldn't be reached / its answer couldn't
 * be matched up with the images.
 */
async function analyzeScreenshots(images, setup) {
  const keys = getApiKeys();
  if (!keys.length) {
    console.warn('[ss-verify] GEMINI_API_KEY / GEMINI_API_KEYS not set — skipping screenshot verification.');
    return { ok: false, error: 'no_api_key' };
  }

  const platform = PLATFORMS[setup.type];
  const prompt = platform.kind === 'custom'
    ? buildCustomPrompt(setup, images.length)
    : buildFollowPrompt(platform, setup.accountName, images.length);

  // Interleave a "Screenshot N:" label before each image so the model can't
  // lose track of ordering when matching its answers back up.
  const parts = [{ text: prompt }];
  images.forEach((img, i) => {
    parts.push({ text: `Screenshot ${i + 1}:` });
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.buf.toString('base64') } });
  });

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      // Thinking tokens count against maxOutputTokens — keep them minimal
      // so the model doesn't run out of budget before writing the JSON.
      thinkingConfig: { thinkingLevel: 'minimal' },
    },
  });

  const keyOrder = availableKeyOrder(keys);
  if (!keyOrder.length) {
    console.error('[ss-verify] All Gemini API keys are exhausted for today.');
    return { ok: false, error: 'quota_exhausted' };
  }

  for (const keyIndex of keyOrder) {
    const apiKey = keys[keyIndex];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${apiKey}`;
    let overloadRetried = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          console.error(`[ss-verify] Gemini API key #${keyIndex + 1} returned ${res.status}:`, errBody);

          if (res.status === 429) {
            // Quota exhausted on this key — bench it for 24h and move to the
            // next available key right away (no point waiting).
            markKeyExhausted(keyIndex);
            nextKeyIndex = (keyIndex + 1) % keys.length;
            break; // fall through to the next key in keyOrder
          }
          if (res.status === 503 && !overloadRetried) {
            // Transient overload — one quick retry on the SAME key.
            overloadRetried = true;
            await sleep(OVERLOAD_RETRY_DELAY_MS);
            continue;
          }
          return { ok: false, error: 'api_error' };
        }

        nextKeyIndex = (keyIndex + 1) % keys.length; // spread load next time
        return await parseGeminiResponse(res, images.length);
      } catch (err) {
        console.error(`[ss-verify] Failed to reach Gemini API (key #${keyIndex + 1}):`, err);
        if (!overloadRetried) {
          overloadRetried = true;
          await sleep(OVERLOAD_RETRY_DELAY_MS);
          continue;
        }
        return { ok: false, error: 'network_error' };
      }
    }
  }

  // Every key hit a 429 in this call.
  console.error('[ss-verify] All Gemini API keys returned 429 for this request.');
  return { ok: false, error: 'quota_exhausted' };
}

async function parseGeminiResponse(res, expectedCount) {
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    console.error('[ss-verify] Gemini API response had no text (finishReason:', finishReason + '):', JSON.stringify(data));
    return { ok: false, error: 'empty_response' };
  }

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    console.error('[ss-verify] Failed to parse JSON array from vision model:', text);
    return { ok: false, error: 'bad_json' };
  }

  if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
    console.error(`[ss-verify] Expected ${expectedCount} results, got:`, JSON.stringify(parsed));
    return { ok: false, error: 'bad_json' };
  }

  return {
    ok: true,
    results: parsed.map(p => ({
      verified: Boolean(p) && p.verified === true,
      reason: p && typeof p.reason === 'string' ? p.reason : '',
    })),
  };
}

async function downloadImage(attachment) {
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let mimeType = (attachment.contentType || res.headers.get('content-type') || 'image/png').split(';')[0];
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
  return { buf, mimeType };
}

// ------------------------------------------------------ roles + logging
// Gives the setup's verified role. Never throws — a missing role, missing
// permission, or the member having left doesn't block the rest of the flow.
async function giveVerifiedRole(message, setup) {
  const guild = message.guild;
  const role = guild.roles.cache.get(setup.roleId);
  if (!role) {
    console.error(`[ss-verify] Role ${setup.roleId} for channel ${setup.channelId} no longer exists in guild ${guild.id} — re-run the setup in /ss-verify-panel.`);
    return;
  }
  const botMember = guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    console.error(`[ss-verify] Bot is missing the "Manage Roles" permission in guild ${guild.id}.`);
    return;
  }
  if (role.position >= botMember.roles.highest.position) {
    console.error(`[ss-verify] Bot's highest role is below "${role.name}" (${role.id}) in guild ${guild.id} — move the bot's role above it.`);
    return;
  }
  try {
    const member = message.member ?? await guild.members.fetch(message.author.id);
    if (!member.roles.cache.has(role.id)) await member.roles.add(role.id);
  } catch (err) {
    console.error(`[ss-verify] Failed to give role ${role.id} to ${message.author.id} in guild ${guild.id}: ${err.code ?? ''} ${err.message}`);
  }
}

function buildLogEmbed(message, setup, thumbnailUrl) {
  const embed = new EmbedBuilder()
    .setTitle(`${PLATFORMS[setup.type].emoji} ${PLATFORMS[setup.type].label} — Verified`)
    .setColor(0x57F287)
    .setDescription(`${message.author} completed **${setup.requiredSs}** screenshot${setup.requiredSs === 1 ? '' : 's'} in <#${setup.channelId}> (${describeSetup(setup)}).\n[Jump to the last submission](${message.url})`)
    .setTimestamp();
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  return embed;
}

// ------------------------------------------------------------ main flow
// Re-reads the guild's data just before writing: the AI call can take several
// seconds, and other parts of the bot may have saved in the meantime.
function commitRecords(guildId, setupChannelId, newRecords) {
  const fresh = getGuildStore(guildId);
  if (!fresh.ssData) fresh.ssData = {};
  if (!fresh.ssData[setupChannelId]) fresh.ssData[setupChannelId] = [];
  fresh.ssData[setupChannelId].push(...newRecords);
  saveGuildStore(guildId, fresh);
  return fresh;
}

const sec = ms => (ms / 1000).toFixed(2);

// Entry point, called from index.js for every message in a submit channel.
// Returns true when the message was handled here, false when it should fall
// through to the rest of the bot (staff with the "tourney-mod" role).
async function handleSsVerifyMessage(message) {
  const guildId = message.guild.id;
  const store = getGuildStore(guildId);
  const setup = store.ssSetups && store.ssSetups[message.channelId];
  if (!setup) return false;

  if (message.member && message.member.roles.cache.some(r => r.name.toLowerCase() === STAFF_BYPASS_ROLE_NAME)) {
    return false;
  }

  const platform = PLATFORMS[setup.type];
  const say = (color, description) => message.reply({
    embeds: [new EmbedBuilder().setColor(color).setDescription(description)],
  }).catch(() => null);

  if (!platform) {
    await say(0xED4245, '<a:985581725159669780:1548939847962468412> This screenshot channel isn\'t set up correctly — an admin needs to fix it in `/ss-verify-panel`.');
    return true;
  }

  if (isUserVerified(store, setup, message.author.id)) {
    await say(0xED4245, '**Your screenshots are already verified, kindly move onto the next step.**');
    return true;
  }

  const attachments = validAttachments(message);
  if (attachments.length === 0) {
    await say(0xED4245, '**Kindly send screenshots in `png/jpg/jpeg` format only.**');
    return true;
  }

  const limited = checkRateLimit(guildId, message.author.id);
  if (limited) {
    await say(0xED4245, limited.scope === 'member'
      ? `**You are too fast. Kindly resend after \`${limited.retry.toFixed(2)}\` seconds.**`
      : `**Many users are submitting screenshots from this server at this time. Kindly retry after \`${limited.retry.toFixed(2)}\` seconds.**`);
    return true;
  }

  const records = recordsOf(store, setup).slice();
  const have = countFor(records, message.author.id);
  const remaining = Math.max(0, setup.requiredSs - have);
  if (attachments.length > remaining) {
    await say(0xED4245, `**You only need to send \`${remaining}\` more screenshot${remaining === 1 ? '' : 's'} but you sent \`${attachments.length}\`.**`);
    return true;
  }

  const processing = await say(0xFEE75C, `Processing your screenshot${attachments.length === 1 ? '' : 's'}... <a:DOT128:1552891040195678298>`);
  const removeProcessing = () => (processing ? processing.delete().catch(() => {}) : Promise.resolve());
  const startedAt = Date.now();

  let images;
  let hashes;
  try {
    images = await Promise.all(attachments.map(downloadImage));
    hashes = await Promise.all(images.map(img => computeImageHashes(img.buf)));
  } catch (err) {
    console.error('[ss-verify] Failed to download screenshots:', err);
    await removeProcessing();
    await say(0xED4245, '**Failed to process your screenshots. Try again later.**');
    return true;
  }

  // Step 1 — duplicates (skipped when the setup allows the same screenshot).
  // `lines[i]` is the reply line for attachment i; `candidates` are the ones
  // that still need the type check.
  const lines = new Array(attachments.length).fill(null);
  const candidates = [];
  attachments.forEach((_, i) => {
    if (!setup.allowSame) {
      const dup = findDuplicate(records, message.author.id, hashes[i]);
      if (dup) {
        lines[i] = dup.authorId === message.author.id
          ? `<a:banned128:1552898864636371046> | **Image ${i + 1}:** You've already submitted this screenshot [here](${jumpUrl(guildId, dup)}).`
          : `<a:banned128:1552898864636371046> | **Image ${i + 1}:** <@${dup.authorId}> already submitted the [same screenshot](${jumpUrl(guildId, dup)}).`;
        return;
      }
      const sameInBatch = candidates.find(j => hashDistance(hashes[j].dhash, hashes[i].dhash) <= NEAR_DUPLICATE_DISTANCE);
      if (sameInBatch !== undefined) {
        lines[i] = `<a:banned128:1552898864636371046> | **Image ${i + 1}:** Same screenshot as image ${sameInBatch + 1} in this message.`;
        return;
      }
    }
    candidates.push(i);
  });

  // Step 2 — does each remaining screenshot show what it should?
  const verdicts = new Map(); // attachment index -> { verified, reason }
  if (platform.kind === 'any') {
    for (const i of candidates) verdicts.set(i, { verified: true, reason: '' });
  } else if (candidates.length) {
    const result = await runExclusive(() => analyzeScreenshots(candidates.map(i => images[i]), setup));
    if (!result.ok) {
      // Nothing was counted, so the member can simply resend.
      await removeProcessing();
      await say(0xED4245, '<a:985581725159669780:1548939847962468412> Couldn\'t run verification right now (the AI checker is temporarily unavailable). None of these screenshots were counted — please resend them shortly, or ping a staff member if this keeps happening.');
      return true;
    }
    candidates.forEach((attIdx, k) => verdicts.set(attIdx, result.results[k]));
  }

  // Step 3 — build the reply lines and save what passed.
  const accepted = [];
  for (const i of candidates) {
    const v = verdicts.get(i);
    if (v.verified) {
      lines[i] = `<a:452028tick:1548939815574175764> | **Image ${i + 1}:** Verified successfully.`;
      accepted.push({
        authorId: message.author.id,
        channelId: message.channelId,
        messageId: message.id,
        dhash: hashes[i].dhash,
        phash: hashes[i].phash,
        submittedAt: new Date().toISOString(),
      });
    } else {
      // Keep the AI's specific reasoning in the logs only — members just see
      // a plain generic rejection line, not the exact detail it noticed.
      if (v.reason) console.log(`[ss-verify] rejected image ${i + 1}: ${v.reason}`);
      lines[i] = `<a:banned128:1552898864636371046> | **Image ${i + 1}:** Screenshot must clearly show the correct account/username.`;
    }
  }

  let total = have;
  if (accepted.length) {
    const fresh = commitRecords(guildId, setup.channelId, accepted);
    total = countFor(recordsOf(fresh, setup), message.author.id);
  }

  const failed = attachments.length - accepted.length;
  const embed = new EmbedBuilder()
    .setColor(accepted.length === 0 ? 0xED4245 : failed === 0 ? 0x57F287 : 0xFEE75C)
    .setAuthor({
      name: `Submitted ${Math.min(total, setup.requiredSs)}/${setup.requiredSs}`,
      iconURL: message.author.displayAvatarURL ? message.author.displayAvatarURL() : undefined,
    })
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: `Time taken: ${sec(Date.now() - startedAt)} seconds` });

  await removeProcessing();
  await message.reply({ embeds: [embed] }).catch(() => {});

  if (total >= setup.requiredSs) {
    await giveVerifiedRole(message, setup);
    await message.react('✅').catch(() => {});

    if (setup.successMessage) {
      await message.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('Screenshot Verification Complete')
          .setURL(message.url)
          .setDescription(setup.successMessage)],
      }).catch(() => {});
    } else {
      await say(0x57F287, `${message.author} Your screenshots are verified, move on to the next step.`);
    }

    const latest = getGuildStore(guildId);
    const logChannel = await resolveLogChannel(message.guild, latest, latest.settings && latest.settings.ssVerifyLogChannelId);
    if (logChannel) {
      try {
        await logChannel.send({ embeds: [buildLogEmbed(message, setup, attachments[0].url)] });
      } catch (err) {
        console.error('[ss-verify] Failed to post to log channel:', err);
      }
    }
  }

  return true;
}

// ---------------------------------------------------- cleanup + migration
// A deleted submit channel or verified role makes its setup meaningless —
// remove it (and its stored screenshots), as Quotient does.
function handleChannelDelete(channel) {
  if (!channel.guild) return;
  const store = getGuildStore(channel.guild.id);
  if (store.ssSetups && store.ssSetups[channel.id]) {
    delete store.ssSetups[channel.id];
    if (store.ssData) delete store.ssData[channel.id];
    saveGuildStore(channel.guild.id, store);
  }
}

function handleRoleDelete(role) {
  const store = getGuildStore(role.guild.id);
  let changed = false;
  for (const [channelId, setup] of Object.entries(store.ssSetups || {})) {
    if (setup.roleId === role.id) {
      delete store.ssSetups[channelId];
      if (store.ssData) delete store.ssData[channelId];
      changed = true;
    }
  }
  if (changed) saveGuildStore(role.guild.id, store);
}

// The first version of this feature had a single channel/platform/username in
// guild settings. Turns that into one setup (once), and keeps the members who
// were already verified under it verified.
function migrateLegacySsSettings(store) {
  if (!store.ssSetups) store.ssSetups = {};
  if (!store.ssData) store.ssData = {};
  const s = store.settings || {};
  if (s.ssMigratedToSetups) return false;
  if (!s.ssVerifyChannelId && !s.ssVerifyRoleId && !s.ssVerifyPlatform) return false;
  if (!store.settings) store.settings = s;
  s.ssMigratedToSetups = true;

  const platform = PLATFORMS[s.ssVerifyPlatform];
  const name = s.ssVerifyUsernames && s.ssVerifyUsernames[s.ssVerifyPlatform];
  if (platform && name && s.ssVerifyChannelId && s.ssVerifyRoleId && !store.ssSetups[s.ssVerifyChannelId]) {
    store.ssSetups[s.ssVerifyChannelId] = newSetup({
      channelId: s.ssVerifyChannelId,
      type: platform.id,
      accountName: name,
      roleId: s.ssVerifyRoleId,
      legacyVerified: true,
    });
  }
  return true;
}

function migrateAllGuilds() {
  for (const guildId of listGuildIds()) {
    try {
      const store = getGuildStore(guildId);
      if (migrateLegacySsSettings(store)) {
        saveGuildStore(guildId, store);
        console.log(`[ss-verify] Migrated the old single-channel setup for guild ${guildId} to the new multi-setup format.`);
      }
    } catch (err) {
      console.error(`[ss-verify] Migration failed for guild ${guildId}:`, err);
    }
  }
}

module.exports = {
  handleSsVerifyMessage,
  handleChannelDelete,
  handleRoleDelete,
  migrateLegacySsSettings,
  migrateAllGuilds,
  PLATFORMS,
  DEFAULT_REQUIRED_SS,
  MAX_REQUIRED_SS,
  normalizeName,
  displayName,
  setupLink,
  describeSetup,
  newSetup,
  countVerifiedMembers,
  // API key management (used by the "API Keys" screen in ss-verify-panel-handlers.js)
  getKeyStatus,
  addExtraApiKey,
  removeExtraApiKeyAt,
  // exported for testing
  dHashFromPixels,
  pHashFromPixels,
  computeImageHashes,
  hashDistance,
  findDuplicate,
  checkRateLimit,
};
