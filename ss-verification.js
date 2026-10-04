const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { resolveLogChannel } = require('./log-channel');

// Vision-capable model on Google's Gemini API. Configurable via .env in
// case Google renames/retires this model later — no code changes needed.
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-3.6-flash';

// One team member submits proof for the whole squad in a single message:
// their own follow screenshot plus one from each of 3 teammates — all 4
// showing they follow the SAME configured account, and all 4 must be
// genuinely separate screenshots (see the duplicate check below).
//
// NOTE: all screenshots are now sent to the vision model together in a
// SINGLE request (see analyzeFollowScreenshots) to conserve Gemini's
// free-tier daily request quota. The model is still asked to judge each
// image independently, and the exact-duplicate hash check below runs
// BEFORE any AI call as a first line of defense against reusing one
// screenshot for multiple slots.
const REQUIRED_SCREENSHOT_COUNT = 4;

// How long the "X/4 screenshots received" progress reply stays in the
// channel before auto-deleting itself, so the verify channel doesn't
// fill up with these interim status messages.
const TEMP_MESSAGE_TTL_MS = 15 * 1000;

// Only these get sent off to the vision model — random file attachments
// (zip, txt, etc.) in the channel are ignored rather than misread as "no
// screenshot" screenshots.
function imageAttachments(message) {
  return [...message.attachments.values()].filter(a =>
    (a.contentType || '').startsWith('image/')
  );
}

// Catches reusing one screenshot for multiple/all 4 slots: literally the
// same image file (or an exact re-upload of it) attached more than once.
// Byte-identical only — a re-saved/recompressed copy of the same
// screenshot won't hash the same, but this still stops the easy version
// of the cheat (attaching the same file 4 times).
async function hashImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image for hashing: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function findExactDuplicates(imageUrls) {
  const hashes = await Promise.all(imageUrls.map(hashImage));
  const firstSeenAt = new Map(); // hash -> first 0-based index
  const pairs = []; // [imageNumber1, imageNumber2] (1-based, for the reply)
  hashes.forEach((hash, i) => {
    if (firstSeenAt.has(hash)) {
      pairs.push([firstSeenAt.get(hash) + 1, i + 1]);
    } else {
      firstSeenAt.set(hash, i);
    }
  });
  return pairs;
}

function buildBatchPrompt(instagramUsername, count) {
  return `You are checking ${count} screenshots submitted as proof of following the Instagram account "@${instagramUsername}". They are attached in order as Screenshot 1, Screenshot 2, etc.

For EACH screenshot, decide whether it clearly shows the Instagram app open on that account's profile page with a "Following" state on the follow button (not a "Follow" button, which means they have NOT followed yet).

Be strict, for each screenshot independently:
- The username visible in the screenshot must match "${instagramUsername}" (a leading "@" or minor case difference is fine).
- It must look like a genuine Instagram profile screenshot — not an unrelated image, a different app, or an obviously edited/mocked-up button.
- If the button says "Follow" (not "Following"/"Message"), or the username doesn't match, or you can't clearly tell, mark it NOT verified rather than guessing.

Respond with ONLY a JSON array, nothing else, with exactly ${count} objects in the same order as the screenshots:
[{"verified": true or false, "reason": "<one short sentence explaining the decision>"}, ...]`;
}

/**
 * Calls the Gemini vision model ONCE with all screenshots attached
 * together (instead of one request per image), since the free tier's
 * daily request quota is scarce enough that 4 calls per submission burns
 * through it fast. Returns { ok: true, verified, perImage, reasons } on
 * success, or { ok: false, error } if the model couldn't be reached or
 * its response couldn't be parsed/matched to the images.
 */
