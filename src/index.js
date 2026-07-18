import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { handleMessage } from './handlers/message.js';
import { cloneRepoIfNeeded } from './tools/git.js';
import { setDiscordClient } from './tools/index.js';

// Validate required env vars on startup
const required = ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY'];
const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('ready', () => {
  setDiscordClient(client); // give tools access to the Discord client
  console.log(`✅ Wublets bot is online as ${client.user.tag}`);
  console.log(`   Model: ${process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'}`);
  console.log(`   Repo:  ${process.env.REPO_PATH || './repo'}`);
  console.log(`   Drive: ${process.env.GOOGLE_DRIVE_FOLDER_ID ? 'configured' : 'not configured'}`);
  console.log('   Mention me in Discord to get started!');
});

client.on('messageCreate', handleMessage);

client.on('error', err => {
  console.error('[discord error]', err);
});

// Clone or pull the website repo before connecting to Discord
async function start() {
  try {
    await cloneRepoIfNeeded();
  } catch (err) {
    console.error('❌ Failed to clone repo:', err.message);
    console.error('   Check GITHUB_REPO_URL and GITHUB_TOKEN in your .env');
    process.exit(1);
  }

  client.login(process.env.DISCORD_TOKEN);
}

start();
