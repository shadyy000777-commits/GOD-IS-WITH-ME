module.exports = {
  name: 'help',
  aliases: [],
  description: 'Sends the custom animated emoji',
  adminOnly: false,

  async execute(message) {
    await message.channel.send('<a:qg_hehe128:1555494946201534544>');
  },
};