async function analyzeFollowScreenshots(imageUrls, instagramUsername) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[ss-verify] GEMINI_API_KEY not set — skipping screenshot verification.');
    return { ok: false, error: 'no_api_key' };
  }

  // Unlike Groq, Gemini can't fetch a Discord CDN URL server-side — each
  // image has to be sent as inline base64 data, so download them all first.
  let images;
  try {
    images = await Promise.all(imageUrls.map(async (imageUrl) => {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`status ${imgRes.status}`);
      const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await imgRes.arrayBuffer());
      return { mimeType, base64Data: buf.toString('base64') };
    }));
  } catch (err) {
    console.error('[ss-verify] Failed to download screenshots for Gemini:', err);
    return { ok: false, error: 'network_error' };
  }

  // Interleave a "Screenshot N:" label before each image so the model
  // can't lose track of ordering when matching its answers back up.
  const parts = [{ text: buildBatchPrompt(instagramUsername, images.length) }];
  images.forEach((img, i) => {
    parts.push({ text: `Screenshot ${i + 1}:` });
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64Data } });
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          // gemini-3.6-flash thinks by default, and those thinking tokens
          // count against maxOutputTokens — without this, the model was
          // burning its whole budget "reasoning" and getting cut off
          // before it ever wrote the actual JSON. This task doesn't need
          // deep reasoning, so keep thinking minimal.
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[ss-verify] Gemini API returned ${res.status}:`, errBody);
      return { ok: false, error: 'api_error' };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) {
      const finishReason = data?.candidates?.[0]?.finishReason;
      console.error('[ss-verify] Gemini API response had no text (finishReason:', finishReason + '):', JSON.stringify(data));
      return { ok: false, error: 'empty_response' };
    }

    // responseMimeType: 'application/json' should make this clean JSON
    // already, but pull out just the [...] array as a safety net in case
    // the model still wraps it in a code fence or stray text.
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (err) {
      const finishReason = data?.candidates?.[0]?.finishReason;
      console.error(`[ss-verify] Failed to parse JSON array from vision model (finishReason: ${finishReason}):`, text);
      return { ok: false, error: 'bad_json' };
    }

    if (!Array.isArray(parsed) || parsed.length !== imageUrls.length) {
      console.error(`[ss-verify] Expected ${imageUrls.length} results, got:`, JSON.stringify(parsed));
      return { ok: false, error: 'bad_json' };
    }

    const perImage = parsed.map(p => p.verified === true);
    const reasons = parsed.map(p => (typeof p.reason === 'string' ? p.reason : ''));
    return { ok: true, verified: perImage.every(Boolean), perImage, reasons };
  } catch (err) {
    console.error('[ss-verify] Failed to reach Gemini API:', err);
    return { ok: false, error: 'network_error' };
  }
}

// Gives the configured "SS verified" role, if one is set. Never throws —
// mirrors giveVerifiedRole in verification-handlers.js so a missing role,
// missing permission, or the member having left doesn't block the rest of
// the flow.
async function giveSsVerifiedRole(message, store) {
  const roleId = store.settings && store.settings.ssVerifyRoleId;
  if (!roleId) {
    console.warn(`[ss-verify] No ssVerifyRoleId configured for guild ${message.guild.id} — run /set-ss-verify-role.`);
    return;
  }

  const role = message.guild.roles.cache.get(roleId);
  if (!role) {
    console.error(`[ss-verify] Configured role ${roleId} no longer exists in guild ${message.guild.id} — re-run /set-ss-verify-role.`);
    return;
  }

  const botMember = message.guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    console.error(`[ss-verify] Bot is missing the "Manage Roles" permission in guild ${message.guild.id}.`);
    return;
  }
  if (role.position >= botMember.roles.highest.position) {
    console.error(`[ss-verify] Bot's highest role is below "${role.name}" (${roleId}) in guild ${message.guild.id} — move the bot's role above it.`);
    return;
  }

  try {
    const member = message.member ?? await message.guild.members.fetch(message.author.id);
    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(roleId);
    }
  } catch (err) {
    console.error(`[ss-verify] Failed to give role ${roleId} to ${message.author.id} in guild ${message.guild.id}: ${err.code ?? ''} ${err.message}`);
  }
}

function buildLogEmbed(message, instagramUsername, result, thumbnailUrl) {
  return new EmbedBuilder()
    .setTitle('📸 Instagram Follow — Squad Verified')
    .setColor(0x57F287)
    .setDescription(`${message.author} submitted ${REQUIRED_SCREENSHOT_COUNT} distinct screenshots (themself + 3 teammates) all following **@${instagramUsername}**.`)
    .addFields(
      { name: 'Model reasoning', value: result.reasons.filter(Boolean).join(' / ') || '_none given_' },
    )
    .setThumbnail(thumbnailUrl)
    .setTimestamp();
}

// Entry point, called from index.js for every message posted in the
// configured SS-verify channel. Returns true if this message was handled
// (so the caller knows not to fall through to anything else), false if it
// wasn't an SS-verify submission at all.
async function handleSsVerifyMessage(message) {
  const store = getGuildStore(message.guild.id);
  if (!store.settings) store.settings = {};

  const instagramUsername = store.settings.instagramUsername;
  if (!instagramUsername) {
    await message.reply({
      content: '⚠️ Screenshot verification isn\'t fully set up yet — an admin needs to run `/set-instagram-username` first.',
    }).catch(() => {});
    return true;
  }

  if (!store.ssVerifications) store.ssVerifications = {};
  const existing = store.ssVerifications[message.author.id];
  if (existing) {
    await message.reply({
      content: `✅ You're already verified as following **@${instagramUsername}**.`,
    }).catch(() => {});
    return true;
  }

  const images = imageAttachments(message);

  if (images.length === 0) {
    await message.reply({
      content: `📸 Post **${REQUIRED_SCREENSHOT_COUNT} screenshots** — yours plus your **3 teammates'** (each a genuinely separate screenshot) — each showing you're following **@${instagramUsername}** (the "Following" button visible), to get verified. You can send them all in one message or across several — I'll count them as they come in.`,
    }).catch(() => {});
    return true;
  }

  // Screenshots accumulate across messages: a player can post 1 now and
  // more later, and we track progress toward REQUIRED_SCREENSHOT_COUNT
  // per user. Verification (and the role) only fires once they've hit
  // the full count — partial submissions never trigger it.
  if (!store.ssPending) store.ssPending = {};
  const pending = store.ssPending[message.author.id] || { imageUrls: [] };
  const remainingSlots = REQUIRED_SCREENSHOT_COUNT - pending.imageUrls.length;

  if (images.length > remainingSlots) {
    await message.reply({
      content: `📸 You already have **${pending.imageUrls.length}/${REQUIRED_SCREENSHOT_COUNT}** screenshots counted — only **${remainingSlots}** more needed. Please attach just ${remainingSlots} (not ${images.length}) in your next message.`,
    }).catch(() => {});
    return true;
  }

  pending.imageUrls.push(...images.map(a => a.url));
  store.ssPending[message.author.id] = pending;
  saveGuildStore(message.guild.id, store);

  if (pending.imageUrls.length < REQUIRED_SCREENSHOT_COUNT) {
    const progressEmbed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setDescription(`📸 Got it — **${pending.imageUrls.length}/${REQUIRED_SCREENSHOT_COUNT}** screenshots received. Send ${REQUIRED_SCREENSHOT_COUNT - pending.imageUrls.length} more (yours + teammates') showing you're following **@${instagramUsername}** to complete verification.`);
    const sent = await message.reply({ embeds: [progressEmbed] }).catch(() => null);
    if (sent) {
      setTimeout(() => sent.delete().catch(() => {}), TEMP_MESSAGE_TTL_MS);
    }
    return true;
  }

  // Duplicate check runs BEFORE any AI call — catches the exact same image
  // file attached more than once (e.g. reusing one person's screenshot to
  // fill all 4 slots), across any of the messages they were sent in.
  let exactDupPairs = [];
  try {
    exactDupPairs = await findExactDuplicates(pending.imageUrls);
  } catch (err) {
    console.error('[ss-verify] Failed to hash images for duplicate check:', err);
    // Don't block verification just because hashing failed.
  }

  if (exactDupPairs.length) {
    delete store.ssPending[message.author.id];
    saveGuildStore(message.guild.id, store);
    const pairText = exactDupPairs.map(([a, b]) => `#${a} & #${b}`).join(', ');
    await message.reply({
      content: `❌ Screenshot(s) ${pairText} are the exact same image reused. Each of the ${REQUIRED_SCREENSHOT_COUNT} screenshots must be a genuinely different screenshot (yours + 3 teammates'). Your progress has been reset — please resend all ${REQUIRED_SCREENSHOT_COUNT}.`,
    }).catch(() => {});
    return true;
  }

  await message.channel.sendTyping().catch(() => {});

  const analysisStartedAt = Date.now();
  const result = await analyzeFollowScreenshots(pending.imageUrls, instagramUsername);
  const elapsedSeconds = ((Date.now() - analysisStartedAt) / 1000).toFixed(2);

  if (!result.ok) {
    // Don't clear pending here — a flaky API call shouldn't cost them
    // their already-counted screenshots. They can just try again.
    await message.reply({
      content: '⚠️ Couldn\'t run verification right now (the AI checker is temporarily unavailable). Your screenshots are still counted — please try again shortly, or ping a staff member if this keeps happening.',
    }).catch(() => {});
    return true;
  }

  if (!result.verified) {
    delete store.ssPending[message.author.id];
    saveGuildStore(message.guild.id, store);
    const failedNums = result.perImage
      .map((ok, i) => (ok ? null : i + 1))
      .filter(Boolean);
    const rejectionLines = failedNums
      .map(num => `🚫 | **Image ${num}** ${result.reasons[num - 1] || 'Did not check out.'}`)
      .join('\n');
    const rejectionEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setAuthor({ name: `Submitted 0/${REQUIRED_SCREENSHOT_COUNT}` })
      .setDescription(`❌ **Rejected :**\n${rejectionLines}\n\nMake sure every screenshot clearly shows that profile with the **Following** button. Your progress has been reset — please resend all ${REQUIRED_SCREENSHOT_COUNT}.`)
      .setFooter({ text: `Time taken: ${elapsedSeconds} seconds` });
    const sentRejection = await message.reply({ embeds: [rejectionEmbed] }).catch(() => null);
    if (sentRejection) {
      setTimeout(() => sentRejection.delete().catch(() => {}), TEMP_MESSAGE_TTL_MS);
    }
    return true;
  }

  delete store.ssPending[message.author.id];
  store.ssVerifications[message.author.id] = {
    verifiedAt: new Date().toISOString(),
    imageUrls: pending.imageUrls,
  };
  saveGuildStore(message.guild.id, store);

  await giveSsVerifiedRole(message, store);

  await message.react('✅').catch(() => {});
  await message.reply({
    content: `✅ Verified! You and your 3 teammates are confirmed as following **@${instagramUsername}**.`,
  }).catch(() => {});

  const logChannel = await resolveLogChannel(message.guild, store, store.settings.ssVerifyLogChannelId);
  if (logChannel) {
    try {
      await logChannel.send({ embeds: [buildLogEmbed(message, instagramUsername, result, pending.imageUrls[0])] });
    } catch (err) {
      console.error('[ss-verify] Failed to post to log channel:', err);
    }
  }

  return true;
}

module.exports = { handleSsVerifyMessage, analyzeFollowScreenshots, REQUIRED_SCREENSHOT_COUNT };
