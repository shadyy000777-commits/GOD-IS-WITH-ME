const tournamentWizard = require('./tn-tournament-wizard-handlers');

module.exports = {
  name: 'tourney_close',
  aliases: ['tclose', 'tourneyclose'],
  description: 'Close a tournament group channel — no messages, files or threads until !tourney_open — run it inside the group channel (staff / Manage Server)',
  // Not adminOnly: tournament Staff-role members may use it too — the handler checks.
  async execute(message) {
    return tournamentWizard.handleGroupChatToggle(message, false);
  },
};
