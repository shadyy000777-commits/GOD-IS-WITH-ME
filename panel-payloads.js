const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// These two builders used to live in cmd-verify-panel.js and cmd-register.js
// alongside their /verify-panel and /register slash commands. Those slash
// commands were removed (everything's driven from the Admin Panel's "Post
// Verification Panel" / "Post Registration Panel" buttons now — see
// admin-panel-handlers.js), but the payloads themselves still needed a
// home since the panel buttons post exactly these embeds.

function buildVerifyPanelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('<:276022clydebot:1549274299758809148> 𝐒𝐂𝐑𝐈𝐌𝐒 𝐕𝐄𝐑𝐈𝐅𝐈𝐂𝐀𝐓𝐈𝐎𝐍')
    .setColor(0xF5A623)
    .setDescription(
      '<:559950clipboard:1549274535579230238> 𝑹𝒆𝒂𝒅𝒚 𝒕𝒐 𝒆𝒏𝒕𝒆𝒓 𝒕𝒉𝒆 𝒍𝒐𝒃𝒃𝒚? 𝑽𝒆𝒓𝒊𝒇𝒚 𝒚𝒐𝒖𝒓 𝒔𝒒𝒖𝒂𝒅 𝒂𝒏𝒅 𝒍𝒐𝒄𝒌 𝒚𝒐𝒖𝒓 𝒔𝒑𝒐𝒕 𝒃𝒆𝒇𝒐𝒓𝒆 𝒕𝒉𝒆 𝒔𝒍𝒐𝒕𝒔 𝒓𝒖𝒏 𝒐𝒖𝒕! \n\n' +
      '𝑽𝑬𝑹𝑰𝑭𝑰𝑪𝑨𝑻𝑰𝑶𝑵 𝑺𝑻𝑬𝑷𝑺\n\n' +
      '① 𝑷𝒓𝒆𝒔𝒔 𝑽𝑬𝑹𝑰𝑭𝒀 𝑯𝑬𝑹𝑬 𝒃𝒆𝒍𝒐𝒘\n' +
      '② 𝑨𝒅𝒅 𝒚𝒐𝒖𝒓 𝑻𝒆𝒂𝒎 𝑫𝒆𝒕𝒂𝒊𝒍𝒔\n' +
      '③ 𝑺𝒆𝒍𝒆𝒄𝒕 𝒚𝒐𝒖𝒓 4 𝒑𝒍𝒂𝒚𝒊𝒏𝒈 𝒎𝒆𝒎𝒃𝒆𝒓𝒔\n' +
      '④ 𝑺𝒖𝒃𝒎𝒊𝒕 & 𝒔𝒆𝒄𝒖𝒓𝒆 𝒚𝒐𝒖𝒓 𝒔𝒍𝒐𝒕\n\n' +
      '<a:985581725159669780:1549274753079189615> Everʏ field is required\n\n' +
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n' +
      '𝗡𝗢𝗕𝗟𝗘 𝗚𝗔𝗠𝗜𝗡𝗚 • 𝗦𝗖𝗥𝗜𝗠𝗦'
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_start')
      .setLabel('Verify')
      .setEmoji('<a:452028tick:1547663744979574955>')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('verify_edit_start')
      .setLabel('Edit')
      .setEmoji('<:dc992fea7ae84f43b24df2e52282cf6f:1549067424685490186>')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('verify_delete_start')
      .setLabel('Delete Team')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

function buildRegisterPanelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('<:55163calendar:1549274532915970168> 𝐓𝐞𝐚𝐦 𝐑𝐞𝐠𝐢𝐬𝐭𝐫𝐚𝐭𝐢𝐨𝐧')
    .setColor(0x57F287)
    .setDescription(
      '𝑪𝒍𝒊𝒄𝒌 𝒕𝒉𝒆 𝒃𝒖𝒕𝒕𝒐𝒏 𝒃𝒆𝒍𝒐𝒘 𝒕𝒐 𝒓𝒆𝒈𝒊𝒔𝒕𝒆𝒓 𝒚𝒐𝒖𝒓 𝒕𝒆𝒂𝒎 𝒇𝒐𝒓 𝒕𝒉𝒆 𝒔𝒄𝒓𝒊𝒎.\n\n' +
      '𝑨𝒇𝒕𝒆𝒓 𝒄𝒐𝒎𝒑𝒍𝒆𝒕𝒊𝒏𝒈 𝒕𝒉𝒆 𝒇𝒐𝒓𝒎 𝒚𝒐𝒖 𝒘𝒊𝒍𝒍 𝒃𝒆 𝒂𝒔𝒌𝒆𝒅 𝒕𝒐 𝒔𝒆𝒍𝒆𝒄𝒕 **4-5** 𝒎𝒆𝒎𝒃𝒆𝒓𝒔 𝒇𝒓𝒐𝒎 𝒂 𝒅𝒓𝒐𝒑 𝒅𝒐𝒘𝒏 𝒎𝒆𝒏𝒖\n\n' +
      '🔔 Group full? Teams can set a **Slot Reminder** with the **Set Reminder** button below and pick the group(s) they want — I\'ll tag you when a slot opens up.\n\n' +
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n' +
      '𝗚𝗔𝗠𝗜𝗡𝗚 • 𝗦𝗖𝗥𝗜𝗠𝗦'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('register_team_start')
      .setLabel('Register Team')
      .setEmoji('📥')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('slot_reminder_start')
      .setLabel('Set Reminder')
      .setEmoji('🔔')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

module.exports = { buildVerifyPanelPayload, buildRegisterPanelPayload };
