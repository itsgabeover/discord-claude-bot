import { chat, clearHistory, getHistoryLength } from '../claude.js';
import { setVoiceChannel } from '../tools/index.js';

const ALLOWED_CHANNEL_IDS = process.env.ALLOWED_CHANNEL_IDS
  ? process.env.ALLOWED_CHANNEL_IDS.split(',').map(id => id.trim())
  : null;

// Discord's max message length
const DISCORD_MAX_LENGTH = 2000;

// Friendly labels for the live progress log — falls back to the raw tool
// name for anything not listed here (e.g. if a new tool gets added).
const TOOL_LABELS = {
  read_file: '📖 Reading a file',
  write_file: '✍️ Writing a file',
  list_directory: '📁 Listing a directory',
  git_status: '🔍 Checking git status',
  git_commit: '💾 Committing changes',
  git_push: '🚀 Pushing to GitHub',
  git_pull: '⬇️ Pulling latest changes',
  git_log: '📜 Checking git history',
  gdrive_list: '🗂️ Listing Google Drive',
  gdrive_read: '📄 Reading a Drive file',
  gdrive_create_doc: '📝 Creating a Google Doc',
  gdrive_append_doc: '✏️ Updating a Google Doc',
  gdrive_process_image: '🖼️ Downloading an image from Drive',
  list_channels: '📋 Listing Discord channels',
  send_to_channel: '📨 Sending a Discord message',
  inspect_image: '🔎 Inspecting an image',
  process_image: '🖼️ Processing an image',
  web_search: '🌐 Searching the web',
  run_npm: '⚙️ Running npm',
  speak_in_voice: '🔊 Speaking in voice',
  leave_voice: '👋 Leaving voice channel',
};

// Keep only the most recent steps in the progress message so it doesn't
// grow unbounded on long tool chains.
const MAX_VISIBLE_STEPS = 8;

function formatProgress(steps, { done = false } = {}) {
  const visible = steps.slice(-MAX_VISIBLE_STEPS);
  const header = steps.length > visible.length ? `_(+${steps.length - visible.length} earlier steps)_\n` : '';
  const lines = visible.map((s, i) => {
    const isLast = i === visible.length - 1;
    return isLast && !done ? `${s}…` : `${s} ✓`;
  });
  return header + lines.join('\n');
}

/**
 * Split a long response into chunks that fit Discord's 2000-char limit.
 * Tries to split on newlines so code blocks and paragraphs stay intact.
 */
function splitMessage(text) {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > DISCORD_MAX_LENGTH) {
    // Find the last newline within the limit
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitAt === -1) splitAt = DISCORD_MAX_LENGTH;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Collect image attachments from a Discord message.
 * Returns objects with { url, contentType } for Claude.
 */
function extractImages(message) {
  const images = [];

  for (const [, attachment] of message.attachments) {
    const type = attachment.contentType || '';
    if (type.startsWith('image/')) {
      images.push({
        url: attachment.url,
        contentType: type,
      });
    }
  }

  return images;
}

/**
 * Main message handler — called for every message in the server.
 */
export async function handleMessage(message) {
  // Ignore bots (including ourselves)
  if (message.author.bot) return;

  // Check if the bot is mentioned
  const isMentioned = message.mentions.has(message.client.user);
  if (!isMentioned) return;

  // Optional: restrict to specific channels
  if (ALLOWED_CHANNEL_IDS && !ALLOWED_CHANNEL_IDS.includes(message.channelId)) return;

  // Strip the @mention from the message text
  let text = message.content
    .replace(/<@!?\d+>/g, '')  // remove all @mentions
    .trim();

  // Special commands
  if (text.toLowerCase() === '!clear') {
    clearHistory(message.channelId);
    await message.reply('🧹 Conversation history cleared! Fresh start.');
    return;
  }

  if (text.toLowerCase() === '!history') {
    const count = getHistoryLength(message.channelId);
    await message.reply(`📚 I have ${count} messages in my memory for this channel.`);
    return;
  }

  // Collect any image attachments
  const images = extractImages(message);

  // If there's no text and no images, prompt them
  if (!text && images.length === 0) {
    await message.reply("Hey! What can I help with? You can ask me anything, share a drawing, or ask me to build something for the site.");
    return;
  }

  // Detect if the user is in a voice channel and tell the tools about it
  const voiceChannel = message.member?.voice?.channel ?? null;
  setVoiceChannel(voiceChannel);

  // Append voice context so Claude knows it can speak
  const voiceNote = voiceChannel
    ? `\n\n[${message.author.username} is in voice channel "${voiceChannel.name}". You can use speak_in_voice to respond verbally — use plain conversational text, no markdown.]`
    : '';

  // Show a typing indicator while we think
  await message.channel.sendTyping();

  // Keep the typing indicator alive for long operations
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);

  // Live progress log — a single message that edits itself as tools run,
  // so you can see it's actually doing something instead of just "typing...".
  // Built entirely from data the agentic loop already produces — no extra
  // Claude API calls or tokens involved.
  const steps = [];
  let progressMessagePromise = null;

  const onToolCall = (name) => {
    steps.push(TOOL_LABELS[name] || `🔧 ${name}`);
    const body = formatProgress(steps);
    progressMessagePromise = progressMessagePromise
      ? progressMessagePromise.then(m => m ? m.edit(body).catch(() => m) : null)
      : message.reply(body).catch(() => null);
  };

  try {
    const response = await chat(
      message.channelId,
      (text || '(image shared — no text)') + voiceNote,
      images,
      message.author.username,
      onToolCall,
    );

    clearInterval(typingInterval);

    if (progressMessagePromise) {
      const finalBody = formatProgress(steps, { done: true });
      await progressMessagePromise.then(m => m?.edit(finalBody).catch(() => {}));
    }

    // Split and send the response
    const chunks = splitMessage(response);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0 && !progressMessagePromise) {
        // No progress message was shown — reply directly to the original message
        await message.reply(chunks[i]);
      } else {
        await message.channel.send(chunks[i]);
      }
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error('[error]', err);
    await message.reply(`Something went wrong: ${err.message}`);
  }
}
