const os = require('os');
const { EmbedBuilder, version: discordJsVersion } = require('discord.js');
const { getGuildStore } = require('./storage');

// ───────────────────────── helpers ─────────────────────────

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  if (!d) parts.push(`${s}s`);
  return parts.join(' ');
}

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// ▰▰▰▰▱▱▱▱▱▱ style bar for a 0–100 percentage.
function bar(percent, size = 10) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

function pingEmoji(ms) {
  if (ms < 0) return '⚪';
  if (ms < 150) return '🟢';
  if (ms < 300) return '🟡';
  return '🔴';
}

// Share of one CPU core this process used over a short sample window.
async function sampleProcessCpu(windowMs = 400) {
  const startUsage = process.cpuUsage();
  const startTime = process.hrtime.bigint();
  await new Promise(r => setTimeout(r, windowMs));
  const usage = process.cpuUsage(startUsage);
  const elapsedMicros = Number(process.hrtime.bigint() - startTime) / 1000;
  const percent = ((usage.user + usage.system) / elapsedMicros) * 100;
  return Math.min(100, percent);
}

function uniqueCommandCount(client) {
  // prefixCommands is keyed by name AND every alias, so count unique commands.
  return new Set(client.prefixCommands.values()).size;
}

// ───────────────────────── command ─────────────────────────

module.exports = {
  name: 'stats',
  aliases: ['botinfo', 'botstats', 'g'],
  triggers: ['*g'], // typing just *g (no prefix) also runs this
  description: "Shows the bot's live statistics, performance and system info",
  adminOnly: false,

  async execute(message) {
    const client = message.client;
    const prefix = process.env.PREFIX || '!';

    // Round-trip latency: time how long it takes to send a message.
    const sentAt = Date.now();
    const pending = await message.channel.send('📡 Gathering stats...');
    const apiLatency = Date.now() - sentAt;
    const wsPing = Math.round(client.ws.ping);

    const cpuPercent = await sampleProcessCpu();

    // ── Bot statistics ──
    const servers = client.guilds.cache.size;
    const users = client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);
    const channels = client.channels.cache.size;
    const slashCount = client.commands.size;
    const prefixCount = uniqueCommandCount(client);

    // ── Memory ──
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const rssPercent = (mem.rss / totalMem) * 100;
    const heapPercent = (mem.heapUsed / mem.heapTotal) * 100;
    const sysUsedPercent = ((totalMem - os.freemem()) / totalMem) * 100;

    // ── This server's scrim snapshot ──
    let scrimLine = '`No scrim set up`';
    try {
      const store = getGuildStore(message.guildId);
      if (store && store.scrim) {
        const filled = Object.keys(store.scrim.slots || {}).length;
        const total = store.scrim.totalSlots || 0;
        const groupCount = Object.keys((store.settings && store.settings.groupChannels) || {}).length;
        scrimLine = `\`${filled}/${total}\` slots filled • \`${groupCount}\` group channel(s)`;
      }
    } catch { /* stats must never fail because of storage */ }

    const cpuModel = (os.cpus()[0] && os.cpus()[0].model.replace(/\s+/g, ' ').trim()) || 'Unknown';
    const [load1] = os.loadavg();

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setAuthor({ name: `${client.user.username} — Live Statistics`, iconURL: client.user.displayAvatarURL() })
      .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
      .setDescription(
        `🟢 **Online** since <t:${Math.floor((Date.now() - client.uptime) / 1000)}:R>\n` +
        `🆔 \`${client.user.id}\` • Created <t:${Math.floor(client.user.createdTimestamp / 1000)}:R>`,
      )
      .addFields(
        {
          name: '📊 Bot Statistics',
          value: [
            `🌐 **Servers:** \`${servers.toLocaleString()}\``,
            `👥 **Users:** \`${users.toLocaleString()}\``,
            `💬 **Channels:** \`${channels.toLocaleString()}\``,
            `⌨️ **Commands:** \`${slashCount}\` slash • \`${prefixCount}\` prefix`,
          ].join('\n'),
          inline: true,
        },
        {
          name: '📡 Latency',
          value: [
            `${pingEmoji(wsPing)} **WebSocket:** \`${wsPing >= 0 ? wsPing + 'ms' : 'n/a'}\``,
            `${pingEmoji(apiLatency)} **API:** \`${apiLatency}ms\``,
            `⏱️ **Uptime:** \`${formatDuration(client.uptime)}\``,
          ].join('\n'),
          inline: true,
        },
        { name: '\u200b', value: '\u200b', inline: false },
        {
          name: '⚙️ Performance',
          value: [
            `🧠 **CPU (bot):** \`${cpuPercent.toFixed(1)}%\``,
            `${bar(cpuPercent)}`,
            `💾 **RAM (bot):** \`${formatBytes(mem.rss)}\` / \`${formatBytes(totalMem)}\` (\`${rssPercent.toFixed(2)}%\`)`,
            `${bar(rssPercent)}`,
            `📦 **Heap:** \`${formatBytes(mem.heapUsed)}\` / \`${formatBytes(mem.heapTotal)}\` (\`${heapPercent.toFixed(0)}%\`)`,
            `${bar(heapPercent)}`,
            `🖥️ **System RAM used:** \`${sysUsedPercent.toFixed(0)}%\` • **Load:** \`${load1.toFixed(2)}\``,
          ].join('\n'),
          inline: false,
        },
        {
          name: '🛠️ Technical',
          value: [
            `🟩 **Node.js:** \`${process.version}\` • 📚 **discord.js:** \`v${discordJsVersion}\``,
            `🐧 **Platform:** \`${os.platform()} ${os.arch()}\` • 🔩 **Cores:** \`${os.cpus().length}\``,
            `🔧 **CPU:** \`${cpuModel}\``,
          ].join('\n'),
          inline: false,
        },
        {
          name: '🎯 This Server',
          value: scrimLine,
          inline: false,
        },
      )
      .setFooter({
        text: `Requested by ${message.author.username} • Prefix: ${prefix}`,
        iconURL: message.author.displayAvatarURL(),
      })
      .setTimestamp();

    await pending.edit({ content: null, embeds: [embed] });
  },
};
