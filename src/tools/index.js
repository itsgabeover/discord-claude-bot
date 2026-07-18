import { readFile, writeFile, listDirectory } from './filesystem.js';
import { gitStatus, gitCommit, gitPush, gitPull, gitLog } from './git.js';
import { gdriveList, gdriveRead, gdriveCreateDoc, gdriveAppendDoc } from './gdrive.js';
import { listChannels, sendToChannel } from './discord-send.js';
import { processImage, inspectImage } from './image.js';
import { webSearch } from './web.js';
import { runNpm } from './npm.js';
import { speakInVoice, leaveVoice } from './voice.js';

export { setDiscordClient } from './discord-send.js';
export { setVoiceChannel } from './voice.js';

// Tool definitions — sent to Claude so it knows what it can call.
export const toolDefinitions = [

  // ── Filesystem ────────────────────────────────────────────────────────────
  {
    name: 'read_file',
    description: "Read a file in the website repo. Always do this before editing a file so you know what's already there.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from the repo root, e.g. "src/app/page.tsx"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the website repo. Creates missing parent directories automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from the repo root.' },
        content: { type: 'string', description: 'The full file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory of the website repo.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the directory. Defaults to repo root.' },
      },
      required: [],
    },
  },

  // ── Git ───────────────────────────────────────────────────────────────────
  {
    name: 'git_status',
    description: 'Show which files have been changed in the website repo.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_commit',
    description: 'Stage all changed files and commit them. Always commit before pushing.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Descriptive commit message, e.g. "Add character gallery page"' },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_push',
    description: 'Push committed changes to GitHub. Vercel will redeploy the site automatically. Always commit first.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_pull',
    description: 'Pull the latest changes from GitHub. Do this at the start of any coding task.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_log',
    description: 'Show recent commit history.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of commits to show (default 5).' },
      },
      required: [],
    },
  },

  // ── Google Drive ─────────────────────────────────────────────────────────
  {
    name: 'gdrive_list',
    description: 'List files in the Wublets Google Drive folder — brand docs, character sheets, notes, etc.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'gdrive_read',
    description: 'Read a Google Doc, Sheet, or text file from the Wublets Drive folder.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID from gdrive_list results.' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'gdrive_create_doc',
    description: 'Create a new Google Doc in the Wublets Drive folder. Good for character sheets, brand docs, meeting notes, marketing copy.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Document name, e.g. "Wublets Brand Guide"' },
        content: { type: 'string', description: 'Text content to put in the document.' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'gdrive_append_doc',
    description: 'Append text to the end of an existing Google Doc.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID from gdrive_list results.' },
        content: { type: 'string', description: 'Text to append.' },
      },
      required: ['file_id', 'content'],
    },
  },

  // ── Discord ───────────────────────────────────────────────────────────────
  {
    name: 'list_channels',
    description: 'List all text channels in the Discord server with their IDs. Use this to find a channel ID before sending a message.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'send_to_channel',
    description: 'Send a message to a specific Discord channel. Use list_channels first to get the channel ID. Good for announcements like "the site just deployed" or pinging Hannah about something.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Discord channel ID (from list_channels).' },
        message: { type: 'string', description: 'The message to send.' },
      },
      required: ['channel_id', 'message'],
    },
  },

  // ── Images ────────────────────────────────────────────────────────────────
  {
    name: 'inspect_image',
    description: "Get the dimensions, format, and file size of an image URL — useful for checking a Procreate export before deciding how to process it.",
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the image to inspect.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'process_image',
    description: "Download an image from a URL, resize it, convert its format, and save it into the website repo's public folder. Great for turning Procreate exports into web-optimised assets. Recommended format: webp.",
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the source image.' },
        output_path: { type: 'string', description: 'Where to save it in the repo, e.g. "public/images/blobby.webp"' },
        width: { type: 'number', description: 'Max width in pixels (optional, preserves aspect ratio).' },
        height: { type: 'number', description: 'Max height in pixels (optional, preserves aspect ratio).' },
        format: { type: 'string', description: 'Output format: webp (default), png, jpg, avif.' },
        quality: { type: 'number', description: 'Quality 1–100 (default 85).' },
      },
      required: ['url', 'output_path'],
    },
  },

  // ── Web Search ────────────────────────────────────────────────────────────
  {
    name: 'web_search',
    description: 'Search the web for inspiration, market research, competitor analysis, pricing, or any factual question.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        count: { type: 'number', description: 'Number of results to return (max 10, default 5).' },
      },
      required: ['query'],
    },
  },

  // ── npm ───────────────────────────────────────────────────────────────────
  {
    name: 'run_npm',
    description: 'Run a safe npm command in the website repo — install packages, build, lint, or type-check. Use after making code changes to verify nothing is broken before committing.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The npm command to run, e.g. "npm run build" or "npm install framer-motion"' },
      },
      required: ['command'],
    },
  },

  // ── Voice ─────────────────────────────────────────────────────────────────
  {
    name: 'speak_in_voice',
    description: [
      'Convert text to speech using ElevenLabs and play it in the voice channel the user is currently in.',
      'Use this when the user is in a voice channel and you want to respond verbally — for example when asked a question while on a call.',
      'Keep the text natural and conversational — avoid markdown, code blocks, bullet points, and URLs since they sound awkward when spoken.',
      'If ELEVENLABS_API_KEY is not configured this will return an error.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'What to say out loud. Plain conversational text only — no markdown, no code blocks.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'leave_voice',
    description: 'Disconnect the bot from the voice channel immediately. Use if the bot gets stuck or the user asks it to leave.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// Route a tool call from Claude to the right function.
export async function executeTool(name, input) {
  switch (name) {
    case 'read_file':         return readFile(input.path);
    case 'write_file':        return writeFile(input.path, input.content);
    case 'list_directory':    return listDirectory(input.path || '.');
    case 'git_status':        return gitStatus();
    case 'git_commit':        return gitCommit(input.message);
    case 'git_push':          return gitPush();
    case 'git_pull':          return gitPull();
    case 'git_log':           return gitLog(input.limit);
    case 'gdrive_list':       return gdriveList();
    case 'gdrive_read':       return gdriveRead(input.file_id);
    case 'gdrive_create_doc': return gdriveCreateDoc(input.name, input.content);
    case 'gdrive_append_doc': return gdriveAppendDoc(input.file_id, input.content);
    case 'list_channels':     return listChannels();
    case 'send_to_channel':   return sendToChannel(input.channel_id, input.message);
    case 'inspect_image':     return inspectImage(input.url);
    case 'process_image':     return processImage(input.url, input.output_path, {
                                width: input.width,
                                height: input.height,
                                format: input.format,
                                quality: input.quality,
                              });
    case 'web_search':        return webSearch(input.query, input.count);
    case 'run_npm':           return runNpm(input.command);
    case 'speak_in_voice':    return speakInVoice(input.text);
    case 'leave_voice':       return leaveVoice();
    default:                  return `Unknown tool: ${name}`;
  }
}
