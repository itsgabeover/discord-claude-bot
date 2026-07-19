import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { handleMessage } from './handlers/message.js';
import { cloneRepoIfNeeded } from './tools/git.js';
import { allProjects } from './config.js';
import { setDiscordClient } from './tools/index.js';
import { startWebhookServer } from './webhooks/server.js';

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
  startWebhookServer(client); // start HTTP server for GitHub/Vercel webhooks
  console.log(`✅ Bot is online as ${client.user.tag}`);
  console.log(`   Model: ${process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'}`);
  for (const p of allProjects()) {
    const guild = p.guildId ? `guild ${p.guildId}` : 'all guilds';
    console.log(`   Project "${p.name}" — ${guild}`);
    console.log(`      repo:  ${p.repoPath}`);
    console.log(`      drive: ${p.driveFolderId ? 'configured' : 'not configured'}`);
  }
  console.log(`   Webhooks: ${process.env.NOTIFICATIONS_CHANNEL_ID ? 'configured' : 'not configured'}`);
  console.log('   Mention me in Discord to get started!');
});

client.on('messageCreate', handleMessage);

client.on('error', err => {
  console.error('[discord error]', err);
});

// Clone or pull every configured project's repo before connecting to Discord
async function start() {
  const projects = allProjects();

  for (const project of projects) {
    try {
      await cloneRepoIfNeeded(project);
    } catch (err) {
      // One broken project shouldn't ground the whole bot when others are fine —
      // but with only one configured there's nothing left to serve, so failing
      // loudly beats idling in a state where every request errors.
      console.error(`❌ [${project.id}] Failed to prepare repo: ${err.message}`);
      if (projects.length === 1) {
        console.error('   Check the repo URL and GitHub token for this project.');
        process.exit(1);
      }
      console.error(`   Continuing without ${project.id}; its tools will fail until fixed.`);
    }
  }

  client.login(process.env.DISCORD_TOKEN);
}

start();
