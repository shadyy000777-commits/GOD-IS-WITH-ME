const { buildTournamentListPayload } = require('./tn-tournament-wizard-handlers');
const panelInactivity = require('./tn-panel-inactivity');

module.exports = {
  name: 'tournament',
  aliases: ['tourney'],
  description: 'Post the tournament panel — create, switch between, and manage multiple tournaments (usage: !tournament)',
  adminOnly: true,

  async execute(message) {
    const payload = buildTournamentListPayload(message.guildId);
    const sent = await message.channel.send(payload);
    panelInactivity.touch(sent);
    await message.delete().catch(() => {});
  },
};
