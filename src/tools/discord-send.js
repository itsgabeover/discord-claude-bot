import { ChannelType } from 'discord.js';

let _client = null;

/** Called from index.js once the bot is logged in. */
export function setDiscordClient(client) {
  _client = client;
}

/** List all text channels in the server so Claude knows where to send messages. */
export async function listChannels() {
  if (!_client) return 'Discord client not ready yet.';

  try {
    const guilds = _client.guilds.cache;
    if (guilds.size === 0) return 'Bot is not in any servers.';

    const lines = [];
    for (const [, guild] of guilds) {
      lines.push(`**${guild.name}**`);
      const channels = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText)
        .sort((a, b) => a.position - b.position);

      for (const [, channel] of channels) {
        lines.push(`  #${channel.name}  (id: ${channel.id})`);
      }
    }

    return `Discord channels:\n\n${lines.join('\n')}`;
  } catch (err) {
    return `Error listing channels: ${err.message}`;
  }
}

/** Send a message to a specific channel by ID. */
export async function sendToChannel(channelId, message) {
  if (!_client) return 'Discord client not ready yet.';

  try {
    const channel = await _client.channels.fetch(channelId);
    if (!channel) return `Channel ${channelId} not found.`;
    if (!channel.isTextBased()) return `Channel ${channelId} is not a text channel.`;

    await channel.send(message);
    return `Message sent to #${channel.name}`;
  } catch (err) {
    return `Error sending message: ${err.message}`;
  }
}
